'use strict';

// The training loop's model-scoring verifier and its keep rule (scripts/lib/train/model-verifier.js): scripted
// champion and challenger results (the paired Monte Carlo's shape, prop/evaluator.js scorePaired, and scorecard
// decisions) through decide, verify and combine; the two sides' rulebooks read from real trees; and verify end to end
// with its default parts on replay runs. The loop wiring: tests/lib/train-loop.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MV = require('../../scripts/lib/train/model-verifier');
const { DECISION_RULE, judge, pairUp } = require('../../scripts/lib/train/paired');
const { PROMOTION_GATE } = require('../../scripts/lib/prop/promotion');
const { checkModelWindow } = require('../../scripts/lib/prop/evaluator');
const { streamFor } = require('../../scripts/lib/prop/stats');
const { loadStrategies } = require('../../scripts/lib/trading/strategies');
const { record, multiDayRun, weekdays } = require('../fixtures/prop-model');

const REPO = path.join(__dirname, '..', '..');
const iv = (diff, lo, hi) => ({ diff, lo, hi, level: 0.9, n: 60 });
const ZERO = iv(0, -0.05, 0.05);
const NONE = iv(null, null, null);
/** n real start days: the champion passes on every aEvery-th, the challenger on every bEvery-th (0: never). */
const startsOf = (n, aEvery = 6, bEvery = 6) => Array.from({ length: n }, (_, i) => ({
  start: `s${i}`, a: aEvery && i % aEvery === 0 ? 'passed' : 'timeout', b: bEvery && i % bEvery === 0 ? 'passed' : 'timeout',
}));
/** A pairRuns result (A champion, B challenger; every difference A minus B). */
function mc({ blowsA = 0, blowsB = 0, starts = startsOf(60), real = {}, rs = {}, runDays = 90, sessions = 30, score = 'real', level = 0.9 } = {}) {
  const side = { passRate: 0.3, blowRate: 0, medianDaysToPass: 20 };
  return {
    a: { real: side, resampled: side, score }, b: { real: side, resampled: side, score }, starts,
    diff: {
      real: { passRate: ZERO, blowRate: ZERO, timeoutRate: ZERO, medianDaysToPass: NONE, ...real },
      resampled: { passRate: ZERO, blowRate: ZERO, timeoutRate: ZERO, medianDaysToPass: NONE, ...rs },
    },
    blows: { a: blowsA, b: blowsB }, inputs: { sessions, days: runDays, level, seed: 3, reps: 400 },
  };
}
// The challenger passes on 30 of 60 start days, the champion on 10, where the challenger passes too.
const BETTER = { starts: startsOf(60, 6, 2) };
const decisions = (cats, prefix = 't') => cats.map((category, i) => ({ key: `${prefix}${i}|MNQ`, category }));
const many = (n, x) => Array(n).fill(x);
const SAME = MV.adherence(decisions(many(30, 'right')), decisions(many(30, 'right')));
const readMap = (n, check = true, prefix = 'MNQ|') => new Map(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, [{ check }]]));
const READS = MV.reads(readMap(30), readMap(30));
const win = (m, over = {}) => ({ label: 'w0', mc: m, adherence: SAME, reads: READS, ...over });

test('the keep rule: a challenger that passes more on the real attempts, zero blows, decisions not worse, is kept', () => {
  const v = MV.decide([win(mc(BETTER))]);
  assert.strictEqual(v.verdict, 'kept', v.reasons.join('; '));
  assert.ok(v.pooled.hi < 0 && v.pooled.n === 60, JSON.stringify(v.pooled));
  assert.match(v.reasons[0], /pooled pass rate on 60 real attempts better for the challenger/);
  assert.ok(Object.isFrozen(MV.KEEP_RULE));
  assert.deepStrictEqual({ ...MV.KEEP_RULE }, { maxChallengerBlows: 0, level: 0.9, primary: 'passRate', minBlocks: 2, minOverlap: 0.5 });
});

test('(a) a challenger that adds return but adds a blow is rejected, whatever it gains', () => {
  for (const blowsB of [1, 7]) {
    const v = MV.decide([win(mc({ ...BETTER, blowsB }))]);
    assert.strictEqual(v.verdict, 'rejected');
    assert.match(v.reasons[0], /^\(a\) .*blow.*hard rule/);
  }
  // A blow in any window rejects: they are summed over the windows.
  assert.strictEqual(MV.decide([win(mc(BETTER)), win(mc({ ...BETTER, blowsB: 1 }), { label: 'w1' })]).verdict, 'rejected');
  // The champion's blows don't count against the challenger.
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, blowsA: 5 }))]).verdict, 'kept');
});

