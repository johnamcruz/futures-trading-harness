'use strict';

// The 2R mark (composed-reads.js `target 2r`, trade-lifecycle.js planOf): with no named level the trade's way, the
// target is the strategy's minimum R from the entry, on the tick the trade's way; a named level ahead is the target (the
// first at 2R or more), and one short of 2R is still refused. Exits treat it as any target (exit-trail.js: prices only).

const test = require('node:test');
const assert = require('node:assert');
const { scenario1, SCENARIO_1 } = require('../fixtures/trade-lifecycle-scenario');
const { checkReads, checkRead, parseRead, targetsAhead, readSignature } = require('../../scripts/lib/trading/composed-reads');
const { planOf, stopRuleOf } = require('../../scripts/lib/trading/trade-lifecycle');
const { afterTargetStep, liveTarget } = require('../../scripts/lib/trading/exit-trail');

const RULE = stopRuleOf({ stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: 0.25 });
const plan = (checked, b, side, o = {}) => planOf({ checked, briefing: b, side, size: 1, tick: 0.25, tickValue: 0.5, minRR: 2, maxRiskUsd: 300, stopRule: RULE, ...o });
// Scenario 1 with nothing named above price (no swing target, no key level above 21540.25).
const bare = (edit = () => {}) => { const b = scenario1(); b.sections.m3.data.swingTargets.above = []; b.keyLevels = b.keyLevels.filter(x => x[1] < 21540); edit(b); return b; };
const withTarget = read => [...SCENARIO_1.filter(r => r.step !== 'target'), { step: 'target', skill: 'take-profit', read, why: 'x' }];

test('2R mark: parsed as its own target form; TRUE only with no named level the side\'s way', () => {
  assert.deepStrictEqual([parseRead('target 2r').kind, parseRead('target 2r').mark, parseRead('Target 2R').source], ['target', true, '2r']);
  assert.deepStrictEqual(targetsAhead(bare(), 'long', { tick: 0.25 }), []);
  const c = checkRead(parseRead('target 2r'), bare(), { tick: 0.25, side: 'long' });
  assert.deepStrictEqual([c.check, c.dir, c.mark], [true, 'long', true]);
  assert.strictEqual(checkRead(parseRead('target 2r'), bare(), { tick: 0.25 }).check, 'unchecked', 'no side: unchecked');
  const named = checkRead(parseRead('target 2r'), scenario1(), { tick: 0.25, side: 'long' });
  assert.strictEqual(named.check, false);
  assert.match(named.fact, /^the briefing names .+ above price 21540\.25: the target is the first named level at the minimum R or more/);
});

test('2R mark: no level ahead, long: the target at twice the stop from the entry; R:R 2, the signature its own', () => {
  const b = bare();
  const checked = checkReads({ reads: withTarget('target 2r'), side: 'long', briefing: b, tick: 0.25 });
  assert.strictEqual(checked.ok, true, JSON.stringify(checked.problems));
  assert.deepStrictEqual(checked.target, { source: '2r', level: null, mark: true });
  const p = plan(checked, b, 'long');
  // Entry 21540.25, stop 21512.50 (one tick under the 15m low 21512.75): 111 ticks; 2 x 111 = 222 ticks: 21595.75.
  assert.deepStrictEqual([p.problems, p.plan.stop.price, p.plan.stop.ticks, p.plan.target.price, p.plan.target.ticks, p.plan.rr, p.plan.target.mark], [[], 21512.5, 111, 21595.75, 222, 2, true]);
  assert.match(readSignature(checked.reads, { reference: 21540.25 }), /target:2r$/);
});

