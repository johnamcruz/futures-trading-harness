'use strict';

/**
 * The pooled combine score of many replay runs (scripts/pooled-score.js): each run a one-morning or multi-day replay of
 * days someone picked, read as the replay's report reads it, and all of a group's trades pooled into one stream in date
 * order and scored by the one evaluator (prop/evaluator.js checkPooledWindow, scoreStream: the 30-day Monte Carlo
 * combine of prop/model-score.js, its rule engine combine.js). No second rule engine.
 *
 * Per run: its date (its first..last session day), its trades with their sides and gross R (the model stream,
 * prop/model-stream.js, as the run's prop score reads them) and its dollars (the report's: replay/report.js summarize,
 * the round trips' net of fees). A run whose report and stream count different trades, or that left an entry out, is
 * flagged on its row.
 *
 * The pooled score is `diagnostic (picked days)`, never a promotion score: picked days are not a calendar of the market.
 * Below the score's minimum of independent attempts (the promotion gate's minAttempts, prop/promotion.js, read here,
 * never changed), counted as the score counts them (floor of the pooled days over the account's sessions), no Monte
 * Carlo runs and no pass rate is printed: dollars and R only, with the count and the minimum stated. The Monte Carlo is
 * refused for a pooled stream with an entry left out or two trades open at once, as a real score refuses one (a dropped
 * loss flatters), and for a run whose report and stream count different trades (the dollars would describe other trades).
 * Never pooled at all: a curated run or one whose days started from drawn account states (refuseDrawn), a setup-focused
 * practice run, a trend-set run stepping windows, a continuous-combine run or one whose attempt carries a balance from
 * outside its window (refuseCarried),
 * a run naming an account that does not resolve (ownAccount), a run whose
 * stream holds a day outside its own window, and runs the evaluator's checkPooledWindow refuses.
 * Groups (arms) are scored each on their own, with the same seed and options, and printed side by side.
 *
 *   readGroupRun(home, { root, barsFiles })   { runId, home, dir, stream, run, report: { trades, net } } (read only)
 *   ownAccount({ runId, attempts, runnerAccount, accounts })   a run's own account pick; one that doesn't resolve: refused
 *   agreeAccount(picks, { override, fallback })   the one account the runs name (--account only for runs naming none)
 *   poolStreams(entries)                      the runs' streams as one model stream, days in date order
 *   runRow(entry), groupSummary(rows)         a run's row; a group's totals
 *   scoreGroup(name, entries, { account, policy, limits, contracts, seed, paths, reps, minimum })   a group's score
 *   pooledText(groups, { account, sizingFrom, sessions })   the printout
 */

const fs = require('fs');
const path = require('path');
const { MC_SIZE } = require('./mc-size');
const { PROMOTION_GATE } = require('./promotion');
const { checkPooledWindow, scoreStream } = require('./evaluator');
const { readModelStream } = require('./model-stream');
const { gateLimits } = require('./attempts');
const { scoreText, resolveAccount, steppedWindows } = require('./model-score');
const { requireSizing } = require('../trading/combine');

const LABEL = 'diagnostic (picked days)';
const cents = x => Math.round(x * 100) / 100;
const fourth = x => Math.round(x * 10000) / 10000;