test('F1: the gain is judged on the real attempts only; the resampled intervals (Monte Carlo precision) never keep a change', () => {
  // No difference on the real start days, but a tight resampled "gain" (as 20000 paths give any effect): not kept.
  const tight = MV.decide([win(mc({ rs: { passRate: iv(-0.2, -0.201, -0.199), medianDaysToPass: iv(5, 4, 6) } }))]);
  assert.strictEqual(tight.verdict, 'rejected');
  assert.match(tight.reasons[0], /no significant gain/);
  // Real per-window intervals clear of 0 don't keep it either: only the pooled start-day interval does.
  assert.strictEqual(MV.decide([win(mc({ real: { passRate: iv(-0.2, -0.3, -0.1), medianDaysToPass: iv(4, 2, 6) } }))]).verdict, 'rejected');
  // The resampled pass rate is not read by (c): a real gain with a resampled "loss" is kept (it is conditional on the days).
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, rs: { passRate: iv(0.2, 0.19, 0.21) } }))]).verdict, 'kept');
  // (b) still reads the resampled blow rate: worse rejects.
  assert.match(MV.decide([win(mc({ ...BETTER, rs: { blowRate: iv(-0.05, -0.08, -0.01) } }))]).reasons.join(';'), /\(b\) w0: blow rate significantly worse on the resampled paths \(conditional/);
});

test('F2: a window needs two independent blocks of S real start days (about 3 x S days); fewer shows nothing', () => {
  const zero = MV.decide([win(mc({ starts: [], real: { passRate: NONE, blowRate: NONE }, runDays: 30 }))]);
  assert.strictEqual(zero.verdict, 'inconclusive');
  assert.match(zero.reasons[0], /0 real attempt\(s\) over 30 day\(s\), under 2 independent blocks of 30 start days \(about 90 days\)/);
  // 59 start days (89 days): one block short, inconclusive, though the gain is there.
  const short = MV.decide([win(mc({ starts: startsOf(59, 6, 2), runDays: 89 }))]);
  assert.strictEqual(short.verdict, 'inconclusive');
  assert.match(short.reasons[0], /^w0: 59 real attempt\(s\) over 89 day\(s\)/);
  // A degenerate real interval (too few blocks to resample) shows nothing either.
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, real: { passRate: { ...iv(-0.3, -1, 1), degenerate: true } } }))]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, real: { blowRate: { ...iv(0, -1, 1), degenerate: true } } }))]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, sessions: 31 }))]).verdict, 'inconclusive', '60 start days are under two blocks of 31');
  assert.strictEqual(MV.decide([win(mc(BETTER))]).verdict, 'kept');
});

test('F4 (c): one pooled interval over every window; no window significantly worse on the real attempts', () => {
  // A gain in one window and none in another: the pooled interval decides (here it excludes 0).
  const pooled = MV.decide([win(mc(BETTER)), win(mc(), { label: 'w1' })]);
  assert.strictEqual(pooled.verdict, 'kept', pooled.reasons.join(';'));
  assert.strictEqual(pooled.pooled.n, 120);
  // Each window significantly worse on its real attempts rejects, even beside a pooled gain.
  const worse = [
    [{ passRate: iv(0.1, 0.05, 0.15) }, /\(c\) w1: pass rate significantly worse on the real attempts/],
    [{ blowRate: iv(-0.05, -0.08, -0.01) }, /\(c\) w1: blow rate significantly worse on the real attempts/],
    [{ medianDaysToPass: iv(-4, -6, -2) }, /\(c\) w1: median days to pass significantly more on the real attempts/],
  ];
  for (const [real, re] of worse) {
    const v = MV.decide([win(mc(BETTER)), win(mc({ ...BETTER, real }), { label: 'w1' })]);
    assert.strictEqual(v.verdict, 'rejected');
    assert.match(v.reasons.join(';'), re);
  }
  // A small gain on a few neighbouring start days: the interval reaches 0, so not kept.
  const tiny = startsOf(60, 0, 0).map((x, i) => (i < 3 ? { ...x, b: 'passed' } : x));
  const t = MV.decide([win(mc({ starts: tiny }))]);
  assert.ok(t.pooled.lo < 0 && t.pooled.hi === 0, JSON.stringify(t.pooled));
  assert.strictEqual(t.verdict, 'rejected');
  // A window that is worse on the start days drags the pooled interval to 0: not kept.
  assert.strictEqual(MV.decide([win(mc(BETTER)), win(mc({ starts: startsOf(60, 2, 6) }), { label: 'w1' })]).verdict, 'rejected');
  // Windows of different sessions don't pool.
  assert.strictEqual(MV.decide([win(mc(BETTER)), win(mc({ ...BETTER, sessions: 20 }), { label: 'w1' })]).verdict, 'inconclusive');
});

