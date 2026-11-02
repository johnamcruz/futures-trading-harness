'use strict';

/**
 * Risk-manager phase 1's live inputs, as one canonical key (the smart phase-1 cache: accurate, not stale and not
 * late). Phase 1's report states the account's live facts; the runner reads them fresh every cycle, and a cached
 * report is served only while every one of them is what it was when the report was made. One function builds the
 * facts for the runner (report-cache.js, the key it records and serves under) and the parts the order gate checks
 * against its own reads (config.js, mcp-gateway.js), so the two can't drift. Any input missing or unreadable: no facts,
 * no key (nothing served, nothing recorded).
 *
 *   The facts: the trading day; the account (id, balance, its trading flags canTrade and mcpTradingAllowed and the day's
 *   remainingBeforeLimit as the server gives them; each position's contract, side, size and average price; each working
 *   order's id, contract, type, side, size and prices); each running attempt as the runner gives it (status,
 *   balance, floor, cushion, profit, day P&L, entry block, sessions, budgets and its facts: room, trades, losses,
 *   streak); the loss state from the day's fills (their count, losing closes, streak) and the loss cooldown's remaining time in
 *   whole bars from the cycle's bar close (0: none), so a cooldown that ends between two bars is another key; the
 *   window's entry state on the cycle's bar (the briefing's windowEntries: a stand-down by the time); the journal's
 *   lessons and reviewed trades lines (phase 1's lessons).
 *
 *   phase1Facts({ account, day, trades, carried, barClose, barMinutes, cooldown, windowEntries, lessons, reviewed })
 *                                             the facts, or null when any input is missing or unreadable
 *   factsKey(facts)                           sha256 of their canonical text, or null
 *   cooldownBars({ trades, carried, barClose, barMinutes, cooldown })   the cooldown's remaining whole bars, or null
 *   gateParts({ positions, orders, attempts })   the parts the gateway compares with its own reads (positions, orders)
 *   record({ bar, facts }) / parseRecord(text)   the runner's record for the cycle's environment (FTH_CYCLE_PHASE1)
 *   recordHolds(rec, { bar })                 the record is whole: its key is its facts', on the cycle's bar
 *   gateRefusal({ rec, positions, orders, running, now })   the gateway's check of a cached phase 1 against its own
 *                                             reads at the entry (the broker's positions and orders, the local prop
 *                                             state, the trading day): why it no longer holds, or null; a read that
 *                                             failed (null) refuses
 *   gateViolations(config, reads)             the gateway's [phase1-cache] violation for an entry, or none (no cached phase 1)
 *   ENV                                       'FTH_CYCLE_PHASE1'
 */

const crypto = require('crypto');
const { resolveContract } = require('./journal');

const ENV = 'FTH_CYCLE_PHASE1';
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

/** Canonical JSON: keys sorted at every level, so the same facts always give the same text. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
// A contract by the translator's standard name (its root), or `raw:<id>` when nothing names it (journal.js resolveContract):
// two reads that name one contract two ways compare by the rest of their fields (sameList).
const root = id => { if (typeof id !== 'string' || !id) return null; const r = resolveContract(id); return r.named ? r.root : `raw:${id}`; };
const unnamed = c => typeof c !== 'string' || c.startsWith('raw:');
/** Two lists of [contract, ...fields] the same: each field equal, the contract too unless either side's is unnamed. */
function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const rest = x => canonical(x.slice(1));
  const by = (x, y) => (rest(x) < rest(y) ? -1 : rest(x) > rest(y) ? 1 : 0);
  const sa = [...a].sort(by);
  const sb = [...b].sort(by);
  return sa.every((x, i) => rest(x) === rest(sb[i]) && (x[0] === sb[i][0] || unnamed(x[0]) || unnamed(sb[i][0])));
}

