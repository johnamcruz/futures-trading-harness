'use strict';

// The training loop's model-scoring verifier and its keep rule (scripts/lib/train/model-verifier.js): scripted
// champion and challenger results (the paired Monte Carlo's shape, prop/evaluator.js scorePaired, and scorecard
// decisions) through decide, verify and combine. The loop wiring: tests/lib/train-loop.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const MV = require('../../scripts/lib/train/model-verifier');
const { DECISION_RULE, judge, pairUp } = require('../../scripts/lib/train/paired');
const { PROMOTION_GATE } = require('../../scripts/lib/prop/promotion');
const { checkModelWindow } = require('../../scripts/lib/prop/evaluator');

const iv = (diff, lo, hi) => ({ diff, lo, hi, level: 0.9, n: 2000 });
const ZERO = iv(0, -0.02, 0.02);
/** A pairRuns result (A champion, B challenger; every difference A minus B). */
function mc({ blowsA = 0, blowsB = 0, pass = ZERO, blow = ZERO, days = iv(0, -1, 1), runDays = 60, sessions = 30, score = 'real', level = 0.9 } = {}) {
  const side = { passRate: 0.3, blowRate: 0, medianDaysToPass: 20 };
  return {
    a: { real: side, resampled: side, score }, b: { real: side, resampled: side, score },
    diff: { real: { passRate: iv(0, -1, 1), blowRate: iv(0, -1, 1), medianDaysToPass: iv(null, null, null) }, resampled: { passRate: pass, blowRate: blow, timeoutRate: ZERO, medianDaysToPass: days } },
    blows: { a: blowsA, b: blowsB }, inputs: { sessions, days: runDays, level, seed: 3 },
  };
}
const BETTER = { pass: iv(-0.2, -0.3, -0.1) };
const decisions = (cats, prefix = 't') => cats.map((category, i) => ({ key: `${prefix}${i}|MNQ`, category }));
const many = (n, x) => Array(n).fill(x);
const SAME = MV.adherence(decisions(many(30, 'right')), decisions(many(30, 'right')));
const READS = MV.reads(new Map([['MNQ|1', [{ check: true }]]]), new Map([['MNQ|1', [{ check: true }]]]));
const win = (m, over = {}) => ({ label: 'w0', mc: m, adherence: SAME, reads: READS, ...over });

test('the keep rule: a challenger clearly better (pass rate up, zero blows, decisions not worse) is kept', () => {
  const v = MV.decide([win(mc(BETTER))]);
  assert.strictEqual(v.verdict, 'kept', v.reasons.join('; '));
  // Fewer median days to pass (champion minus challenger above 0) is a gain too.
  assert.strictEqual(MV.decide([win(mc({ days: iv(4, 2, 6) }))]).verdict, 'kept');
  assert.ok(Object.isFrozen(MV.KEEP_RULE) && MV.KEEP_RULE.maxChallengerBlows === 0);
});

test('(a) a challenger that adds return but adds a blow is rejected, whatever it gains', () => {
  for (const blowsB of [1, 7]) {
    const v = MV.decide([win(mc({ ...BETTER, blowsB }))]);
    assert.strictEqual(v.verdict, 'rejected');
    assert.match(v.reasons[0], /^\(a\) .*blow.*hard rule/);
  }
  // A blow in any window rejects: they are summed over the windows.
  const v = MV.decide([win(mc(BETTER)), win(mc({ ...BETTER, blowsB: 1 }), { label: 'w1' })]);
  assert.strictEqual(v.verdict, 'rejected');
  // The champion's blows don't count against the challenger.
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, blowsA: 5 }))]).verdict, 'kept');
});

test('no difference is not kept; a gain in one window and none in another is not kept', () => {
  const none = MV.decide([win(mc())]);
  assert.strictEqual(none.verdict, 'rejected');
  assert.match(none.reasons[0], /no significant gain/);
  // The interval touching 0 is no gain.
  assert.strictEqual(MV.decide([win(mc({ pass: iv(-0.1, -0.2, 0) }))]).verdict, 'rejected');
  assert.strictEqual(MV.decide([win(mc({ days: iv(3, 0, 6) }))]).verdict, 'rejected');
  const split = MV.decide([win(mc(BETTER)), win(mc(), { label: 'w1' })]);
  assert.strictEqual(split.verdict, 'rejected');
  assert.match(split.reasons.join(';'), /w1: no significant gain/);
  assert.doesNotMatch(split.reasons.join(';'), /w0/);
});

