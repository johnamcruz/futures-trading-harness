'use strict';

// The trade lifecycle's record and plan (scripts/lib/trading/trade-lifecycle.js): the plan worked out in code from
// the checked reads (D3's one-tick buffer, D13's minimum stop refused never widened, R:R, the stated size within the
// dollar cap), the record's schema, expiry and the append-only file.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const TL = require('../../scripts/lib/trading/trade-lifecycle');
const { checkReads } = require('../../scripts/lib/trading/composed-reads');
const { tmpDir } = require('../helpers');
const { scenario1, SCENARIO_1, SKILLS } = require('../fixtures/trade-lifecycle-scenario');

const MNQ = { tick: 0.25, tickValue: 0.5 };
const plan = (over = {}) => {
  const briefing = over.briefing || scenario1();
  const side = over.side || 'long';
  const checked = checkReads({ reads: over.reads || SCENARIO_1, side, briefing, skills: SKILLS });
  return { checked, briefing, ...TL.planOf({ checked, briefing, side, size: 2, minRR: 2, maxRiskUsd: 150, ...MNQ, ...over }) };
};

test('scenario 1, tick-checked: the stop one tick under 21512.75, 111 ticks, $55.50 a contract, 231 ticks to 21598, 2.08R', () => {
  const { plan: p, problems } = plan();
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(p.entry, { type: 'limit', price: 21540.25 });
  assert.deepStrictEqual(p.stop, { source: '15m-low', level: 21512.75, price: 21512.5, ticks: 111, bufferTicks: 1, floorTicks: 40 });
  assert.deepStrictEqual(p.target, { source: '1h-swing', level: 21598, price: 21598, ticks: 231 });
  assert.strictEqual(p.rr, 2.08);
  assert.strictEqual(p.perContractUsd, 55.5);
  assert.strictEqual(p.riskUsd, 111);
  assert.strictEqual(p.size, 2);
  assert.strictEqual(p.maxSize, 2, '$150 over $55.50 a contract');
  // The first level between the entry and the target, in the plan's R (27.75 points).
  assert.deepStrictEqual(p.inTheWay, { name: 'last 3m swing high', price: 21545, R: 0.17 });
});

test('a level off the tick: the stop goes a tick beyond its tick, the target floors toward the entry', () => {
  const b = scenario1();
  b.sections.m3.data.candles['15m'].l = 21512.6;
  b.sections.m3.data.swingTargets.above[1].price = 21598.1;
  const reads = SCENARIO_1.map(x => (x.step === 'stop' ? { ...x, read: 'stop 15m low 21512.6' } : x.step === 'target' ? { ...x, read: 'target 1h swing 21598.1' } : x));
  const { plan: p } = plan({ briefing: b, reads });
  assert.strictEqual(p.stop.price, 21512.25);
  assert.strictEqual(p.target.price, 21598);
});

test('D13: a stop under max(8 ticks, 0.25 x ATR(20)) is refused, never widened; an unknown ATR refuses', () => {
  const b = scenario1();
  b.sections.m3.data.referenceStop.distance = 60; // ATR(20) 120: the floor is 30 points, 120 ticks
  const tight = plan({ briefing: b });
  assert.strictEqual(tight.plan.stop.ticks, 111, 'the stop stays the level named');
  assert.strictEqual(tight.plan.stop.floorTicks, 120);
  assert.ok(tight.problems.some(x => /111 ticks, under the minimum 120/.test(x)));
  // A small ATR: the 8-tick floor.
  assert.strictEqual(TL.stopFloorTicks({ sections: { m3: { data: { referenceStop: { distance: 1 } } } } }, 0.25), 8);
  b.sections.m3.data.referenceStop = null;
  assert.strictEqual(TL.stopFloorTicks(b, 0.25), null);
  assert.ok(plan({ briefing: b }).problems.some(x => /ATR\(20\) is unknown/.test(x)));
});

