'use strict';

/**
 * The runner's prop-challenge duties, for the policy strategies (signal:
 * policy) that trade an account (`account`):
 *
 *   snapshot   every bar: the account balance into combine/<account>.json
 *              (the gate refuses entries on a snapshot older than 10 min);
 *   endOfDay   after the end-of-day flatten: the day's closing balance;
 *   screen     at a setup: the sizing verdict (prop/verdict.js), recorded
 *              for the gate; a skipped setup starts no cycle.
 *
 * An open trade is managed by the policy strategy's exit (its trail), as in
 * the backtester. Tick specs are the broker's (trading/broker-specs.js), as
 * the gate sizes with them: a contract without one recorded gets a skip
 * verdict.
 */

const { loadAccounts } = require('../trading/accounts');
const { contractRoot, readJournal, resolveJournalPath } = require('../trading/journal');
const { familyOf } = require('../trading/contracts');
const { liveSpecs, whyNoSpec } = require('../trading/broker-specs');
const { isOpen } = require('../trading/positions');
const state = require('../trading/prop-state');
const { decideSetup } = require('./verdict');
const { componentRefusal } = require('../trading/strategies');
const combine = require('../trading/combine');
const { tradingDayKey } = require('../trading/clock');
const { lanePolicies } = require('../lanes');

