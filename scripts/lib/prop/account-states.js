'use strict';

/**
 * Account states for practice: the states a curated practice window starts from, drawn from the Monte Carlo's own
 * attempt paths (prop/attempts.js runAttempt on the resampled paths of the model's trade stream, as prop/evaluator.js
 * draws them), so a stage-2 run practises risk decisions under the account pressure its own trading brings.
 *
 * sampleAccountStates (the diagnostic sample): the account as each day opened, bucketed by prop/risk-attribution.js
 * stateOf (fresh, mid, near-target, near-mll), `perBucket` states each, seeded and hashed. Each state: { bucket, day,
 * sessionsDone, balance, floor, peak, eodHigh, roomToMll, roomToTarget, days, facts, record } (`record`: the prop-state
 * attempt record that would start an attempt there, which prop-state stateFrom reads back to the same balance, floor
 * and day).
 *
 * The practice draw (drawPracticeStates, the replay's): the population is every decision moment on the paths, the
 * account as each day opened and as it stood after each trade the attempt took, wherever a new entry was still allowed
 * (no entry block: the attempt over, the firm's daily limit, the soft daily stop, the loss streak stop; and fewer losing
 * trades today than the order gate's daily limit, and a loss streak under the gate's consecutive-loss limit: a seeded
 * day puts its last loss at the window start, where a streak at the limit would still be cooling down). Each is put in a practice bucket (practiceBucketOf, first that holds):
 *   near-mll       the cushion to the floor at most NEAR_MLL of the max loss limit (risk-attribution's)
 *   after-losses   a losing trade closed today
 *   near-target    the profit at least NEAR_TARGET of the target
 *   fresh          the attempt's first session
 *   mid            any other
 * The natural share p_b of each bucket is its share of the population. The draw is stratified: `count` states, each
 * bucket's number in proportion to p_b x oversample_b (near-mll and after-losses 3, the rest 1, by default: practice
 * dwells on the states near the limits), at least one for every bucket the population has, largest remainders. Each
 * draw records its bucket's sampling weight w_b = p_b / q_b (q_b: the bucket's share of the draws), so a score
 * weighted by w restores the natural rates exactly (weightedRates). The draws are shuffled (seeded) into the order the
 * run's days take them.
 *
 * The document (drawDocument): { kind, v, account, accountDigest (the profile's rules: a changed rule refuses it), gate
 * (the order gate's loss limits the population respected), seed, paths, count, meanBlock, oversample, population,
 * natural, sampled, weights, draws, source (the runs the trades came from), hash }. Each draw: { id, bucket, weight,
 * state: { sessionsDone, balance, peak, dayPnl, days (each closed day's P&L), tradesToday, lossesToday, lossStreak },
 * facts (combine.attemptFacts: the attempt line's facts there) }. Nothing about a draw reaches the model: the run seeds
 * its attempt record from `state` (prop-state seedAttempt) and the replay broker's balance, and the model sees the
 * attempt line it would see live.
 *
 * A run assigns the draws to its curated window days (assignStates): the k-th day (in time order) takes draw k mod
 * count; the weights a run's scores use are its own days' (q_b from the days each bucket got), so they restore the
 * natural shares over the run's days exactly; a bucket the population has but no day got is `unsampled` (its states
 * can't be reweighted back: the preflight says so).
 *
 *   sampleAccountStates(stream, { account, sizing, contracts, seed, paths, perBucket, meanBlock })
 *   practiceBucketOf(cs, counters)                         the practice bucket of a decision moment
 *   drawPracticeStates(stream, { account, sizing, contracts, seed, paths, count, meanBlock, oversample, gate })
 *   drawDocument(stream, { ..., source })                  the hashed document; readDocument(file), writeDocument(dir, doc)
 *   allocate(population, count, oversample)                { <bucket>: draws } (stratified, largest remainders)
 *   assignStates(doc, windows)                             { days: [{ day, at, draw, bucket, weight }], weights, natural, sampledDays, unsampled, hash }
 *   weightedRates(rows, weightOf)                          { n, raw, weighted }: the mean of each row's 0/1 or number, raw and weighted
 *   accountDigest(account)                                 the profile's rules, hashed
 *   readStatesLog(runDir)                                  the run's account-states.jsonl (replay/driver.js: start, carried, end)
 *   dayWeights(lines)                                      Map day -> { draw, bucket, weight } (a carried day: its attempt's)
 *   decisionWeight(lines)                                  decision -> its day's weight (prop/natural-rate.js stateWeightOf)
 *   practiceByState(lines)                                 the practice score by account state: each attempt's end, raw and
 *                                                          reweighted (blown, stopped for the day, at the target, P&L)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const combine = require('../trading/combine');
const at = require('./attempts');
const stats = require('./stats');
const { MC_SIZE, checkSize } = require('./mc-size');
const { STATES, stateOf } = require('./risk-attribution');
const { tradingDayKey } = require('../trading/clock');

const KIND = 'account-states';
const VERSION = 1;
const PRACTICE_BUCKETS = Object.freeze(['fresh', 'mid', 'near-target', 'near-mll', 'after-losses']);
/** Practice dwells on the states near the limits: these buckets are drawn this many times their natural share. */
const AS = require('../tunables').replay().accountStates; // config/replay.json accountStates
const DEFAULT_OVERSAMPLE = AS.oversample;
const DEFAULTS = Object.freeze({ seed: AS.seed, paths: MC_SIZE.paths, count: AS.count, meanBlock: AS.meanBlock }); // paths: the Monte Carlo's one default (mc-size.js)

