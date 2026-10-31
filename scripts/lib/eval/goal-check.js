'use strict';

/**
 * The goal regression (docs/TRAINING.md, "The goal regression"; tests/plugin/goal-regression.test.js; the CLI
 * scripts/goal-check.js): the harness's own entry, setup, stop, sizing and exit code on a fixed sample of real sessions
 * (goal-fixture.js), per half, against main's committed baseline (tests/fixtures/goal/baseline.json). A pull request
 * that moves the strategy away from the goal fails: in the owner's order, more blows, a lower combine pass rate, a
 * lower mean R or a smaller share of the trends' R caught, each beyond its tolerance (config/training.json
 * goalRegression.tolerance; blows have none: one more blow fails).
 *
 * The baseline only rises (as the promotion gate's numbers): a new baseline is written only when every gated metric
 * is at least the current one's (blows at most), and the test holds the committed baseline to the base branch's the
 * same way (riseProblems). A new fixture (another hash) starts a new baseline only with the change recorded in it
 * (fixtureChange: the hash it replaces and why), which the review (CLAUDE.md) reads. A lower baseline of the same fixture
 * is written only by an owner-approved reset (goal-check.js baseline --write --reset --why "<why>"), recorded in it
 * (reset: why, the gated metrics it replaces, the fixture, when): accepted once, by the branch that brings it (a reset
 * new against the base's, replacing exactly the base's numbers, never adding a blow); once on the base it is the
 * base's, and a later lowering without a new reset fails as before.
 *
 *   CI_FIXTURE, REAL_FIXTURE(env)  the committed slice's file; the local goal:real fixture's (under the harness home)
 *   fixtureSet(kind, env)          { kind, doc, synth, baselineFile, goldenFile } | { kind, missing }; kindOf(env): FTH_GOAL_FIXTURE
 *   blockOf(set, day)              { block, doc } of a session, in the fixture or the synthetic days
 *   GATED                          the gated metrics, in the goal's order: [{ key, label, dir, tol }] (the synthetic
 *                                  blow path, half S: its blows only)
 *   loadFixture(file)              the fixture document, with its hash (of the JSON inside the gzip)
 *   evaluate(doc, { root, env, synth })   { fixture, halves: { A, B, S } } each { sessions, trend, ...tradeStats, caught, mc, list (the trades) }
 *   summary(result)                the result without the trade lists (what a baseline holds)
 *   compare(baseline, now, tolerance)   [row]: { half, key, label, main, pr, allowed, ok, gated }
 *   regressions(rows)              the failing rows
 *   riseProblems(base, next)       [problem]: a gated metric of `next` below `base`'s (blows above); another fixture
 *                                  without its fixtureChange recorded; a reset new in `next` that isn't valid (resetProblems)
 *   gatedOf(doc)                   the gated metrics of each half: { half: { key: value } } (what a reset replaces)
 *   resetBaseline(base, now, { why, at, commit })   the owner-approved reset of the same fixture's baseline: `now` with
 *                                  reset { why, from: gatedOf(base), fixture, at, commit } recorded (throws without a why,
 *                                  a base, the same fixture, or when a blow is added)
 *   resetProblems(base, next)      [problem] of a reset new in `next`; null when `next` carries none new
 *   renderTable(rows)              the table: metric, main, this PR, allowed
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const GF = require('./goal-fixture');
const GT = require('./goal-trades');
const GM = require('./goal-metrics');
const { dayRegimes } = require('../prop/trade-stream');

const msOf = minutes => minutes * 60000;
const CFG = () => require('../tunables').training().goalRegression;

// The gated metrics, the goal's priority order: dir 'max' may not rise (blows), 'min' may not fall past its tolerance.
const GATED = Object.freeze([
  Object.freeze({ key: 'mc.blows', label: 'combine blows (paths)', dir: 'max', tol: null }),
  Object.freeze({ key: 'mc.pass', label: 'combine pass rate', dir: 'min', tol: 'passRate' }),
  Object.freeze({ key: 'meanR', label: 'mean R per trade', dir: 'min', tol: 'meanR' }),
  Object.freeze({ key: 'caught.share', label: 'R caught / R available', dir: 'min', tol: 'rCaught' }),
  // The trend legs caught, a count (no tolerance): fewer legs caught is a worse strategy for the goal even where the
  // pass rate and mean R rise on a few wide trades (the stop-floor mutation under one position after sizing).
  Object.freeze({ key: 'caught.caught', label: 'trend legs caught', dir: 'min', tol: null }),
]);
const INFO = Object.freeze([
  ['trades', 'trades'], ['mc.blow', 'combine blow rate'], ['mc.meanDaysToPass', 'sessions to pass (mean)'],
  ['caught.legs', 'trend legs'], ['falseStartShare', 'false-start share'], ['maxDrawdownR', 'max drawdown (R)'],
]);
const get = (o, key) => key.split('.').reduce((x, k) => (x && typeof x === 'object' ? x[k] : undefined), o);

// The committed CI fixture (a small real slice, its baseline and move goldens) and the local goal:real one (fetched through
// the replay broker, its files under the harness home, never the repository).
const REPO = path.resolve(__dirname, '..', '..', '..');
const CI_DIR = path.join(REPO, 'tests', 'fixtures', 'goal');
const CI_FIXTURE = path.join(CI_DIR, 'bars.json.gz');
const realDir = (env = process.env) => path.join(require('../paths').harnessHome(env), 'goal');
const REAL_FIXTURE = (env = process.env) => path.join(realDir(env), 'real-bars.json.gz');
const KINDS = Object.freeze(['ci', 'real']);

/**
 * The fixture set of a kind ('ci' the committed slice, 'real' the local one; FTH_GOAL_FIXTURE, default ci): { kind, doc,
 * synth (goal-synth.js's days), baselineFile, goldenFile } or { kind, missing } when the local fixture isn't built.
 */
