'use strict';

/**
 * Prop-challenge state on disk, kept by the runner (which can read the
 * account) and enforced by the order gate (which reads only local state):
 *
 *   <FTH_HOME>/combine/<account>.json   the attempt: start, end-of-day
 *                                       balances, and the latest snapshot
 *   <FTH_HOME>/policy-verdicts.jsonl    one line per policy strategy's verdict at a setup
 *
 * Where a verdict stage is in force (verdict-stage.js: phase 2 started at the head trader's compose), appendVerdict
 * writes to the stage and readVerdicts reads the real file and the stage; promoteVerdicts moves a stage's verdicts to
 * the real file at once (one atomic rename), once the entry adopts the run.
 *
 * Light on purpose: the order-gate hook loads it on every order.
 */

const fs = require('fs');
const path = require('path');
const combine = require('./combine');
const { contractRoot, mayBeRoot, entryTime } = require('./journal');
const { specFor, familyOf, selectedLeg } = require('./contracts');
const { feePerSide } = require('./accounts');
const { whyNoSpec } = require('./broker-specs');
const { tradingDayKey, tradingDayStart } = require('./clock');
const { sameBar, barMs, lastRecordedBar } = require('./signal-state');
const { componentRefusal, componentsNote } = require('./strategies');

const ACC = require('../tunables').runner().account; // config/runner.json, tighten-only but verdictsKept
const SNAPSHOT_MAX_AGE_MS = ACC.snapshotMaxAgeMs; // the gate refuses entries on an older snapshot
const BALANCE_TOLERANCE = ACC.balanceToleranceUsd; // dollars: the broker's balance against the anchor plus the fills' net
const SNAPSHOT_FUTURE_TOLERANCE_MS = ACC.snapshotFutureToleranceMs; // ... and on one further in the future (clock skew)
const VERDICT_KEEP = ACC.verdictsKept;
/** A verdict is `full` or `skip` (docs/LEARNED-RULEBOOK.md, R4); only a full one allows an entry. Any other action refuses. */
const ENTRY_ACTIONS = Object.freeze(['full']);

/**
 * A verdict's size multiplier (the rulebook's enforced items, prop/verdict.js): the share of the size
 * budget a full verdict allows. Above 0 and at most 1, or null: missing, not a number, 0 (the rulebook
 * skipped the setup) or above 1 (nothing raises the size). Null refuses the entry (fails closed).
 */
function verdictMultiplier(v) {
  const m = v ? v.multiplier : undefined;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 && m <= 1 ? m : null;
}

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
/** The days whose close was never recorded (records from before the list kept one). */
const missedOf = record => [...new Set([...(record.missedCloses || []), ...(record.missedClose ? [record.missedClose] : [])])]
  .filter(d => !record.days.some(x => x.day === d)).sort();

function startAttempt(home, account, now = new Date(), { historyFrom = null } = {}) {
  // historyFrom: a combine replay's fresh attempt (prop/attempt-scope.js): its prompt history starts here.
  const r = { account: account.name, startedAt: now.toISOString(), startDay: tradingDayKey(now), days: [], snapshot: null, missedClose: null, ...(historyFrom ? { historyFrom: new Date(historyFrom).toISOString() } : {}) };
  writeJson(combineFile(home, account.name), r);
  return r;
}

const DAY_MS = 86400000;
const r2 = x => Math.round(x * 100) / 100;

/**
 * Start an attempt part way through, from an account state (a practice run's drawn state, prop/account-states.js): the
 * attempt's closed days on the exchange sessions before `day` (their closing balances from the starting balance and
 * each day's P&L), its peak, and the counts carried into `day` from before its anchor (`carried`: today's trades,
 * losing trades and losing streak; the last loss at `at` when the streak holds one). The broker's balance must be
 * `state.balance` (the last close plus today's P&L): the runner's first snapshot reads today's P&L from it, as live.
 * The record is what a live attempt started that many sessions ago would hold; nothing in it says it was drawn.
 *   state: { days (each closed day's P&L), peak, dayPnl, balance, tradesToday, lossesToday, lossStreak }
 * Returns { record, balance }; throws on a state whose balance isn't its days plus today's P&L.
 */
function seedAttempt(home, account, { day, at, state }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day)) || !Number.isFinite(Date.parse(at))) throw new Error('seedAttempt: a trading day (YYYY-MM-DD) and a time');
  const s = state || {};
  if (!Array.isArray(s.days) || !s.days.every(Number.isFinite) || ![s.balance, s.peak, s.dayPnl].every(Number.isFinite)) throw new Error('seedAttempt: a state with days, balance, peak and dayPnl');
  // Lazily: the calendar is the driver's, never the gate's.
  const { hasSession } = require('../prop/splits');
  const dates = [];
  for (let t = Date.parse(`${day}T00:00:00Z`) - DAY_MS; dates.length < s.days.length; t -= DAY_MS) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (hasSession(d)) dates.unshift(d);
  }
  let bal = account.starting_balance;
  const days = s.days.map((pnl, k) => { bal = r2(bal + pnl); return { day: dates[k], balance: bal, pnl: r2(pnl) }; });
  if (Math.abs(r2(bal + s.dayPnl) - s.balance) > 0.011) throw new Error(`seedAttempt: the state's balance $${s.balance} is not its last close $${bal} plus today's $${s.dayPnl}`);
  const startDay = dates[0] || day;
  const count = x => (Number.isInteger(x) && x >= 0 ? x : 0);
  const streak = count(s.lossStreak);
  const lastLossAt = streak > 0 && count(s.lossesToday) > 0 ? new Date(at).toISOString() : null;
  const record = {
    account: account.name, startedAt: tradingDayStart(new Date(`${startDay}T12:00:00Z`)).toISOString(), startDay, days,
    peak: r2(Math.max(account.starting_balance, s.peak, s.balance, ...days.map(d => d.balance))), snapshot: null, missedClose: null, missedCloses: [], anchor: null,
    lossStreak: { day, count: streak, at: lastLossAt },
    carried: { day, at: new Date(at).toISOString(), trades: count(s.tradesToday), losses: count(s.lossesToday), streak, lastLossAt },
  };
  writeJson(combineFile(home, account.name), record);
  return { record, balance: r2(s.balance) };
}