const r2 = x => Math.round(x * 100) / 100;
const r6 = x => Math.round(x * 1e6) / 1e6;
const sha = x => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

function stateRecord(cs, account, days) {
  let bal = account.starting_balance;
  return {
    account: account.name, startDay: null,
    days: cs.days.map((pnl, k) => { bal = r2(bal + pnl); return { day: days[k] || `S${k + 1}`, balance: bal, pnl }; }),
    peak: cs.peak, snapshot: null,
  };
}

/** The attempt simulator's context for an account on a stream (the evaluator's legs and sizing). */
function attemptContext(account, { sizing = null, contracts = 'auto', gate = undefined }) {
  const legs = new Map();
  return {
    account, sizing: combine.requireSizing(sizing, `${account.name}: account states size from a policy's rulebook entry`), mode: contracts, gate: gate === undefined ? at.gateLimits() : gate,
    legsOf: t => { if (!legs.has(t.symbol)) legs.set(t.symbol, at.legsFor(account, t.symbol, { tickValue: t.tickValue })); return legs.get(t.symbol); },
  };
}

/** The resampled attempt paths (the evaluator's stationary block bootstrap), each a list of the stream's days. */
function* attemptPaths(stream, account, { seed, paths, meanBlock, label }) {
  const days = stream.days;
  if (!days.length) throw new Error('the stream has no days to draw attempt paths from');
  const regimes = days.map(d => d.regime || 'normal');
  const byRegime = stats.groupBy(regimes);
  const prand = stats.streamFor(seed, label);
  for (let p = 0; p < paths; p += 1) yield stats.stationaryPath(days.length, account.sessions, { meanBlock, rand: prand, regimes, byRegime }).map(k => days[k]);
}

function sampleAccountStates(stream, { account, sizing = null, contracts = 'auto', seed = AS.seed, paths = MC_SIZE.paths, perBucket = AS.perBucket, meanBlock = AS.meanBlock } = {}) {
  if (!account || !Number.isInteger(account.sessions)) throw new Error('account: an account profile with sessions');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  if (!(Number.isInteger(perBucket) && perBucket >= 1)) throw new Error('perBucket: 1 or more');
  checkSize({ paths });
  const ctx = attemptContext(account, { sizing, contracts });
  const pool = Object.fromEntries(STATES.map(s => [s, []]));
  for (const list of attemptPaths(stream, account, { seed, paths, meanBlock, label: 'account-states:paths' })) {
    at.runAttempt(list, {
      ...ctx,
      onDay: (cs, d) => {
        if (cs.status !== 'active') return;
        pool[stateOf(cs)].push({
          bucket: stateOf(cs), day: d + 1, sessionsDone: cs.days.length, balance: r2(cs.balance), floor: r2(cs.floor), peak: r2(cs.peak), eodHigh: r2(cs.eodHigh),
          roomToMll: r2(combine.cushion(cs)), roomToTarget: r2(Math.max(0, combine.profitNeeded(cs) - combine.profit(cs))), days: [...cs.days],
          facts: combine.attemptFacts(cs, { tradesToday: 0, lossesToday: 0 }), record: stateRecord(cs, account, list.map(x => x.day)),
        });
      },
    });
  }
  const pick = stats.streamFor(seed, 'account-states:pick');
  const states = [];
  for (const b of STATES) {
    const xs = pool[b];
    for (let k = 0; k < perBucket && xs.length; k += 1) states.push(xs[stats.pick(pick, xs.length)]);
  }
  const counts = Object.fromEntries(STATES.map(s => [s, pool[s].length]));
  const hash = sha({ account: account.name, seed, paths, perBucket, states });
  return { states, counts, hash, seed, account: account.name };
}

