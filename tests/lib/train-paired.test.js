'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DECISION_RULE, NO_DECISION, ruleFrom, mcnemar, collapse, pairUp, judge } = require('../../scripts/lib/train/paired');

const FAILURES = ['wrong-side entry', 'bad size', 'wrong stated reason'];
const side = (cats, { blowAt = -1 } = {}) => cats.map((category, i) => ({ key: `t${i}`, repeat: 0, category, blow: i === blowAt }));
const pairs = (base, cand, opts) => pairUp(side(base), side(cand, opts));
const many = (n, x) => Array(n).fill(x);

test('the frozen decision rule: its numbers never fall, and a config may only tighten them', () => {
  assert.ok(Object.isFrozen(DECISION_RULE));
  assert.ok(DECISION_RULE.alpha <= 0.05 && DECISION_RULE.minPairs >= 20 && DECISION_RULE.minDiscordant >= 6 && DECISION_RULE.minEffect >= 0.1 && DECISION_RULE.harmTolerance <= 0.02 && DECISION_RULE.maxExcluded <= 0.1);
  assert.deepStrictEqual(ruleFrom({ alpha: 0.01, minPairs: 40 }), { ...DECISION_RULE, alpha: 0.01, minPairs: 40 });
  assert.strictEqual(ruleFrom({ maxExcluded: 0.05 }).maxExcluded, 0.05);
  for (const loose of [{ alpha: 0.1 }, { minPairs: 10 }, { minDiscordant: 2 }, { minEffect: 0.05 }, { harmTolerance: 0.1 }, { maxExcluded: 0.5 }]) {
    assert.throws(() => ruleFrom(loose), /loosen the frozen rule/, JSON.stringify(loose));
  }
  assert.throws(() => ruleFrom({ maxBlows: 1 }), /not a rule setting/);
  assert.throws(() => ruleFrom({ alpha: 'x' }), /a number/);
});

test('mcnemar: the exact one-sided binomial tail', () => {
  assert.strictEqual(mcnemar(0, 0), 1);
  assert.ok(Math.abs(mcnemar(6, 0) - 1 / 64) < 1e-12);
  assert.ok(Math.abs(mcnemar(8, 2) - 56 / 1024) < 1e-12); // P(X >= 8 | 10): (45 + 10 + 1) / 1024
  assert.ok(mcnemar(2, 8) > 0.98);
  assert.throws(() => mcnemar(1.5, 0), /whole counts/);
});

test('pairUp: one pair per decision, repeats collapsed to the majority (a tie to the failure); a missing candidate repeat is a failure', () => {
  const p = pairUp([{ key: 'a', repeat: 0, category: 'right' }, { key: 'b', repeat: 0, category: NO_DECISION }], []);
  assert.deepStrictEqual(p.map(x => [x.key, x.cand.category]), [['a', NO_DECISION]]);
  const r = (key, repeat, category, blow = false) => ({ key, repeat, category, blow });
  const q = pairUp([r('a', 0, 'right'), r('a', 1, 'right'), r('a', 2, 'bad size')], [r('a', 0, 'right'), r('a', 1, 'bad size'), r('a', 2, 'right', true)]);
  assert.deepStrictEqual(q.map(x => [x.key, x.base.category, x.cand.category, x.cand.blow, x.cand.agree]), [['a', 'right', 'right', true, 2]]);
  assert.strictEqual(collapse([r('a', 0, 'right'), r('a', 1, 'bad size')]).category, 'bad size', 'a tie is a failure');
  assert.strictEqual(collapse([r('a', 0, 'right'), r('a', 1, 'bad size')], { tieTo: 'right' }).category, 'right');
  // A champion split 1:1 is right (never a fix); a candidate split 1:1 is a failure (broken).
  const split = pairUp([r('a', 0, 'wrong stated reason'), r('a', 1, 'right')], [r('a', 0, 'right'), r('a', 1, 'bad size')]);
  assert.deepStrictEqual([split[0].base.category, split[0].cand.category], ['right', 'bad size']);
  assert.strictEqual(pairUp([r('a', 0, 'right'), r('a', 1, 'right')], [r('a', 0, 'right')])[0].cand.category, NO_DECISION, '1 of 2 missing: a tie, so the failure');
});

