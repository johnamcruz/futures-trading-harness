'use strict';

/**
 * Stage 2's continuous combine (docs/TRAINING.md section 5): a replay run that trades real combine attempts, each from
 * zero, on consecutive trading days, instead of curated days from drawn account states.
 *
 * Config (the replay config's `combine`, replay/config.js; stage 2 only, never with accountStates, curatedList, prop
 * or practice, every bar stepped):
 *   { account: <profile>, attempts: ['YYYY-MM-DD', ...], maxSessions?: n }
 *   account      the account profile the attempts trade (accounts/<name>/ACCOUNT.md); the active policy strategy's
 *   attempts     each attempt's first trading day, in order
 *   maxSessions  the most trading sessions an attempt runs before it is `unfinished` (default: the profile's `sessions`)
 * Each attempt's window is its first maxSessions trading days of the run (the days the run's sessions hold a decision
 * time, from its start date): inside the run's window, inside one learning split window, and never overlapping another.
 *
 * In the driver (replay/driver.js), before each step of an attempt's day (beforeStep):
 *   - an attempt not started yet starts: the account flat (else refused), the previous attempt's record ended
 *     (prop-state endAttempt: kept, renamed), the replay broker's balance set to the profile's starting balance through
 *     the balance schedule (as a drawn state's day is), a fresh attempt record (prop-state startAttempt), and the broker's
 *     balance checked to be the starting balance (else refused);
 *   - the attempt's state is read from its record and the broker's balance (prop-state stateFrom, combine.js): passed or
 *     blown ends it. Flat, it ends at once and no step runs; with a position or a working order still open, only the
 *     day's end of day runs (the runner's own flatten, as live: the gate already refuses new entries) and it ends once
 *     flat. Every later time of an ended attempt runs no step: the clock moves to the next attempt's start.
 * An attempt still active when its last session is done ends `unfinished` (at the next attempt's start, or the run's end).
 * Each start and end is a line of the run's combine.jsonl (never shown to the model); the driver's own state (the attempt
 * under way, its lowest cushion and worst day so far, the attempts ended) is the manifest's `combine`.
 *
 *   LOG                                   the log's file name in the run's folder
 *   validateCombineConfig(raw)            { combine: { account, attempts, maxSessions } | null, errors }
 *   combineForRun(spec, { points, account, rolesBetween })   { account, maxSessions, attempts: [{ n, start, days, last }] } (throws)
 *   attemptOf(combine, day)               the attempt whose window holds `day`, or -1
 *   attemptSummary(account, record, balance, track)   { balance, floor, profit, target, lowCushion, worstDay, dailyLimit, closedDays }
 *   beforeStep(run, point, ranAt, env, deps, { root, manifest, save, log })   true: step it; false: no step
 *   finishCombine(run, env, deps, { root, manifest, save, log, at })   ends the attempt under way (the run's last time ran)
 *   readLog(runDir), combineReport(runDir, { days, role }), reportLines(report)
 */

const fs = require('fs');
const path = require('path');

const LOG = 'combine.jsonl';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEYS = ['account', 'attempts', 'maxSessions'];
const r2 = x => Math.round(x * 100) / 100;

function validateCombineConfig(raw) {
  if (raw === undefined) return { combine: null, errors: [] };
  const errors = [];
  if (!(raw && typeof raw === 'object' && !Array.isArray(raw))) return { combine: null, errors: ['combine: { "account": "<profile>", "attempts": ["YYYY-MM-DD", ...], "maxSessions": n }'] };
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`combine.${k}: unknown (${KEYS.join(', ')})`);
  if (!(typeof raw.account === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.account))) errors.push('combine.account: an account profile name (accounts/<name>/ACCOUNT.md)');
  const a = raw.attempts;
  if (!(Array.isArray(a) && a.length && a.every(d => typeof d === 'string' && DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d))) {
    errors.push('combine.attempts: a list of each attempt\'s first trading day (YYYY-MM-DD), at least one');
  } else if (a.some((d, i) => i && d <= a[i - 1])) errors.push('combine.attempts: in order, each after the one before');
  if (raw.maxSessions !== undefined && !(Number.isInteger(raw.maxSessions) && raw.maxSessions >= 1)) errors.push('combine.maxSessions: a whole number of trading sessions, 1 or more (default: the profile\'s sessions)');
  return errors.length ? { combine: null, errors } : { combine: { account: raw.account, attempts: [...a], maxSessions: raw.maxSessions === undefined ? null : raw.maxSessions }, errors };
}