/**
 * The losing trades and streak carried into today by the running attempts (carriedOf), for the order gate's daily
 * loss count and loss cooldown, which count the day's own closes on top of them: { losses, streak, lastLossMs } (the
 * most of any attempt), or null when none carries any. It only ever adds to what the gate counts (never fails open).
 */
function carriedLossState(home, now = new Date()) {
  const day = tradingDayKey(now);
  let out = null;
  for (const name of runningAttempts(home)) {
    const c = carriedOf(readAttempt(home, name), day);
    if (!c || (!c.losses && !c.streak)) continue;
    const ms = Date.parse(c.lastLossAt);
    const last = out ? out.lastLossMs : null;
    out = {
      losses: Math.max(out ? out.losses : 0, c.losses), streak: Math.max(out ? out.streak : 0, c.streak),
      lastLossMs: Number.isFinite(ms) ? Math.max(last === null ? -Infinity : last, ms) : last,
    };
  }
  return out;
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

/**
 * The session's closed trades from the broker's fills (search_trades), in time order: [{ gross, at }]. A fill with a
 * P&L closes; one without opens. The closing fills between two opening fills are one trade (a stop filled in parts
 * is one loss, not several), its gross the sum of their P&L before fees, as the gate counts a loss. A fill without a
 * time or a readable P&L throws (the caller keeps the last streak; the balance check refuses entries on it anyway).
 */
function tradesFromFills(fills) {
  if (!Array.isArray(fills)) throw new Error('the fills are not a list');
  const list = fills.filter(f => f && !f.voided).map(f => {
    const ms = Date.parse(f.creationTimestamp);
    if (!Number.isFinite(ms)) throw new Error(`a fill without a time (${JSON.stringify(f)})`);
    const closing = f.profitAndLoss !== null && f.profitAndLoss !== undefined;
    const pnl = closing ? Number(f.profitAndLoss) : 0;
    if (!Number.isFinite(pnl)) throw new Error(`a fill with no readable P&L (${JSON.stringify(f)})`);
    return { ms, closing, pnl };
  }).sort((a, b) => a.ms - b.ms);
  const trades = [];
  let cur = null;
  for (const f of list) {
    if (!f.closing) { cur = null; continue; }
    if (!cur) { cur = { gross: 0, at: null }; trades.push(cur); }
    cur.gross = Math.round((cur.gross + f.pnl) * 100) / 100;
    cur.at = new Date(f.ms).toISOString();
  }
  return trades;
}

/**
 * The loss streak after these closed trades (combine.streakAfter: a loss extends it, a win ends it, a scratch neither),
 * from `start` (the streak carried into the day's anchor, carriedOf; 0 without one).
 */
const streakOf = (trades, start = 0) => trades.reduce((n, t) => combine.streakAfter(n, t.gross), start);

/**
 * The counts carried into trading day `day` from before its anchor (the attempt record's `carried`, written when an
 * attempt is started from a state part way through a day: seedAttempt): { day, at, trades, losses, streak, lastLossAt },
 * or null (none, or another day's). The day's fills since the anchor add to them.
 */
function carriedOf(record, day) {
  const c = record && record.carried;
  if (!c || c.day !== day) return null;
  const n = x => (Number.isInteger(x) && x >= 0 ? x : 0);
  return { day: c.day, at: c.at || null, trades: n(c.trades), losses: n(c.losses), streak: n(c.streak), lastLossAt: c.lastLossAt || null };
}

/** The record's loss streak for its snapshot's session (0 when it has none for that day). */
const recordStreak = record => (record && record.lossStreak && record.snapshot && record.lossStreak.day === record.snapshot.day
  && Number.isInteger(record.lossStreak.count) ? record.lossStreak.count : 0);

/**
 * The session's loss streak as the runner last recorded it (from the broker's closing fills): { count, stop, day, at }
 * (`stop`: the account's loss_streak_stop, 0 when off), or null with no attempt or no snapshot today. For the attempt
 * line and the gate's facts; the gate itself refuses on the snapshot's block (combine.entryBlock).
 */
function sessionLossStreak(home, account, now = new Date()) {
  const r = readAttempt(home, account.name);
  if (!r || !r.snapshot || r.snapshot.day !== tradingDayKey(now)) return null;
  return { count: recordStreak(r), stop: account.loss_streak_stop || 0, day: r.snapshot.day, at: (r.lossStreak && r.lossStreak.at) || null };
}

/**
 * The combine state from the attempt record and the balance now (live, or the last snapshot). `streak`: the
 * session's loss streak, by default the record's for its snapshot's day (recordStreak).
 */
function stateFrom(account, record, balance, streak = recordStreak(record)) {
  let cs = combine.start(account);
  for (const d of record.days) {
    cs = combine.endDay({ ...cs, balance: d.balance, dayPnl: d.pnl });
    // `sessions` bounds training and evaluation attempts, not the firm's: a
    // live attempt runs on (with its trailing floor) until it passes or blows.
    if (cs.status === 'timeout') cs = { ...cs, status: 'active' };
    if (cs.status !== 'active') return cs;
  }
  const lastEod = record.days.length ? record.days[record.days.length - 1].balance : account.starting_balance;
  const b = Number.isFinite(balance) ? balance : cs.balance;
  // The peak balance: every close and snapshot so far (closed trades only: the snapshot is the realized balance).
  const peak = Math.max(cs.start, record.peak || 0, ...record.days.map(d => d.balance), b);
  cs = { ...cs, balance: b, peak, dayPnl: Math.round((b - lastEod) * 100) / 100, lossStreak: streak };
  if (b <= cs.floor) cs = { ...cs, status: 'blown' };
  if (cs.dailyLimit > 0 && cs.dayPnl <= -cs.dailyLimit) cs.dayStopped = true;
  return cs;
}

/**
 * The balance the broker should show: the day's anchor (the balance at the
 * attempt's first snapshot that trading day) plus every fill's realized P&L
 * less its fees since then (`fills`: the broker's search_trades, at or after
 * the anchor's time; voided ones don't count). Throws on a fill it can't read.
 * Returns { expected, balance, diff, since }.
 */
function balanceCheck(anchor, balance, fills) {
  if (!anchor || !Number.isFinite(anchor.balance) || !Number.isFinite(Date.parse(anchor.at))) throw new Error('no anchor balance');
  if (!Number.isFinite(balance)) throw new Error('no balance');
  if (!Array.isArray(fills)) throw new Error('the fills are not a list');
  const since = Date.parse(anchor.at);
  let net = 0;
  for (const f of fills) {
    const ts = Date.parse(f && f.creationTimestamp);
    if (!Number.isFinite(ts)) throw new Error(`a fill without a time (${JSON.stringify(f)})`);
    if (ts < since || f.voided) continue;
    const pnl = f.profitAndLoss === null || f.profitAndLoss === undefined ? 0 : Number(f.profitAndLoss);
    const fees = costOf(f);
    if (!Number.isFinite(pnl) || !Number.isFinite(fees)) throw new Error(`a fill with no readable P&L or fees (${JSON.stringify(f)})`);
    net += pnl - fees;
  }
  const expected = Math.round((anchor.balance + net) * 100) / 100;
  return { expected, balance, diff: Math.round((balance - expected) * 100) / 100, since: anchor.at };
}

/** A balance check that passed (not missing, not an error, within the tolerance). */
const reconciled = c => Boolean(c && !c.error && Number.isFinite(c.diff) && Math.abs(c.diff) <= BALANCE_TOLERANCE);

/**
 * The day's trade counts for the attempt line (combine.attemptFacts): trades closed today and losing ones (the losing
 * streak is the session's, sessionLossStreak: one source). From the fills this snapshot read (since the day's anchor,
 * the first flat snapshot); else the day's last counts, only when nothing moved since them (`unchanged`); else, on the
 * day's first snapshot (its anchor, flat), none yet. Null when unknown (a position open, the fills unread or
 * unreadable): never stale counts shown as current. Facts only, never a block.
 */
function dayCounts(record, day, fills, fresh, open, unchanged = false) {
  const prev = record.snapshot && record.snapshot.counts && record.snapshot.counts.day === day ? record.snapshot.counts : null;
  // The counts carried into the day from before its anchor (carriedOf): the fills since the anchor add to them.
  const c = carriedOf(record, day) || { trades: 0, losses: 0 };
  let today = null;
  if (Array.isArray(fills)) {
    // Lazily: the account gate reads this module's state, so it can't be loaded with it.
    const { closingFills, fillLossState } = require('./account-gate');
    today = { trades: c.trades + closingFills(fills).length, losses: c.losses + fillLossState(fills).losses };
  } else if (prev && unchanged) today = prev;
  else if (fresh && open === 0) today = { trades: c.trades, losses: c.losses };
  if (!today) return null;
  return { day, trades: today.trades, losses: today.losses };
}

/**
 * Today's trades and losses for combine.attemptFacts, from the attempt's latest snapshot when it is of today; nulls
 * otherwise. The losing streak is not here: the attempt line reads sessionLossStreak, its one source.
 */
function attemptCounts(record, now = new Date()) {
  const c = record && record.snapshot && record.snapshot.counts;
  if (!c || c.day !== tradingDayKey(now)) return { tradesToday: null, lossesToday: null };
  return { tradesToday: c.trades, lossesToday: c.losses };
}

/**
 * Save the latest balance and open-position count (the gate reads them),
 * returning the state. A snapshot on a new trading day whose previous
 * snapshot's day has no recorded close marks that close as missed: the
 * trailing floor can't be known until it is recorded, so entries stop.
 *
 * The balance is checked against the broker's fills (`fills`, or the error
 * reading them in `fillsError`): the day's first snapshot anchors it, and
 * every later flat snapshot must equal the anchor plus the fills' net since
 * then (balanceCheck). A mismatch, or fills that couldn't be read, is kept
 * on the snapshot and refuses entries (combineBlock) until a snapshot
 * reconciles; with a position open the realized balance isn't checked, nor
 * anchored (a fill landing while the anchor is read would count twice).
 * `unchanged` (the runner saw nothing move since a snapshot that
 * reconciled: same balance, still flat) carries that check forward without
 * asking the broker for its fills again.
 *
 * The session's loss streak (the rulebook's loss_streak_stop) is counted from
 * the same fills, the closed trades since the day's anchor (tradesFromFills):
 * a new trading day starts at 0, and a snapshot that read no fills (a position
 * open, nothing moved, or fills that couldn't be read, which refuses entries
 * anyway) keeps the last count. One position at a time keeps it current: an
 * entry waits for the next snapshot, and a snapshot with a position open
 * refuses entries until a flat one has read the closing fills.
 */
function snapshot(home, account, balance, now = new Date(), { open = 0, openIds = [], fills, fillsError = null, unchanged = false } = {}) {
  const record = readAttempt(home, account.name);
  if (!record) return null;
  const day = tradingDayKey(now);
  const prev = record.snapshot && record.snapshot.day;
  // Every trading day whose close was never recorded, not just the first:
  // each one moves the trailing floor, so each must be recorded.
  const missed = missedOf(record);
  if (prev && prev !== day && !record.days.some(d => d.day === prev) && !missed.includes(prev)) missed.push(prev);
  missed.sort();
  const missedClose = missed[0] || null;
  const cs = stateFrom(account, record, balance);
  // The day's anchor: the first flat snapshot of the trading day, from the broker's own balance.
  const fresh = !record.anchor || record.anchor.day !== day;
  const anchor = fresh && open === 0 ? { at: now.toISOString(), day, balance } : record.anchor || null;
  const prevCheck = record.snapshot && record.snapshot.day === day ? record.snapshot.balanceCheck : null;
  let check = null;
  if (!fresh && open === 0) {
    if (fillsError) check = { error: String(fillsError) };
    else if (unchanged) {
      // Carried forward only from a check that passed on this same balance; anything else is unchecked (fails closed).
      check = reconciled(prevCheck) && record.snapshot.balance === balance ? prevCheck : { error: 'nothing checked to carry forward' };
    }
    else if (fills !== undefined) {
      try {
        check = balanceCheck(anchor, balance, fills);
      } catch (err) {
        check = { error: err.message };
      }
    }
  }
  const kept = record.lossStreak && record.lossStreak.day === day ? record.lossStreak : { day, count: 0, at: null };
  let lossStreak = kept;
  if (!fresh && open === 0 && !fillsError && !unchanged && fills !== undefined) {
    try {
      const trades = tradesFromFills((fills || []).filter(f => !(Date.parse(f && f.creationTimestamp) < Date.parse(anchor.at))));
      // From the streak carried into the day (an attempt started part way through it), else 0.
      const carried = carriedOf(record, day);
      lossStreak = { day, count: streakOf(trades, carried ? carried.streak : 0), at: trades.length ? trades[trades.length - 1].at : carried ? carried.lastLossAt : null };
    } catch (_err) {
      lossStreak = kept; // an unreadable fill: the balance check above refuses entries on it
    }
  }
  const state = { ...cs, lossStreak: lossStreak.count };
  const counts = dayCounts(record, day, fillsError ? undefined : fills, fresh, open, unchanged && !fillsError);
  writeJson(combineFile(home, account.name), {
    ...record, missedClose, missedCloses: missed, peak: cs.peak, anchor, lossStreak,
    snapshot: { at: now.toISOString(), day, balance, open, openIds, balanceCheck: check, summary: combine.summary(state), block: combine.entryBlock(state), state, counts },
  });
  return state;
}

/** When trading day `day` (YYYY-MM-DD, the date it ends on) ended: the next day's 18:00 ET open, in ms. */
function dayEndMs(day) {
  // 23:59 UTC on that date is after 18:00 ET (19:59 EDT / 18:59 EST): inside the next trading day.
  return tradingDayStart(new Date(`${day}T23:59:00Z`)).getTime();
}

/** A fill's costs: its fees, and its commissions where the broker reports them apart (some brokers do). */
function costOf(f) {
  const n = v => (v === null || v === undefined ? 0 : Number(v));
  return n(f.fees) + n(f.commissions);
}

/**
 * A past trading day's closing balance from the balance now and the broker's
 * fills since that day ended: the balance minus each later fill's realized
 * P&L and fees (a catch-up end of day closes positions on a later day; their
 * result is that day's, never the missed day's). Throws on a fill it can't
 * read: a wrong close moves the trailing floor.
 */
function closeBefore(balanceNow, fills, endMs) {
  if (!Number.isFinite(balanceNow)) throw new Error('no balance');
  if (!Array.isArray(fills)) throw new Error('the fills are not a list');
  let later = 0;
  for (const f of fills) {
    const ts = Date.parse(f && f.creationTimestamp);
    if (!Number.isFinite(ts)) throw new Error(`a fill without a time (${JSON.stringify(f)})`);
    if (ts < endMs || f.voided) continue;
    const pnl = f.profitAndLoss === null || f.profitAndLoss === undefined ? 0 : Number(f.profitAndLoss);
    const fees = costOf(f);
    if (!Number.isFinite(pnl) || !Number.isFinite(fees)) throw new Error(`a fill with no readable P&L or fees (${JSON.stringify(f)})`);
    later += pnl - fees;
  }
  return Math.round((balanceNow - later) * 100) / 100;
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
  const missed = missedOf(record).filter(d => d !== dayKey);
  const next = { ...record, missedClose: missed[0] || null, missedCloses: missed, days };
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
  if (!r) return `no ${accountName} attempt is started (starting one is the user's: node scripts/combine.js start --account ${accountName})`;
  if (r.missedClose) {
    const missed = missedOf(r);
    const day = missed[0] || r.missedClose;
    const more = missed.length > 1 ? ` (also ${missed.slice(1).join(', ')}: the user records each)` : '';
    const record = `the user records it: node scripts/combine.js record-day --account ${accountName} --day ${day} --balance <dollars>`;
    return `the close of ${day} was never recorded, so the trailing floor is unknown; the account's closing balance that day is needed (${record})${more}`;
  }
  const s = r.snapshot;
  const age = now.getTime() - Date.parse(s && s.at);
  // A snapshot from the future (a clock stepped back) can't be trusted to hold the latest entries.
  if (!s || !(age <= SNAPSHOT_MAX_AGE_MS) || age < -SNAPSHOT_FUTURE_TOLERANCE_MS) return `the ${accountName} account snapshot is missing or older than ${SNAPSHOT_MAX_AGE_MS / 60000} minutes, or dated in the future (the runner updates it each bar)`;
  if (s.open > 0) {
    const ids = Array.isArray(s.openIds) && s.openIds.length ? ` (${s.openIds.join(', ')})` : '';
    return `a position is open on the account${ids}; a prop attempt trades one position at a time (as the backtester does): close it to trade the attempt`;
  }
  if (s.block && /^the attempt is over|^the challenge is passed/.test(s.block)) {
    return `${s.block}; stand aside: ending it and starting a new one (node scripts/combine.js stop --account ${accountName}) is the user's decision, never an agent's`;
  }
  const bc = s.balanceCheck;
  if (bc && bc.error) return `the account balance couldn't be checked against the broker's fills (${bc.error}); entries wait for a snapshot that can (exits still go)`;
  if (bc && Math.abs(bc.diff) > BALANCE_TOLERANCE) {
    return `the account balance doesn't reconcile: the broker reports $${bc.balance}, but the day's opening balance plus every fill since ${bc.since} (P&L less fees) gives $${bc.expected} (off by $${bc.diff}); entries wait until a snapshot reconciles, or the next trading day's first flat snapshot starts from the broker's balance again (exits still go)`;
  }
  return s.block || null;
}

/** The oldest snapshot time (ms) of the running attempts `names`: NaN when one has none (the gate then refuses). */
function oldestSnapshotMs(home, names) {
  const ats = (names || []).map(n => { const r = readAttempt(home, n); return Date.parse(r && r.snapshot && r.snapshot.at); });
  return ats.length && ats.every(Number.isFinite) ? Math.min(...ats) : NaN;
}

const RISK_REDUCING = /^\s*\[(exit|protect)\]/i;

/**
 * Why an entry must wait for the next snapshot, or null: an entry order went
 * through at or after the snapshot was taken, so its `open` count (and the
 * cushion every size is worked out from) doesn't hold that trade yet. With
 * several markets, two setups on one bar would otherwise each be sized from
 * the whole cushion. One position at a time across the account, as trained.
 */
function entrySinceSnapshot(home, accountName, entries = []) {
  const r = readAttempt(home, accountName);
  const at = Date.parse(r && r.snapshot && r.snapshot.at);
  if (!Number.isFinite(at)) return null; // combineBlock refuses a missing snapshot
  const since = (entries || []).filter(e => e && e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true
    && !RISK_REDUCING.test(String(e.text || '')) && !(entryTime(e) < at));
  if (!since.length) return null;
  const ids = [...new Set(since.map(e => e.contractId).filter(Boolean))];
  const unreadable = since.some(e => !Number.isFinite(entryTime(e)));
  return `an entry${ids.length ? ` (${ids.join(', ')})` : ''} went in at or after the account snapshot of ${r.snapshot.at}, which doesn't hold it yet; `
    + (unreadable ? 'its journal entry has an unreadable time (ts), so it is counted as since the snapshot until it leaves the journal window; tell the user'
      : 'a prop attempt trades one position at a time: wait for the next bar\'s snapshot');
}

/**
 * Did the harness send an order (any: entry, exit or stop) that went through at or after `sinceIso`? From the
 * journal's `order_placed` records. A record with an unreadable time counts (fails closed). A round trip
 * between two flat snapshots can leave the balance unchanged when the broker hasn't booked it: this is what
 * tells the runner to read the fills anyway. Not seen: an order placed outside the harness (by hand) that
 * leaves the balance exactly unchanged; any balance change is read.
 */
function orderSince(entries, sinceIso) {
  const at = Date.parse(sinceIso);
  if (!Number.isFinite(at)) return true;
  return (entries || []).some(e => e && e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true
    && !(entryTime(e) < at));
}

// A fee is the account's only (ACCOUNT.md fees_per_side): none is null, and a leg without one sizes nothing.
const feeOf = (account, root) => feePerSide(account, root);

/*
 * `specOf` (root -> { tickSize, tickValue } or null) is where tick specs come
 * from: the static table (contracts.js specFor) offline, the broker's recorded
 * specs (broker-specs.js) live. The gate and order_plan pass the broker's.
 */

/** A contract the account can trade: tick value, the account's fee (null when its profile states none), and its limit. */
function legOf(account, root, specOf = specFor) {
  const spec = specOf(root);
  return spec ? { root, tickValue: spec.tickValue, fee: feeOf(account, root), max: (account.max_contracts && account.max_contracts[root]) || 0 } : null;
}

/**
 * The micro and mini legs of a root's family (or the root alone), and the mini:micro ratio (from the specs' tick values).
 * `selected` (the selected contracts: the runner's symbols, or FTH_SYMBOLS): a selected leg of the family is the
 * only one sized (mode micro or mini), as every strategy trades the selected contract; none selected, the
 * strategy's `contracts` decides.
 */
function legsFor(account, root, specOf = specFor, selected = null) {
  const fam = familyOf(root);
  if (!fam) return { legs: { micro: legOf(account, root, specOf), mini: null }, ratio: 10, mode: 'micro' };
  const legs = { micro: legOf(account, fam.micro, specOf), mini: legOf(account, fam.mini, specOf) };
  const ratio = legs.micro && legs.mini ? Math.round(legs.mini.tickValue / legs.micro.tickValue) : fam.ratio;
  const pick = selectedLeg(root, selected);
  return { legs, ratio: ratio >= 1 ? ratio : fam.ratio, ...(pick ? { mode: pick === fam.micro ? 'micro' : 'mini' } : {}) };
}

/**
 * The contract and size the account's budget allows for a policy strategy's
 * entry with a `stopTicks` stop, from the latest snapshot (combine.contractPlan,
 * as the backtester sizes it), or { error }. `fraction` scales the budget
 * (a verdict's multiplier: verdictMultiplier).
 */
function budgetPlan(home, account, strategy, root, stopTicks, fraction = 1, specOf = specFor, selected = null) {
  const r = readAttempt(home, account.name);
  const state = r && r.snapshot && r.snapshot.state;
  if (!state) return { error: `no ${account.name} snapshot to size from` };
  // The budget and room worked out only after every check below passes (as before: a check's error, never a throw).
  return sizeWithin(z => ({ dollars: combine.budget(state, z), room: combine.room(state) }), account, strategy, root, stopTicks, fraction, specOf, selected);
}

/**
 * budgetPlan's sizing for a budget already known: { dollars } the attempt's size budget for the strategy
 * (combine.budget) and { room } its dollars to the floor or the daily limit (combine.room), e.g. as an attempt line
 * recorded them at a past cycle (the training loop's trend facts, train/trend-facts.js), or a function of the sizing
 * giving them, called once the checks pass. The same checks, in the same order, and plan.
 */
function sizeWithin(budget, account, strategy, root, stopTicks, fraction = 1, specOf = specFor, selected = null) {
  // Every contract the budget may pick (the micro and the mini of a family) needs its specs.
  const fam = familyOf(root);
  const missing = [fam ? fam.micro : root, ...(fam ? [fam.mini] : [])].find(x => !specOf(x));
  if (missing) return { error: specOf === specFor ? `no tick specs for ${missing}` : whyNoSpec(specOf, missing) };
  // One stop in ticks sizes both legs: the family's contracts must agree on the tick size.
  if (fam && Math.abs(specOf(fam.micro).tickSize - specOf(fam.mini).tickSize) > 1e-12) {
    return { error: `${fam.micro} and ${fam.mini} have different tick sizes (${specOf(fam.micro).tickSize}, ${specOf(fam.mini).tickSize}): no size can be worked out` };
  }
  const noFee = [fam ? fam.micro : root, ...(fam ? [fam.mini] : [])].find(x => account.max_contracts && account.max_contracts[x] > 0 && feeOf(account, x) === null);
  if (noFee) return { error: `no fees_per_side.${noFee} in the ${account.name} profile (ACCOUNT.md): a fee is never assumed, so no size` };
  if (!(Number.isInteger(stopTicks) && stopTicks > 0)) return { error: 'a combine entry needs stopLossBracket.ticks (the gate sizes the trade from its stop)' };
  const z = strategy.sizing || {}; // the rulebook's, every key (combine.sizingErrors): an incomplete one sizes nothing
  const bad = combine.sizingErrors(z);
  if (bad.length) return { error: `${strategy.name} has no whole sizing from its account's rulebook (${bad.join('; ')}): no size` };
  const { legs, ratio, mode } = legsFor(account, root, specOf, selected);
  const { dollars, room } = typeof budget === 'function' ? budget(z) : budget;
  const args = {
    dollars, room, stopTicks, legs, mode: mode || strategy.contracts || 'auto', guard: z.min_size_guard, fraction, ratio, slipTicks: z.stop_slippage_ticks, minContracts: z.min_contracts,
  };
  const plan = combine.contractPlan(args);
  // None fits: `floor` says so when the rulebook's min_contracts alone sized it out.
  return plan || { root: null, size: 0, riskPerContract: 0, floor: combine.floorReason(args) };
}

/** The latest verdict for a strategy on a contract root, or null. */
function latestVerdict(home, strategy, root) {
  // Any contract of the family: a verdict for MNQ data may say to trade NQ.
  const micro = r => (familyOf(r) ? familyOf(r).micro : r);
  const all = readVerdicts(home).filter(v => v.strategy === strategy && micro(v.contract || contractRoot(v.contractId || v.symbol)) === micro(root));
  return all.length ? all[all.length - 1] : null;
}

/**
 * Why a verdict is not for the bar the setup is on now, or null. The verdict's
 * stop ticks, size and side were worked out on its own bar: an entry is judged
 * against it only while that bar is still the last one recorded for the
 * strategy's timeframe (signal-state.js lastRecordedBar), never against the
 * next bar's setup when the runner recorded no verdict for it. Fails closed:
 * no record, an unreadable one, or a verdict with no bar refuses.
 */
function verdictBarProblem(home, strategy, root, v) {
  const cur = lastRecordedBar(home, root, strategy.timeframe);
  if (cur.error) return `${cur.error}; the verdict can't be tied to it`;
  const tf = cur.timeframe;
  if (!Number.isFinite(barMs(v.bar))) {
    return `the latest verdict (${v.action}${v.reason ? `: ${v.reason}` : ''}, ${v.at}) names no bar, so it can't be tied to the setup on the ${tf} bar opened ${cur.bar}; wait for the next setup's verdict`;
  }
  if (sameBar(v.bar, cur.bar)) return null;
  if (barMs(v.bar) < barMs(cur.bar)) {
    return `the latest verdict is for the ${tf} bar opened ${v.bar}; the setup on the bar opened ${cur.bar} has no verdict yet (an older bar's stop and size are never used for it): wait for the next setup's verdict`;
  }
  return `the latest verdict is for the ${tf} bar opened ${v.bar}, after the last recorded ${tf} bar (opened ${cur.bar}): the signal record is behind the verdict (the runner records both every bar); wait for the next bar`;
}

/** What one `root` contract counts toward the floor (micro-equivalents): a mini its family's ratio, else 1. */
function floorRatio(account, root, specOf = specFor) {
  const fam = familyOf(root);
  // No account (missing or invalid): the family's own ratio, never a throw (the account check refuses it on its own).
  return fam && root === fam.mini ? (account ? legsFor(account, root, specOf).ratio : fam.ratio) : 1;
}

/**
 * The floor in the order's own contracts: ceil(sizing.min_contracts / what one counts), e.g. 3 micro-equivalents is
 * 1 mini at a ratio of 10. null without a whole floor of 1 or more (minContractsRefusal refuses then).
 */
function minContractsIn(strategy, account, root, specOf = specFor) {
  const min = strategy && strategy.sizing ? strategy.sizing.min_contracts : undefined;
  if (!(Number.isInteger(min) && min >= 1)) return null;
  return Math.ceil(min / floorRatio(account, root, specOf));
}

/**
 * Why an entry of `size` on `root` is under the floor of a strategy that trades an account (its rulebook's
 * sizing.min_contracts), or null. Counted in micro-equivalents, as combine.contractPlan sizes: a mini is its family's
 * ratio of micros, a contract with no family one. Fails closed: a sizing without a whole floor of 1 or more refuses.
 */
function minContractsRefusal(strategy, account, root, size, specOf = specFor) {
  const min = strategy && strategy.sizing ? strategy.sizing.min_contracts : undefined;
  if (!(Number.isInteger(min) && min >= 1)) {
    return `setup:${strategy && strategy.name}: its account's rulebook states no sizing.min_contracts (${JSON.stringify(min)}), so no floor can be checked: no entry (fails closed). Exits and protective stops still go.`;
  }
  const ratio = floorRatio(account, root, specOf);
  const n = Number(size);
  if (size !== null && size !== undefined && Number.isInteger(n) && n >= 1 && n * ratio >= min) return null;
  if (size === null || size === undefined || size === '') {
    return `setup:${strategy.name}: no size stated on ${root}; the floor is ${min} contracts (its account's rulebook, sizing.min_contracts): state ${min} or more within the size budget, or no trade.`;
  }
  return `setup:${strategy.name}: size ${size} ${root} is under the floor of ${min} contracts${ratio > 1 ? ` (a ${root} counts as ${ratio})` : ''} (its account's rulebook, sizing.min_contracts): trade ${min} or more within the size budget, or no trade; never a tighter stop. Exits, protective stops, stop moves, cancels and closes still go.`;
}

/**
 * The prop-challenge checks for a new entry by a strategy that trades an
 * account: [{ check, message }]. Hard checks: they fail closed on missing or
 * stale state and can't be skipped.
 *   combine: an attempt is running, the snapshot is fresh, the account allows
 *            entries, and the size is within the budget for the order's stop;
 *   min-contracts: the size is at least the rulebook's floor (minContractsRefusal);
 *   policy:  a fresh verdict for this policy strategy, contract and side,
 *            recorded on the bar the setup is on now (the last bar of the
 *            signal record), whose action allows an entry (ENTRY_ACTIONS: full;
 *            skip or anything else refuses) with a valid multiplier
 *            (verdictMultiplier: above 0, at most 1; the budget is checked at
 *            it), and the size is within it;
 *            the setup it traded is from one of the policy's active strategies
 *            (strategies.js componentRefusal against `strategies`, the
 *            registry: none refuses). `paper` (order_plan in a paper run
 *            only; the gate never sets it) also takes a paper one.
 */
function propViolations(home, { strategy, account, input = {}, now = new Date(), entries = [], journal = entries, specOf = specFor, selected = null, strategies = null, paper = false }) {
  const out = [];
  const root = contractRoot(input.contractId);
  const size = Number(input.size);
  // An invalid strategy (e.g. a policy its account's rulebook refuses) is never sized, hard: the skippable
  // [strategy] check isn't the only refusal, and its sizing would otherwise fall back to the code's defaults.
  if (strategy.valid === false) {
    const why = (strategy.errors && strategy.errors[0]) || 'invalid';
    out.push({ check: strategy.signal === 'policy' ? 'policy' : 'combine', message: `setup:${strategy.name} is invalid (${why}); no entry is sized from it until it is fixed (exits and protective stops still go).` });
    return out;
  }
  if (!account || !account.valid) {
    out.push({ check: 'combine', message: `setup:${strategy.name} trades account "${strategy.account}", which is ${account ? `invalid (${account.errors[0]})` : 'not found'} (accounts/<name>/ACCOUNT.md).` });
    return out;
  }
  const ticks = input.stopLossBracket ? Number(input.stopLossBracket.ticks) : NaN;
  // The budget is checked at the verdict's multiplier (a share can fall from minis to micros); a verdict
  // that allows no entry, or carries no valid multiplier, is refused below, never sized as full.
  const verdictNow = strategy.signal === 'policy' ? latestVerdict(home, strategy.name, root) : null;
  const vm = verdictNow && ENTRY_ACTIONS.includes(verdictNow.action) ? verdictMultiplier(verdictNow) : null;
  const fraction = vm === null ? 1 : vm;
  // `journal`: every entry, unfiltered, so one with an unreadable time still counts as since the snapshot.
  const block = combineBlock(home, account.name, now) || entrySinceSnapshot(home, account.name, journal);
  if (block) out.push({ check: 'combine', message: `${account.name}: ${block}.` });
  else {
    // A composed entry's verdict (on a compose record) is sized in its own contract, as the runner sizes it (selected
    // [root]) and the size translation reads it (prop/size-translate.js translateSize): with none selected, never a mini
    // the entry doesn't trade (the owner, 2026-10-30: the size is the most the $300 cap fits).
    const legs = selected || (verdictNow && verdictNow.record && verdictNow.contract === root ? [root] : null);
    const b = budgetPlan(home, account, strategy, root, ticks, fraction, specOf, legs);
    if (b.error) out.push({ check: 'combine', message: `${account.name}: ${b.error}.` });
    else if (b.root !== root || !(size >= 1 && size <= b.size)) {
      const allowed = b.root ? `${b.size} ${b.root} at $${b.riskPerContract.toFixed(2)} risk each` : `nothing${b.floor ? `: ${b.floor}` : ''}`;
      out.push({ check: 'combine', message: `${account.name}: ${input.size} ${root} is not within the account's ${fraction < 1 ? `${fraction}x ` : ''}size budget for a ${ticks}-tick stop (${allowed}; contracts: ${strategy.contracts || 'auto'}).` });
    }
  }
  // The floor (the rulebook's min_contracts), whatever the budget or the verdict say: an entry below it is no trade.
  const floorMsg = minContractsRefusal(strategy, account, root, input.size, specOf);
  if (floorMsg) out.push({ check: 'min-contracts', message: floorMsg });
  // Every entry of a policy strategy follows a fresh verdict the runner
  // recorded at its setup (prop/verdict.js).
  if (strategy.signal === 'policy') {
    const v = verdictNow;
    const side = String(input.side || '').toLowerCase();
    const dir = side === 'buy' ? 'long' : side === 'sell' ? 'short' : null;
    let why = null;
    let barWhy; // the verdict must be for the bar the setup is on now
    let compWhy; // a paper strategy stays paper inside a policy: the setup is from an active one
    if (!v) why = `no verdict for ${root} (${componentsNote(strategy)})`;
    else if ((compWhy = componentRefusal(strategy, strategies, v.component, { paper }))) why = `the latest verdict's setup is from ${v.component || 'no named strategy'}: ${compWhy}; no live entry from it`;
    else if (!(Date.parse(v.expiresAt) > now.getTime())) why = `the latest verdict (${v.bar}) expired at ${v.expiresAt}`;
    else if ((barWhy = verdictBarProblem(home, strategy, root, v))) why = barWhy;
    else if (v.action === 'skip' || !(v.maxSize >= 1)) why = `the setup was skipped${v.reason ? ` (${v.reason})` : ''}`;
    else if (!ENTRY_ACTIONS.includes(v.action)) why = `the verdict's action ${JSON.stringify(v.action)} allows no entry (a verdict is full or skip)`;
    else if (verdictMultiplier(v) === null) {
      why = v.multiplier === 0 ? 'the rulebook\'s enforced items skipped the setup (multiplier 0)'
        : `the verdict's size multiplier (${JSON.stringify(v.multiplier)}) is not above 0 and at most 1, so no size can be judged; wait for the next setup's verdict`;
    }
    else if (dir !== v.direction) why = `the verdict is for a ${v.direction} entry, not ${side || 'this side'}`;
    else if (v.contract !== root) why = `the verdict trades ${v.contract}, not ${root}`;
    else if (!(size >= 1 && size <= v.maxSize)) why = `size ${input.size} is over the verdict's ${v.maxSize} ${v.contract} (${v.action})`;
    else if (ticks !== v.stopTicks) why = `the stop is ${ticks} ticks; the verdict was sized for ${v.stopTicks}`;
    else {
      // A verdict permits one entry, as in training: a re-entry after a stop-out would be sized
      // from a snapshot that doesn't have the loss yet. The next setup brings a new verdict.
      const used = verdictUsed(entries, strategy.name, v, root);
      if (!Number.isFinite(Date.parse(v.at))) why = 'the verdict has no time; wait for the next setup';
      else if (used) why = `the verdict of ${v.at} was already used for an entry; wait for the next setup`;
    }
    if (why) out.push({ check: 'policy', message: `setup:${strategy.name}: ${why}.` });
  }
  return out;
}

/** Whether a successful entry tagged setup:<name> on `root`'s family was placed at or after verdict `v`. */
function verdictUsed(entries, name, v, root) {
  const tag = new RegExp(`^\\s*setup:${name}(?![\\w-])`, 'i');
  const fam = r => (familyOf(r) ? familyOf(r).micro : r);
  return (entries || []).some(e => e.kind === 'order_placed' && e.data && e.data.result && e.data.result.success === true
    && tag.test(String(e.text || '')) && entryTime(e) >= Date.parse(v.at)
    && (mayBeRoot(e.contractId, root) || (Boolean(e.contractId) && fam(contractRoot(e.contractId)) === fam(root))));
}

/**
 * The entry verdicts still open now: each policy's latest verdict per index family that allows an entry (full with
 * a valid multiplier, size >= 1), unexpired, and not used for an entry yet (`entries`: the journal). A multi-lane runner settles a
 * new setup against them, so a higher-priority policy's open setup keeps its place across cycles (lane-cycle.js).
 */
function openEntryVerdicts(home, entries, now = new Date()) {
  const fam = r => (familyOf(r) ? familyOf(r).micro : r);
  const latest = new Map();
  for (const v of readVerdicts(home)) {
    const root = fam(v.contract || contractRoot(v.contractId || v.symbol) || '');
    if (v && v.strategy) latest.set(`${v.strategy}|${root}`, { v, root });
  }
  return [...latest.values()].filter(({ v, root }) => ENTRY_ACTIONS.includes(v.action) && verdictMultiplier(v) !== null && v.maxSize >= 1
    && Date.parse(v.expiresAt) > now.getTime() && Number.isFinite(Date.parse(v.at)) && !verdictUsed(entries, v.strategy, v, root)).map(x => x.v);
}

function appendVerdict(home, verdict) {
  const file = require('./verdict-stage').stageOf(home) || verdictsFile(home);
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

const readVerdictLines = file => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_err) { return null; }
    }).filter(Boolean);
  } catch (_err) {
    return [];
  }
};

