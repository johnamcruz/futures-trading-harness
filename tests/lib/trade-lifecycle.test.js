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
const { tmpDir, lifecycleStopRule } = require('../helpers');
const { scenario1, SCENARIO_1, SKILLS } = require('../fixtures/trade-lifecycle-scenario');

const MNQ = { tick: 0.25, tickValue: 0.5 };
const plan = (over = {}) => {
  const briefing = over.briefing || scenario1();
  const side = over.side || 'long';
  const checked = checkReads({ reads: over.reads || SCENARIO_1, side, briefing, skills: SKILLS });
  return { checked, briefing, ...TL.planOf({ checked, briefing, side, size: 2, minRR: 2, maxRiskUsd: 150, stopRule: lifecycleStopRule(), ...MNQ, ...over }) };
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
  assert.strictEqual(TL.stopFloorTicks({ sections: { m3: { data: { referenceStop: { distance: 1 } } } } }, 0.25, lifecycleStopRule()), 8);
  b.sections.m3.data.referenceStop = null;
  assert.strictEqual(TL.stopFloorTicks(b, 0.25, lifecycleStopRule()), null);
  assert.ok(plan({ briefing: b }).problems.some(x => /ATR\(20\) is unknown/.test(x)));
});

test('the stop rule\'s one home is the strategy\'s STRATEGY.md risk: its numbers are what the plan uses; none, no plan', () => {
  // The shipped values (the code's constants before they moved: 1 tick beyond, the larger of 8 ticks and 0.25 x ATR(20)).
  assert.deepStrictEqual({ ...lifecycleStopRule() }, { bufferTicks: 1, floorTicks: 8, floorAtr: 0.25 });
  // The plan reads the rule it is given: a 2-tick buffer moves the stop a tick further, a 12-tick floor raises the floor.
  const one = plan().plan;
  const two = plan({ stopRule: { bufferTicks: 2, floorTicks: 8, floorAtr: 0.25 } }).plan;
  assert.deepStrictEqual([two.stop.price, two.stop.ticks, two.stop.bufferTicks], [one.stop.price - 0.25, one.stop.ticks + 1, 2]);
  assert.strictEqual(TL.stopFloorTicks({ sections: { m3: { data: { referenceStop: { distance: 1 } } } } }, 0.25, { bufferTicks: 1, floorTicks: 12, floorAtr: 0.25 }), 12);
  assert.strictEqual(TL.stopFloorTicks({ sections: { m3: { data: { referenceStop: { distance: 60 } } } } }, 0.25, { bufferTicks: 1, floorTicks: 8, floorAtr: 0.5 }), 240);
  // No rule, or an incomplete one: no plan (never a default).
  for (const risk of [undefined, {}, { stop_buffer_ticks: 1, stop_floor_ticks: 8 }, { stop_buffer_ticks: 1, stop_floor_ticks: 0, stop_floor_atr: 0.25 }, { stop_buffer_ticks: -1, stop_floor_ticks: 8, stop_floor_atr: 0.25 }, { stop_buffer_ticks: 1, stop_floor_ticks: 8, stop_floor_atr: '0.25' }]) {
    assert.strictEqual(TL.stopRuleOf(risk), null, JSON.stringify(risk));
  }
  const none = plan({ stopRule: null });
  assert.strictEqual(none.plan, null);
  assert.match(none.problems[0], /states no whole stop rule \(risk\.stop_buffer_ticks, risk\.stop_floor_ticks, risk\.stop_floor_atr\)/);
  assert.ok(!('STOP_BUFFER_TICKS' in TL) && !('FLOOR_TICKS' in TL) && !('FLOOR_ATR' in TL), 'no code copy of the rule');
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

test('the record file: under FTH_HOME, one shard per family and trading day, append-only, unreadable lines skipped', () => {
  const home = tmpDir();
  assert.strictEqual(TL.recordFile(home, 'NQ', '2026-10-07'), path.join(home, 'trade-lifecycle', 'MNQ', '2026-10-07.jsonl'));
  assert.throws(() => TL.recordFile(home, 'MNQ', '../x'), /not a trading day/);
  assert.deepStrictEqual(TL.readRecords(home, 'MNQ'), []);
  const a = TL.buildRecord({ at: '2026-10-07T14:00:00.000Z', root: 'MNQ', side: 'long', problems: ['x'] });
  const b = TL.buildRecord({ at: '2026-10-07T14:01:00.000Z', root: 'NQ', side: 'short', problems: ['y'] });
  TL.appendRecord(home, a);
  fs.appendFileSync(TL.recordFile(home, 'MNQ', '2026-10-07'), 'not json\n');
  TL.appendRecord(home, b);
  assert.deepStrictEqual(TL.readRecords(home, 'MNQ').map(r => r.at), [a.at, b.at]);
  assert.strictEqual(fs.readFileSync(TL.recordFile(home, 'MNQ', '2026-10-07'), 'utf8').split('\n').filter(Boolean).length, 3);
  // A record with no time to file it under is never written to a guessed day.
  assert.throws(() => TL.appendRecord(home, { ...a, at: 'x', bar: null }), /no bar or time/);
});

test('the shards: a record is filed under its bar\'s session day (18:00 ET rollover), not the time it was written', () => {
  const home = tmpDir();
  // 17:57 ET (21:57 UTC, EDT) is 2026-10-07's session; 18:00 ET is 2026-10-08's.
  assert.deepStrictEqual([TL.dayOf('2026-10-07T21:57:00.000Z'), TL.dayOf('2026-10-07T21:59:59.999Z'), TL.dayOf('2026-10-07T22:00:00.000Z')], ['2026-10-07', '2026-10-07', '2026-10-08']);
  // Standard time (EST): the rollover is 23:00 UTC.
  assert.deepStrictEqual([TL.dayOf('2026-12-07T22:59:00.000Z'), TL.dayOf('2026-12-07T23:00:00.000Z')], ['2026-12-07', '2026-12-08']);
  assert.strictEqual(TL.dayOf('not a time'), null);
  const onBar = TL.buildRecord({ at: '2026-10-07T22:00:01.000Z', root: 'MNQ', side: 'long', problems: ['x'] });
  TL.appendRecord(home, { ...onBar, bar: '2026-10-07T21:57:00.000Z' });
  TL.appendRecord(home, onBar); // no bar: its `at`
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'trade-lifecycle', 'MNQ')).sort(), ['2026-10-07.jsonl', '2026-10-08.jsonl']);
  assert.strictEqual(TL.readRecords(home, 'MNQ', { days: ['2026-10-07'] })[0].bar, '2026-10-07T21:57:00.000Z');
  assert.strictEqual(TL.readRecords(home, 'MNQ', { days: ['2026-10-08'] })[0].bar, null);
  assert.strictEqual(TL.readRecords(home, 'NQ').length, 2, 'every day, oldest day first');
  assert.throws(() => TL.readRecords(home, 'MNQ', { days: ['../../etc'] }), /not trading days/);
  // The days around a time: the one before, its own, the one after (across a weekend: the keys the shards use).
  assert.deepStrictEqual(TL.daysNear('2026-10-07T22:00:00.000Z'), ['2026-10-07', '2026-10-08', '2026-10-09']);
  assert.deepStrictEqual(TL.daysNear(new Date('2026-10-07T21:59:00.000Z')), ['2026-10-06', '2026-10-07', '2026-10-08']);
  assert.deepStrictEqual(TL.daysNear('x'), []);
});