test('pooledInterval: a block bootstrap inside each window (no block runs across two), degenerate under two blocks', () => {
  const rand = () => streamFor(3, 'x');
  // Each window constant: a stratified draw gives each its own sum, so the interval is the point.
  const strat = MV.pooledInterval([many(60, -1), many(60, 0)], { block: 30, reps: 200, level: 0.9, rand: rand() });
  assert.deepStrictEqual([strat.diff, strat.lo, strat.hi, strat.n, strat.degenerate], [-0.5, -0.5, -0.5, 120, undefined]);
  const d = MV.pooledInterval([many(60, -1), many(59, 0)], { block: 30, reps: 200, level: 0.9, rand: rand() });
  assert.deepStrictEqual([d.degenerate, d.lo, d.hi], [true, -1, 1]);
  assert.strictEqual(MV.pooledInterval([], { block: 30, reps: 10, level: 0.9, rand: rand() }).degenerate, true);
  // Mixed outcomes: an interval around the mean, inside the range.
  const mixed = MV.pooledInterval([startsOf(60, 6, 2).map(x => (x.a === 'passed') - (x.b === 'passed'))], { block: 30, reps: 400, level: 0.9, rand: rand() });
  assert.ok(mixed.lo <= mixed.diff && mixed.diff <= mixed.hi && mixed.hi < 0, JSON.stringify(mixed));
});

test('(d): process adherence or the correct-read rate significantly worse rejects a Monte Carlo gain', () => {
  const broken = MV.adherence(decisions(many(30, 'right')), decisions([...many(8, 'wrong-side entry'), ...many(22, 'right')]));
  assert.deepStrictEqual([broken.b, broken.c], [0, 8]);
  const v = MV.decide([win(mc(BETTER), { adherence: broken })]);
  assert.strictEqual(v.verdict, 'rejected');
  assert.match(v.reasons[0], /\(d\) w0: process adherence significantly worse/);
  // Under minDiscordant broken decisions is not significant (noise); a stricter loop rule catches the same few.
  const few = MV.adherence(decisions(many(30, 'right')), decisions([...many(DECISION_RULE.minDiscordant - 1, 'bad size'), ...many(30 - DECISION_RULE.minDiscordant + 1, 'right')]));
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: few })]).verdict, 'kept');
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: few })], { rule: { ...DECISION_RULE, minDiscordant: 5 } }).verdict, 'rejected');
  const bad = new Map([...readMap(30)].map(([key], i) => [key, i < 8 ? [{ check: true }, { check: false }] : [{ check: 'true' }]]));
  const r = MV.reads(readMap(30), bad);
  assert.deepStrictEqual([r.b, r.c, r.decisions, r.overlap], [0, 8, 30, 1]);
  assert.match(MV.decide([win(mc(BETTER), { reads: r })]).reasons[0], /\(d\) w0: correct-read rate significantly worse/);
  // A decision only the challenger made, a failure, counts against it.
  assert.strictEqual(MV.adherence(decisions(many(5, 'right')), [...decisions(many(5, 'right')), ...decisions(many(8, 'wrong-side entry'), 'x')]).c, 8);
});

test('F3: (d) never passes on nothing: too few paired decisions, a challenger that stops reading or keys its decisions apart', () => {
  // Zero decisions, or under the rule's minPairs: not measured, never kept.
  const none = MV.decide([win(mc(BETTER), { adherence: MV.adherence([], []) })]);
  assert.strictEqual(none.verdict, 'inconclusive');
  assert.match(none.reasons[0], /process adherence: 0 paired decision\(s\), under the rule's minimum of 20/);
  const n19 = MV.adherence(decisions(many(19, 'right')), decisions(many(19, 'right')));
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: n19 })]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(mc(BETTER), { reads: MV.reads(readMap(19), readMap(19)) })]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: n19 })], { rule: { ...DECISION_RULE, minPairs: 19 } }).verdict, 'kept');
  // The challenger stops emitting reads: each read the champion made is a failure on its side, never a vacuous pass.
  const stopped = MV.reads(readMap(30), new Map());
  assert.deepStrictEqual([stopped.c, stopped.decisions, stopped.overlap], [30, 30, 0]);
  assert.strictEqual(MV.decide([win(mc(BETTER), { reads: stopped })]).verdict, 'rejected');
  // ... and where the champion's reads were all false (no discordance to test), the missing pairing is inconclusive.
  const quiet = MV.reads(readMap(30, false), new Map());
  assert.strictEqual(quiet.n, 0);
  const q = MV.decide([win(mc(BETTER), { reads: quiet })]);
  assert.strictEqual(q.verdict, 'inconclusive');
  assert.match(q.reasons[0], /correct-read rate: the challenger decided on 0% of the champion's keys .* don't pair/);
  // Decisions keyed apart: the champion's failed where the challenger, on other keys, is all right: no discordance,
  // so without the overlap check (d) would pass; it is inconclusive.
  const apart = MV.adherence(decisions(many(30, 'wrong-side entry')), decisions(many(30, 'right'), 'x'));
  assert.deepStrictEqual([apart.n, apart.overlap], [0, 0]);
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: apart })]).verdict, 'inconclusive');
  const half = MV.adherence(decisions(many(30, 'right')), decisions(many(15, 'right')).concat(decisions(many(15, 'right'), 'x')));
  assert.strictEqual(half.overlap, 0.5);
});

