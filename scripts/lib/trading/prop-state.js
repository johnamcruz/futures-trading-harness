'use strict';

/**
 * Prop-challenge state on disk, kept by the runner (which can read the
 * account) and enforced by the order gate (which reads only local state):
 *
 *   <FTH_HOME>/combine/<account>.json   the attempt: start, end-of-day
 *                                       balances, and the latest snapshot
 *   <FTH_HOME>/policy-verdicts.jsonl    one line per policy decision at a setup
 *
 * Light on purpose: the order-gate hook loads it on every order.
 */

const fs = require('fs');
const path = require('path');
const combine = require('./combine');
const { contractRoot, entryTime } = require('./journal');
const { specFor, familyOf } = require('./contracts');
const { tradingDayKey } = require('./clock');

const SNAPSHOT_MAX_AGE_MS = 10 * 60000; // the gate refuses entries on an older snapshot
const VERDICT_KEEP = 500;

const combineFile = (home, account) => path.join(home, 'combine', `${account}.json`);
const verdictsFile = home => path.join(home, 'policy-verdicts.jsonl');

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The attempt record, or null when none was started (scripts/combine.js start). */
function readAttempt(home, account) {
  try {
    const r = JSON.parse(fs.readFileSync(combineFile(home, account), 'utf8'));
    return r && r.account === account && Array.isArray(r.days) ? r : null;
  } catch (_err) {
    return null;
  }
}

/** Start (or restart) an attempt for an account profile. */
function startAttempt(home, account, now = new Date()) {
  const r = { account: account.name, startedAt: now.toISOString(), startDay: tradingDayKey(now), days: [], snapshot: null, missedClose: null };
  writeJson(combineFile(home, account.name), r);
  return r;
}

/** End an attempt (passed, blown, or abandoned): its record is kept, renamed. */
function endAttempt(home, accountName, now = new Date()) {
  const file = combineFile(home, accountName);
  if (!fs.existsSync(file)) return null;
  const dest = `${file.slice(0, -5)}.ended-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  fs.renameSync(file, dest);
  return dest;
}

/** The accounts with a running attempt (combine/<account>.json). */
function runningAttempts(home) {
  let names;
  try {
    names = fs.readdirSync(path.join(home, 'combine')).filter(f => /^[a-z0-9][a-z0-9_-]*\.json$/.test(f)).map(f => f.slice(0, -5));
  } catch (_err) {
    return [];
  }
  return names.filter(n => readAttempt(home, n));
}

/** The combine state from the attempt record and the balance now (live, or the last snapshot). */
function stateFrom(account, record, balance) {
  let cs = combine.start(account);
  for (const d of record.days) {
    cs = combine.endDay({ ...cs, balance: d.balance, dayPnl: d.pnl });
    if (cs.status !== 'active') return cs;
  }
  const lastEod = record.days.length ? record.days[record.days.length - 1].balance : account.starting_balance;
  const b = Number.isFinite(balance) ? balance : cs.balance;
  // The peak balance: every close and snapshot so far (closed trades only: the snapshot is the realized balance).
  const peak = Math.max(cs.start, record.peak || 0, ...record.days.map(d => d.balance), b);
  cs = { ...cs, balance: b, peak, dayPnl: Math.round((b - lastEod) * 100) / 100 };
  if (b <= cs.floor) cs = { ...cs, status: 'blown' };
  if (cs.dailyLimit > 0 && cs.dayPnl <= -cs.dailyLimit) cs.dayStopped = true;
  return cs;
}

/**
 * Save the latest balance and open-position count (the gate reads them),
 * returning the state. A snapshot on a new trading day whose previous
 * snapshot's day has no recorded close marks that close as missed: the
 * trailing floor can't be known until it is recorded, so entries stop.
 */
function snapshot(home, account, balance, now = new Date(), { open = 0 } = {}) {
  const record = readAttempt(home, account.name);
  if (!record) return null;
  const day = tradingDayKey(now);
  const prev = record.snapshot && record.snapshot.day;
  let missedClose = record.missedClose || null;
  if (!missedClose && prev && prev !== day && !record.days.some(d => d.day === prev)) missedClose = prev;
  const cs = stateFrom(account, record, balance);
  writeJson(combineFile(home, account.name), {
    ...record, missedClose, peak: cs.peak,
    snapshot: { at: now.toISOString(), day, balance, open, summary: combine.summary(cs), block: combine.entryBlock(cs), state: cs },
  });
  return cs;
}

/**
 * Record a trading day's closing balance, once per day. A missed day may be
 * recorded after later ones (the days stay in order and each day's P&L is
 * recomputed). Returns the record, or throws when the day is already recorded
 * with another balance.
 */
function recordEndOfDay(home, account, balance, dayKey) {
  const record = readAttempt(home, account.name);
  if (!record) return null;
  if (!Number.isFinite(balance) || !/^\d{4}-\d{2}-\d{2}$/.test(String(dayKey))) throw new Error(`a closing balance and a trading day (YYYY-MM-DD) are required`);
  const same = record.days.find(d => d.day === dayKey);
  if (same) {
    if (Math.abs(same.balance - balance) > 0.005) throw new Error(`${account.name}: the close of ${dayKey} is already recorded at $${same.balance}, not $${balance}`);
    return record;
  }
  if (record.startDay && dayKey < record.startDay) throw new Error(`${account.name}: ${dayKey} is before the attempt started (${record.startDay})`);
  const sorted = [...record.days.map(d => ({ day: d.day, balance: d.balance })), { day: dayKey, balance }].sort((a, b) => a.day.localeCompare(b.day));
  let prev = account.starting_balance;
  const days = sorted.map(d => {
    const out = { day: d.day, balance: d.balance, pnl: Math.round((d.balance - prev) * 100) / 100 };
    prev = d.balance;
    return out;
  });
  const next = { ...record, missedClose: record.missedClose === dayKey ? null : record.missedClose || null, days };
  writeJson(combineFile(home, account.name), next);
  return next;
}

/**
 * Why the gate must refuse a new entry for a strategy trading `account`, or
 * null: no attempt started, a missing or stale snapshot, or the account's own
 * block (passed, daily limits, at target, over).
 */
function combineBlock(home, accountName, now = new Date()) {
  const r = readAttempt(home, accountName);
  if (!r) return `no ${accountName} attempt is started (node scripts/combine.js start --account ${accountName})`;
  if (r.missedClose) {
    return `the close of ${r.missedClose} was never recorded, so the trailing floor is unknown; record the account's closing balance that day `
      + `(node scripts/combine.js record-day --account ${accountName} --day ${r.missedClose} --balance <dollars>)`;
  }
  const s = r.snapshot;
  if (!s || !(now.getTime() - Date.parse(s.at) <= SNAPSHOT_MAX_AGE_MS)) return `the ${accountName} account snapshot is missing or older than ${SNAPSHOT_MAX_AGE_MS / 60000} minutes (the runner updates it each bar)`;
  if (s.open > 0) return `a position is open on the account; a prop attempt trades one position at a time (as the backtester and the policy do)`;
  return s.block || null;
}