/** The practice bucket of a decision moment: the account `cs` and today's counts so far (see the header). */
function practiceBucketOf(cs, counters = {}) {
  const b = stateOf(cs);
  if (b === 'near-mll') return b;
  if ((counters.lossesToday || 0) > 0) return 'after-losses';
  return b;
}

function checkOversample(oversample) {
  const o = { ...DEFAULT_OVERSAMPLE, ...(oversample || {}) };
  for (const [k, v] of Object.entries(o)) {
    if (!PRACTICE_BUCKETS.includes(k)) throw new Error(`oversample.${k}: not a practice bucket (${PRACTICE_BUCKETS.join(', ')})`);
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new Error(`oversample.${k}: a factor above 0`);
  }
  return o;
}

/**
 * The draws per bucket: `count` in proportion to population x oversample, at least one for each bucket the
 * population has (largest remainders, ties by bucket order). Refused when count can't hold one of each.
 */
function allocate(population, count, oversample) {
  const o = checkOversample(oversample);
  const have = PRACTICE_BUCKETS.filter(b => (population[b] || 0) > 0);
  if (!have.length) throw new Error('no decision moment on the paths: nothing to draw');
  if (!(Number.isInteger(count) && count >= have.length)) throw new Error(`count: a whole number of draws, at least one per bucket the paths have (${have.length})`);
  const mass = Object.fromEntries(have.map(b => [b, population[b] * o[b]]));
  const total = have.reduce((a, b) => a + mass[b], 0);
  const out = Object.fromEntries(PRACTICE_BUCKETS.map(b => [b, 0]));
  for (const b of have) out[b] = 1;
  const left = count - have.length;
  const exact = have.map(b => ({ b, x: (left * mass[b]) / total }));
  for (const e of exact) out[e.b] += Math.floor(e.x);
  let rest = count - Object.values(out).reduce((a, x) => a + x, 0);
  for (const e of exact.slice().sort((p, q) => (q.x - Math.floor(q.x)) - (p.x - Math.floor(p.x)) || PRACTICE_BUCKETS.indexOf(p.b) - PRACTICE_BUCKETS.indexOf(q.b))) {
    if (rest <= 0) break;
    out[e.b] += 1;
    rest -= 1;
  }
  return out;
}

/** The sampling weights p_b / q_b of the buckets drawn (`sampled`: { bucket: n }), from the natural shares. */
function weightsOf(natural, sampled) {
  const n = Object.values(sampled).reduce((a, x) => a + x, 0);
  return Object.fromEntries(PRACTICE_BUCKETS.filter(b => sampled[b] > 0).map(b => [b, r6(natural[b] / (sampled[b] / n))]));
}

const compact = (cs, counters) => ({
  sessionsDone: cs.days.length, balance: r2(cs.balance), peak: r2(cs.peak), dayPnl: r2(cs.dayPnl), days: cs.days.map(r2),
  tradesToday: counters.tradesToday || 0, lossesToday: counters.lossesToday || 0, lossStreak: cs.lossStreak || 0,
});