const nextDate = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/**
 * The attempts' windows on the run's trading days (`points`: its decision times, replay/schedule.js): each attempt's
 * first maxSessions days from its start date. Throws naming every attempt that starts on no trading day of the run, runs
 * past the run's end, spans two learning split windows (rolesBetween: learning/splits.js), or overlaps the one before.
 */
function combineForRun(spec, { points, account, rolesBetween }) {
  const maxSessions = spec.maxSessions === null ? account.sessions : spec.maxSessions;
  if (!(Number.isInteger(maxSessions) && maxSessions >= 1)) throw new Error(`combine.maxSessions: ${spec.account} states no sessions; set maxSessions`);
  const days = [...new Set(points.map(p => p.day))].sort();
  const errors = [];
  const attempts = spec.attempts.map((start, i) => {
    const n = i + 1;
    const at = days.indexOf(start);
    if (at === -1) {
      errors.push(`combine.attempts[${i}] ${start}: not a trading day of the run (a session day inside its window with a decision time of its sessions)`);
      return null;
    }
    const own = days.slice(at, at + maxSessions);
    if (own.length < maxSessions) errors.push(`combine.attempts[${i}] ${start}: its ${maxSessions} sessions run past the run's end (${days.length - at} trading day(s) left from it); move it earlier or the run's end later`);
    const last = own[own.length - 1];
    if (rolesBetween) {
      try {
        const roles = rolesBetween(start, nextDate(last));
        if (roles.length !== 1) errors.push(`combine.attempts[${i}] ${start}..${last}: spans ${roles.join(' + ')}; an attempt lies inside one split window`);
      } catch (e) { errors.push(`combine.attempts[${i}] ${start}..${last}: ${String(e.message).split('\n')[0]}`); }
    }
    return { n, start, days: own, last };
  });
  for (let i = 1; i < attempts.length; i++) {
    const a = attempts[i - 1];
    const b = attempts[i];
    if (a && b && b.start <= a.last) errors.push(`combine.attempts[${i}] ${b.start}: overlaps attempt ${a.n} (${a.start}..${a.last}, its ${maxSessions} sessions); attempts are independent and never share a session`);
  }
  if (errors.length) throw new Error(errors.join('\n- '));
  return { account: spec.account, maxSessions, attempts };
}

function attemptOf(combine, day) {
  return combine ? combine.attempts.findIndex(a => a.days.includes(day)) : -1;
}

function readLog(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, LOG), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_err) {
    return [];
  }
}

const appendLog = (runDir, line) => fs.appendFileSync(path.join(runDir, LOG), `${JSON.stringify(line)}\n`);

/**
 * An attempt's end numbers: its balance and floor now, its profit, its lowest cushion to the floor (the record's every
 * close, the balance now and the lowest the driver saw before a step, `track.low`), its worst day: the lowest day P&L
 * seen (each closed day's, today's now, and the lowest the driver saw before a step, `track.worst`; $0 when no day was
 * ever down), against the account's daily limit.
 */