const feeOf = (account, root) => (account.fees_per_side && account.fees_per_side[root]) ?? (specFor(root) || {}).feesPerSide ?? 0.37;

/** A contract the account can trade: tick value, the account's fee (else the spec's), and its limit. */
function legOf(account, root) {
  const spec = specFor(root);
  return spec ? { root, tickValue: spec.tickValue, fee: feeOf(account, root), max: (account.max_contracts && account.max_contracts[root]) || 0 } : null;
}

/** The micro and mini legs of a root's family (or the root alone), and the mini:micro ratio. */
function legsFor(account, root) {
  const fam = familyOf(root);
  if (!fam) return { legs: { micro: legOf(account, root), mini: null }, ratio: 10, mode: 'micro' };
  return { legs: { micro: legOf(account, fam.micro), mini: legOf(account, fam.mini) }, ratio: fam.ratio };
}

/**
 * The contract and size the account's budget allows for a policy strategy's
 * entry with a `stopTicks` stop, from the latest snapshot (combine.contractPlan,
 * as the backtester and training size it), or { error }.
 */
function budgetPlan(home, account, strategy, root, stopTicks, fraction = 1) {
  const r = readAttempt(home, account.name);
  const state = r && r.snapshot && r.snapshot.state;
  if (!state) return { error: `no ${account.name} snapshot to size from` };
  if (!specFor(root)) return { error: `no tick specs for ${root}` };
  if (!(Number.isInteger(stopTicks) && stopTicks > 0)) return { error: 'a combine entry needs stopLossBracket.ticks (the gate sizes the trade from its stop)' };
  const z = { ...combine.DEFAULT_SIZING, ...(strategy.sizing || {}) };
  const { legs, ratio, mode } = legsFor(account, root);
  const plan = combine.contractPlan({
    dollars: combine.budget(state, z), room: combine.room(state), stopTicks, legs, mode: mode || strategy.contracts || 'auto', guard: z.min_size_guard, fraction, ratio,
  });
  return plan || { root: null, size: 0, riskPerContract: 0 };
}

/** The latest verdict for a strategy on a contract root, or null. */
function latestVerdict(home, strategy, root) {
  // Any contract of the family: a verdict for MNQ data may say to trade NQ.
  const micro = r => (familyOf(r) ? familyOf(r).micro : r);
  const all = readVerdicts(home).filter(v => v.strategy === strategy && micro(v.contract || contractRoot(v.contractId || v.symbol)) === micro(root));
  return all.length ? all[all.length - 1] : null;
}

/**
 * The prop-challenge checks for a new entry by a strategy that trades an
 * account (and maybe a policy): [{ check, message }]. Hard checks: they fail
 * closed on missing or stale state and can't be skipped.
 *   combine: an attempt is running, the snapshot is fresh, the account allows
 *            entries, and the size is within the budget for the order's stop;
 *   policy:  a fresh verdict from the strategy's policy for this contract and
 *            side said half or full, and the size is within it.
 */
