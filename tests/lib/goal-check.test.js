'use strict';

const test = require('node:test');
const assert = require('node:assert');
const GC = require('../../scripts/lib/eval/goal-check');

const half = o => ({ trades: 10, meanR: 0.1, falseStartShare: 0.4, maxDrawdownR: 5, caught: { share: 0.1, caught: 3, legs: 9 }, mc: { pass: 0.2, blow: 0, blows: 0, meanDaysToPass: 20 }, ...o });
const doc = (a = {}, b = {}) => ({ fixture: 'f1', halves: { A: half(a), B: half(b) } });
const TOL = { passRate: 0.02, meanR: 0.03, rCaught: 0.02 };

test('compare: the gated metrics in the goal\'s order, each half; one more blow fails, the rest past their tolerance', () => {
  const rows = GC.compare(doc(), doc(), TOL);
  assert.deepStrictEqual(rows.filter(r => r.gated && r.half === 'A').map(r => r.key), ['mc.blows', 'mc.pass', 'meanR', 'caught.share', 'caught.caught']);
  assert.deepStrictEqual(GC.regressions(rows), []);
  const k = now => GC.regressions(GC.compare(doc(), now, TOL)).map(r => `${r.half} ${r.key}`);
  assert.deepStrictEqual(k(doc({ mc: { pass: 0.2, blow: 0.001, blows: 1 } })), ['A mc.blows']);
  assert.deepStrictEqual(k(doc({}, { mc: { pass: 0.181, blows: 0 } })), [], 'within the tolerance');
  assert.deepStrictEqual(k(doc({}, { mc: { pass: 0.179, blows: 0 } })), ['B mc.pass']);
  assert.deepStrictEqual(k(doc({ meanR: 0.069 })), ['A meanR']);
  assert.deepStrictEqual(k(doc({ caught: { share: 0.079, caught: 3, legs: 9 } })), ['A caught.share']);
  // One trend leg fewer caught fails, with no tolerance; one more passes.
  assert.deepStrictEqual(k(doc({}, { caught: { share: 0.1, caught: 2, legs: 9 } })), ['B caught.caught']);
  assert.deepStrictEqual(k(doc({}, { caught: { share: 0.1, caught: 4, legs: 9 } })), []);
  assert.deepStrictEqual(k(doc({ meanR: null })), ['A meanR'], 'a missing metric fails');
});

test('riseProblems: a baseline only improves on the same fixture; a new fixture starts over only with its change recorded', () => {
  assert.deepStrictEqual(GC.riseProblems(doc(), doc({ mc: { pass: 0.3, blows: 0 } })), []);
  assert.match(GC.riseProblems(doc(), doc({ meanR: 0.09 })).join(), /half A mean R per trade: 0.09 in the new baseline, 0.1 on the base branch/);
  assert.match(GC.riseProblems(doc(), doc({ caught: { share: 0.1, caught: 2, legs: 9 } })).join(), /half A trend legs caught: 2 in the new baseline, 3 on the base branch/);
  assert.match(GC.riseProblems(doc(), doc({}, { mc: { pass: 0.2, blows: 2 } })).join(), /half B combine blows/);
  assert.match(GC.riseProblems(doc(), { ...doc({ meanR: -1 }), fixture: 'f2' }).join(), /the fixture changed .* no fixtureChange/, 'a new fixture without its change recorded');
  assert.deepStrictEqual(GC.riseProblems(doc(), { ...doc({ meanR: -1 }), fixture: 'f2', fixtureChange: { from: 'f1', why: 'more sessions' } }), []);
  assert.ok(GC.riseProblems(doc(), { ...doc(), fixture: 'f2', fixtureChange: { from: 'f0', why: 'x' } }).length, 'the change must name the hash it replaces');
  // Even a recorded new fixture never takes a blow back, and never softens the blow path.
  const withS = (s, o = {}) => ({ ...doc(o), halves: { ...doc(o).halves, S: { trades: 10, meanR: -2, mc: { blows: 0 }, ...s } } });
  const moved = n => ({ ...n, fixture: 'f2', fixtureChange: { from: 'f1', why: 'a new draw' } });
  assert.deepStrictEqual(GC.riseProblems(withS({}), moved(withS({}))), []);
  assert.match(GC.riseProblems(withS({}), moved(withS({}, { mc: { pass: 0.2, blows: 3 } }))).join(), /half A combine blows: 3 .* never adds a blow/);
  assert.match(GC.riseProblems(withS({}), moved(withS({ meanR: -0.1 }))).join(), /the blow path: .* never softens it/);
  assert.match(GC.riseProblems(withS({}), moved(doc())).join(), /half S combine blows: undefined|the blow path: gone/);
});