test('R:R under the minimum, a size over the dollar cap, no cap, a bad size, an unknown tick: each refused', () => {
  assert.ok(plan({ minRR: 2.5 }).problems.some(x => /R:R 2.081 is under the strategy's min 2.5/.test(x)));
  assert.ok(plan({ size: 3 }).problems.some(x => /size 3 risks \$166.5, over the strategy's risk.max_risk_usd \$150 \(at most 2/.test(x)));
  assert.ok(plan({ maxRiskUsd: null }).problems.some(x => /states no risk.max_risk_usd/.test(x)));
  for (const size of [0, 1.5, null, 101]) assert.ok(plan({ size }).problems.some(x => /size: a whole number/.test(x)), String(size));
  assert.deepStrictEqual(plan({ tick: null }).problems, ['the contract\'s tick size and value are unknown']);
  assert.strictEqual(plan({ tick: null }).plan, null);
});

test('buildRecord: the schema; ok only when every read and the plan stand; expiry is validBars base bars after the bar\'s close (the next close by default)', () => {
  const { checked, briefing, ...planned } = plan();
  const r = TL.buildRecord({ at: '2026-04-23T15:00:05.000Z', root: 'MNQ', symbol: 'MNQ', side: 'long', briefing, checked, planned, cycleId: 'c1' });
  assert.deepStrictEqual(Object.keys(r), TL.RECORD_KEYS);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.strategy, 'trade_lifecycle');
  assert.strictEqual(r.bar, '2026-04-23T14:57:00.000Z');
  assert.strictEqual(r.expiresAt, '2026-04-23T15:03:00.000Z');
  // The strategy's valid_bars: two 3m bars after the 15:00 close; an unusable count is one bar.
  assert.strictEqual(TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', briefing, checked, planned, validBars: 2 }).expiresAt, '2026-04-23T15:06:00.000Z');
  for (const bad of [0, -1, 1.5, '2', null]) assert.strictEqual(TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', briefing, checked, planned, validBars: bad }).expiresAt, '2026-04-23T15:03:00.000Z', String(bad));
  // expiryOf: no readable minutes, the next close only; no validUntil, none.
  assert.strictEqual(TL.expiryOf({ ...briefing, minutes: undefined }, 3), Date.parse('2026-04-23T15:03:00.000Z'));
  assert.strictEqual(TL.expiryOf({ ...briefing, minutes: 3 }, 3), Date.parse('2026-04-23T15:09:00.000Z'));
  assert.ok(Number.isNaN(TL.expiryOf({ sections: { m3: {} } }, 2)));
  assert.strictEqual(TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', briefing: { ...briefing, sections: { ...briefing.sections, m3: { ...briefing.sections.m3, validUntil: 'x' } } }, checked, planned, validBars: 2 }).expiresAt, null);
  assert.strictEqual(r.plan.size, 2);
  assert.strictEqual(r.signature, checked.signature);
  assert.deepStrictEqual(r.context, checked.context);
  assert.strictEqual(r.reads.length, 8);
  assert.deepStrictEqual(Object.keys(r.reads[0]), ['step', 'skill', 'read', 'why', 'kind', 'form', 'field', 'value', 'check', 'fact', 'agrees']);
  assert.match(r.id, /^[0-9a-f]{16}$/);
  assert.match(TL.renderRecord(r, checked), /entry limit 21540.25; stop 21512.5[^]*OK: every read verified/);
  // A false read, a plan problem, or no plan: not ok.
  const bad = plan({ reads: SCENARIO_1.map(x => (x.step === 'setup' ? { ...x, read: '15m rejected prior VAH down' } : x)) });
  assert.strictEqual(TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', briefing, checked: bad.checked, planned: bad }).ok, false);
  const over = plan({ size: 3 });
  const r2 = TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', briefing, checked: over.checked, planned: over });
  assert.strictEqual(r2.ok, false);
  assert.match(TL.renderRecord(r2, over.checked), /NOT OK[^]*/);
  assert.match(TL.renderRecord(r2, over.checked), /PROBLEM: size 3 risks/);
  assert.strictEqual(TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', problems: ['no cycle bar'] }).ok, false);
});

test('the record file: under FTH_HOME, one family per file, append-only, unreadable lines skipped', () => {
  const home = tmpDir();
  assert.strictEqual(TL.recordFile(home, 'NQ'), path.join(home, 'trade-lifecycle', 'MNQ.jsonl'));
  assert.deepStrictEqual(TL.readRecords(home, 'MNQ'), []);
  const a = TL.buildRecord({ at: '1', root: 'MNQ', side: 'long', problems: ['x'] });
  const b = TL.buildRecord({ at: '2', root: 'NQ', side: 'short', problems: ['y'] });
  TL.appendRecord(home, a);
  fs.appendFileSync(TL.recordFile(home, 'MNQ'), 'not json\n');
  TL.appendRecord(home, b);
  assert.deepStrictEqual(TL.readRecords(home, 'MNQ').map(r => r.at), ['1', '2']);
  assert.strictEqual(fs.readFileSync(TL.recordFile(home, 'MNQ'), 'utf8').split('\n').filter(Boolean).length, 3);
});

test('R:R is compared unrounded: 231/111 ticks (2.0811) meets a min of 2.0805 though it shows 2.08, and fails 2.0812', () => {
  assert.deepStrictEqual(plan({ minRR: 231 / 111 }).problems, []);
  assert.deepStrictEqual(plan({ minRR: 2.0805 }).problems, []);
  assert.strictEqual(plan({ minRR: 2.0805 }).plan.rr, 2.08);
  assert.ok(plan({ minRR: 2.0812 }).problems.some(x => /R:R 2.081 is under the strategy's min 2.0812/.test(x)));
});

test('inTheWay: the first level strictly between the entry and the target, never one at the target or behind the entry', () => {
  const b = scenario1();
  b.sections.m3.data.nearestLiquidity = { above: [{ name: 'at the target', price: 21598 }, { name: 'next', price: 21570 }], below: [{ name: 'behind', price: 21530 }] };
  assert.deepStrictEqual(plan({ briefing: b }).plan.inTheWay, { name: 'next', price: 21570, R: 1.07 });
  b.sections.m3.data.nearestLiquidity = { above: [{ name: 'at the target', price: 21597.75 }, { name: 'beyond', price: 21610 }], below: [] };
  assert.strictEqual(plan({ briefing: b }).plan.inTheWay, null, 'within a tick of the target, or past it');
});

test('the record carries its contract, lane and exploratory flag (the learning loop reads them)', () => {
  const { checked, briefing, ...planned } = plan();
  briefing.contractId = 'MNQ:2026-06';
  const r = TL.buildRecord({ at: 'x', root: 'MNQ', symbol: 'MNQ', side: 'long', briefing, checked, planned });
  assert.deepStrictEqual([r.contract, r.lane, r.exploratory], ['MNQ:2026-06', '3m', false]);
  const none = TL.buildRecord({ at: 'x', root: 'MNQ', side: 'long', problems: ['no cycle bar'] });
  assert.deepStrictEqual([none.contract, none.lane, none.exploratory], [null, null, false]);
});