function drawPracticeStates(stream, { account, sizing = null, contracts = 'auto', seed = DEFAULTS.seed, paths = DEFAULTS.paths, count = DEFAULTS.count, meanBlock = DEFAULTS.meanBlock, oversample = null, gate = undefined } = {}) {
  if (!account || !Number.isInteger(account.sessions)) throw new Error('account: an account profile with sessions');
  if (!Number.isInteger(seed)) throw new Error('seed: a whole number');
  if (!(Number.isInteger(paths) && paths >= 1)) throw new Error('paths: 1 or more');
  checkSize({ paths });
  const o = checkOversample(oversample);
  const ctx = attemptContext(account, { sizing, contracts, gate });
  const maxLosses = ctx.gate ? ctx.gate.maxDailyLosses : Infinity;
  // A seeded after-losses day's last loss is put at the window start, so a streak at the gate's limit would still be in its
  // cooldown there: those moments are left out (a streak under the limit has no cooldown to cover).
  const maxStreak = ctx.gate ? ctx.gate.maxConsecutiveLosses : Infinity;
  const pool = Object.fromEntries(PRACTICE_BUCKETS.map(b => [b, []]));
  // A new entry is still allowed there: no entry block, and the gate's daily count of losing trades not reached.
  const add = (cs, counters) => {
    if (cs.status !== 'active' || cs.dayStopped || combine.entryBlock(cs) || (counters.lossesToday || 0) >= maxLosses || (cs.lossStreak || 0) >= maxStreak) return;
    pool[practiceBucketOf(cs, counters)].push(compact(cs, counters));
  };
  for (const list of attemptPaths(stream, account, { seed, paths, meanBlock, label: 'account-states:practice-paths' })) {
    at.runAttempt(list, {
      ...ctx,
      onDay: cs => add(cs, { tradesToday: 0, lossesToday: 0 }),
      onTrade: ({ after, gross, counters }) => add(after, { tradesToday: counters.tradesToday + 1, lossesToday: counters.lossesToday + (gross < 0 ? 1 : 0) }),
    });
  }
  const population = Object.fromEntries(PRACTICE_BUCKETS.map(b => [b, pool[b].length]));
  const N = Object.values(population).reduce((a, x) => a + x, 0);
  const natural = Object.fromEntries(PRACTICE_BUCKETS.map(b => [b, N ? r6(population[b] / N) : 0]));
  const sampled = allocate(population, count, o);
  const weights = weightsOf(natural, sampled);
  const pick = stats.streamFor(seed, 'account-states:practice-pick');
  const draws = [];
  for (const b of PRACTICE_BUCKETS) {
    const xs = pool[b].slice();
    for (let k = 0; k < sampled[b]; k += 1) {
      // Without replacement while the bucket lasts.
      const i = stats.pick(pick, xs.length);
      const st = xs.length > 1 ? xs.splice(i, 1)[0] : xs[0];
      draws.push({ bucket: b, weight: weights[b], state: st });
    }
  }
  // Shuffled (Fisher-Yates, seeded): the order the run's days take them.
  const shuffle = stats.streamFor(seed, 'account-states:practice-order');
  for (let i = draws.length - 1; i > 0; i -= 1) {
    const j = stats.pick(shuffle, i + 1);
    [draws[i], draws[j]] = [draws[j], draws[i]];
  }
  return {
    population, natural, sampled, weights, oversample: o, gate: ctx.gate ? { ...ctx.gate } : null,
    draws: draws.map((d, id) => ({ id, ...d, facts: combine.attemptFacts(drawState(account, d.state), { tradesToday: d.state.tradesToday, lossesToday: d.state.lossesToday, lossStreak: d.state.lossStreak }) })),
  };
}

/** The combine state of a compact draw (start, closed days, today's P&L, streak): what the seeded attempt reads back. */
function drawState(account, st) {
  let cs = combine.start(account);
  for (const pnl of st.days) {
    cs = combine.endDay({ ...cs, balance: r2(cs.balance + pnl), dayPnl: pnl });
    if (cs.status === 'timeout') cs = { ...cs, status: 'active' };
  }
  return { ...cs, balance: st.balance, peak: Math.max(cs.peak, st.peak), dayPnl: st.dayPnl, lossStreak: st.lossStreak };
}

/** The account profile's rules, hashed: a draw is the account's as it was drawn. */
function accountDigest(account) {
  const keys = ['name', 'starting_balance', 'profit_target', 'max_loss', 'max_loss_mode', 'daily_loss_limit', 'daily_loss_soft', 'loss_streak_stop', 'consistency_pct', 'sessions'];
  return sha(Object.fromEntries(keys.map(k => [k, account[k] === undefined ? null : account[k]]))).slice(0, 32);
}

const docHash = doc => { const { hash: _h, ...rest } = doc; return sha(rest); };

function drawDocument(stream, opts = {}) {
  const { account, seed = DEFAULTS.seed, paths = DEFAULTS.paths, count = DEFAULTS.count, meanBlock = DEFAULTS.meanBlock, source = [] } = opts;
  const d = drawPracticeStates(stream, { ...opts, seed, paths, count, meanBlock });
  const doc = {
    kind: KIND, v: VERSION, account: account.name, accountDigest: accountDigest(account), gate: d.gate, seed, paths, count, meanBlock, oversample: d.oversample,
    population: d.population, natural: d.natural, sampled: d.sampled, weights: d.weights, draws: d.draws, source,
  };
  return { ...doc, hash: docHash(doc) };
}