/** A run's folder from what was given: a run home (<home>/replay/<runId>, or its one replay folder) or the run's folder. */
function runDirOf(given) {
  const p = path.resolve(given);
  if (fs.existsSync(path.join(p, 'manifest.json'))) return p;
  const own = path.join(p, 'replay', path.basename(p));
  if (fs.existsSync(path.join(own, 'manifest.json'))) return own;
  let subs = [];
  try { subs = fs.readdirSync(path.join(p, 'replay')).filter(n => fs.existsSync(path.join(p, 'replay', n, 'manifest.json'))); } catch (_err) { /* none */ }
  if (subs.length === 1) return path.join(p, 'replay', subs[0]);
  throw new Error(`no replay run in ${given}${subs.length ? ` (${subs.length} runs: give one's folder)` : ''}`);
}

/**
 * A run the single-run score never takes as whole days (model-score.js: a curated run is reweighted to its lists' natural
 * rates or not scored, a run from drawn account states weighted back): its days aren't the market's, so never pooled.
 */
function refuseDrawn(dir) {
  const id = path.basename(dir);
  let pin;
  try { pin = require('../learning/curated-lists').loadPinnedCurated(path.resolve(dir, '..', '..')); } catch (err) { pin = { broken: err.message }; }
  if (pin) throw new Error(`run ${id} is a curated run${pin.broken ? ` (${pin.broken})` : ''}: its moments are picked outcome-balanced, so it is never pooled (its own report scores it at natural rates)`);
  if (require('./account-states').readStatesLog(dir).some(x => x && x.kind === 'start')) {
    throw new Error(`run ${id} started its days from drawn account states: they are weighted back to the natural mix only in its own score, so it is never pooled`);
  }
  // A continuous-combine run (replay/combine-run.js: its log; stage 2, replay/stage.js stageTwoHome) carries one balance
  // across its days. An attempt record of the run's own is not refused for being there: refuseCarried refuses one that
  // started before or after the run's window, or holds a close (recorded or missed) outside it.
  if (fs.existsSync(path.join(dir, require('../replay/combine-run').LOG))) {
    throw new Error(`run ${id} is a continuous-combine run: one balance carried across its days (stage 2), never pooled with picked days`);
  }
  // A training-loop trend-set run (replay/step-windows.js): stretches of its sessions picked by outcome, never whole days.
  if (steppedWindows(dir)) throw new Error(`run ${id} steps windows of its sessions only (the training loop's trend set): never pooled with whole days`);
}

/**
 * A run whose attempt records (every one in its home's combine folder: running, and ended ones, renamed
 * <account>.ended-<time>.json) carry a balance from outside the run's own window [from, to): an attempt started on a day
 * outside it, or a close recorded (days) or missed (missedCloses, missedClose) on one. Never pooled.
 */
function refuseCarried(home, run, id) {
  let files = [];
  try { files = fs.readdirSync(path.join(home, 'combine')).filter(f => f.endsWith('.json')).sort(); } catch (_err) { return; }
  const inside = day => day >= run.from && day < run.to;
  for (const f of files) {
    let a = null;
    try { a = JSON.parse(fs.readFileSync(path.join(home, 'combine', f), 'utf8')); } catch (_err) { /* not a record */ }
    if (!a || !Array.isArray(a.days)) continue;
    const name = a.account || f;
    const where = `outside its own window ${run.from}..${run.to} (a carried balance): never pooled`;
    if (a.startDay && !inside(a.startDay)) throw new Error(`run ${id}'s attempt of ${name} started on ${a.startDay}, ${where}`);
    const closes = [...a.days.map(d => d && d.day), ...(a.missedCloses || []), ...(a.missedClose ? [a.missedClose] : [])].filter(Boolean);
    const out = closes.find(d => !inside(d));
    if (out) throw new Error(`run ${id}'s attempt of ${name} carries a close of ${out}, ${where}`);
  }
}

/** A finished run read as its report reads it: the model stream (its trades, sides, gross R) and the report's dollars. */
function readGroupRun(given, { root = null, barsFiles = {} } = {}) {
  const dir = runDirOf(given);
  refuseDrawn(dir);
  const { stream, run } = readModelStream(dir, { root, barsFiles });
  // A setup-focused practice run is scored `diagnostic (setup-focused)` on its own (model-score.js): not whole days to pool.
  if (run.practice) throw new Error(`run ${run.runId || path.basename(dir)} is a setup-focused practice run: it steps setup moments, not whole days, so it is never pooled (its own report scores it as diagnostic (setup-focused))`);
  refuseCarried(path.resolve(dir, '..', '..'), run, run.runId || path.basename(dir));
  const { readRun } = require('../replay/store');
  const { summarize } = require('../replay/report');
  const total = summarize(readRun(dir).days).total;
  return { runId: run.runId || path.basename(dir), home: path.resolve(dir, '..', '..'), dir, stream, run, report: { trades: total.trades, net: cents(total.net) } };
}

/**
 * A run's own account (model-score.js resolveAccount over its attempt records and runner config, no policy fallback),
 * refused when what it names does not resolve: an attempt of an account that is no valid profile, or a runner account
 * that names a profile only in another case or an invalid one. Any other runner account is the broker's account id
 * (the runner's `account`), no profile: the run names none.
 */
function ownAccount({ runId, attempts = [], runnerAccount = null, accounts = [] }) {
  const valid = new Set(accounts.filter(a => a.valid !== false).map(a => a.name));
  const invalid = new Set(accounts.filter(a => a.valid === false).map(a => a.name));
  const why = n => (invalid.has(n) ? 'an invalid profile' : 'no such profile');
  const lost = attempts.find(n => !valid.has(n));
  if (lost) throw new Error(`run ${runId} holds an attempt of account "${lost}", which does not resolve (${why(lost)})`);
  if (runnerAccount !== null && runnerAccount !== undefined && !valid.has(String(runnerAccount))) {
    const r = String(runnerAccount);
    const cased = [...valid].find(n => n.toLowerCase() === r.toLowerCase());
    if (cased || invalid.has(r)) throw new Error(`run ${runId}'s runner config names account "${r}", which does not resolve (${cased ? `the profile is ${cased}` : 'an invalid profile'})`);
  }
  return resolveAccount({ attempts, runnerAccount, strategies: [], accounts });
}

/**
 * The one account the runs name (picks: each run's own, model-score.js resolveAccount over its attempt and runner config,
 * name null when it names none). Runs naming two accounts never pool. override (--account) only names the account of runs
 * that name none: one the runs name otherwise is refused. None named and no override: the fallback's (the policy
 * strategies' account), else refused with its reason.
 */
function agreeAccount(picks, { override = null, fallback = null } = {}) {
  const names = [...new Set(picks.filter(p => p && p.name).map(p => p.name))].sort();
  if (names.length > 1) throw new Error(`the runs name different accounts (${names.join(', ')}): pool runs of one account`);
  if (override) {
    if (names.length && names[0] !== override) throw new Error(`--account ${override}, but the runs name ${names[0]}: --account only names the account of runs that name none`);
    return override;
  }
  if (names.length) return names[0];
  if (fallback && fallback.name) return fallback.name;
  throw new Error((fallback && fallback.why) || 'no account: pass --account (no default account)');
}

/** The runs' streams as one model stream, its days in date order; a session day in two runs is refused. */
function poolStreams(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('no runs to pool');
  const owner = new Map();
  for (const e of entries) {
    for (const d of e.stream.days) {
      // As single-run scoring holds a run's days to its own window (evaluator.js daysFor).
      if (!(d.day >= e.run.from && d.day < e.run.to)) throw new Error(`run ${e.runId}'s stream holds ${d.day}, outside its own window ${e.run.from}..${e.run.to}`);
      if (owner.has(d.day)) throw new Error(`session day ${d.day} is in runs ${owner.get(d.day)} and ${e.runId}: a pooled stream holds each day once`);
      owner.set(d.day, e.runId);
    }
  }
  const days = entries.flatMap(e => e.stream.days).sort((a, b) => a.day.localeCompare(b.day));
  const trades = days.flatMap(d => d.trades);
  const tag = key => entries.flatMap(e => (e.stream[key] || []).map(x => ({ ...x, runId: e.runId })));
  const sum = (key, k) => entries.reduce((a, e) => a + Number((e.stream[key] || {})[k] || 0), 0);
  const first = entries[0].stream;
  return {
    source: 'model', rBasis: 'gross', days, trades, excluded: tag('excluded'), overlaps: tag('overlaps'), fieldBranch: [], entryDelayMs: null,
    slippageTicks: first.slippageTicks, timeframe: first.timeframe, noStop: { known: sum('noStop', 'known'), missing: sum('noStop', 'missing') },
    adverse: { bars: sum('adverse', 'bars'), bound: sum('adverse', 'bound') }, runtimeMs: null,
  };
}

/** A run's row: its date, trades, sides, gross R (each and the sum) and the report's dollars, with what disagrees. */
function runRow(e) {
  const keys = e.stream.days.map(d => d.day).sort();
  const t = e.stream.trades;
  const flags = [];
  if (e.report.trades !== t.length) flags.push(`the report counts ${e.report.trades} trade(s), the stream ${t.length}`);
  if ((e.stream.excluded || []).length) flags.push(`${e.stream.excluded.length} entr(y/ies) left out`);
  if ((e.stream.overlaps || []).length) flags.push(`${e.stream.overlaps.length} pair(s) open at once`);
  return {
    runId: e.runId, date: keys.length > 1 ? `${keys[0]}..${keys[keys.length - 1]}` : keys[0] || '-', days: keys.length, trades: t.length,
    long: t.filter(x => x.direction === 'long').length, short: t.filter(x => x.direction === 'short').length, sides: t.map(x => x.direction),
    rs: t.map(x => x.r), grossR: fourth(t.reduce((a, x) => a + (Number(x.r) || 0), 0)), net: e.report.net, flags,
  };
}

function groupSummary(rows) {
  const add = k => rows.reduce((a, r) => a + r[k], 0);
  const trades = add('trades');
  const grossR = fourth(add('grossR'));
  return { runs: rows.length, days: add('days'), trades, long: add('long'), short: add('short'), grossR, meanR: trades ? fourth(grossR / trades) : null, net: cents(add('net')) };
}

/** A group's rows, totals and pooled score (null below the minimum, with why); options as model-score.js scoreRun's. */
function scoreGroup(name, entries, { account, policy = null, limits = null, contracts = null, seed = 1, paths = MC_SIZE.paths, reps = MC_SIZE.reps, minimum = PROMOTION_GATE.minAttempts, env = process.env, now = new Date() } = {}) {
  if (!Array.isArray(entries) || !entries.length) throw new Error(`group ${name}: no runs`);
  if (!account) throw new Error('an account profile to score against');
  requireSizing(policy && policy.sizing, `${account.name}: no policy strategy with a whole rulebook sizing trades it, so nothing is scored`);
  const rows = entries.map(runRow).sort((a, b) => a.date.localeCompare(b.date));
  const summary = groupSummary(rows);
  const stream = poolStreams(entries);
  const S = account.sessions;
  const independent = Math.floor(stream.days.length / S);
  const out = { name, rows, summary, independent, minimum, sessions: S, refused: null, result: null };
  // Every run checked before anything of it is printed (a held-back, sealed or hidden run, runs of two roles: refused),
  // whether or not the Monte Carlo runs. The check logs nothing.
  const pass = checkPooledWindow({ runs: entries.map(e => e.run), now });
  if (independent < minimum) {
    out.refused = `${independent} independent attempt(s) (${stream.days.length} day(s) / ${S} sessions) is below the minimum of ${minimum} the score uses (the promotion gate's minAttempts): no pass rate, dollars and R only`;
    return out;
  }
  const miscount = entries.find(e => e.report.trades !== e.stream.trades.length);
  if (miscount) {
    out.refused = `run ${miscount.runId}: the report counts ${miscount.report.trades} trade(s), the stream ${miscount.stream.trades.length}: the dollars and the Monte Carlo would describe different trades`;
    return out;
  }
  if (stream.excluded.length) {
    const x = stream.excluded[0];
    out.refused = `${stream.excluded.length} entr(y/ies) without a settled outcome (first: ${x.runId} ${x.root || ''} ${x.bar || ''}: ${x.why}): a pooled score never leaves one out`;
    return out;
  }
  if (stream.overlaps.length) {
    out.refused = `${stream.overlaps.length} pair(s) of trades open at the same time (first in ${stream.overlaps[0].runId}): their combined drawdown would go unseen`;
    return out;
  }
  const ctr = contracts || (policy && policy.contracts) || 'auto';
  const r = scoreStream(stream, { pass, account, rulebook: { sizing: policy.sizing, limits }, contracts: ctr, gate: gateLimits(env), seed, paths, reps });
  out.result = {
    ...r, account: account.name, policy: policy.name || null, sizingFrom: `${policy.name || 'the policy'}'s rulebook`, sizedWith: { limits, contracts: ctr },
    trades: stream.trades.length, runDays: stream.days.length, excluded: [], adverse: stream.adverse, reweighted: null, riskActions: null,
  };
  return out;
}

const pct = x => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1)}%`);
const iv = i => (i && i.lo !== null && i.lo !== undefined ? ` [${pct(i.lo)}, ${pct(i.hi)}]` : '');
const usd = x => (x === null || x === undefined ? '-' : cents(x).toFixed(2));
const num = x => (x === null || x === undefined ? '-' : String(x));

/** Rows of cells as aligned text, two spaces between columns. */
function table(rows, indent = '  ') {
  const width = rows[0].map((_c, i) => Math.max(...rows.map(r => String(r[i]).length)));
  return rows.map(r => `${indent}${r.map((c, i) => String(c).padEnd(width[i])).join('  ').trimEnd()}`).join('\n');
}

/** The printout: the label, each group's runs, the groups side by side, and each scored group's whole score. */
function pooledText(groups, { account, sizingFrom, sessions }) {
  const out = [`Pooled combine score: ${LABEL}, never a promotion score: hand-picked days of many replay runs pooled into one stream in date order, the ${sessions}-day Monte Carlo combine (account ${account}, ${sizingFrom}); R gross (price over the stop), dollars the report's (net of fees)`];
  for (const g of groups) {
    out.push('', `Group ${g.name}: ${g.summary.runs} run(s), ${g.summary.days} day(s)`);
    out.push(table([['date', 'run', 'trades', 'sides', 'gross R', 'net $', 'flags'], ...g.rows.map(r => [r.date, r.runId, r.trades, r.sides.join(',') || '-', r.rs.length ? r.rs.join(',') : '-', usd(r.net), r.flags.join('; ')])]));
  }
  const res = g => g.result;
  const rate = (k, i) => g => (res(g) ? `${pct(res(g)[k])}${iv(res(g).intervals[i])}` : 'not printed');
  const metrics = [
    ['runs', g => g.summary.runs], ['days', g => g.summary.days], ['trades', g => g.summary.trades], ['long / short', g => `${g.summary.long} / ${g.summary.short}`],
    ['gross R (sum)', g => num(g.summary.grossR)], ['gross R per trade', g => num(g.summary.meanR)], ['net $ (report)', g => usd(g.summary.net)],
    ['independent attempts', g => `${g.independent} (minimum ${g.minimum})`],
    ['pass rate', rate('passRate', 'pass')], ['blow rate', rate('blowRate', 'blow')], ['timeout rate', rate('timeoutRate', 'timeout')],
    ['days to pass (median / p90)', g => (res(g) ? `${num(res(g).medianDaysToPass)} / ${num(res(g).p90DaysToPass)}` : 'not printed')],
    ['resampled pass / blow', g => (res(g) ? `${pct(res(g).resampled.passRate)} / ${pct(res(g).resampled.blowRate)}` : 'not printed')],
  ];
  out.push('', table([[groups.length > 1 ? 'Arm vs arm' : 'Pooled', ...groups.map(g => g.name)], ...metrics.map(([k, f]) => [k, ...groups.map(f)])], ''));
  for (const g of groups) {
    out.push('', g.result ? `Group ${g.name}: ${scoreText(g.result).trimEnd()}` : `Group ${g.name}: ${g.refused}`);
  }
  return `${out.join('\n')}\n`;
}

module.exports = { LABEL, readGroupRun, ownAccount, agreeAccount, poolStreams, runRow, groupSummary, scoreGroup, pooledText };