test('what can\'t be measured is never a pass: no reads, a low interval level, no windows, no Monte Carlo', () => {
  const noReads = MV.decide([win(mc(BETTER), { reads: null, readsWhy: 'run not finished' })]);
  assert.strictEqual(noReads.verdict, 'inconclusive');
  assert.match(noReads.reasons[0], /correct-read rate not measured \(run not finished\)/);
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: null })]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, level: 0.8 }))]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(null)]).verdict, 'inconclusive');
  const noStarts = mc(BETTER);
  delete noStarts.starts;
  assert.strictEqual(MV.decide([win(noStarts)]).verdict, 'inconclusive');
  // A rejection still wins over what is unmeasured.
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, blowsB: 1 }), { reads: null })]).verdict, 'rejected');
});

test('a curated (diagnostic) score keeps on tuning only, labelled; it never judges held out or promotes', () => {
  const t = MV.decide([win(mc({ ...BETTER, score: 'diagnostic (setup-focused)' }))]);
  assert.deepStrictEqual([t.verdict, t.diagnostic], ['kept', true]);
  assert.match(t.reasons[0], /never a promotion/);
  const h = MV.decide([win(mc({ ...BETTER, score: 'diagnostic (reweighted)' }))], { heldOut: true });
  assert.strictEqual(h.verdict, 'inconclusive');
  assert.match(h.reasons.join(';'), /diagnostic score .* never judges held-out months/);
  assert.strictEqual(MV.decide([win(mc(BETTER))], { heldOut: true }).verdict, 'kept');
  for (const side of ['a', 'b']) {
    const m = mc(BETTER);
    m[side] = { ...m[side], score: 'diagnostic (setup-focused)' };
    assert.strictEqual(MV.decide([win(m)], { heldOut: true }).verdict, 'inconclusive', side);
  }
});

test('splits: tuning on practice-train only; held out inside one held-back learning window', () => {
  assert.deepStrictEqual(MV.windowErrors([{ from: '2022-03-09', to: '2022-04-09' }], [{ from: '2024-08-01', to: '2024-10-01' }, { from: '2025-02-03', to: '2025-04-01' }]), []);
  for (const w of [{ from: '2024-07-01', to: '2024-08-01' }, { from: '2024-06-01', to: '2024-08-01' }, { from: '2025-02-01', to: '2025-03-01' }, { from: '2019-01-01', to: '2019-02-01' }]) {
    assert.match(MV.windowErrors([w], [])[0], /tunes on practice-train only/, JSON.stringify(w));
  }
  for (const w of [{ from: '2023-09-13', to: '2023-09-14' }, { from: '2024-12-01', to: '2025-02-01' }]) {
    assert.match(MV.windowErrors([], [w])[0], /judges held out inside one of practice-validate, test, final/, JSON.stringify(w));
  }
});

test('W1 lookErrors: judging needs two looks per sealed window; refused up front when the budget left can\'t hold them', () => {
  const T = w => ({ from: `2025-0${w}-03`, to: `2025-0${w}-04` });
  const spent = n => Array.from({ length: n }, (_, i) => ({ kind: 'look', evaluation: `e${i}`, candidate: 'c', purpose: 'judging', runId: `r${i}`, from: '2025-05-05', to: '2025-05-06', role: 'test' }));
  assert.deepStrictEqual(MV.lookErrors([T(3)], []), []);
  assert.match(MV.lookErrors([T(3), T(4)], [])[0], /^test: judging these windows takes 4 look\(s\) .* 3 of its 3 are left: refused before any look is spent/);
  assert.deepStrictEqual(MV.lookErrors([T(3)], spent(1)), []);
  assert.match(MV.lookErrors([T(3)], spent(2))[0], /takes 2 look\(s\).* 1 of its 3 are left/);
  // A score or a validate look spends nothing; practice-validate has no budget.
  assert.deepStrictEqual(MV.lookErrors([T(3)], [...spent(1), { kind: 'score', evaluation: 'e9', runId: 'r9', role: 'test' }]), []);
  assert.deepStrictEqual(MV.lookErrors([{ from: '2024-09-10', to: '2024-09-11' }, { from: '2024-09-12', to: '2024-09-13' }], []), []);
  // Final: one look, so model-scored judging (two) is always refused there.
  assert.match(MV.lookErrors([{ from: '2026-03-03', to: '2026-03-04' }], [])[0], /^final: .* 2 look\(s\).* 1 of its 1 are left/);
  assert.deepStrictEqual(MV.lookErrors([T(3), T(4), T(5)], [], { perWindow: 1 }), []);
});