function attemptSummary(account, record, balance, track = {}) {
  const combine = require('../trading/combine');
  const { stateFrom } = require('../trading/prop-state');
  let cs = combine.start(account);
  const cushions = [];
  for (const d of record.days) {
    cs = combine.endDay({ ...cs, status: 'active', balance: d.balance, dayPnl: d.pnl });
    cushions.push(cs.balance - cs.floor);
  }
  const now = stateFrom(account, record, balance);
  const finite = xs => xs.filter(x => typeof x === 'number' && Number.isFinite(x));
  const lows = finite([...cushions, now.balance - now.floor, track.low]);
  const worst = finite([...record.days.map(d => d.pnl), now.dayPnl, track.worst]);
  return {
    balance: r2(now.balance), floor: r2(now.floor), profit: r2(now.balance - account.starting_balance), target: account.profit_target,
    lowCushion: r2(Math.min(...lows)), worstDay: worst.length ? r2(Math.min(...worst)) : 0, dailyLimit: account.daily_loss_limit || 0, closedDays: record.days.length,
  };
}

const state = manifest => {
  if (!manifest.combine) manifest.combine = { current: null, ended: [], closing: null, track: null };
  return manifest.combine;
};

const refused = msg => new Error(`replay refused: ${msg}`);

async function balanceOf(run, env, deps) {
  const b = await Promise.resolve().then(() => deps.balance(env, run.cfg.account)).then(Number, err => {
    throw refused(`can't read the account's balance for the combine attempt (${String((err && err.message) || err).split('\n')[0]})`);
  });
  if (!Number.isFinite(b)) throw refused('the replay broker reports no balance for the combine attempt');
  return b;
}

/** Start attempt `idx` before its first step (see the header). */
async function startOne(run, idx, point, ranAt, env, deps, { root, manifest, save, log }) {
  const { readJson, writeJsonAtomic } = require('../harness-run');
  const ps = require('../trading/prop-state');
  const account = require('../trading/accounts').accountNamed(root || run.root, run.combine.account, env);
  const a = run.combine.attempts[idx];
  if (!run.cfg.account) throw refused('a combine run needs the replay broker\'s account (the runner config\'s account)');
  const open = await Promise.resolve().then(() => deps.open(env, run.cfg.account)).then(Boolean, err => {
    throw refused(`can't read the account to start combine attempt ${a.n} (${String((err && err.message) || err).split('\n')[0]})`);
  });
  if (open) throw refused(`combine attempt ${a.n} (${a.start}) would start with a position or working order open: attempts start flat`);
  const schedule = readJson(run.paths.balanceSchedule, []) || [];
  if (!schedule.some(e => e.attempt === a.n)) {
    schedule.push({ at: ranAt.toISOString(), day: point.day, balance: account.starting_balance, dayPnl: 0, attempt: a.n });
    writeJsonAtomic(run.paths.balanceSchedule, schedule);
  }
  if (ps.readAttempt(run.paths.runHome, account.name)) ps.endAttempt(run.paths.runHome, account.name, ranAt);
  ps.startAttempt(run.paths.runHome, account, ranAt);
  const balance = await balanceOf(run, env, deps);
  if (!(Math.abs(balance - account.starting_balance) <= 0.01)) {
    throw refused(`the replay broker reports a balance of ${balance}, not ${account.name}'s starting ${account.starting_balance}: it doesn't apply the balance schedule (${run.brokerEnv.balanceSchedule || 'brokerEnv.balanceSchedule'})`);
  }
  appendLog(run.paths.runDir, { kind: 'start', attempt: a.n, start: a.start, day: point.day, at: ranAt.toISOString(), balance });
  const st = state(manifest);
  st.current = idx;
  st.closing = null;
  st.track = { low: null, worst: null, days: [] };
  save();
  log(`combine attempt ${a.n} of ${run.combine.attempts.length} starts ${a.start} at ${account.name}'s starting balance $${account.starting_balance} (up to ${run.combine.maxSessions} sessions)`);
}