function readVerdicts(home) {
  // A stage named that isn't one: no verdicts at all (fails closed: the gate's policy check refuses the entry).
  let stage;
  try { stage = require('./verdict-stage').stageOf(home); } catch (_err) { return []; }
  return [...readVerdictLines(verdictsFile(home)), ...(stage ? readVerdictLines(stage) : [])];
}

/**
 * A stage's verdicts moved to the real file (verdict-stage.js; the runner's entry adopting phase 2 started at the
 * compose), in one write and rename; a staged verdict on a record the real file already holds for its strategy is
 * left out (composed-verdict.js records one per record). The stage is removed. Returns how many were added.
 */
function promoteVerdicts(home, stageFile) {
  const staged = stageFile ? readVerdictLines(stageFile) : [];
  const file = verdictsFile(home);
  const real = readVerdictLines(file);
  const have = new Set(real.filter(v => v.record).map(v => `${v.strategy}|${v.record}`));
  const add = staged.filter(v => !(v.record && have.has(`${v.strategy}|${v.record}`)));
  if (add.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (_err) { /* the first verdicts */ }
    fs.writeFileSync(tmp, `${[...lines, ...add.map(v => JSON.stringify(v))].slice(-VERDICT_KEEP).join('\n')}\n`);
    fs.renameSync(tmp, file);
  }
  require('./verdict-stage').dropStage(stageFile);
  return add.length;
}

module.exports = {
  dayEndMs, closeBefore, balanceCheck, reconciled, orderSince, BALANCE_TOLERANCE,
  SNAPSHOT_MAX_AGE_MS, combineFile, verdictsFile, readAttempt, startAttempt, seedAttempt, carriedOf, carriedLossState, endAttempt, runningAttempts, stateFrom, tradesFromFills, sessionLossStreak, snapshot, dayCounts, attemptCounts, recordEndOfDay, combineBlock, entrySinceSnapshot, oldestSnapshotMs, feeOf,
  legOf, legsFor, budgetPlan, sizeWithin, minContractsRefusal, minContractsIn, latestVerdict, propViolations, appendVerdict, readVerdicts, promoteVerdicts, ENTRY_ACTIONS, verdictMultiplier, verdictUsed, openEntryVerdicts,
};