// `lane` (lanes.js): the runner's lane; its policies are the ones that screen setups (a policy on another timeframe
// has no setups in this lane's scan). null: every policy, as before lanes.
function createPropHooks({ root, env = process.env, home, client, accountId, strategies, paper = false, log = () => {}, journal = null, lane = null }) {
  // The broker's journal (the harness's own order records): read only to know whether an order went through.
  const journalEntries = journal || (() => readJournal(resolveJournalPath({ ...env, FTH_HOME: home })));
  const specOf = liveSpecs({ ...env, FTH_HOME: home }); // the broker's tick specs, as the gate reads them
  const warned = new Set();
  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(msg, 'error');
  };

  /** The account profiles the valid policy strategies trade. */
  function accounts() {
    const names = new Set(strategies().filter(s => s.valid && s.signal === 'policy').map(s => s.account));
    const all = loadAccounts(root, env).accounts;
    return [...names].map(n => all.find(a => a.name === n && a.valid)).filter(Boolean);
  }

  /** The combine state for an account: the attempt and this balance (or the last snapshot). */
  function stateOf(account) {
    const r = state.readAttempt(home, account.name);
    if (!r) return null;
    return state.stateFrom(account, r, r.snapshot ? r.snapshot.balance : NaN);
  }

  async function balances(now, fn, { flat = false, closeOf = null, withFills = false } = {}) {
    const list = accounts();
    if (!list.length || !accountId) return;
    if (list.length > 1) warnOnce('many', `strategies trade ${list.length} account profiles (${list.map(a => a.name).join(', ')}) on one live account; each sees the same balance`);
    const { positions } = await client.accountState(accountId);
    const openIds = positions.filter(isOpen).map(p => String(p.contractId));
    const open = openIds.length;
    // A closing balance is read only once the account is flat (the closing fills are in it).
    if (flat && open) throw new Error(`${open} position(s) still open (${openIds.join(', ')}); the closing balance is read once flat`);
    const current = await client.accountBalance(accountId);
    // A past day's close (a catch-up): today's balance less what the fills since that day ended made.
    const balance = closeOf ? state.closeBefore(current, await client.fillsSince(accountId, new Date(closeOf)), closeOf) : current;
    for (const a of list) {
      if (!state.readAttempt(home, a.name)) {
        warnOnce(`start:${a.name}`, `${a.name}: no attempt is started, so the gate refuses its strategies' entries (node scripts/combine.js start --account ${a.name})`);
        continue;
      }
      // The fills since the day's anchor, to check the balance against (prop-state balanceCheck): only when flat,
      // on a day already anchored, and only when something moved (the balance, a position closed) or the last
      // check didn't pass; otherwise that check carries forward with no broker call. A broker that can't list
      // them refuses entries, never skips the check.
      let fills;
      let fillsError = null;
      let unchanged = false;
      const r = withFills && !open ? state.readAttempt(home, a.name) : null;
      const prev = r && r.snapshot;
      if (r && r.anchor && r.anchor.day === tradingDayKey(now)) {
        // Unchanged: flat before and now, the same balance, a check that passed, and no order of ours since
        // (a round trip between two snapshots leaves both flat). A journal that can't be read counts as moved.
        let ordered;
        try {
          ordered = prev ? state.orderSince(journalEntries(), prev.at) : true;
        } catch (_err) {
          ordered = true;
        }
        unchanged = Boolean(prev && prev.day === r.anchor.day && prev.open === 0 && prev.balance === balance && state.reconciled(prev.balanceCheck) && !ordered);
        if (!unchanged) {
          try {
            fills = await client.fillsSince(accountId, new Date(r.anchor.at));
          } catch (err) {
            fillsError = (err && err.message) || String(err) || 'the fills could not be read';
          }
          if (fills === undefined && !fillsError) fillsError = 'the broker returned no fills list';
        }
      }
      fn(a, balance, now, open, openIds, { fills, fillsError, unchanged });
    }
  }

  // A policy strategy owns its strategies' setups only while it can trade: active (or any
  // non-disabled one in a paper run) with an attempt running. Otherwise they trade as before.
  // everyLane: every such policy, whatever the lane (ownership is never lost to a lane); else the lane's only.
  function activePolicies(symbol, contractId, everyLane = false) {
    const root = contractRoot(contractId) || symbol;
    const fam = r => (familyOf(r) ? familyOf(r).micro : r);
    const all = strategies();
    const inLane = lane && !everyLane ? new Set(lanePolicies(all, lane)) : null;
    return all.filter(s => s.valid && s.signal === 'policy' && (!inLane || inLane.has(s))
      && (s.status === 'active' || (paper && s.status !== 'disabled'))
      && s.instruments.some(x => fam(x) === fam(root)) && state.readAttempt(home, s.account));
  }

  return {
    accounts,
    /**
     * The running attempts' state for the cycle prompt: balance, floor,
     * cushion, progress, the day, sessions left, each policy strategy's size
     * budget, and any entry block (the gate's own check). Built from
     * `balance` (the account balance just read) when given, else from the
     * latest snapshot; `asOf` says which. With neither, no numbers: an attempt
     * without a balance has none to show.
     */
    summaries(now = new Date(), balance = NaN) {
      const out = [];
      for (const a of accounts()) {
        const r = state.readAttempt(home, a.name);
        if (!r) continue;
        const entryBlock = state.combineBlock(home, a.name, now);
        const fresh = Number.isFinite(balance);
        const snapshotAt = r.snapshot ? r.snapshot.at : null;
        if (!fresh && !snapshotAt) {
          out.push({ account: a.name, status: 'unknown', noBalance: true, snapshotAt, entryBlock });
          continue;
        }
        const cs = state.stateFrom(a, r, fresh ? balance : r.snapshot.balance);
        const budgets = strategies().filter(x => x.valid && x.signal === 'policy' && x.account === a.name && x.status !== 'disabled')
          .map(x => ({ strategy: x.name, budgetUsd: combine.budget(cs, x.sizing || {}) }));
        out.push({ ...combine.summary(cs), asOf: fresh ? now.toISOString() : snapshotAt, snapshotAt, budgets, entryBlock });
      }
      return out;
    },
    /** Every bar: the balance and open positions now. */
    snapshot: now => balances(now, (a, b, t, open, openIds, check) => state.snapshot(home, a, b, t, { open, openIds, ...check }), { withFills: true }),
    /**
     * After the end-of-day flatten: the closing balance of trading day `day`
     * (YYYY-MM-DD). For a catch-up (a day that has ended), the balance then,
     * from the fills since (closeBefore): never today's.
     */
    endOfDay: (now, day) => balances(now, (a, b) => {
      // A day before the attempt started has nothing to record (a catch-up end of day for it is not an error).
      const r = state.readAttempt(home, a.name);
      if (r && r.startDay && day < r.startDay) return;
      state.recordEndOfDay(home, a, b, day);
    }, { flat: true, closeOf: now.getTime() >= state.dayEndMs(day) ? state.dayEndMs(day) : null }),

    /**
     * Scan results with every policy strategy applied. A policy strategy owns
     * its strategies' setups: their own results stop being candidates, and
     * the first of them that fired (in the policy strategy's order, as the
     * backtester picks) becomes the policy strategy's setup, sized from the
     * attempt's budget (or skipped). The verdict (contract, size, stop) is
     * recorded for the gate. A paper strategy stays paper inside a policy:
     * the pick passes over a strategy that isn't active (in a paper run, one
     * that is disabled; strategies.js componentRefusal, as the gate checks
     * the verdict's component). With only such setups fired, the policy has
     * no setup: not a candidate, no verdict, and a note naming them.
     */
    /** The strategies an active policy owns on this contract now: Map(strategy -> policy); empty when none. */
    owners({ symbol, contractId }) {
      const owners = new Map();
      for (const s of activePolicies(symbol, contractId, true)) for (const n of s.strategies) if (!owners.has(n)) owners.set(n, s.name);
      return owners;
    },
    screen(results, { symbol, contractId, bars, now = new Date() }) {
      // The contract's root (MNQ), not the plugin root this factory was given.
      const root = contractRoot(contractId) || symbol;
      const policies = activePolicies(symbol, contractId);
      const owners = this.owners({ symbol, contractId });
      if (!policies.length && !owners.size) return results;
      const registry = strategies();
      const refusal = (s, n) => componentRefusal(s, registry, n, { paper }); // null: the policy may trade n's setup
      const byName = new Map((results || []).map(r => [r.name, r]));
      const ownedNote = r => {
        const owner = owners.get(r.name);
        const p = policies.find(x => x.name === owner);
        // A policy outside the runner's lane still owns the setup: never a plain setup (the start check refuses such a lane).
        if (!p) return `not traded: ${owner} owns it and is not in this runner's lane`;
        const why = refusal(p, r.name);
        return why ? `not traded through ${owner}: ${why}` : `traded through ${owner}`;
      };
      const out = (results || []).filter(r => !policies.some(s => s.name === r.name))
        .map(r => (owners.has(r.name) && r.candidate ? { ...r, candidate: false, note: ownedNote(r) } : r));
      for (const s of policies) {
        const fired = s.strategies.map(n => byName.get(n)).filter(r => r && r.candidate && r.direction && r.stopDistance > 0);
        const pick = fired.find(r => !refusal(s, r.name));
        if (!pick) {
          const passed = fired.map(r => `${r.name} (${refusal(s, r.name)})`).join('; ');
          if (passed) log(`${symbol}: ${s.name} has no setup: it passed over ${passed}`);
          out.push({ name: s.name, status: s.status, signal: 'policy', candidate: false, ...(passed ? { note: `no setup: passed over ${passed}` } : {}) });
          continue;
        }
        const account = accounts().find(a => a.name === s.account);
        const spec = specOf(root);
        // The budget may pick either contract of the family: both need the broker's specs.
        const unspecified = [root, ...(familyOf(root) ? [familyOf(root).micro, familyOf(root).mini] : [])].find(r => !specOf(r));
        const cs = account && stateOf(account);
        let verdict;
        if (!cs || unspecified) {
          const reason = !cs ? `no ${s.account} attempt` : whyNoSpec(specOf, unspecified);
          verdict = { at: now.toISOString(), strategy: s.name, component: pick.name, symbol, contractId, direction: pick.direction, action: 'skip', maxSize: 0, contract: null, reason, expiresAt: now.toISOString() };
        } else {
          verdict = decideSetup({ account, cs, strategy: s, component: pick.name, symbol: root, contractId, rawBars: bars, spec, scan: pick, now, specOf, selected: [root] });
        }
        state.appendVerdict(home, verdict);
        log(`${symbol}: ${s.name} ${pick.direction} setup from ${pick.name}: sizing says ${verdict.action}`
          + `${verdict.maxSize ? ` (max ${verdict.maxSize} ${verdict.contract}, stop ${verdict.stopTicks} ticks)` : ''}${verdict.reason ? ` (${verdict.reason})` : ''}`);
        out.push({
          name: s.name, status: s.status, signal: 'policy', candidate: verdict.action !== 'skip', direction: pick.direction, component: pick.name,
          stopDistance: pick.stopDistance, verdict,
        });
      }
      return out;
    },
  };
}

module.exports = { createPropHooks };