test('2R mark: short, and rounded on the tick the trade\'s way when the minimum R is fractional', () => {
  const b = scenario1();
  b.sections.m3.data.swingTargets.below = [];
  b.keyLevels = [];
  b.sections.m3.data.candles['3m'].relations = [];
  b.sections.m3.data.candles['15m'].relations = [];
  b.sections.m3.data.liquidity.equalHighs = [];
  b.sections.m3.data.liquidity.equalLows = [];
  assert.deepStrictEqual(targetsAhead(b, 'short', { tick: 0.25 }), []);
  // Short from 21540.25, stop above at 21560.25 (+1 tick: 21560.50): 81 ticks; 2 x 81 = 162 ticks: 21499.75.
  const checked = { reference: 21540.25, stop: { source: 'x', level: 21560.25 }, target: { source: '2r', level: null, mark: true } };
  const p = plan(checked, b, 'short');
  assert.deepStrictEqual([p.plan.stop.price, p.plan.stop.ticks, p.plan.target.price, p.plan.target.ticks], [21560.5, 81, 21499.75, 162]);
  // At 2.5R: 202.5 ticks, rounded the trade's way (down for a short) to 203: 21489.50; long: up to 278 ticks.
  assert.deepStrictEqual([plan(checked, b, 'short', { minRR: 2.5 }).plan.target.price, plan(checked, b, 'short', { minRR: 2.5 }).plan.target.ticks], [21489.5, 203]);
  const long = plan({ reference: 21540.25, stop: { source: 'x', level: 21512.75 }, target: { source: '2r', level: null, mark: true } }, bare(), 'long', { minRR: 2.5 });
  assert.deepStrictEqual([long.plan.target.ticks, long.plan.target.price], [278, 21609.75]);
  assert.match(plan(checked, b, 'short', { minRR: null }).problems[0], /the 2R mark needs the strategy's risk.min_rr/);
});

test('2R mark: a named level at 1.5R ahead and none at 2R is still refused; a named one at 3R is the target, not the mark', () => {
  const at = price => bare(b => { b.sections.m3.data.swingTargets.above = [{ frame: '15m', price }]; });
  // 21581.75 is 41.5 points ahead: 166 ticks over the 111-tick stop, 1.5R.
  const b15 = at(21581.75);
  assert.strictEqual(checkReads({ reads: withTarget('target 2r'), side: 'long', briefing: b15, tick: 0.25 }).ok, false, 'the mark is no target with a level named ahead');
  const named = checkReads({ reads: withTarget('target 15m swing 21581.75'), side: 'long', briefing: b15, tick: 0.25 });
  assert.strictEqual(named.ok, true);
  assert.match(plan(named, b15, 'long').problems.join(), /R:R 1\.495 is under the strategy's min 2/);
  // 21623.5 is 83.25 points ahead: 333 ticks, 3R: that level.
  const b3 = at(21623.5);
  assert.strictEqual(checkReads({ reads: withTarget('target 2r'), side: 'long', briefing: b3, tick: 0.25 }).ok, false);
  const three = checkReads({ reads: withTarget('target 15m swing 21623.5'), side: 'long', briefing: b3, tick: 0.25 });
  const p = plan(three, b3, 'long');
  assert.deepStrictEqual([p.problems, p.plan.target.price, p.plan.rr], [[], 21623.5, 3]);
});

test('2R mark: the exit is the target-then-trail rule\'s, as for a named target at the same price (prices only)', () => {
  const b = bare();
  const marked = plan(checkReads({ reads: withTarget('target 2r'), side: 'long', briefing: b, tick: 0.25 }), b, 'long').plan;
  const named = plan(checkReads({ reads: withTarget('target 15m swing 21595.75'), side: 'long', briefing: bare(x => { x.sections.m3.data.swingTargets.above = [{ frame: '15m', price: 21595.75 }]; }), tick: 0.25 }), b, 'long').plan;
  assert.deepStrictEqual([marked.target.price, marked.stop.price], [named.target.price, named.stop.price]);
  const exitPlan = { afterTarget: { lockGivebackR: 0.5, trailBy: 'r', trailR: 1 } };
  const trade = p => ({ sign: 1, entry: p.entry.price, risk: p.entry.price - p.stop.price, stop: p.stop.price, peakR: 0, armed: false, target: p.target.price });
  // A bar through the mark, then higher: armed at the mark, then trailed past it (never closed at it), the same for both.
  const bars = [{ h: 21600, l: 21590, c: 21598 }, { h: 21640, l: 21620, c: 21638 }];
  const run = p => { let t = trade(p); const out = []; for (const bar of bars) { const r = afterTargetStep(t, bar, exitPlan, 0.25, null); out.push(r); t = { ...t, ...r }; } return out; };
  assert.deepStrictEqual(run(marked), run(named));
  const steps = run(marked);
  assert.ok(steps.every(r => r.armed && !r.close), 'armed at the mark, still open');
  assert.ok(steps[1].stop > marked.entry.price, 'the stop trails up past the entry');
});

test('2R mark: live, its resting target bracket at the mark is the one cancelled for the trail, as for a named target', () => {
  const b = bare();
  const p = plan(checkReads({ reads: withTarget('target 2r'), side: 'long', briefing: b, tick: 0.25 }), b, 'long').plan;
  // The runner's entry record (entry-orders.json): the order's bracket ticks and the composed plan's prices.
  const rec = { targetTicks: p.target.ticks, composed: { entry: p.entry.price, stop: p.stop.price, target: p.target.price, side: 'long' } };
  const resting = { id: 9, contractId: 'MNQ', type: 1, side: 1, limitPrice: p.target.price };
  const other = { id: 10, contractId: 'MNQ', type: 1, side: 1, limitPrice: p.target.price + 10 };
  const got = liveTarget({ rec, entry: p.entry.price, sign: 1, tick: 0.25, orders: [resting, other], contractId: 'MNQ' });
  assert.deepStrictEqual([got.price, got.cancel.map(o => o.id)], [21595.75, [9]]);
});

test('room rule: the running day or session extreme the trade extends is no level in the way: a short at a new day low gets the mark', () => {
  const short = (edit = () => {}) => {
    const b = scenario1();
    const d = b.sections.m3.data;
    d.swingTargets.below = [];
    d.candles['3m'].relations = [];
    d.candles['15m'].relations = [];
    d.liquidity.equalLows = [];
    // The bar made the day's and the session's low (21529.75) and closed above it at 21540.25.
    b.keyLevels = [['day low', 21529.75], ['session low', 21529.75]];
    edit(b);
    return b;
  };
  assert.deepStrictEqual(targetsAhead(short(), 'short', { tick: 0.25 }), [], 'the running low the bar is at is no level ahead');
  const reads = [{ step: 'bias', skill: 'x', read: '1h bos up' }, { step: 'target', skill: 'take-profit', read: 'target 2r' }];
  assert.strictEqual(checkReads({ reads, side: 'short', briefing: short(), tick: 0.25 }).reads[1].check, true);
  // The bar above the day low (not at or through it): a real level in the way, the mark refused.
  assert.strictEqual(checkReads({ reads, side: 'short', briefing: short(b => { b.sections.m3.data.bar.l = 21531; }), tick: 0.25 }).reads[1].check, false);
  // A level beyond the running low stays the next target.
  assert.deepStrictEqual(targetsAhead(short(b => { b.keyLevels.push(['prior RTH low', 21480]); }), 'short', { tick: 0.25 }).map(x => x.price), [21480]);
  // The overnight low is a finished session's level, never ignored as running.
  assert.deepStrictEqual(targetsAhead(short(b => { b.keyLevels = [['overnight low', 21529.75]]; }), 'short', { tick: 0.25 }).map(x => x.price), [21529.75]);
});

test('room rule: the running day high a long extends, mirrored', () => {
  const b = bare(x => { x.keyLevels = [['day high', 21541], ['session high', 21541]]; });
  assert.strictEqual(b.sections.m3.data.bar.h, 21541);
  assert.deepStrictEqual(targetsAhead(b, 'long', { tick: 0.25 }), []);
  b.sections.m3.data.bar.h = 21540.5;
  assert.deepStrictEqual(targetsAhead(b, 'long', { tick: 0.25 }).map(x => x.read), ['target day high 21541', 'target session high 21541']);
});

test('room rule: a named level within roomIgnoreR (0.25R) of the entry is ignored; one past it refuses the mark; long and short', () => {
  assert.strictEqual(require('../../scripts/lib/tunables').analysis().composedReads.roomIgnoreR, 0.25);
  // Long from 21540.25, the stop read at the 15m low 21512.75: R = 27.5 points. 0.2R ahead: 21545.75; 0.3R: 21548.5.
  const at = price => bare(b => { b.sections.m3.data.swingTargets.above = [{ frame: '15m', price }]; });
  const mark = b => checkReads({ reads: withTarget('target 2r'), side: 'long', briefing: b, tick: 0.25 }).reads.find(r => r.step === 'target').check;
  assert.strictEqual(mark(at(21545.75)), true, '0.2R: ignored');
  assert.strictEqual(mark(at(21548.5)), false, '0.3R: in the way');
  // Without a stop's R nothing is ignored by distance.
  assert.deepStrictEqual(targetsAhead(at(21545.75), 'long', { tick: 0.25 }).map(x => x.price), [21545.75]);
  assert.deepStrictEqual(targetsAhead(at(21545.75), 'long', { tick: 0.25, riskPts: 27.5 }), []);
  // Short mirrored: from 21540.25 with R = 27.5, a level 0.2R below is ignored, one 0.3R below stands.
  const b = scenario1();
  b.keyLevels = [];
  b.sections.m3.data.candles['3m'].relations = [];
  b.sections.m3.data.candles['15m'].relations = [];
  b.sections.m3.data.liquidity.equalLows = [];
  b.sections.m3.data.swingTargets.below = [{ frame: '15m', price: 21534.75 }];
  assert.deepStrictEqual(targetsAhead(b, 'short', { tick: 0.25, riskPts: 27.5 }), []);
  b.sections.m3.data.swingTargets.below = [{ frame: '15m', price: 21532 }];
  assert.deepStrictEqual(targetsAhead(b, 'short', { tick: 0.25, riskPts: 27.5 }).map(x => x.price), [21532]);
});