test('judge: repeats are not independent pairs: 2 fixed decisions x 10 repeats is never kept', () => {
  const base = [];
  const cand = [];
  for (let k = 0; k < 10; k += 1) {
    for (let i = 0; i < 20; i += 1) {
      base.push({ key: `t${i}`, repeat: k, category: i < 2 ? 'wrong stated reason' : 'right' });
      cand.push({ key: `t${i}`, repeat: k, category: 'right' });
    }
  }
  const v = judge({ pairs: pairUp(base, cand), targets: ['wrong stated reason'], failures: FAILURES });
  assert.deepStrictEqual([v.tests.pairs, v.tests.target.b], [20, 2]);
  assert.strictEqual(v.verdict, 'inconclusive');
});

test('judge: a targeted failure turned unchecked or into another failure is never a fix; tolerance 0 means none broken', () => {
  const v = judge({ pairs: pairs([...many(10, 'wrong stated reason'), ...many(10, 'right')], [...many(10, 'unchecked'), ...many(10, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(v.tests.target.b, 0);
  assert.notStrictEqual(v.verdict, 'kept');
  const spread = judge({ pairs: pairs([...many(12, 'wrong stated reason'), ...many(18, 'right')], [...many(6, 'right'), 'bad size', 'wrong-side entry', 'unchecked', 'unchecked', 'bad size', 'wrong-side entry', ...many(18, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(spread.tests.target.b, 6);
  const strict = judge({ pairs: pairs([...many(10, 'wrong stated reason'), ...many(10, 'right')], [...many(10, 'right'), 'bad size', ...many(9, 'right')]), targets: ['wrong stated reason'], failures: FAILURES, rule: ruleFrom({ harmTolerance: 0 }) });
  assert.strictEqual(strict.verdict, 'rejected');
  assert.match(strict.reasons.join(), /bad size: 1 decision\(s\) broken against 0 fixed, worse by more than the tolerance \(0\)/);
});

test('judge: a significant fix with nothing broken is kept', () => {
  const v = judge({ pairs: pairs([...many(10, 'wrong stated reason'), ...many(10, 'right')], many(20, 'right')), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(v.verdict, 'kept', v.reasons.join());
  assert.deepStrictEqual([v.tests.target.b, v.tests.target.c, v.tests.target.effect], [10, 0, 0.5]);
});

test('judge: a fix that breaks another category beyond the tolerance is rejected, whatever its gain', () => {
  const v = judge({ pairs: pairs([...many(10, 'wrong stated reason'), ...many(10, 'right')], [...many(10, 'right'), ...many(2, 'bad size'), ...many(8, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /bad size: 2 decision\(s\) broken against 0 fixed/);
  // The tolerance is floor(2% of the decisions), never a minimum of one: at 20 decisions none may break...
  const one = judge({ pairs: pairs([...many(10, 'wrong stated reason'), ...many(10, 'right')], [...many(10, 'right'), 'bad size', ...many(9, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(one.verdict, 'rejected');
  assert.match(one.reasons.join(), /bad size: 1 decision\(s\) broken against 0 fixed, worse by more than the tolerance \(0\)/);
  assert.strictEqual(one.tests.harmTolerance, 0);
  // ...at 50, one may (and two may not).
  const at50 = broken => judge({ pairs: pairs([...many(25, 'wrong stated reason'), ...many(25, 'right')], [...many(25, 'right'), ...many(broken, 'bad size'), ...many(25 - broken, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.deepStrictEqual([at50(1).verdict, at50(1).tests.harmTolerance], ['kept', 1]);
  assert.strictEqual(at50(2).verdict, 'rejected');
  // A tighter config: 1% at 50 decisions is floor(0.5) = 0.
  assert.strictEqual(judge({ pairs: pairs([...many(25, 'wrong stated reason'), ...many(25, 'right')], [...many(25, 'right'), 'bad size', ...many(24, 'right')]), targets: ['wrong stated reason'], failures: FAILURES, rule: ruleFrom({ harmTolerance: 0.01 }) }).verdict, 'rejected');
});

test('unchecked, conservatively for the candidate: champion-checked candidate-unchecked is broken; champion-unchecked is left out, capped', () => {
  // The reviewer's case: 30 targeted failures fixed, and 70 right decisions the candidate turned unchecked (skipped
  // "on judgment"). Never kept: each of the 70 is broken.
  const hide = judge({ pairs: pairs([...many(30, 'wrong stated reason'), ...many(70, 'right')], [...many(30, 'right'), ...many(70, 'unchecked')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(hide.verdict, 'rejected');
  assert.deepStrictEqual([hide.tests.target.b, hide.tests.target.c, hide.tests.harm.unchecked.c], [30, 70, 70]);
  assert.match(hide.reasons.join(), /unchecked: 70 decision\(s\) broken/);
  // A targeted failure the candidate turns unchecked: never a fix, and broken.
  const fail = judge({ pairs: pairs([...many(20, 'wrong stated reason'), ...many(10, 'right')], [...many(19, 'right'), 'unchecked', ...many(10, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.deepStrictEqual([fail.verdict, fail.tests.target.b, fail.tests.harm.unchecked.c], ['rejected', 19, 1]);
  // The champion's unchecked decisions are left out, whatever the candidate did: within the cap (10%) the rest decides.
  const ok = judge({ pairs: pairs([...many(20, 'wrong stated reason'), ...many(16, 'right'), ...many(4, 'unchecked')], [...many(20, 'right'), ...many(16, 'right'), ...many(2, 'right'), ...many(2, 'bad size')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.deepStrictEqual([ok.verdict, ok.tests.pairs, ok.tests.excluded, ok.tests.excludedShare], ['kept', 36, 4, 0.1]);
  // Over the cap: insufficient evidence, never kept.
  const over = judge({ pairs: pairs([...many(20, 'wrong stated reason'), ...many(15, 'right'), ...many(5, 'unchecked')], [...many(20, 'right'), ...many(15, 'right'), ...many(5, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(over.verdict, 'inconclusive');
  assert.match(over.reasons[0], /insufficient evidence: 5 of 40 decisions \(0\.125\) were unchecked on the champion's side; at most 0\.1/);
  assert.strictEqual(judge({ pairs: pairs([...many(20, 'wrong stated reason'), ...many(16, 'right'), ...many(4, 'unchecked')], many(40, 'right')), targets: ['wrong stated reason'], failures: FAILURES, rule: ruleFrom({ maxExcluded: 0.05 }) }).verdict, 'inconclusive', 'a tighter cap');
  // Blows still count where the decision is unchecked.
  const blow = judge({ pairs: pairUp(many(20, 'wrong stated reason').map((c, i) => ({ key: `t${i}`, repeat: 0, category: c })), many(20, 'right').map((c, i) => ({ key: `t${i}`, repeat: 0, category: i === 0 ? 'unchecked' : c, blow: i === 0 }))), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(blow.verdict, 'rejected');
});

test('decisions only the candidate made (a trade the champion never opened) count as broken and for blows, never toward the sample', () => {
  const base = many(20, 'wrong stated reason').map((c, i) => ({ key: `t${i}`, repeat: 0, category: c }));
  const cand = [...base.map(r => ({ ...r, category: 'right' })), { key: 'extra', repeat: 0, category: 'right', blow: true }];
  const p = pairUp(base, cand);
  assert.deepStrictEqual([p.length, p[20].base.implicit], [21, true]);
  const v = judge({ pairs: p, targets: ['wrong stated reason'], failures: FAILURES });
  assert.deepStrictEqual([v.verdict, v.tests.pairs, v.tests.onlyCandidate, v.tests.blows], ['rejected', 20, 1, 1]);
  const harm = judge({ pairs: pairUp(base, [...cand.slice(0, 20), { key: 'extra', repeat: 0, category: 'wrong-side entry' }]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(harm.verdict, 'rejected');
  assert.match(harm.reasons.join(), /wrong-side entry: 1 decision\(s\) broken/);
});

test('judge: a single blow on the candidate rejects', () => {
  const v = judge({ pairs: pairs(many(20, 'wrong stated reason'), many(20, 'right'), { blowAt: 3 }), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(v.verdict, 'rejected');
  assert.match(v.reasons[0], /1 blow/);
});

test('judge: too few pairs, too few discordant pairs, a small effect or no significance is never kept', () => {
  assert.strictEqual(judge({ pairs: pairs(many(19, 'wrong stated reason'), many(19, 'right')), targets: ['wrong stated reason'], failures: FAILURES }).verdict, 'inconclusive');
  assert.strictEqual(judge({ pairs: pairs([...many(5, 'wrong stated reason'), ...many(20, 'right')], many(25, 'right')), targets: ['wrong stated reason'], failures: FAILURES }).verdict, 'inconclusive');
  // 6 fixed, 0 broken over 100 pairs: significant but an effect of 0.06 (< 0.1).
  const small = judge({ pairs: pairs([...many(6, 'wrong stated reason'), ...many(94, 'right')], many(100, 'right')), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(small.verdict, 'rejected');
  assert.match(small.reasons.join(), /effect 0\.06 is under 0\.1/);
  // 7 fixed, 4 broken, no harm beyond the tolerance (3 of 50 pairs fall in the target): p 0.27.
  const noise = judge({ pairs: pairs([...many(7, 'wrong stated reason'), ...many(43, 'right')], [...many(7, 'right'), ...many(4, 'wrong stated reason'), ...many(39, 'right')]), targets: ['wrong stated reason'], failures: FAILURES, rule: ruleFrom({ minEffect: 0.1 }) });
  assert.notStrictEqual(noise.verdict, 'kept');
  // 7 fixed, 3 broken over 30 pairs: an effect of 0.13 and 10 discordant pairs, but p 0.17: not significant.
  const weak = judge({ pairs: pairs([...many(7, 'wrong stated reason'), ...many(23, 'right')], [...many(7, 'right'), ...many(3, 'wrong stated reason'), ...many(20, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(weak.verdict, 'rejected');
  assert.deepStrictEqual(weak.reasons, ['no significant gain on the targeted measure (p 0.1719 > 0.05)']);
});

test('judge: a mechanical change waits for the evaluator; an evaluator\'s blow or failure rejects', () => {
  const good = pairs(many(20, 'wrong stated reason'), many(20, 'right'));
  assert.strictEqual(judge({ pairs: good, targets: ['wrong stated reason'], failures: FAILURES, mechanical: true, evaluator: { available: false, why: 'step 9' } }).verdict, 'blocked');
  assert.strictEqual(judge({ pairs: good, targets: ['wrong stated reason'], failures: FAILURES, mechanical: true, evaluator: { available: true, blows: 0, failures: [] } }).verdict, 'kept');
  assert.strictEqual(judge({ pairs: good, targets: ['wrong stated reason'], failures: FAILURES, evaluator: { available: true, blows: 1 } }).verdict, 'rejected');
  assert.strictEqual(judge({ pairs: good, targets: ['wrong stated reason'], failures: FAILURES, evaluator: { available: true, blows: 0, failures: ['pass-rate bound'] } }).verdict, 'rejected');
  assert.throws(() => judge({ pairs: good, targets: [], failures: FAILURES }), /names the failure categories/);
  // A strategy or rulebook the evaluator's streams never read is not screened.
  const un = judge({ pairs: good, targets: ['wrong stated reason'], failures: FAILURES, mechanical: true, evaluator: { available: true, blows: 0, failures: [], uncovered: ['accounts/x/RULEBOOK.md'] } });
  assert.strictEqual(un.verdict, 'blocked');
  assert.match(un.reasons[0], /scored no stream that reads accounts\/x\/RULEBOOK\.md/);
});

test('judge: a candidate that stops deciding never reads as a fix', () => {
  const v = judge({ pairs: pairUp(side(many(20, 'wrong stated reason')), []), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /no decision: 20 decision\(s\) broken/);
  assert.strictEqual(v.tests.target.b, 0);
});