function propViolations(home, { strategy, account, input = {}, now = new Date(), entries = [] }) {
  const out = [];
  const root = contractRoot(input.contractId);
  const size = Number(input.size);
  if (!account || !account.valid) {
    out.push({ check: 'combine', message: `setup:${strategy.name} trades account "${strategy.account}", which is ${account ? `invalid (${account.errors[0]})` : 'not found'} (accounts/<name>/ACCOUNT.md).` });
    return out;
  }
  const ticks = input.stopLossBracket ? Number(input.stopLossBracket.ticks) : NaN;
  // The verdict says full or half; the budget is checked at that size (a half can fall from minis to micros).
  const verdictNow = strategy.signal === 'policy' ? latestVerdict(home, strategy.name, root) : null;
  const fraction = verdictNow && verdictNow.action === 'half' ? 0.5 : 1;
  const block = combineBlock(home, account.name, now);
  if (block) out.push({ check: 'combine', message: `${account.name}: ${block}.` });
  else {
    const b = budgetPlan(home, account, strategy, root, ticks, fraction);
    if (b.error) out.push({ check: 'combine', message: `${account.name}: ${b.error}.` });
    else if (b.root !== root || !(size >= 1 && size <= b.size)) {
      const allowed = b.root ? `${b.size} ${b.root} at $${b.riskPerContract.toFixed(2)} risk each` : 'nothing';
      out.push({ check: 'combine', message: `${account.name}: ${input.size} ${root} is not within the account's ${fraction < 1 ? 'half-size ' : ''}size budget for a ${ticks}-tick stop (${allowed}; contracts: ${strategy.contracts || 'auto'}).` });
    }
  }
  // Every entry of a policy strategy follows a fresh verdict the runner
  // recorded at its setup: the trained policy's, or (no bundle) the sizing's.
  if (strategy.signal === 'policy') {
    const v = verdictNow;
    const side = String(input.side || '').toLowerCase();
    const dir = side === 'buy' ? 'long' : side === 'sell' ? 'short' : null;
    const bundle = strategy.policy ? strategy.policy.bundle : null;
    let why = null;
    if (!v) why = `no verdict for ${root} (the runner records one at each setup of ${(strategy.strategies || []).join(', ')})`;
    else if ((v.policy || null) !== bundle) why = `the latest verdict came from ${v.policy || 'the sizing alone'}, not ${bundle || 'the sizing alone'}`;
    else if (!(Date.parse(v.expiresAt) > now.getTime())) why = `the latest verdict (${v.bar}) expired at ${v.expiresAt}`;
    else if (v.action === 'skip' || !(v.maxSize >= 1)) why = `the setup was skipped${v.reason ? ` (${v.reason})` : ''}`;
    else if (dir !== v.direction) why = `the verdict is for a ${v.direction} entry, not ${side || 'this side'}`;
    else if (v.contract !== root) why = `the verdict trades ${v.contract}, not ${root}`;
    else if (!(size >= 1 && size <= v.maxSize)) why = `size ${input.size} is over the verdict's ${v.maxSize} ${v.contract} (${v.action})`;
    else if (ticks !== v.stopTicks) why = `the stop is ${ticks} ticks; the verdict was sized for ${v.stopTicks}`;
    else {
      // A verdict permits one entry, as in training: a re-entry after a stop-out would be sized
      // from a snapshot that doesn't have the loss yet. The next setup brings a new verdict.
      const tag = new RegExp(`^\\s*setup:${strategy.name}(?![\\w-])`, 'i');
      const fam = r => (familyOf(r) ? familyOf(r).micro : r);
      const used = entries.some(e => e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true
        && tag.test(String(e.text || '')) && entryTime(e) >= Date.parse(v.at)
        && (!e.contractId || fam(contractRoot(e.contractId)) === fam(root)));
      if (!Number.isFinite(Date.parse(v.at))) why = 'the verdict has no time; wait for the next setup';
      else if (used) why = `the verdict of ${v.at} was already used for an entry; wait for the next setup`;
    }
    if (why) out.push({ check: 'policy', message: `setup:${strategy.name}: ${why}.` });
  }
  return out;
}

function appendVerdict(home, verdict) {
  const file = verdictsFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch (_err) {
    // first verdict
  }
  lines.push(JSON.stringify(verdict));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.slice(-VERDICT_KEEP).join('\n')}\n`);
  fs.renameSync(tmp, file);
}

function readVerdicts(home) {
  try {
    return fs.readFileSync(verdictsFile(home), 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_err) { return null; }
    }).filter(Boolean);
  } catch (_err) {
    return [];
  }
}

module.exports = {
  SNAPSHOT_MAX_AGE_MS, combineFile, verdictsFile, readAttempt, startAttempt, endAttempt, runningAttempts, stateFrom, snapshot, recordEndOfDay, combineBlock, feeOf,
  legOf, legsFor, budgetPlan, latestVerdict, propViolations, appendVerdict, readVerdicts,
};