/** End the attempt under way: its outcome (given, else the record's: passed, blown, else unfinished) and numbers logged. */
async function endOne(run, env, deps, { root, manifest, save, log, outcome = null, balance = null, at }) {
  const ps = require('../trading/prop-state');
  const st = state(manifest);
  const idx = st.current;
  const a = run.combine.attempts[idx];
  const account = require('../trading/accounts').accountNamed(root || run.root, run.combine.account, env);
  const record = ps.readAttempt(run.paths.runHome, account.name);
  if (!record) throw refused(`combine attempt ${a.n} has no attempt record to end`);
  const bal = balance === null ? await balanceOf(run, env, deps) : balance;
  const cs = ps.stateFrom(account, record, bal);
  const out = outcome || (cs.status === 'blown' ? 'blown' : cs.status === 'passed' ? 'passed' : 'unfinished');
  const sum = attemptSummary(account, record, bal, st.track || {});
  const days = (st.track && st.track.days) || [];
  appendLog(run.paths.runDir, { kind: 'end', attempt: a.n, start: a.start, outcome: out, sessions: days.length, days, at: at.toISOString(), ...sum });
  st.ended.push(idx);
  st.current = null;
  st.closing = null;
  st.track = null;
  save();
  log(`combine attempt ${a.n} (${a.start}) ${out} after ${days.length} session(s): profit $${sum.profit}, lowest cushion $${sum.lowCushion}; no step runs for it after this`);
}

/** Before a step of a combine run: start its attempt, end it when it passed or blew; whether the step runs (header). */
async function beforeStep(run, point, ranAt, env, deps, ctx) {
  const st = state(ctx.manifest);
  const idx = attemptOf(run.combine, point.day);
  if (idx === -1 || st.ended.includes(idx)) return false;
  if (st.current !== idx) {
    if (st.current !== null) await endOne(run, env, deps, { ...ctx, at: ranAt });
    await startOne(run, idx, point, ranAt, env, deps, ctx);
  }
  const ps = require('../trading/prop-state');
  const account = require('../trading/accounts').accountNamed(ctx.root || run.root, run.combine.account, env);
  const record = ps.readAttempt(run.paths.runHome, account.name);
  if (!record) throw refused(`combine attempt ${run.combine.attempts[idx].n}'s record is gone (combine/${account.name}.json): the run can't go on without it`);
  const balance = await balanceOf(run, env, deps);
  const cs = ps.stateFrom(account, record, balance);
  const t = st.track || (st.track = { low: null, worst: null, days: [] });
  const cushion = cs.balance - cs.floor;
  t.low = t.low === null ? r2(cushion) : Math.min(t.low, r2(cushion));
  t.worst = t.worst === null ? r2(cs.dayPnl) : Math.min(t.worst, r2(cs.dayPnl));
  const outcome = st.closing ? st.closing.outcome : cs.status === 'blown' ? 'blown' : cs.status === 'passed' ? 'passed' : null;
  if (!outcome) {
    if (!t.days.includes(point.day)) t.days.push(point.day);
    ctx.save();
    return true;
  }
  // A check that fails counts as open: the day's end of day still runs (never leaves a position alone).
  const open = await Promise.resolve().then(() => deps.open(env, run.cfg.account)).then(Boolean, () => true);
  if (open) {
    if (!st.closing) ctx.log(`combine attempt ${run.combine.attempts[idx].n} ${outcome} with a position or working order open: only the day's end of day runs (the runner's flatten), then it ends`);
    st.closing = { outcome, day: point.day };
    const eod = point.kind === 'eod' || point.kind === 'eod-retry';
    if (eod && !t.days.includes(point.day)) t.days.push(point.day);
    ctx.save();
    return eod;
  }
  await endOne(run, env, deps, { ...ctx, outcome, balance, at: ranAt });
  return false;
}

/** The run's last time ran: the attempt under way ends (passed, blown, or unfinished at its last session). */
async function finishCombine(run, env, deps, ctx) {
  const st = state(ctx.manifest);
  if (st.current === null) return;
  await endOne(run, env, deps, { ...ctx, outcome: st.closing ? st.closing.outcome : null });
}

/**
 * The run's attempts: each start and end from the log, with its trades from the run's records (`days`: store.js readRun,
 * each closing fill's net and R, report.js tradesOf), and the totals. role: the run's learning role (for the label).
 */