test('the blow path\'s pinned trade-count allowance: exactly its from -> to, blows not up, mean R not milder; nothing else', () => {
  const withS = s => ({ ...doc(), halves: { ...doc().halves, S: { trades: 11, meanR: -1.583, mc: { blows: 0 }, ...s } } });
  const moved = n => ({ ...n, fixture: 'f2', fixtureChange: { from: 'f1', why: 'the blow path harsher' } });
  const base = withS({});
  // The approved case: 11 -> 10 trades, mean R harsher, no blow more.
  assert.deepStrictEqual(GC.riseProblems(base, moved(withS({ trades: 10, meanR: -1.6634 }))), []);
  // Any other drop, a milder mean R, or a blow more: refused.
  assert.match(GC.riseProblems(base, moved(withS({ trades: 9, meanR: -1.7 }))).join(), /the blow path: 9 trades/);
  assert.match(GC.riseProblems(base, moved(withS({ trades: 10, meanR: -1.459 }))).join(), /the blow path: 10 trades, mean R -1.459 .* never softens it/);
  assert.match(GC.riseProblems(base, moved(withS({ trades: 10, meanR: -1.6634, mc: { blows: 1 } }))).join(), /half S combine blows: 1/);
  assert.strictEqual(GC.allowedTradeDrop({ trades: 11, meanR: -1.583, mc: { blows: 0 } }, { trades: 10, meanR: -1.6634, mc: { blows: 1 } }), false, 'a blow more is never excused');
  assert.strictEqual(GC.allowedTradeDrop({ trades: 11, meanR: -1.583, mc: { blows: 0 } }, { trades: 10, meanR: null, mc: { blows: 0 } }), false, 'a missing mean R is never excused');
  // Only from exactly the pinned count: a base of 12 dropping to 11 or 10 is no allowance.
  assert.match(GC.riseProblems(withS({ trades: 12 }), moved(withS({ trades: 11, meanR: -1.7 }))).join(), /never softens it/);
  // Without the allowance (an empty list) the same drop is refused: the allowance is what passes it.
  assert.match(GC.riseProblems(base, moved(withS({ trades: 10, meanR: -1.6634 })), { allowances: [] }).join(), /never softens it/);
  // The same fixture never needs it: only blows are gated there, as before.
  assert.deepStrictEqual(GC.riseProblems(base, withS({ trades: 10, meanR: -1.6634 })), []);
});