function fixtureSet(kind = 'ci', env = process.env) {
  if (!KINDS.includes(kind)) throw new Error(`FTH_GOAL_FIXTURE: ${KINDS.join(' or ')}, not ${kind}`);
  const dir = kind === 'ci' ? CI_DIR : realDir(env);
  const file = kind === 'ci' ? CI_FIXTURE : REAL_FIXTURE(env);
  if (!fs.existsSync(file)) return { kind, missing: `no ${kind} goal fixture at ${file}${kind === 'real' ? ' (build it: node scripts/goal-fixture.js --replay-config <replay config.json> --symbol MNQ)' : ''}` };
  return { kind, doc: loadFixture(file), synth: require('./goal-synth').synthFixture(), baselineFile: path.join(dir, kind === 'ci' ? 'baseline.json' : 'baseline-real.json'), goldenFile: path.join(dir, kind === 'ci' ? 'move-scenarios.json' : 'move-scenarios-real.json') };
}
const kindOf = (env = process.env) => env.FTH_GOAL_FIXTURE || 'ci';

/** The block of a session, in the fixture or the synthetic days: { block, doc }. */
function blockOf(set, day) {
  for (const doc of [set.doc, set.synth]) { const block = doc.blocks.find(b => b.sessions.includes(day)); if (block) return { block, doc }; }
  return null;
}