test('resolveModelScore: an account; the seed is the loop\'s; faults parsed; bad settings refused', () => {
  assert.strictEqual(MV.resolveModelScore(undefined), null);
  assert.deepStrictEqual(MV.resolveModelScore({ account: 'acct_a' }), { account: 'acct_a', paths: 2000, reps: 2000, faults: {} });
  assert.deepStrictEqual(MV.resolveModelScore({ account: 'acct_a', paths: 500, faults: 'stop=0.01,outage=0' }).faults, { stopFault: 0.01, outage: 0, measured: true });
  assert.throws(() => MV.resolveModelScore({ account: 'acct_a', seed: 2 }), /modelScore.seed: not a setting/);
  assert.throws(() => MV.resolveModelScore({}), /modelScore.account/);
  assert.throws(() => MV.resolveModelScore({ account: 'a', paths: 10 }), /modelScore.paths/);
  assert.throws(() => MV.resolveModelScore({ account: 'a', faults: 'stop=2' }), /modelScore.faults/);
  assert.throws(() => MV.resolveModelScore([]), /an object/);
});

const ACCT = { name: 'acct_a', sessions: 30 };
const POL = { name: 'pol', sizing: { cap_usd: 1 } };
const ONE = { account: ACCT, policy: POL, accountB: ACCT, policyB: POL, candidateB: false, firmDiffers: false, policyMissing: false, loosenings: [], pairing: 'one rulebook' };
/** verify's deps, scripted: the sides, the paired Monte Carlo per window, the reads, the one-side score. */
function deps({ result = mc(BETTER), sides = {}, seen = [], promotion = { passes: false, failures: ['too small an out-of-sample test'] } } = {}) {
  return {
    sides: () => ({ ...ONE, ...sides }),
    pair: (a, b, opts) => { seen.push({ a, b, opts }); return typeof result === 'function' ? result(a, b, opts) : result; },
    reads: () => readMap(30),
    scoreOne: () => ({ promotion }),
  };
}
const PAIRS = [{ label: 'w0', champion: { runDir: '/c0', decisions: decisions(many(30, 'right')) }, candidate: { runDir: '/x0', decisions: decisions(many(30, 'right')) } }];
const CFG = { account: 'acct_a', paths: 500, reps: 400, faults: {} };

test('verify: each window\'s two runs through one paired Monte Carlo on the loop\'s seed, champion first; the verdict is the keep rule\'s', () => {
  const seen = [];
  const v = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/champ', candidateRoot: '/cand', deps: deps({ seen }) });
  assert.strictEqual(v.verdict, 'kept', v.reasons.join(';'));
  const o = seen[0].opts;
  assert.deepStrictEqual([seen[0].a, seen[0].b, o.seed, o.paths, o.reps, o.root, o.rootB, o.account.name, o.policy.name, o.accountB.name, o.policyB.name, o.candidateB], ['/c0', '/x0', 3, 500, 400, '/champ', '/cand', 'acct_a', 'pol', 'acct_a', 'pol', false]);
  // The window's figures: the real attempts' evidence; the resampled ones labelled conditional.
  const w = v.windows[0];
  assert.deepStrictEqual([w.blows.b, w.attempts, w.days, v.pairing], [0, 60, 90, 'one rulebook']);
  assert.deepStrictEqual(w.diff.passRate, { diff: 0, lo: -0.05, hi: 0.05 });
  assert.match(w.resampled.conditional, /conditional on this window's days .* \(a\) and \(b\) only/);
  assert.ok(v.pooled && v.pooled.hi < 0);
  assert.strictEqual(v.promotion, undefined, 'tuning reports no promotion');
  assert.strictEqual(MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: deps({ result: mc({ ...BETTER, blowsB: 1 }) }) }).verdict, 'rejected');
  assert.strictEqual(MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: deps({ result: mc() }) }).verdict, 'rejected');
  assert.deepStrictEqual(MV.verify({ cfg: null, pairs: PAIRS }).available, false);
});

test('verify fails closed: a score that throws, a sealed run without its look, unreadable reads', () => {
  const thrown = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: deps({ result: () => { throw new Error('1 entry without a settled outcome'); } }) });
  assert.deepStrictEqual([thrown.verdict, thrown.available], ['blocked', true]);
  assert.match(thrown.reasons[0], /could not score the runs: 1 entry without a settled outcome/);
  const sealed = () => { checkModelWindow({ run: { runId: 'r', learning: true, role: 'test', from: '2025-02-03', to: '2025-04-01' }, logScore: () => {} }); return mc(BETTER); };
  const s = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', heldOut: true, deps: deps({ result: sealed }) });
  assert.strictEqual(s.verdict, 'blocked');
  assert.match(s.reasons[0], /carries no look/);
  const r = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: { ...deps(), reads: () => { throw new Error('not finished'); } } });
  assert.strictEqual(r.verdict, 'inconclusive');
});