test('the shards: every family read with root null; an older single file read with them; a file that can\'t be read or is too large throws', () => {
  const home = tmpDir();
  const rec = (at, root) => TL.buildRecord({ at, root, side: 'long', problems: ['x'] });
  TL.appendRecord(home, rec('2026-10-07T14:00:00.000Z', 'MNQ'));
  TL.appendRecord(home, rec('2026-10-08T14:00:00.000Z', 'MES'));
  // An older home's single file: read, never written; a day's read takes only its records of that day.
  fs.writeFileSync(TL.legacyFile(home, 'MNQ'), `${JSON.stringify(rec('2026-10-01T14:00:00.000Z', 'MNQ'))}\n${JSON.stringify(rec('2026-10-07T13:00:00.000Z', 'MNQ'))}\n`);
  fs.writeFileSync(path.join(home, 'trade-lifecycle', 'notes.txt'), 'x');
  assert.deepStrictEqual(TL.readRecords(home).map(r => `${r.root} ${r.at.slice(0, 13)}`), ['MES 2026-10-08T14', 'MNQ 2026-10-01T14', 'MNQ 2026-10-07T13', 'MNQ 2026-10-07T14']);
  assert.deepStrictEqual(TL.readRecords(home, 'MNQ', { days: ['2026-10-07'] }).map(r => r.at.slice(0, 13)), ['2026-10-07T13', '2026-10-07T14']);
  // An unreadable shard throws (a full read and that day's read), never read as none.
  fs.mkdirSync(TL.recordFile(home, 'MNQ', '2026-10-09'));
  assert.throws(() => TL.readRecords(home, 'MNQ'), /can't be read \(EISDIR\)/);
  assert.throws(() => TL.readRecords(home, 'MNQ', { days: ['2026-10-09'] }), /can't be read \(EISDIR\)/);
  assert.strictEqual(TL.readRecords(home, 'MNQ', { days: ['2026-10-07'] }).length, 2, 'another day\'s shard is never opened');
  // The family's folder not a folder (a shard's path can't be reached): throws, never none.
  const blocked = tmpDir();
  fs.mkdirSync(path.join(blocked, 'trade-lifecycle'));
  fs.writeFileSync(path.join(blocked, 'trade-lifecycle', 'MNQ'), 'x');
  assert.throws(() => TL.readRecords(blocked, 'MNQ', { days: ['2026-10-07'] }), /can't be read \(ENOTDIR\)/);
  assert.throws(() => TL.readRecords(blocked, 'MNQ'), /can't be read \(ENOTDIR\)/);
  // Over the cap: throws, named.
  const big = tmpDir();
  fs.mkdirSync(path.dirname(TL.recordFile(big, 'MNQ', '2026-10-07')), { recursive: true });
  fs.writeFileSync(TL.recordFile(big, 'MNQ', '2026-10-07'), '');
  fs.truncateSync(TL.recordFile(big, 'MNQ', '2026-10-07'), TL.MAX_BYTES + 1);
  assert.throws(() => TL.readRecords(big, 'MNQ', { days: ['2026-10-07'] }), /is over 67108864 bytes/);
  // An older home's single file over the cap: refused, saying what it is and what to do.
  fs.writeFileSync(TL.legacyFile(big, 'MES'), '');
  fs.truncateSync(TL.legacyFile(big, 'MES'), TL.MAX_BYTES + 1);
  assert.throws(() => TL.readRecords(big, 'MES', { days: ['2026-10-07'] }), /MES\.jsonl, an older home's single file from before the day shards, is over 67108864 bytes: [^]*continue in a new run home/);
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
