'use strict';

/**
 * The runner's prop-challenge duties, for strategies that trade an account
 * (`account`) and maybe a policy (`policy`):
 *
 *   snapshot   every bar: the account balance into combine/<account>.json
 *              (the gate refuses entries on a snapshot older than 10 min);
 *   endOfDay   after the end-of-day flatten: the day's closing balance;
 *   screen     at a setup: the policy's verdict, recorded for the gate; a
 *              skipped setup starts no cycle;
 *   position   in a trade past the ratchet: hold or close.
 *
 * A bundle that can't be loaded (missing, retrained on another observation,
 * not validated) makes every verdict a skip: the gate then refuses the entry.
 */

const { loadAccounts } = require('../trading/accounts');
const { contractRoot } = require('../trading/journal');
const { specFor, familyOf } = require('../trading/contracts');
const { loadBundle, bundleMismatch } = require('./policy-bundle');
const live = require('./live');
const combine = require('../trading/combine');

function createPropHooks({ root, env = process.env, home, client, accountId, strategies, paper = false, log = () => {} }) {
  const bundles = new Map();
  const warned = new Set();
  const warnOnce = (key, msg) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(msg, 'error');
  };

  /** The strategy's bundle, or { error }: unloadable, unvalidated, or trained for another strategy, account, or sizing. */
  function bundleFor(strategy, symbolRoot) {
    const name = strategy.policy.bundle;
    if (!bundles.has(name)) {
      try {
        bundles.set(name, loadBundle(root, name, env));
      } catch (err) {
        bundles.set(name, { error: err.message });
      }
    }
    const b = bundles.get(name);
    if (b.error) return b;
    const why = bundleMismatch(b.meta, strategy, symbolRoot);
    return why ? { error: `policy ${name} ${why}; retrain it for this strategy` } : b;
  }

  /** The account profiles the valid policy strategies trade. */
  function accounts() {
    const names = new Set(strategies().filter(s => s.valid && s.signal === 'policy').map(s => s.account));
    const all = loadAccounts(root, env).accounts;
    return [...names].map(n => all.find(a => a.name === n && a.valid)).filter(Boolean);
  }

  /** The combine state for an account: the attempt and this balance (or the last snapshot). */
  function stateOf(account) {
    const r = live.readAttempt(home, account.name);
    if (!r) return null;
    return live.stateFrom(account, r, r.snapshot ? r.snapshot.balance : NaN);
  }

  async function balances(now, fn, { flat = false } = {}) {
    const list = accounts();
    if (!list.length || !accountId) return;
    if (list.length > 1) warnOnce('many', `strategies trade ${list.length} account profiles (${list.map(a => a.name).join(', ')}) on one live account; each sees the same balance`);
    const { positions } = await client.accountState(accountId);
    const openIds = positions.filter(p => Number(p.size || 0) > 0).map(p => String(p.contractId));
    const open = openIds.length;
    // A closing balance is read only once the account is flat (the closing fills are in it).
    if (flat && open) throw new Error(`${open} position(s) still open (${openIds.join(', ')}); the closing balance is read once flat`);
    const balance = await client.accountBalance(accountId);
    for (const a of list) {
      if (!live.readAttempt(home, a.name)) {
        warnOnce(`start:${a.name}`, `${a.name}: no attempt is started, so the gate refuses its strategies' entries (node scripts/combine.js start --account ${a.name})`);
        continue;
      }
      fn(a, balance, now, open, openIds);
    }
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
        const r = live.readAttempt(home, a.name);
        if (!r) continue;
        const entryBlock = live.combineBlock(home, a.name, now);
        const fresh = Number.isFinite(balance);
        const snapshotAt = r.snapshot ? r.snapshot.at : null;
        if (!fresh && !snapshotAt) {
          out.push({ account: a.name, status: 'unknown', noBalance: true, snapshotAt, entryBlock });
          continue;
        }
        const cs = live.stateFrom(a, r, fresh ? balance : r.snapshot.balance);
        const budgets = strategies().filter(x => x.valid && x.signal === 'policy' && x.account === a.name && x.status !== 'disabled')
          .map(x => ({ strategy: x.name, budgetUsd: combine.budget(cs, x.sizing || {}) }));
        out.push({ ...combine.summary(cs), asOf: fresh ? now.toISOString() : snapshotAt, snapshotAt, budgets, entryBlock });
      }
      return out;
    },
    /** Every bar: the balance and open positions now. */
    snapshot: now => balances(now, (a, b, t, open, openIds) => live.snapshot(home, a, b, t, { open, openIds })),
    /** After the end-of-day flatten: the closing balance of trading day `day` (YYYY-MM-DD). */
    endOfDay: (now, day) => balances(now, (a, b) => {
      // A day before the attempt started has nothing to record (a catch-up end of day for it is not an error).
      const r = live.readAttempt(home, a.name);
      if (r && r.startDay && day < r.startDay) return;
      live.recordEndOfDay(home, a, b, day);
    }, { flat: true }),

    /**
     * Scan results with every policy strategy applied. A policy strategy owns
     * its strategies' setups: their own results stop being candidates, and
     * the first of them that fired (in the policy strategy's order, as the
     * backtester picks) becomes the policy strategy's setup, screened by its
     * trained policy (or taken as sized without one). The verdict (contract,
     * size, stop) is recorded for the gate.
     */
    screen(results, { symbol, contractId, bars, now = new Date() }) {
      const root = contractRoot(contractId) || symbol;
      const fam = r => (familyOf(r) ? familyOf(r).micro : r);
      // A policy strategy owns its strategies' setups only while it can trade: active (or any
      // non-disabled one in a paper run) with an attempt running. Otherwise they trade as before.
      const policies = strategies().filter(s => s.valid && s.signal === 'policy'
        && (s.status === 'active' || (paper && s.status !== 'disabled'))
        && s.instruments.some(x => fam(x) === fam(root)) && live.readAttempt(home, s.account));
      if (!policies.length) return results;
      const owners = new Map();
      for (const s of policies) for (const n of s.strategies) if (!owners.has(n)) owners.set(n, s.name);
      const byName = new Map((results || []).map(r => [r.name, r]));
      const out = (results || []).filter(r => !policies.some(s => s.name === r.name))
        .map(r => (owners.has(r.name) && r.candidate ? { ...r, candidate: false, note: `traded through ${owners.get(r.name)}` } : r));
      for (const s of policies) {
        const pick = s.strategies.map(n => byName.get(n)).find(r => r && r.candidate && r.direction && r.stopDistance > 0);
        if (!pick) {
          out.push({ name: s.name, status: s.status, signal: 'policy', candidate: false });
          continue;
        }
        const account = accounts().find(a => a.name === s.account);
        const spec = specFor(root);
        const bundle = s.policy ? bundleFor(s, root) : null;
        const cs = account && stateOf(account);
        let verdict;
        if ((bundle && bundle.error) || !cs || !spec) {
          const reason = (bundle && bundle.error) || (!cs ? `no ${s.account} attempt` : `no tick specs for ${root}`);
          verdict = { at: now.toISOString(), strategy: s.name, component: pick.name, symbol, contractId, direction: pick.direction, action: 'skip', maxSize: 0, contract: null, reason, expiresAt: now.toISOString() };
        } else {
          verdict = live.decideSetup({ bundle, account, cs, strategy: s, component: pick.name, symbol: root, contractId, rawBars: bars, spec, scan: pick, results: [...byName.values()], now });
        }
        live.appendVerdict(home, verdict);
        log(`${symbol}: ${s.name} ${pick.direction} setup from ${pick.name}: ${s.policy ? `policy ${s.policy.bundle}` : 'sizing'} says ${verdict.action}`
          + `${verdict.maxSize ? ` (max ${verdict.maxSize} ${verdict.contract}, stop ${verdict.stopTicks} ticks)` : ''}${verdict.reason ? ` (${verdict.reason})` : ''}`);
        out.push({
          name: s.name, status: s.status, signal: 'policy', candidate: verdict.action !== 'skip', direction: pick.direction, component: pick.name,
          stopDistance: pick.stopDistance, verdict,
        });
      }
      return out;
    },

    /**
     * hold / close for an open trade of a policy strategy past its ratchet;
     * null when it has no usable policy. The trade's strategy and contract
     * come from the verdict it was entered on.
     */
    position({ strategy, contractId, bars, pos }) {
      if (!strategy || strategy.signal !== 'policy' || !strategy.policy) return null;
      const root = contractRoot(contractId);
      const bundle = bundleFor(strategy, root);
      const account = accounts().find(a => a.name === strategy.account);
      const cs = account && stateOf(account);
      const spec = specFor(root);
      const entered = live.readVerdicts(home).filter(v => v.strategy === strategy.name && v.contract === root && v.action !== 'skip').pop();
      if (bundle.error || !cs || !spec || !entered) {
        warnOnce(`pos:${strategy.name}`, `${strategy.name}: policy ${strategy.policy.bundle} can't decide in a trade (${bundle.error || (!entered ? 'no verdict for this trade' : 'no attempt or tick specs')}); the trail manages it alone`);
        return null;
      }
      return live.decidePosition({ bundle, account, cs, strategy, rawBars: bars, spec, pos: { ...pos, contract: root, component: entered.component } });
    },
  };
}

module.exports = { createPropHooks };