function writeDocument(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `account-states-${doc.hash.slice(0, 16)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

function readDocument(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`${file}: not an account-states document (${err.message})`, { cause: err }); }
  if (!doc || doc.kind !== KIND) throw new Error(`${file}: not an account-states document`);
  if (doc.v !== VERSION) throw new Error(`${file}: account states of version ${doc.v}, not ${VERSION}: draw them again`);
  if (docHash(doc) !== doc.hash) throw new Error(`${file}: its content doesn't match its hash (changed after it was drawn)`);
  if (!Array.isArray(doc.draws) || !doc.draws.length) throw new Error(`${file}: no draws`);
  return doc;
}

/**
 * The draws assigned to a curated run's window days (`windows`: [{ from, to }] ms, the run's pinned windows): the k-th
 * day in time order takes draw k mod count, seeded at its first window's opening (`at`); the weights are the run's own
 * days' (see the header).
 */
function assignStates(doc, windows) {
  const first = new Map();
  for (const w of (windows || []).slice().sort((a, b) => a.from - b.from)) {
    const day = tradingDayKey(new Date(w.to));
    if (!first.has(day)) first.set(day, w.from);
  }
  const keys = [...first.keys()].sort();
  if (!keys.length) throw new Error('account states: the run has no window days to assign them to');
  const raw = keys.map((day, k) => { const d = doc.draws[k % doc.draws.length]; return { day, at: new Date(first.get(day)).toISOString(), draw: d.id, bucket: d.bucket }; });
  const sampledDays = Object.fromEntries(PRACTICE_BUCKETS.map(b => [b, raw.filter(x => x.bucket === b).length]));
  const weights = weightsOf(doc.natural, sampledDays);
  const unsampled = PRACTICE_BUCKETS.filter(b => doc.natural[b] > 0 && !sampledDays[b]);
  const days = raw.map(x => ({ ...x, weight: weights[x.bucket] }));
  return { days, weights, natural: doc.natural, sampledDays, unsampled, hash: sha({ doc: doc.hash, days }) };
}

/**
 * The mean of each row's value, raw and weighted by weightOf(row) (self-normalized: sum w x / sum w), with each row's
 * value a number (a 0/1 for a rate). { n, raw, weighted } (nulls with no rows).
 */
function weightedRates(rows, valueOf, weightOf = r => r.weight) {
  const xs = rows.map(r => ({ x: Number(valueOf(r)), w: Number(weightOf(r)) })).filter(r => Number.isFinite(r.x) && Number.isFinite(r.w) && r.w >= 0);
  if (!xs.length) return { n: 0, raw: null, weighted: null };
  const sw = xs.reduce((a, r) => a + r.w, 0);
  return { n: xs.length, raw: r6(xs.reduce((a, r) => a + r.x, 0) / xs.length), weighted: sw > 0 ? r6(xs.reduce((a, r) => a + r.w * r.x, 0) / sw) : null };
}

const LOG = 'account-states.jsonl';