test('(b) and (c): a significantly worse blow rate, pass rate or days to pass rejects, even beside a gain', () => {
  assert.match(MV.decide([win(mc({ ...BETTER, blow: iv(-0.05, -0.08, -0.01) }))]).reasons.join(';'), /\(b\) w0: blow rate significantly worse/);
  // A faster pass but a worse pass rate is a trade-off, never a gain.
  const t = MV.decide([win(mc({ days: iv(4, 2, 6), pass: iv(0.1, 0.05, 0.15) }))]);
  assert.strictEqual(t.verdict, 'rejected');
  assert.match(t.reasons.join(';'), /pass rate significantly worse/);
  const d = MV.decide([win(mc({ ...BETTER, days: iv(-4, -6, -2) }))]);
  assert.strictEqual(d.verdict, 'rejected');
  assert.match(d.reasons.join(';'), /median days to pass significantly more/);
});

test('(d): process adherence or the correct-read rate significantly worse rejects a Monte Carlo gain', () => {
  const broken = MV.adherence(decisions(many(30, 'right')), decisions([...many(8, 'wrong-side entry'), ...many(22, 'right')]));
  assert.deepStrictEqual([broken.b, broken.c], [0, 8]);
  assert.ok(broken.pWorse <= DECISION_RULE.alpha);
  const v = MV.decide([win(mc(BETTER), { adherence: broken })]);
  assert.strictEqual(v.verdict, 'rejected');
  assert.match(v.reasons[0], /\(d\) w0: process adherence significantly worse/);
  // Under minDiscordant broken decisions is not significant (noise).
  const few = MV.adherence(decisions(many(30, 'right')), decisions([...many(DECISION_RULE.minDiscordant - 1, 'bad size'), ...many(30 - DECISION_RULE.minDiscordant + 1, 'right')]));
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: few })]).verdict, 'kept');
  // A stricter loop rule (fewer discordant needed) catches the same few.
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: few })], { rule: { ...DECISION_RULE, minDiscordant: 5 } }).verdict, 'rejected');
  const k = n => new Map(Array.from({ length: n }, (_, i) => [`MNQ|${i}`, [{ check: true }, { check: 'true' }]]));
  const bad = new Map([...k(10)].map(([key], i) => [key, i < 8 ? [{ check: true }, { check: false }] : [{ check: true }]]));
  const r = MV.reads(k(10), bad);
  assert.deepStrictEqual([r.b, r.c, r.decisions], [0, 8, 10]);
  assert.match(MV.decide([win(mc(BETTER), { reads: r })]).reasons[0], /\(d\) w0: correct-read rate significantly worse/);
  // Reads only one side made are not paired.
  assert.strictEqual(MV.reads(k(3), new Map()).decisions, 0);
  // A decision only the challenger made, a failure, counts against it.
  const extra = MV.adherence(decisions(many(5, 'right')), [...decisions(many(5, 'right')), ...decisions(many(8, 'wrong-side entry'), 'x')]);
  assert.strictEqual(extra.c, 8);
});