test('W2 verify: the account must be the same; a policy added or removed is blocked; a loosened rulebook is rejected unscored; a candidate rulebook is labelled and never promoted', () => {
  const seen = [];
  const firm = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', deps: deps({ seen, sides: { firmDiffers: true } }) });
  assert.strictEqual(firm.verdict, 'blocked');
  assert.match(firm.reasons[0], /firm rules/);
  assert.strictEqual(MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', deps: deps({ seen, sides: { policyMissing: true } }) }).verdict, 'blocked');
  const loose = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', deps: deps({ seen, sides: { loosenings: ['policies.p.sizing.cap_usd: 1 -> 2 is looser'] } }) });
  assert.deepStrictEqual([loose.verdict, loose.reasons], ['rejected', ['the rulebook guard: policies.p.sizing.cap_usd: 1 -> 2 is looser']]);
  assert.strictEqual(seen.length, 0, 'none of them is scored');
  const B = { name: 'pol', sizing: { cap_usd: 0.5 } };
  const cand = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', heldOut: true, deps: deps({ seen, sides: { policyB: B, candidateB: true, pairing: 'different sizing (the same exit)' } }) });
  assert.strictEqual(cand.verdict, 'kept');
  assert.deepStrictEqual([seen[0].opts.policy, seen[0].opts.policyB, seen[0].opts.candidateB], [POL, B, true]);
  assert.strictEqual(cand.pairing, 'different sizing (the same exit)');
  assert.deepStrictEqual(cand.promotion, [{ label: 'w0', passes: false, failures: ['a candidate rulebook: the promotion gate judges the account\'s adopted rulebook, never a candidate'] }]);
});

test('held out: the frozen promotion gate\'s verdict is reported beside the keep rule, never replaced; a kept change is not promoted', () => {
  const v = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', heldOut: true, deps: deps() });
  assert.strictEqual(v.verdict, 'kept');
  assert.deepStrictEqual(v.promotion, [{ label: 'w0', passes: false, failures: ['too small an out-of-sample test'] }]);
  const failing = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', heldOut: true, deps: { ...deps(), scoreOne: () => { throw new Error('no account'); } } });
  assert.deepStrictEqual(failing.promotion, [{ label: 'w0', passes: false, failures: ['no account'] }]);
  assert.deepStrictEqual({ ...PROMOTION_GATE }, { minPassRate: 0.4, maxBlows: 0, minAttempts: 20, minMonths: 2 });
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'train', 'model-verifier.js'), 'utf8');
  assert.doesNotMatch(src, /PROMOTION_GATE|gateFailures\(/, 'the verifier never re-implements or calls around the gate');
});

/** A tree with the repository's accounts and strategies, edited by `edit(dir, account)`. */
const POLICY = loadStrategies(REPO).strategies.find(s => s.signal === 'policy' && s.valid !== false);
function tree(edit = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-mv-tree-'));
  for (const d of ['accounts', 'strategies']) fs.cpSync(path.join(REPO, d), path.join(dir, d), { recursive: true });
  if (edit) edit(dir, POLICY.account);
  return dir;
}
const editFile = (file, from, to) => {
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, from);
  fs.writeFileSync(file, text.replace(from, to));
};
const book = (dir, acct) => path.join(dir, 'accounts', acct, 'RULEBOOK.md');