/** Positions and working orders as the facts hold them (sorted; the contract by its root, as both reads name it). */
function gateParts({ positions, orders }) {
  if (!Array.isArray(positions) || !Array.isArray(orders)) return null;
  const pos = positions.filter(p => isObj(p) && num(p.size)).map(p => [root(p.contractId), num(p.type), num(p.size), num(p.averagePrice)]);
  const ord = orders.filter(isObj).map(o => [root(o.contractId), String(o.id ?? ''), num(o.type), num(o.side), num(o.size), num(o.limitPrice), num(o.stopPrice)]);
  const by = (a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
  return { positions: pos.sort(by), orders: ord.sort(by) };
}

/**
 * The loss cooldown's remaining time in whole bars from the cycle's bar close (0: none, or over), from the day's fills
 * and what a running attempt carried into the day (account-gate.js fillLossState, the gate's own rule). Null when the
 * fills weren't read or the bar's close is unknown.
 */
function cooldownBars({ trades, carried = null, barClose, barMinutes, cooldown }) {
  if (!Array.isArray(trades) || !Number.isFinite(barClose) || !(barMinutes > 0) || !isObj(cooldown)) return null;
  const { fillLossState } = require('./account-gate');
  const s = fillLossState(trades, carried);
  // `fills`: the day's fills, so a round trip at zero P&L (no loss, no balance change) is another key too.
  const fills = trades.length;
  if (!(s.streak >= cooldown.maxConsecutiveLosses) || s.lastLossTs === null) return { bars: 0, streak: s.streak, losses: s.losses, fills };
  const left = s.lastLossTs + cooldown.lossCooldownMin * 60000 - barClose;
  return { bars: left > 0 ? Math.ceil(left / (barMinutes * 60000)) : 0, streak: s.streak, losses: s.losses, fills };
}

const ATTEMPT_KEYS = ['account', 'status', 'balance', 'floor', 'cushion', 'profit', 'dayPnl', 'entryBlock', 'sessionsDone', 'sessionsLeft', 'budgets', 'facts'];

function phase1Facts({ account, day, trades, carried = null, barClose, barMinutes, cooldown, windowEntries, lessons, reviewed }) {
  if (!isObj(account) || account.error || account.todayError || num(account.balance) === null || typeof day !== 'string' || !day) return null;
  const parts = gateParts({ positions: account.positions, orders: account.orders });
  if (!parts) return null;
  const loss = cooldownBars({ trades, carried, barClose, barMinutes, cooldown });
  if (!loss) return null;
  if (typeof windowEntries !== 'string' || !windowEntries) return null;
  if (!Array.isArray(lessons) || !Array.isArray(reviewed)) return null;
  const attempts = (Array.isArray(account.attempts) ? account.attempts : []).filter(isObj).map(a => Object.fromEntries(ATTEMPT_KEYS.map(k => [k, a[k] === undefined ? null : a[k]])));
  return {
    day,
    // The trading flags and the day's room, as the server gives them (an absent one, null, is a fact too).
    account: {
      id: account.id === undefined ? null : String(account.id), balance: num(account.balance), workingOrders: num(account.workingOrders),
      canTrade: typeof account.canTrade === 'boolean' ? account.canTrade : null, mcpTradingAllowed: typeof account.mcpTradingAllowed === 'boolean' ? account.mcpTradingAllowed : null,
      remainingBeforeLimit: num(account.remainingBeforeLimit),
    },
    ...parts, attempts, loss, windowEntries, lessons: lessons.map(String), reviewed: reviewed.map(String),
  };
}

const factsKey = facts => (isObj(facts) ? sha(canonical(facts)) : null);

/** The runner's record of a served phase 1, for the cycle's environment: the bar it is for, the facts and their key. */
const record = ({ bar, barMinutes, facts }) => (typeof bar === 'string' && bar && barMinutes > 0 && isObj(facts) ? { bar, barMinutes, factsKey: factsKey(facts), facts } : null);

function parseRecord(text) {
  try {
    const r = JSON.parse(String(text || ''));
    return isObj(r) && typeof r.bar === 'string' && Number(r.barMinutes) > 0 && /^[0-9a-f]{64}$/.test(String(r.factsKey)) && isObj(r.facts) ? r : null;
  } catch (_err) {
    return null;
  }
}

/** Whole: its key is its facts' (nothing edited), on the cycle's bar (`bar`: the briefing bar the cycle decides). */
const recordHolds = (rec, { bar }) => Boolean(rec) && typeof bar === 'string' && rec.bar === bar && factsKey(rec.facts) === rec.factsKey;

/**
 * Why a cached phase 1 no longer holds at the entry, by the gateway's own reads, or null: the trading day, the
 * positions and working orders (as the facts hold them), and every running attempt among the facts'. A read that
 * failed (not an array) refuses: phase 1 must run. The day's losses and the loss cooldown are in the runner's key (a
 * cooldown that ends is another key) but not compared here: the gate holds them itself on its own fills read
 * (account-gate.js loss-streak, daily-loss-count), and two fills reads of different windows would refuse every entry.
 */
function gateRefusal({ rec, positions, orders, running = [], now }) {
  if (!rec || !isObj(rec.facts)) return 'the runner\'s record of its facts is missing';
  const f = rec.facts;
  const { tradingDayKey } = require('./clock');
  if (f.day !== tradingDayKey(now)) return `its facts are of trading day ${f.day}, not ${tradingDayKey(now)}`;
  const parts = gateParts({ positions, orders });
  if (!parts) return 'the positions or working orders could not be read';
  if (!sameList(parts.positions, f.positions)) return 'the positions changed since it was made';
  if (!sameList(parts.orders, f.orders)) return 'the working orders changed since it was made';
  const named = new Set((Array.isArray(f.attempts) ? f.attempts : []).map(a => a && a.account));
  const extra = (Array.isArray(running) ? running : []).filter(a => !named.has(a));
  if (extra.length) return `an attempt runs that its facts don't hold (${extra.join(', ')})`;
  return null;
}

/** The gateway's violations for an entry (none unless a cached phase 1 counts): [phase1-cache] when it no longer holds. */
function gateViolations(config, reads) {
  if (!config || !Array.isArray(config.cycleCached) || !config.cycleCached.includes('risk-manager')) return [];
  const why = gateRefusal({ rec: config.cyclePhase1, ...reads });
  return why ? [{ check: 'phase1-cache', message: `Risk-manager phase 1 was served from the report cache, but ${why}: its report no longer states the account as it is. No entry this cycle (exits still go); phase 1 runs again next cycle.` }] : [];
}

module.exports = { ENV, canonical, gateParts, cooldownBars, phase1Facts, factsKey, record, parseRecord, recordHolds, gateRefusal, gateViolations };