test('what can\'t be measured is never a pass: no reads, a short window, a low interval level, no windows', () => {
  const noReads = MV.decide([win(mc(BETTER), { reads: null, readsWhy: 'run not finished' })]);
  assert.strictEqual(noReads.verdict, 'inconclusive');
  assert.match(noReads.reasons[0], /correct-read rate not measured \(run not finished\)/);
  assert.strictEqual(MV.decide([win(mc(BETTER), { adherence: null })]).verdict, 'inconclusive');
  const short = MV.decide([win(mc({ ...BETTER, runDays: 29 }))]);
  assert.strictEqual(short.verdict, 'inconclusive');
  assert.match(short.reasons[0], /shorter than one 30-session attempt/);
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, runDays: 30 }))]).verdict, 'kept');
  assert.strictEqual(MV.decide([win(mc({ ...BETTER, level: 0.8 }))]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([]).verdict, 'inconclusive');
  assert.strictEqual(MV.decide([win(null)]).verdict, 'inconclusive');
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
  // Either side diagnostic makes the comparison diagnostic.
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

/** verify's deps, scripted: the sides, the paired Monte Carlo per window, the reads, the one-side score. */
function deps({ result = mc(BETTER), differ = false, seen = [], promotion = { passes: false, failures: ['too small an out-of-sample test'] } } = {}) {
  return {
    sides: () => ({ account: { name: 'acct_a', sessions: 30 }, policy: { name: 'pol' }, differ }),
    pair: (a, b, opts) => { seen.push({ a, b, opts }); return typeof result === 'function' ? result(a, b, opts) : result; },
    reads: () => new Map([['MNQ|1', [{ check: true }]]]),
    scoreOne: () => ({ promotion }),
  };
}
const PAIRS = [{ label: 'w0', champion: { runDir: '/c0', decisions: decisions(many(30, 'right')) }, candidate: { runDir: '/x0', decisions: decisions(many(30, 'right')) } }];
const CFG = { account: 'acct_a', paths: 500, reps: 400, faults: {} };

test('verify: each window\'s two runs through one paired Monte Carlo on the loop\'s seed, champion first; the verdict is the keep rule\'s', () => {
  const seen = [];
  const v = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/champ', candidateRoot: '/cand', deps: deps({ seen }) });
  assert.strictEqual(v.verdict, 'kept', v.reasons.join(';'));
  assert.deepStrictEqual([seen[0].a, seen[0].b, seen[0].opts.seed, seen[0].opts.paths, seen[0].opts.reps, seen[0].opts.root, seen[0].opts.rootB, seen[0].opts.account.name, seen[0].opts.policy.name], ['/c0', '/x0', 3, 500, 400, '/champ', '/cand', 'acct_a', 'pol']);
  assert.strictEqual(v.windows[0].blows.b, 0);
  assert.strictEqual(v.promotion, undefined, 'tuning reports no promotion');
  assert.strictEqual(MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: deps({ result: mc({ ...BETTER, blowsB: 1 }) }) }).verdict, 'rejected');
  assert.strictEqual(MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: deps({ result: mc() }) }).verdict, 'rejected');
  assert.deepStrictEqual(MV.verify({ cfg: null, pairs: PAIRS }).available, false);
});

test('verify fails closed: a score that throws, a sealed run without its look, a sizing the two trees disagree on', () => {
  const thrown = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: deps({ result: () => { throw new Error('1 entry without a settled outcome'); } }) });
  assert.deepStrictEqual([thrown.verdict, thrown.available], ['blocked', true]);
  assert.match(thrown.reasons[0], /could not score the runs: 1 entry without a settled outcome/);
  // The real look check pairRuns makes (prop/evaluator.js checkModelWindow): a test run without its look is never read.
  const sealed = () => { checkModelWindow({ run: { runId: 'r', learning: true, role: 'test', from: '2025-02-03', to: '2025-04-01' }, logScore: () => {} }); return mc(BETTER); };
  const s = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', heldOut: true, deps: deps({ result: sealed }) });
  assert.strictEqual(s.verdict, 'blocked');
  assert.match(s.reasons[0], /carries no look/);
  const d = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', deps: deps({ differ: true }) });
  assert.strictEqual(d.verdict, 'blocked');
  assert.match(d.reasons[0], /one rulebook/);
  // A run whose reads can't be read: not measured, never kept.
  const r = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', deps: { ...deps(), reads: () => { throw new Error('not finished'); } } });
  assert.strictEqual(r.verdict, 'inconclusive');
});

test('held out: the frozen promotion gate\'s verdict is reported beside the keep rule, never replaced; a kept change is not promoted', () => {
  const v = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', candidateRoot: '/x', heldOut: true, deps: deps() });
  assert.strictEqual(v.verdict, 'kept');
  assert.deepStrictEqual(v.promotion, [{ label: 'w0', passes: false, failures: ['too small an out-of-sample test'] }]);
  const failing = MV.verify({ cfg: CFG, pairs: PAIRS, seed: 3, root: '/c', heldOut: true, deps: { ...deps(), scoreOne: () => { throw new Error('no account'); } } });
  assert.deepStrictEqual(failing.promotion, [{ label: 'w0', passes: false, failures: ['no account'] }]);
  // The gate itself: untouched by this module (its own numbers, its own test).
  assert.deepStrictEqual({ ...PROMOTION_GATE }, { minPassRate: 0.4, maxBlows: 0, minAttempts: 20, minMonths: 2 });
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'lib', 'train', 'model-verifier.js'), 'utf8');
  assert.doesNotMatch(src, /PROMOTION_GATE|gateFailures\(/, 'the verifier never re-implements or calls around the gate');
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