function loadFixture(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const doc = JSON.parse(text);
  if (!doc || doc.kind !== 'goal-fixture' || !Array.isArray(doc.blocks)) throw new Error(`${file}: not a goal fixture`);
  return { ...doc, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

function evaluate(doc, { root, env = {}, synth = null }) {
  const cfg = CFG();
  const P = GT.shippedOf(root, env);
  if (P.baseMinutes !== doc.minutes) throw new Error(`the chain enters on the ${P.entryRule.chain.entry}; the fixture's bars are ${doc.minutes}m`);
  const tfMs = msOf(doc.minutes);
  const ctx = GM.mcContext(P, { root, env, symbol: doc.symbol });
  const tick = require('../trading/contracts').tickOf(doc.symbol);
  const falseStartPeakR = require('../tunables').training().trendReport.falseStartPeakR;
  const halves = {};
  // Halves A and B of the fixture, and S: the synthetic blow path (goal-synth.js), gated on its blows.
  const groups = [['A', doc.blocks.filter(x => x.half === 'A')], ['B', doc.blocks.filter(x => x.half === 'B')], ...(synth ? [['S', synth.blocks.filter(x => x.half === 'S')]] : [])];
  for (const [half, blocks] of groups) {
    const trades = [];
    const legs = [];
    const days = [];
    const regimes = [];
    let trend = 0;
    for (const b of blocks) {
      const bars = GF.decodeBars(b.bars);
      trades.push(...GT.blockTrades(bars, b.sessions, P, { symbol: doc.symbol }).candidates);
      legs.push(...GM.trendLegs(bars, b.sessions, { session: P.session, minutes: doc.minutes }));
      const reg = dayRegimes(bars.map(x => ({ ...x, ms: Date.parse(x.t) })), tfMs);
      for (const d of b.sessions) { days.push(d); regimes.push(reg.get(d) || 'normal'); }
      trend += b.trend.length;
    }
    // The candidates meet the account: the trade metrics on what live takes in the sessions' order, the combine on
    // each path's own (one position at a time after sizing, both).
    const taken = GM.walkTaken({ trades, days, regimes, ctx, symbol: doc.symbol });
    const ts = GM.tradeStats(taken, { falseStartPeakR, tick });
    halves[half] = {
      sessions: days.length, trend, ...ts,
      caught: GM.caught(taken, legs, { refRiskPts: ts.medianRiskPts }),
      mc: GM.combineMc({ trades, days, regimes, ctx, sessions: ctx.account.sessions, paths: cfg.monteCarlo.paths, seed: cfg.monteCarlo.seed, meanBlock: cfg.monteCarlo.meanBlock, symbol: doc.symbol }),
      list: taken,
    };
  }
  return { fixture: synth ? crypto.createHash('sha256').update(`${doc.hash}|${synth.hash}`).digest('hex') : doc.hash, halves };
}

function summary(result) {
  const halves = Object.fromEntries(Object.entries(result.halves).map(([h, { list: _l, ...m }]) => [h, m]));
  return { fixture: result.fixture, halves };
}

// The synthetic blow path is gated on its blows alone (its pass rate and R are a stress's, not the goal's).
const gatedFor = half => (half === 'S' ? GATED.filter(g => g.key === 'mc.blows') : GATED);
const halvesOf = d => Object.keys(d.halves).sort();

function compare(baseline, now, tolerance) {
  const rows = [];
  for (const half of [...new Set([...halvesOf(baseline), ...halvesOf(now)])].sort()) {
    const b = baseline.halves[half] || {};
    const n = now.halves[half] || {};
    for (const g of gatedFor(half)) {
      const main = get(b, g.key);
      const pr = get(n, g.key);
      const tol = g.tol ? tolerance[g.tol] : 0;
      const allowed = g.dir === 'max' ? main : Math.round((main - tol) * 1e4) / 1e4;
      const ok = typeof pr === 'number' && (g.dir === 'max' ? pr <= allowed : pr >= allowed);
      rows.push({ half, key: g.key, label: g.label, main, pr, allowed: `${g.dir === 'max' ? '<=' : '>='} ${allowed}`, ok, gated: true });
    }
    for (const [key, label] of INFO) rows.push({ half, key, label, main: get(b, key), pr: get(n, key), allowed: '(report)', ok: true, gated: false });
  }
  return rows;
}

const regressions = rows => rows.filter(r => r.gated && !r.ok);

// The gated metrics of each half (what a reset replaces, recorded in it): { half: { key: value } }.
const gatedOf = d => Object.fromEntries(halvesOf(d).map(h => [h, Object.fromEntries(gatedFor(h).map(g => [g.key, get(d.halves[h], g.key) ?? null]))]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// Blows never rise, a reset included (the owner's first rule): no half, the blow path included, blows more than the base's.
const blowProblems = (base, next, what) => halvesOf(base).flatMap(half => {
  const was = get(base.halves[half], 'mc.blows');
  const is = get((next.halves || {})[half], 'mc.blows');
  return typeof is !== 'number' || is > was ? [`half ${half} combine blows: ${is} in the new baseline, ${was} on the base branch: ${what} never adds a blow`] : [];
});

/** The problems of a reset new in `next` (not the base's own): null when `next` carries none new. */
function resetProblems(base, next) {
  const r = next && next.reset;
  if (!r || (base && same(base.reset, r))) return null;
  if (!base) return ['a reset with no base baseline to reset'];
  const out = [];
  if (!(typeof r.why === 'string' && r.why.trim())) out.push('the reset records no why (the owner\'s approval): --reset --why "<why>"');
  if (!(typeof r.at === 'string' && r.at.trim())) out.push('the reset records no at (when it was written)');
  if (!(r.fixture === base.fixture && next.fixture === base.fixture)) out.push(`the reset is of fixture ${r.fixture} (the base's ${base.fixture}, the new baseline's ${next.fixture}): a reset keeps the fixture`);
  if (!same(r.from, gatedOf(base))) out.push('the reset\'s from is not the base branch\'s gated metrics: re-run the reset on the current base');
  return [...out, ...blowProblems(base, next, 'a reset')];
}

function resetBaseline(base, now, { why, at, commit = null } = {}) {
  if (!(typeof why === 'string' && why.trim())) throw new Error('refused: a reset needs --why "<the owner\'s approval and reason>"');
  if (!base) throw new Error('refused: no baseline to reset (write the first one with baseline --write)');
  if (base.fixture !== now.fixture) throw new Error('refused: a reset keeps the fixture (another fixture: --new-fixture --why "<why>")');
  const next = { ...base, ...now, reset: { why: why.trim(), from: gatedOf(base), fixture: base.fixture, at, ...(commit ? { commit } : {}) } };
  const problems = resetProblems(base, next) || ['the reset is the base\'s own'];
  if (problems.length) throw new Error(`refused: ${problems.join('\n')}`);
  return next;
}

function riseProblems(base, next) {
  if (!base || !next) return [];
  // An owner-approved reset of the same fixture, new in `next`: accepted once (it replaces the base's numbers exactly).
  const reset = resetProblems(base, next);
  if (reset) return reset;
  // A new fixture starts a new baseline only with the change recorded: the hash it replaces and why (the review reads it).
  if (base.fixture !== next.fixture) {
    const c = next.fixtureChange;
    if (!(c && c.from === base.fixture && typeof c.why === 'string' && c.why.trim())) return [`the fixture changed (${base.fixture} on the base branch, ${next.fixture} now) with no fixtureChange { from: the base's hash, why } recorded in the baseline: node scripts/goal-check.js baseline --write --new-fixture --why "<why>"`];
    // Even a new fixture never takes a blow back: no half, nor the blow path, blows more than the base's, and the blow
    // path stays as harsh (as many trades, a mean R no higher: a fixture change can't gut the stress it carries).
    const out = blowProblems(base, next, 'a fixture change');
    const s0 = base.halves.S;
    const s1 = (next.halves || {}).S;
    if (s0 && !(s1 && s1.meanR <= s0.meanR && s1.trades >= s0.trades)) out.push(`the blow path: ${s1 ? `${s1.trades} trades, mean R ${s1.meanR}` : 'gone'} in the new fixture's baseline, ${s0.trades} trades and ${s0.meanR} on the base branch: a fixture change never softens it`);
    return out;
  }
  const out = [];
  for (const half of halvesOf(base)) {
    for (const g of gatedFor(half)) {
      const was = get(base.halves[half], g.key);
      const is = get((next.halves || {})[half], g.key);
      const worse = typeof is !== 'number' || (g.dir === 'max' ? is > was : is < was);
      if (worse) out.push(`half ${half} ${g.label}: ${is} in the new baseline, ${was} on the base branch: a baseline only improves (blows fall, the rest rise)`);
    }
  }
  return out;
}

function renderTable(rows) {
  const head = ['half', 'metric', 'main', 'this PR', 'allowed', ''];
  const body = rows.map(r => [r.half, r.label, String(r.main ?? '-'), String(r.pr ?? '-'), r.allowed, r.gated ? (r.ok ? 'ok' : 'FAIL') : '']);
  const w = head.map((h, i) => Math.max(h.length, ...body.map(x => x[i].length)));
  const line = cells => cells.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map(x => '-'.repeat(x))), ...body.map(line)].join('\n');
}

module.exports = { CI_FIXTURE, REAL_FIXTURE, KINDS, fixtureSet, kindOf, blockOf, GATED, loadFixture, evaluate, summary, compare, regressions, gatedOf, resetBaseline, resetProblems, riseProblems, renderTable };
