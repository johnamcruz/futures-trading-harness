'use strict';

// The recognition test's per-candle trace (scripts/lib/learning/recognition/trace.js): the harness's own briefing at a
// bar close (skill-usage.js briefingFrom), the present key on it, and the confluence the harness verifies for each side
// (trend-facts.js barFacts: confirmed = barFacts.valid). THE LEAK TEST: every input and label of a candle uses only bars
// closed by it, so perturbing, poisoning or deleting every later bar (3m and 1m) leaves the trace identical, the
// confluence layer included. On the parity bars (tests/fixtures/parity/NQ-3m.csv and the 1m series built from them).
const test = require('node:test');
const assert = require('node:assert');
const T = require('../../scripts/lib/learning/recognition/trace');
const RC = require('../../scripts/lib/learning/recognition/config');
const { BARS, MINUTE_BARS, ROOT } = require('../fixtures/decision-path');

const TF = 3 * 60000;
const DEFS = RC.load().definitions;
const CTX = T.checkContext({ tree: ROOT, root: 'MNQ', inAttempt: true });
const make = (bars, fine) => T.tracer({ bars, fine, root: 'MNQ', minutes: 3, count: 1400, ctx: CTX, thresholds: DEFS.signals });
const CLOSES = ['2026-04-23T14:03:00.000Z', '2026-04-23T15:33:00.000Z', '2026-04-23T15:42:00.000Z'].map(Date.parse);
const json = x => JSON.parse(JSON.stringify(x));

test('a candle\'s trace: the briefing of the bar that closed at it, the key, and both sides\' confluence from barFacts', () => {
  const at = make(BARS, MINUTE_BARS);
  const tr = at(CLOSES[0]);
  assert.strictEqual(tr.bar, '2026-04-23T14:00:00.000Z', 'the bar that closes at the candle');
  assert.ok(['up', 'down', 'range'].includes(tr.key.facts.frames['4h']), JSON.stringify(tr.key.facts.frames));
  assert.ok(['A', 'B', 'C', 'D'].includes(tr.key.cls.long));
  for (const s of ['long', 'short']) {
    assert.ok(!tr.sides[s].error, tr.sides[s].error);
    assert.strictEqual(typeof tr.sides[s].confirmed, 'boolean');
    assert.deepStrictEqual(tr.sides[s].required, ['bias', 'location', 'setup', 'stop', 'target']);
    assert.ok(Number.isInteger(tr.sides[s].reqMet) && tr.sides[s].reqMet <= 5);
    assert.ok(tr.sides[s].declared === null || typeof tr.sides[s].declared === 'boolean');
  }
  assert.ok(tr.sides.long.met.length + tr.sides.short.met.length > 0, 'the confluence layer verified some reads');
  assert.deepStrictEqual(Object.keys(tr.sides.long.reads), tr.sides.long.met, 'the verified reads of each step met');
  assert.strictEqual(at(Date.parse('2030-01-01T00:00:00Z')), null, 'a candle with no bar: none');
});

test('confirmed is barFacts.valid for the side, the one confirmation rule (same briefing, plan, entry rule and missing frames)', () => {
  const TFX = require('../../scripts/lib/train/trend-facts');
  const { briefingFrom } = require('../../scripts/lib/learning/skill-usage');
  const at = make(BARS, MINUTE_BARS);
  const build = briefingFrom(BARS, { root: 'MNQ', minutes: 3, count: 1400, fineBars: MINUTE_BARS });
  const missing = TFX.missingFrames({ minutes: 3, fineBars: MINUTE_BARS });
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const close = Date.parse('2026-04-23T13:33:00.000Z') + i * TF;
    const b = build('MNQ', new Date(close - TF).toISOString());
    const tr = at(close);
    for (const side of ['long', 'short']) {
      const f = TFX.barFacts({ briefing: b, side, tick: CTX.tick, plan: CTX.plan, entryRule: CTX.entryRule, missing });
      assert.strictEqual(tr.sides[side].confirmed, f.valid === true, `${side} at ${new Date(close).toISOString()}`);
      seen.add(`${f.valid === true}|${f.known !== false}`);
    }
  }
  assert.ok(seen.has('true|true') && seen.has('false|true'), `the window holds confirmed and unconfirmed known candles: ${[...seen]}`);
});

