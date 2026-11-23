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
 * Carlo runs and no pass rate is printed: dollars and R only, with the count and the minimum stated. A pooled stream
 * with an entry left out or two trades open at once is refused, as a real score refuses one (a dropped loss flatters).
 * Groups (arms) are scored each on their own, with the same seed and options, and printed side by side.
 *
 *   readGroupRun(home, { root, barsFiles })   { runId, home, dir, stream, run, report: { trades, net } } (read only)
 *   agreeAccount(picks)                       the one account name every run's resolveAccount pick names
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
const { scoreText } = require('./model-score');
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

/** A finished run read as its report reads it: the model stream (its trades, sides, gross R) and the report's dollars. */
function readGroupRun(given, { root = null, barsFiles = {} } = {}) {
  const dir = runDirOf(given);
  const { stream, run } = readModelStream(dir, { root, barsFiles });
  const { readRun } = require('../replay/store');
  const { summarize } = require('../replay/report');
  const total = summarize(readRun(dir).days).total;
  return { runId: run.runId || path.basename(dir), home: path.resolve(dir, '..', '..'), dir, stream, run, report: { trades: total.trades, net: cents(total.net) } };
}

/** The one account every run names (model-score.js resolveAccount picks); runs naming none or several: refused. */
function agreeAccount(picks) {
  const none = picks.find(p => !p.name);
  if (none) throw new Error(none.why || 'no account: pass --account (no default account)');
  const names = [...new Set(picks.map(p => p.name))];
  if (names.length !== 1) throw new Error(`the runs name different accounts (${names.join(', ')}): pass --account`);
  return names[0];
}

/** The runs' streams as one model stream, its days in date order; a session day in two runs is refused. */
function poolStreams(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('no runs to pool');
  const owner = new Map();
  for (const e of entries) {
    for (const d of e.stream.days) {
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

module.exports = { LABEL, readGroupRun, agreeAccount, poolStreams, runRow, groupSummary, scoreGroup, pooledText };