function combineReport(runDir, { days = null, role = null } = {}) {
  const log = readLog(runDir);
  const starts = log.filter(x => x.kind === 'start');
  if (!starts.length) return null;
  const { tradesOf } = require('./report');
  const recs = days || require('./store').readRun(runDir).days;
  const median = require('../prop/stats').median;
  const rows = starts.map(s => {
    const end = log.find(x => x.kind === 'end' && x.attempt === s.attempt) || null;
    const own = end ? end.days : Object.keys(recs).filter(d => d >= s.start).sort();
    const open = new Map();
    const trades = own.flatMap(d => (recs[d] || []).flatMap(rec => tradesOf(rec.trades, open)));
    const rs = trades.map(x => x.r).filter(x => x !== null && x !== undefined);
    return {
      attempt: s.attempt, start: s.start, outcome: end ? end.outcome : 'running', sessions: end ? end.sessions : own.length, end,
      trades: trades.length, winRate: trades.length ? trades.filter(x => x.net > 0).length / trades.length : null, meanR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    };
  });
  const done = rows.filter(r => r.end);
  const passed = done.filter(r => r.outcome === 'passed');
  const blown = done.filter(r => r.outcome === 'blown').length;
  const { gateFailures, PROMOTION_GATE } = require('../prop/promotion');
  const months = {};
  for (const r of done) {
    const m = r.start.slice(0, 7);
    months[m] = months[m] || { blown: 0 };
    if (r.outcome === 'blown') months[m].blown += 1;
  }
  // Every attempt shares no session with another (combineForRun), so each is independent: ess is their count.
  const gate = gateFailures({ attempts: done.length, passed: passed.length, blown, ess: done.length, months, diagnostic: true, score: `continuous combine practice on ${role || 'no role'}` });
  return {
    attempts: rows, role,
    totals: { attempts: done.length, running: rows.length - done.length, passed: passed.length, blown, unfinished: done.filter(r => r.outcome === 'unfinished').length, passRate: done.length ? passed.length / done.length : null, medianSessionsToPass: median(passed.map(r => r.sessions)) },
    gate: { numbers: PROMOTION_GATE, failures: gate },
  };
}

const usd = x => (typeof x === 'number' && Number.isFinite(x) ? `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}` : '-');
const pct = x => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const fix = x => (x === null || x === undefined ? '-' : x.toFixed(2));

/** The report's lines (the stage report and `replay.js report`). */
function reportLines(rep) {
  if (!rep) return [];
  const T = rep.totals;
  const G = rep.gate.numbers;
  const lines = [`continuous combine: ${rep.attempts.length} attempt(s), each from zero at the starting balance`];
  for (const r of rep.attempts) {
    const e = r.end;
    const nums = e ? `; profit ${usd(e.profit)} of ${usd(e.target)}; lowest cushion ${usd(e.lowCushion)} to the floor; worst day ${usd(e.worstDay)} (daily limit ${e.dailyLimit ? usd(e.dailyLimit) : 'none'})` : '';
    lines.push(`  attempt ${r.attempt} from ${r.start}: ${r.outcome} after ${r.sessions} session(s)${nums}; ${r.trades} trade(s), win rate ${pct(r.winRate)}, mean R ${fix(r.meanR)}`);
  }
  lines.push(`  totals: ${T.attempts} attempt(s) ended${T.running ? ` (${T.running} still running)` : ''}: ${T.passed} passed (pass rate ${pct(T.passRate)}), ${T.blown} blown, ${T.unfinished} unfinished; median sessions to pass ${T.medianSessionsToPass === null ? '-' : T.medianSessionsToPass}`);
  lines.push(`  promotion gate numbers (prop/promotion.js, frozen: at least ${G.minAttempts} independent attempts over ${G.minMonths} months, at most ${G.maxBlows} blows, pass rate at least ${G.minPassRate * 100}%): practice${rep.role ? ` (${rep.role})` : ''}, never a promotion score: ${rep.gate.failures.join('; ')}`);
  return lines;
}

module.exports = { LOG, validateCombineConfig, combineForRun, attemptOf, attemptSummary, beforeStep, finishCombine, readLog, combineReport, reportLines };