test('LEAK (1m lane): the last closed 1m bar reaches the trace (the 5m facts), a later one never does', () => {
  const close = Date.parse('2026-04-23T15:45:00.000Z'); // a 3m close that is also a 5m close
  const want = json(make(BARS, MINUTE_BARS)(close));
  const last = MINUTE_BARS.findIndex(b => Date.parse(b.t) + 60000 === close);
  const moved = MINUTE_BARS.map((b, i) => (i === last ? { ...b, c: b.l - 30, l: b.l - 30 } : b));
  assert.notDeepStrictEqual(json(make(BARS, moved)(close)), want, 'the last closed 1m bar changes the trace');
  const later = MINUTE_BARS.map(b => (Date.parse(b.t) + 60000 > close ? { ...b, c: b.l - 30, l: b.l - 30, h: b.h + 30 } : b));
  assert.deepStrictEqual(json(make(BARS, later)(close)), want);
});

test('LEAK: perturbing, poisoning or deleting every later 3m and 1m bar gives the identical per-candle trace (key and confluence)', () => {
  const base = make(BARS, MINUTE_BARS);
  for (const close of CLOSES) {
    const want = json(base(close));
    const later3 = b => Date.parse(b.t) + TF > close;
    const later1 = b => Date.parse(b.t) + 60000 > close;
    const perturb = (b, k) => ({ ...b, o: b.o * 1.6 + k, h: b.h * 1.8 + 80, l: b.l * 0.5, c: b.c * 2 + 5, v: b.v * 9 + 3 });
    const poison = b => ({ ...b, c: -b.c, h: 1e9, l: -1e9 });
    const variants = {
      perturbed: [BARS.map(b => (later3(b) ? perturb(b, 40) : b)), MINUTE_BARS.map(b => (later1(b) ? perturb(b, 7) : b))],
      poisoned: [BARS.map(b => (later3(b) ? poison(b) : b)), MINUTE_BARS.map(b => (later1(b) ? poison(b) : b))],
      deleted: [BARS.filter(b => !later3(b)), MINUTE_BARS.filter(b => !later1(b))],
    };
    for (const [name, [b3, b1]] of Object.entries(variants)) assert.deepStrictEqual(json(make(b3, b1)(close)), want, `${name} later bars changed the trace at ${new Date(close).toISOString()}`);
  }
});

test('the leak test is not vacuous: the last CLOSED bar does change the trace', () => {
  const close = CLOSES[1];
  const want = json(make(BARS, MINUTE_BARS)(close));
  const moved = BARS.map(b => (Date.parse(b.t) + TF === close ? { ...b, c: b.l - 40, l: b.l - 40 } : b));
  assert.notDeepStrictEqual(json(make(moved, MINUTE_BARS)(close)), want);
});

test('checkContext: the entry check as compose_check builds it (trade_lifecycle\'s plan, the policy\'s entry rule for the root)', () => {
  assert.ok(CTX.tick > 0 && CTX.plan.minRR > 0 && CTX.plan.stopRule);
  assert.strictEqual(CTX.plan.suggestion, true);
  assert.ok(CTX.entryRule, 'the policy trading the root has an entry rule');
  assert.strictEqual(T.checkContext({ tree: ROOT, root: 'MNQ', inAttempt: false }).entryRule, null, 'no attempt: no policy entry rule (trend-facts.attachFacts)');
  assert.throws(() => T.checkContext({ tree: ROOT, root: 'NOPE', inAttempt: true }), /no contract spec/);
});
