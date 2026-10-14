'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DECISION_RULE, NO_DECISION, ruleFrom, mcnemar, pairUp, judge } = require('../../scripts/lib/train/paired');

const FAILURES = ['wrong-side entry', 'bad size', 'wrong stated reason'];
const side = (cats, { blowAt = -1 } = {}) => cats.map((category, i) => ({ key: `t${i}`, repeat: 0, category, blow: i === blowAt }));
const pairs = (base, cand, opts) => pairUp(side(base), side(cand, opts));
const many = (n, x) => Array(n).fill(x);

test('the frozen decision rule: its numbers never fall, and a config may only tighten them', () => {
  assert.ok(Object.isFrozen(DECISION_RULE));
  assert.ok(DECISION_RULE.alpha <= 0.05 && DECISION_RULE.minPairs >= 20 && DECISION_RULE.minDiscordant >= 6 && DECISION_RULE.minEffect >= 0.1 && DECISION_RULE.harmTolerance <= 0.02);
  assert.deepStrictEqual(ruleFrom({ alpha: 0.01, minPairs: 40 }), { ...DECISION_RULE, alpha: 0.01, minPairs: 40 });
  for (const loose of [{ alpha: 0.1 }, { minPairs: 10 }, { minDiscordant: 2 }, { minEffect: 0.05 }, { harmTolerance: 0.1 }]) {
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

test('pairUp: by key and repeat; a missing candidate decision is a failure, a missing baseline leaves the pair out', () => {
  const p = pairUp([{ key: 'a', repeat: 0, category: 'right' }, { key: 'b', repeat: 0, category: NO_DECISION }], []);
  assert.deepStrictEqual(p.map(x => [x.key, x.cand.category]), [['a#0', NO_DECISION]]);
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
  // One broken decision is within the tolerance (at least 1 decision) and not significant: kept.
  const ok = judge({ pairs: pairs([...many(10, 'wrong stated reason'), ...many(10, 'right')], [...many(10, 'right'), 'bad size', ...many(9, 'right')]), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(ok.verdict, 'kept');
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
});

test('judge: a candidate that stops deciding never reads as a fix', () => {
  const v = judge({ pairs: pairUp(side(many(20, 'wrong stated reason')), []), targets: ['wrong stated reason'], failures: FAILURES });
  assert.strictEqual(v.verdict, 'rejected');
  assert.match(v.reasons.join(), /no decision: 20 decision\(s\) broken/);
  assert.strictEqual(v.tests.target.b, 0);
});