test('W2 the two sides\' rulebooks from real trees: one rulebook; a tightened sizing a candidate; a loosened limit refused; another exit labelled; another account blocked', () => {
  const champ = tree();
  const run = (cand) => {
    const seen = [];
    const v = MV.verify({ cfg: { ...CFG, account: POLICY.account }, pairs: PAIRS, seed: 3, root: champ, candidateRoot: cand, env: {}, deps: { pair: deps({ seen }).pair, reads: () => readMap(30) } });
    return { v, o: seen[0] && seen[0].opts };
  };
  const same = run(tree());
  assert.deepStrictEqual([same.v.verdict, same.v.pairing, same.o.candidateB, same.o.policyB.name, same.o.accountB.name], ['kept', 'one rulebook', false, POLICY.name, POLICY.account]);
  const tight = run(tree((d, a) => editFile(book(d, a), /cushion_frac: 0\.3\b/, 'cushion_frac: 0.2')));
  assert.deepStrictEqual([tight.v.verdict, tight.v.pairing, tight.o.candidateB, tight.o.policy.sizing.cushion_frac, tight.o.policyB.sizing.cushion_frac], ['kept', 'different sizing (the same exit)', true, 0.3, 0.2]);
  const softer = run(tree((d, a) => editFile(book(d, a), /^daily_loss_soft: (\d+)/m, (_m, x) => `daily_loss_soft: ${Number(x) - 100}`)));
  assert.deepStrictEqual([softer.o.candidateB, softer.o.accountB.daily_loss_soft], [true, softer.o.account.daily_loss_soft - 100]);
  const loose = run(tree((d, a) => editFile(book(d, a), /cap_usd: (\d+)/, (_m, x) => `cap_usd: ${Number(x) * 2}`)));
  assert.strictEqual(loose.v.verdict, 'rejected');
  assert.match(loose.v.reasons[0], /^the rulebook guard: .*sizing\.cap_usd: .* is looser/);
  assert.strictEqual(loose.o, undefined, 'never scored');
  const exit = run(tree((d, a) => editFile(book(d, a), /trail_r: 1\b/, 'trail_r: 1.5')));
  assert.deepStrictEqual([exit.v.verdict, exit.v.pairing, exit.o.candidateB, exit.o.policyB.exit.trail_r], ['kept', 'different trade streams under different sizing/exit', true, 1.5]);
  const firm = run(tree((d, a) => editFile(path.join(d, 'accounts', a, 'ACCOUNT.md'), /^profit_target: (\d+)/m, (_m, x) => `profit_target: ${Number(x) - 500}`)));
  assert.strictEqual(firm.v.verdict, 'blocked');
  assert.match(firm.v.reasons[0], /firm rules/);
  const gone = run(tree(d => editFile(path.join(d, 'strategies', POLICY.name, 'STRATEGY.md'), /^status: active/m, 'status: disabled')));
  assert.strictEqual(gone.v.verdict, 'blocked');
  assert.match(gone.v.reasons[0], /adds or removes the policy/);
  // A contracts change on the policy: no guard covers it, so it is blocked, never scored.
  const minis = run(tree(d => editFile(path.join(d, 'strategies', POLICY.name, 'STRATEGY.md'), /^contracts: auto/m, 'contracts: micro')));
  assert.strictEqual(minis.v.verdict, 'blocked');
  assert.match(minis.v.reasons[0], /policy's contracts/);
  assert.strictEqual(minis.o, undefined, 'never scored');
});

test('W3 verify end to end with its default parts: real trees, real replay runs, pairRuns, the reads by key', () => {
  const champ = tree();
  const days = weekdays('2022-01-03', 95);
  const mk = () => multiDayRun({
    days: days.map(day => {
      const t0 = `${day}T14:00:00.000Z`;
      return {
        day, times: [t0], records: [record({ at: t0 })], rows: [[100.5, 100.75, 99.75, 100.25], [100.25, 103.5, 98.25, 103]],
        fills: [{ id: 1, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:01:00Z`, price: 100, size: 1, side: 0, profitAndLoss: null },
          { id: 2, contractId: 'MNQ:2023-06', creationTimestamp: `${day}T14:05:00Z`, price: 103, size: 1, side: 1, profitAndLoss: 6 }],
      };
    }),
  });
  const a = mk();
  const b = mk();
  const ds = days.map((d, i) => ({ key: `${d}|MNQ`, category: 'right', i }));
  const pairs = [{ label: 'w0', champion: { runDir: a.dir, decisions: ds }, candidate: { runDir: b.dir, decisions: ds } }];
  const cfg = { account: POLICY.account, paths: 200, reps: 200, faults: {} };
  const v = MV.verify({ cfg, pairs, seed: 3, root: champ, candidateRoot: tree(), env: {} });
  assert.notStrictEqual(v.verdict, 'blocked', v.reasons.join(';'));
  const w = v.windows[0];
  assert.deepStrictEqual([w.attempts, w.days, w.blows.b, w.reads.decisions, w.reads.overlap, w.adherence.decisions], [65, 95, 0, 95, 1, 95]);
  assert.deepStrictEqual([w.sizedAs, w.ceiling.blows.b], ['own', 0], 'judged as the model traded; the ceiling line beside it');
  assert.match(w.ceiling.label, /never judged/);
  // The same trades on both sides: no gain on the pooled start days, so not kept.
  assert.deepStrictEqual([v.verdict, v.pooled.diff, v.pairing], ['rejected', 0, 'one rulebook']);
  assert.match(v.reasons[0], /no significant gain/);
  // A tightened rulebook on the challenger's tree: scored as a candidate on practice-train, labelled.
  const t = MV.verify({ cfg, pairs, seed: 3, root: champ, candidateRoot: tree((d, acct) => editFile(book(d, acct), /cushion_frac: 0\.3\b/, 'cushion_frac: 0.2')), env: {} });
  assert.notStrictEqual(t.verdict, 'blocked', t.reasons.join(';'));
  assert.strictEqual(t.pairing, 'different sizing (the same exit)');
});

test('combine: the keep rule decides; the panel\'s blows and harms and the evaluator\'s failures can only reject', () => {
  const kept = { available: true, verdict: 'kept', reasons: ['gain'] };
  const quiet = judge({ pairs: pairUp(decisions(many(30, 'right')).map(d => ({ ...d, repeat: 0 })), decisions(many(30, 'right')).map(d => ({ ...d, repeat: 0 }))), targets: ['wrong stated reason'], failures: ['wrong stated reason'] });
  assert.notStrictEqual(quiet.verdict, 'kept', 'the panel alone shows no gain');
  assert.deepStrictEqual(MV.combine({ panel: quiet, model: kept }), { verdict: 'kept', reasons: ['gain'] });
  const harmed = judge({ pairs: pairUp(decisions(many(30, 'right')).map(d => ({ ...d, repeat: 0 })), decisions([...many(8, 'bad size'), ...many(22, 'right')]).map(d => ({ ...d, repeat: 0 }))), targets: ['wrong stated reason'], failures: ['bad size', 'wrong stated reason'] });
  const h = MV.combine({ panel: harmed, model: kept });
  assert.strictEqual(h.verdict, 'rejected');
  assert.match(h.reasons[0], /^panel: bad size/);
  const blown = judge({ pairs: pairUp([{ key: 'k', repeat: 0, category: 'right' }], [{ key: 'k', repeat: 0, category: 'right', blow: true }]), targets: ['bad size'], failures: ['bad size'] });
  assert.match(MV.combine({ panel: blown, model: kept }).reasons[0], /panel: 1 blow/);
  assert.match(MV.combine({ panel: quiet, model: kept, evaluator: { available: true, blows: 0, failures: ['x: fell'] } }).reasons[0], /^evaluator: x: fell/);
  assert.match(MV.combine({ panel: quiet, model: kept, evaluator: { available: true, blows: 2, failures: [] } }).reasons[0], /^evaluator: 2 blow/);
  assert.strictEqual(MV.combine({ panel: quiet, model: kept, evaluator: { available: false } }).verdict, 'kept');
  assert.strictEqual(MV.combine({ panel: quiet, model: { available: true, verdict: 'blocked', reasons: ['b'] } }).verdict, 'blocked');
  assert.strictEqual(MV.combine({ panel: quiet, model: null }).verdict, 'blocked');
  assert.strictEqual(MV.combine({ panel: quiet, model: { available: false, verdict: 'kept', reasons: [] } }).verdict, 'blocked');
  assert.strictEqual(MV.combine({ panel: harmed, model: { available: true, verdict: 'blocked', reasons: ['b'] } }).verdict, 'blocked');
  const both = MV.combine({ panel: harmed, model: { available: true, verdict: 'rejected', reasons: ['(a) blow'] } });
  assert.deepStrictEqual([both.verdict, both.reasons[both.reasons.length - 1]], ['rejected', '(a) blow']);
  assert.strictEqual(MV.combine({ panel: null, model: kept }).verdict, 'rejected');
  const rej = MV.combine({ panel: quiet, model: { available: true, verdict: 'rejected', reasons: ['(a) blow'] } });
  assert.deepStrictEqual(rej, { verdict: 'rejected', reasons: ['(a) blow'] });
  assert.strictEqual(MV.combine({ panel: quiet, model: { available: true, verdict: 'inconclusive', reasons: ['short'] } }).verdict, 'inconclusive');
});

test('contracts: a policy contracts difference between the trees is blocked, not scored', () => {
  const seen = [];
  const v = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', deps: deps({ seen, sides: { contractsDiffers: true } }) });
  assert.strictEqual(v.verdict, 'blocked');
  assert.match(v.reasons[0], /policy's contracts/);
  assert.strictEqual(seen.length, 0, 'not scored');
});

test('exit-change filter: only the guard\'s own exit message is dropped; a free-text value containing ".exit: changed" stays', () => {
  const exit = 'accounts/a/RULEBOOK.md: policies.p-1.exit: changed (the exit mode and trail are searched, R10; never a proposal\'s to change); a proposal only tightens a rulebook';
  const other = 'accounts/a/RULEBOOK.md: policies.p.sizing.cap_usd: 1 -> 2 is looser; a proposal only tightens a rulebook';
  const free = 'accounts/a/RULEBOOK.md: enforced: policies.x.exit: changed (note) moved out of enforced (the code no longer holds it); a proposal only tightens a rulebook';
  assert.deepStrictEqual(MV.withoutExitChanges([exit, other, free]), [other, free]);
});

test('candidateErrors: a rulebook edit on a sealed window is refused up front; on practice windows or a skill edit it is not', () => {
  const rb = { edits: [{ file: 'accounts/a/RULEBOOK.md', find: 'x', replace: 'y' }] };
  const skill = { edits: [{ file: 'skills/a/SKILL.md', find: 'x', replace: 'y' }] };
  const sealed = [{ from: '2025-03-03', to: '2025-03-04' }];
  assert.match(MV.candidateErrors(sealed, rb)[0], /edits a rulebook.*sealed window/);
  assert.deepStrictEqual(MV.candidateErrors(sealed, skill), []);
  assert.deepStrictEqual(MV.candidateErrors([{ from: '2024-09-10', to: '2024-09-11' }], rb), []);
});