test('resetBaseline: an owner-approved reset writes a lower baseline with the reset recorded, accepted once; never a blow more', () => {
  const base = doc();
  const lower = doc({ meanR: -0.4, mc: { pass: 0.05, blows: 0 } }, { caught: { share: -0.01, caught: 1, legs: 9 } });
  const why = 'one-time reset, owner-approved: the corrected tool';
  // The rule on synthetic baselines: this test's own approved list (the pinned one holds main's real reset only).
  const OK = [{ from: GC.fromHash(GC.gatedOf(base)), to: GC.fromHash(GC.gatedOf(lower)), why, approved: '2026-10-30' }];
  const rise = (b, n) => GC.riseProblems(b, n, { approved: OK });
  // A reset without a why refuses; so does one with no base, or of another fixture.
  for (const w of [undefined, '', '  ']) assert.throws(() => GC.resetBaseline(base, lower, { why: w, at: '2026-10-30' }), /needs --why/);
  assert.throws(() => GC.resetBaseline(null, lower, { why, at: '2026-10-30', approved: OK }), /no baseline to reset/);
  assert.throws(() => GC.resetBaseline(base, { ...lower, fixture: 'f2' }, { why, at: '2026-10-30', approved: OK }), /keeps the fixture/);
  assert.throws(() => GC.resetBaseline(base, doc({ mc: { pass: 0.2, blows: 1 } }), { why, at: '2026-10-30', approved: OK }), /half A combine blows: 1 .* a reset never adds a blow/);
  const next = GC.resetBaseline(base, lower, { why, at: '2026-10-30', commit: 'abc123', approved: OK });
  assert.deepStrictEqual(next.reset, { why, from: GC.gatedOf(base), fixture: 'f1', at: '2026-10-30', commit: 'abc123' });
  assert.strictEqual(next.halves.A.meanR, -0.4);
  assert.deepStrictEqual(GC.gatedOf(base).A, { 'mc.blows': 0, 'mc.pass': 0.2, meanR: 0.1, 'caught.share': 0.1, 'caught.caught': 3 });
  // Accepted once: new against the base, it replaces the base's numbers.
  assert.deepStrictEqual(rise(base, next), []);
  // Without the reset the same lowering fails as before.
  const { reset: _r, ...bare } = next;
  assert.ok(rise(base, bare).length >= 4);
  // Once on the base, the reset is the base's own: a second lowering without a new reset fails (the reset kept or dropped).
  const later = { ...next, halves: { ...next.halves, A: half({ meanR: -0.5, mc: { pass: 0.05, blows: 0 } }) } };
  assert.match(rise(next, later).join(), /half A mean R per trade: -0.5 in the new baseline, -0.4 on the base branch/);
  const { reset: _k, ...laterBare } = later;
  assert.match(rise(next, laterBare).join(), /half A mean R per trade/);
  // A reset that doesn't replace the base's own numbers (stale, or forged) fails; so does one without its why or fixture.
  assert.match(rise(next, { ...later, reset: { ...next.reset, at: '2026-11-02' } }).join(), /from is not the base branch's gated metrics/);
  assert.match(rise(base, { ...next, reset: { ...next.reset, why: ' ' } }).join(), /records no why/);
  assert.match(rise(base, { ...next, reset: { ...next.reset, at: '' } }).join(), /records no at/);
  assert.match(rise(base, { ...next, reset: { ...next.reset, fixture: 'f0' } }).join(), /a reset keeps the fixture/);
  assert.match(rise(base, { ...next, fixture: 'f2' }).join(), /a reset keeps the fixture/);
  // A reset recorded in the baseline still never takes a blow back, the blow path included.
  assert.match(rise(base, { ...next, halves: { ...next.halves, B: half({ mc: { pass: 0, blows: 2 } }) } }).join(), /half B combine blows: 2 .* a reset never adds a blow/);
});

test('a reset is accepted only when pinned in APPROVED_RESETS: the approved one passes, any other fails, a tampered pin fails', () => {
  const fs = require('fs');
  const path = require('path');
  // The reset baseline as main wrote it on 2026-10-30 (its tier 1 part): a later fixture change writes a new baseline
  // without the reset record (goal-check.js --new-fixture), so the approved reset is checked on this frozen copy.
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'goal', 'baseline-reset-2026-10-30.json'), 'utf8'));
  // The base the approved reset replaced, rebuilt from what it records (each half's gated metrics).
  const set = (o, key, v) => { const ks = key.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] = x[k] || {}; x[ks[ks.length - 1]] = v; return o; };
  const before = { fixture: real.fixture, halves: Object.fromEntries(Object.entries(real.reset.from).map(([h, m]) => [h, Object.entries(m).reduce((o, [k, v]) => set(o, k, v), {})])) };
  assert.deepStrictEqual(GC.gatedOf(before), real.reset.from);
  assert.deepStrictEqual(GC.riseProblems(before, real), [], 'the approved reset passes with the pinned list');
  // A well-formed reset whose from is not pinned fails, even replacing the base's numbers exactly.
  const base = doc();
  const lower = doc({ meanR: -0.4, mc: { pass: 0.05, blows: 0 } });
  const why = 'a well-formed reset nobody pinned';
  assert.throws(() => GC.resetBaseline(base, lower, { why, at: '2026-11-01' }), /not an owner-approved one/);
  const forged = { ...lower, reset: { why, from: GC.gatedOf(base), fixture: 'f1', at: '2026-11-01' } };
  assert.match(GC.riseProblems(base, forged).join(), /not an owner-approved one \(APPROVED_RESETS: from [0-9a-f]{64}/);
  // The approved why on another from fails; so does the approved from with another why.
  assert.match(GC.riseProblems(base, { ...forged, reset: { ...forged.reset, why: GC.APPROVED_RESETS[0].why } }).join(), /not an owner-approved one/);
  assert.match(GC.riseProblems(before, { ...real, reset: { ...real.reset, why: `${real.reset.why}.` } }).join(), /not an owner-approved one/);
  // A tampered pin (one hex digit of its hash) fails the written baseline.
  const pin = GC.APPROVED_RESETS[0];
  const tampered = [{ ...pin, from: `${pin.from.slice(0, -1)}${pin.from.endsWith('0') ? '1' : '0'}` }];
  assert.match(GC.riseProblems(before, real, { approved: tampered }).join(), /not an owner-approved one/);
  assert.match(GC.riseProblems(before, real, { approved: [] }).join(), /not an owner-approved one/);
  // The pin holds the reset baseline's own numbers (to): the same reset record with any gated metric lowered fails.
  const lowered = (h, mut) => { const x = JSON.parse(JSON.stringify(real)); mut(x.halves[h]); return x; };
  for (const [h, mut] of [['A', x => { x.meanR = -5; }], ['A', x => { x.mc.pass = 0; }], ['A', x => { x.caught.caught = 0; }], ['B', x => { x.caught.share = -0.5; }]]) {
    assert.match(GC.riseProblems(before, lowered(h, mut)).join(), /not an owner-approved one/);
  }
  // A reset whose new baseline is missing a gated metric (or holds a non-number) fails.
  assert.match(GC.riseProblems(before, lowered('A', x => { delete x.caught.caught; })).join(), /missing gated metrics: A caught\.caught/);
  assert.match(GC.riseProblems(before, lowered('B', x => { x.meanR = null; })).join(), /missing gated metrics: B meanR/);
  assert.match(GC.riseProblems(before, lowered('A', x => { x.caught.share = 'NaN'; })).join(), /missing gated metrics: A caught\.share/);
  // The hash is of canonical JSON: key order doesn't change it, a value does.
  assert.strictEqual(GC.fromHash({ B: { x: 1, y: 2 }, A: { z: 3 } }), GC.fromHash({ A: { z: 3 }, B: { y: 2, x: 1 } }));
  assert.notStrictEqual(GC.fromHash({ A: { z: 3 } }), GC.fromHash({ A: { z: 3.0001 } }));
});

test('renderTable: metric, main, this PR, allowed, and which fail', () => {
  const text = GC.renderTable(GC.compare(doc(), doc({ meanR: 0 }), TOL));
  const lines = text.split('\n');
  assert.match(lines[0], /^half\s+metric\s+main\s+this PR\s+allowed/);
  assert.ok(lines.some(l => /^A\s+mean R per trade\s+0\.1\s+0\s+>= 0\.07\s+FAIL$/.test(l)), text);
  assert.ok(lines.some(l => /^A\s+combine blows \(paths\)\s+0\s+0\s+<= 0\s+ok$/.test(l)), text);
});