function readStatesLog(runDir) {
  try {
    return fs.readFileSync(path.join(runDir, LOG), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_err) {
    return [];
  }
}

function dayWeights(lines) {
  const out = new Map();
  let cur = null;
  for (const x of lines) {
    if (x.kind === 'start') { cur = { draw: x.draw, bucket: x.bucket, weight: x.weight }; out.set(x.day, cur); }
    else if (x.kind === 'carried' && cur) out.set(x.day, cur);
  }
  return out;
}

/** A decision's weight: its day's (by its cycle's trading day); undefined for a day that started from no draw. */
function decisionWeight(lines) {
  const m = dayWeights(lines);
  return d => { const w = m.get(d && d.cycleAt ? tradingDayKey(new Date(d.cycleAt)) : d && d.day); return w ? w.weight : undefined; };
}

function practiceByState(lines) {
  const starts = lines.filter(x => x.kind === 'start');
  const rows = starts.map(s => {
    const e = lines.find(x => x.kind === 'end' && x.day === s.day && x.draw === s.draw);
    const end = e && e.end;
    return end ? { bucket: s.bucket, weight: s.weight, outcome: end.outcome, pnl: Number.isFinite(s.balance) ? r2(end.balance - s.balance) : null } : null;
  }).filter(Boolean);
  const rates = xs => ({
    attempts: xs.length,
    blown: weightedRates(xs, r => (r.outcome === 'blown' ? 1 : 0)), stopped: weightedRates(xs, r => (r.outcome === 'stopped' ? 1 : 0)),
    target: weightedRates(xs, r => (r.outcome === 'target' ? 1 : 0)), pnl: weightedRates(xs.filter(r => r.pnl !== null), r => r.pnl),
  });
  const byBucket = Object.fromEntries(PRACTICE_BUCKETS.map(b => [b, rates(rows.filter(r => r.bucket === b))]).filter(([, v]) => v.attempts));
  return { days: starts.length, ended: rows.length, all: rates(rows), byBucket };
}

/**
 * The model's own trades the draw's Monte Carlo paths are built from: each run's stream (prop/model-stream.js), a
 * curated run's rebuilt at its lists' natural rates (`lists`: its curated lists document; model-score.js ratesFor) and,
 * for a run whose days started from drawn states, weighted back to their natural mix; their days joined (labelled by
 * run). practice-train runs only, never one whose outcomes are hidden (a held-out run's trades never shape practice).
 * { stream, source: [{ runId, role, days, trades, reweighted }] }.
 */
function sourceStream(runDirs, { root = null, barsFiles = {}, lists = null, seed = 1 } = {}) {
  if (!Array.isArray(runDirs) || !runDirs.length) throw new Error('the runs whose trades the states are drawn from (--run)');
  const { readModelStream } = require('./model-stream');
  const { ratesFor, reweightRun } = require('./model-score');
  const { readLearningRun } = require('../learning/run-gate');
  const { loadPinnedCurated } = require('../learning/curated-lists');
  const days = [];
  const source = [];
  runDirs.forEach((dir, k) => {
    const home = path.resolve(dir, '..', '..');
    const l = readLearningRun(path.resolve(dir)) || readLearningRun(home);
    if (!l || l.role !== 'practice-train') throw new Error(`${dir}: account states are drawn from practice-train runs only (this one is ${l ? l.role || 'no role' : 'not a learning run'})`);
    if (l.hideOutcomes) throw new Error(`${dir}: its outcomes are hidden (a reasoning-fix look)`);
    const { stream, run } = readModelStream(dir, { root, barsFiles });
    let s = stream;
    const pinned = loadPinnedCurated(home);
    if (pinned) {
      if (!lists) throw new Error(`${dir} is a curated run: give its curated lists document (--lists), so its trades come at their natural rates`);
      // The score's own reweighting (model-score.js reweightRun): every moment stepped a candidate, each state weighted back.
      const nat = ratesFor(dir, { curated: { file: lists, list: pinned.list } });
      s = reweightRun(dir, stream, { root, barsFiles, rates: nat.rates, listOf: nat.listOf, momentOf: nat.momentOf, seed });
    }
    for (const d of s.days) days.push({ ...d, day: `${k + 1}:${d.day}` });
    source.push({ runId: run.runId, role: l.role, days: s.days.length, trades: s.trades.length, reweighted: Boolean(s.reweighted) });
  });
  return { stream: { ...STREAM_BASE, days, trades: days.flatMap(d => d.trades) }, source };
}
const STREAM_BASE = Object.freeze({ source: 'model', excluded: [], overlaps: [] });

const pctText = x => `${(x * 100).toFixed(1)}%`;

/** The document's summary, for the CLI's show (and the user; never the model). */
function documentText(doc) {
  const lines = [`account states ${doc.hash.slice(0, 16)} on ${doc.account}: ${doc.draws.length} draws from ${doc.paths} paths (seed ${doc.seed}), from ${doc.source.map(s => `${s.runId} (${s.days} days, ${s.trades} trades)`).join(', ') || 'no named runs'}`];
  for (const b of PRACTICE_BUCKETS) {
    if (!doc.population[b]) continue;
    lines.push(`  ${b}: ${doc.population[b]} moments on the paths (natural ${pctText(doc.natural[b])}); drawn ${doc.sampled[b]} (x${doc.oversample[b]}), weight ${doc.weights[b]}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  sourceStream, documentText,
  LOG, readStatesLog, dayWeights, decisionWeight, practiceByState,
  KIND, VERSION, PRACTICE_BUCKETS, DEFAULT_OVERSAMPLE, DEFAULTS,
  sampleAccountStates, practiceBucketOf, drawPracticeStates, drawDocument, writeDocument, readDocument, allocate, assignStates, weightedRates, accountDigest,
  drawState,
};
