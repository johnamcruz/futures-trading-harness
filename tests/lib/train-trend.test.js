'use strict';

// The probe round's trend set (train/trend-set.js), its screen (train/trend-screen.js) and its findings
// (train/trend-findings.js), the merged ranking (findings.js mergeFindings), the `probe.trend` config
// (probe-config.js) and the screen of both sets together (probe.js combinedScreen), with the trend-move fixture's bars.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const TS = require('../../scripts/lib/train/trend-set');
const TSC = require('../../scripts/lib/train/trend-screen');
const TF = require('../../scripts/lib/train/trend-findings');
const F = require('../../scripts/lib/train/findings');
const SC = require('../../scripts/lib/train/screen');
const PC = require('../../scripts/lib/train/probe-config');
const LC = require('../../scripts/lib/learning/leg-census');
const PR = require('../../scripts/lib/train/probe');
const { FLOW_STEPS } = require('../../scripts/lib/trading/composed-reads');
const FL = require('../../scripts/lib/train/flow');
const moves = require('../fixtures/trend-moves');

const NY = '09:30-12:00@America/New_York';

test('the flow\'s steps are the harness\'s one list (composed-reads.js FLOW_STEPS)', () => {
  assert.strictEqual(FL.FLOW_STEPS, FLOW_STEPS);
});

/** A census of the trend-move fixture's legs (learning/leg-census.js), seed 1. */
function fixtureCensus() {
  const { bars } = moves.load();
  const tc = require('../../scripts/lib/replay/trend-capture');
  return LC.buildCensus([], { legs: tc.legsOf(bars.m3, { session: NY }), detector: { version: tc.DETECTOR } }, { use: 'practice', seed: 1 });
}

test('the trend pool: the census\'s legs of the screen period, in its order, every leg (with a moment or not), the excluded days out', () => {
  const census = fixtureCensus();
  const all = TS.poolOf(census, { from: '2021-05-03', to: '2021-05-07' });
  assert.deepStrictEqual(all, census.order.map(x => x.id), 'the census\'s own order, every leg (none has a moment here)');
  const x = TS.poolOf(census, { from: '2021-05-03', to: '2021-05-06', exclude: ['2021-05-04'] });
  assert.deepStrictEqual(x, census.order.filter(e => ['2021-05-03', '2021-05-05'].includes(e.day)).map(e => e.id), 'to is exclusive; an excluded day is out');
  // Round 1's batch is the census's next legs in its order; later cycles reshuffle.
  assert.deepStrictEqual(TS.drawBatches(all, { seed: 9, sizes: [5] })[0].items, [...all.slice(0, 5)].sort());
});

const POOL = Array.from({ length: 40 }, (_, i) => `2022-03-${String(1 + Math.floor(i / 4)).padStart(2, '0')}|${i % 2 ? 'short' : 'long'}|${i}`);

test('a round\'s batch: deterministic from the seed, a new one each round, without replacement until the pool is used up', () => {
  const r1 = TS.drawRound(POOL, { seed: 3, round: 1, per: 12 });
  assert.deepStrictEqual(r1, TS.drawRound(POOL, { seed: 3, round: 1, per: 12 }), 'the same seed and round, the same batch');
  assert.deepStrictEqual(r1.items, [...POOL.slice(0, 12)].sort(), 'the first cycle is the pool\'s own order (the census\'s)');
  assert.notDeepStrictEqual(TS.drawRound(POOL, { seed: 3, round: 5, per: 10 }).items, TS.drawRound(POOL, { seed: 4, round: 5, per: 10 }).items, 'after it, another seed, another shuffle');
  const rounds = Array.from({ length: 10 }, (_, i) => TS.drawRound(POOL, { seed: 3, round: i + 1, per: 12 }));
  assert.notDeepStrictEqual(rounds[0].items, rounds[1].items, 'it changes with the round');
  for (const r of rounds) assert.strictEqual(new Set(r.items).size, 12, 'never twice in a round');
  // Without replacement: the first three rounds (36 legs) never repeat a leg; the pool is used up before any reshuffle.
  assert.strictEqual(new Set(rounds.slice(0, 3).flatMap(r => r.items)).size, 36);
  assert.deepStrictEqual(rounds[3].cycles, [0, 1], 'round 4 spans the first reshuffle');
  // Over the rounds every leg is drawn, and as often as any other within one (ten rounds: 120 draws, three cycles).
  const count = new Map();
  for (const id of rounds.flatMap(r => r.items)) count.set(id, (count.get(id) || 0) + 1);
  assert.strictEqual(count.size, POOL.length);
  assert.ok([...count.values()].every(c => c === 3), [...count.values()].join());
  // Each cycle is a fresh shuffle: with 4 rounds a cycle, round 5 is not round 1 again.
  assert.notDeepStrictEqual(TS.drawRound(POOL, { seed: 3, round: 5, per: 10 }).items, TS.drawRound(POOL, { seed: 3, round: 1, per: 10 }).items);
  assert.throws(() => TS.drawRound(POOL, { seed: 3, round: 1, per: 41 }), /per is 1 to the pool's 40/);
  assert.throws(() => TS.drawRound(POOL, { seed: 3, round: 0, per: 4 }), /round is 1 or more/);
});

test('a batch\'s halves: whole session dates, about the share each, deterministic, no day in both', () => {
  const batch = TS.drawRound(POOL, { seed: 3, round: 1, per: 20 }).items;
  const s = TS.splitBatch(batch, { seed: 3, half: 0.5 });
  assert.deepStrictEqual(s, TS.splitBatch(batch, { seed: 3, half: 0.5 }));
  assert.deepStrictEqual(s.probe.days.filter(d => s.confirm.days.includes(d)), [], 'no day in both halves');
  assert.deepStrictEqual([...s.probe.legs, ...s.confirm.legs].sort(), [...batch].sort(), 'every leg in one half');
  assert.ok(s.probe.legs.every(id => s.probe.days.includes(TS.dayOfLeg(id))) && s.confirm.legs.every(id => s.confirm.days.includes(TS.dayOfLeg(id))));
  // About the share: the probe half reaches it and overshoots by less than one day's legs.
  const perDay = Math.max(...[...new Set(batch.map(TS.dayOfLeg))].map(d => batch.filter(id => TS.dayOfLeg(id) === d).length));
  for (const half of [0.3, 0.5, 0.7]) {
    const x = TS.splitBatch(batch, { seed: 3, half });
    assert.ok(x.probe.legs.length >= half * batch.length && x.probe.legs.length < half * batch.length + perDay, `${half}: ${x.probe.legs.length} of ${batch.length}`);
    assert.ok(x.confirm.legs.length > 0, 'the confirm half is never empty');
  }
  assert.notDeepStrictEqual(TS.splitBatch(batch, { seed: 4, half: 0.5 }).probe.days, s.probe.days);
  const two = TS.splitBatch(['2022-03-01|long|a', '2022-03-01|short|b', '2022-03-02|long|c'], { seed: 3, half: 0.95 });
  assert.deepStrictEqual([two.probe.days.length, two.confirm.days.length], [1, 1], 'a share near one still leaves a confirm day');
  assert.throws(() => TS.splitBatch(batch, { seed: 3, half: 1 }), /half is a share between 0 and 1/);
  assert.deepStrictEqual(TS.dayWindows(['2022-03-09', '2022-03-07', '2022-03-08', '2022-03-11', '2022-03-11']), [{ from: '2022-03-07', to: '2022-03-10' }, { from: '2022-03-11', to: '2022-03-12' }]);
});

// --- the screen ------------------------------------------------------------------------------------------------------

/** A side from leg states: legs(i) -> captured; days -> net R. */
function tside({ n = 20, caught = () => false, r = () => 0, blows = 0 } = {}) {
  const legs = Array.from({ length: n }, (_, i) => ({ id: `2022-03-${String(7 + (i % 10)).padStart(2, '0')}|long|${i}`, day: `2022-03-${String(7 + (i % 10)).padStart(2, '0')}`, captured: caught(i), availableR: 2 }));
  const days = {};
  for (let d = 0; d < 10; d += 1) days[`2022-03-${String(7 + d).padStart(2, '0')}`] = [{ trades: [{ roundTrip: { r: r(d) } }] }];
  // Every session finished (its end-of-day step ran): the screen pairs only those.
  const sessions = Object.keys(days).map(day => ({ day, complete: true, why: null, rollMonth: false }));
  return TSC.sideOfTrend({ captures: [{ legs }], days, scorecard: Array.from({ length: blows }, () => ({ blow: true })), sessions });
}

test('the trend screen: legs caught, paired; a catch counts only when its session\'s net R got no worse', () => {
  const champ = tside({ caught: i => i % 4 === 0 });
  const better = TSC.measureTrend(champ, tside({ caught: i => i % 2 === 0 }));
  assert.deepStrictEqual([better.capture.b, better.capture.c, better.capture.pairs], [5, 0, 20]);
  assert.deepStrictEqual(better.rate, { champion: 0.25, probe: 0.5 });
  assert.strictEqual(TSC.screenTrend(better).verdict, 'helped');
  assert.strictEqual(TSC.screenTrend(better, { target: false }).verdict, 'no effect', 'harm only when not the target');
  // The same catches on sessions that lost more: no fix counts.
  const greedy = TSC.measureTrend(champ, tside({ caught: i => i % 2 === 0, r: () => -1 }));
  assert.strictEqual(greedy.capture.b, 0);
  assert.match(TSC.screenTrend(greedy).harms.join(), /net R per window worse/);
  assert.strictEqual(TSC.screenTrend(greedy).verdict, 'hurt');
  // Fewer caught: a harm; a blow: a harm.
  const worse = TSC.measureTrend(tside({ caught: i => i % 2 === 0 }), tside({ caught: () => false }));
  assert.match(TSC.trendHarms(worse).join(), /legs caught worse \(broken 10, fixed 0/);
  assert.match(TSC.trendHarms(TSC.measureTrend(champ, tside({ caught: i => i % 4 === 0, blows: 1 }))).join(), /1 blow/);
  // Too few changed legs: no gain (the curated screen's minDiscordant).
  const few = TSC.measureTrend(champ, tside({ caught: i => i % 4 === 0 || i === 1 || i === 2 || i === 3 }));
  assert.strictEqual(few.capture.n, SC.SCREEN.minDiscordant - 1);
  assert.strictEqual(TSC.screenTrend(few).verdict, 'no effect');
  // Only legs both sides have pair.
  assert.strictEqual(TSC.measureTrend(champ, tside({ n: 5 })).capture.pairs, 5);
  assert.deepStrictEqual(TSC.dayR({ d: [{ trades: [{ roundTrip: { r: 1.5 } }, { roundTrip: { r: -0.5 } }, { profitAndLoss: 3 }] }] }), { d: 1 });
});

test('the regression days judge harm only: fewer of the champion\'s legs caught there, net, is a harm', () => {
  const champ = tside({ n: 6, caught: i => i < 3 });
  assert.deepStrictEqual(TSC.regressionHarms(champ, tside({ n: 6, caught: () => true })), []);
  assert.deepStrictEqual(TSC.regressionHarms(champ, tside({ n: 6, caught: i => i < 2 || i === 4 })), [], 'one lost, one gained: net even');
  assert.match(TSC.regressionHarms(champ, tside({ n: 6, caught: i => i < 2 })).join(), /1 leg\(s\) the champion caught lost, net/);
});

test('combinedScreen: a harm on either set hurts; the gain is the target set\'s own', () => {
  const ok = { harms: [], gain: true };
  const none = { harms: [], gain: false };
  const champ = tside({ caught: i => i % 4 === 0 });
  const tUp = TSC.measureTrend(champ, tside({ caught: i => i % 2 === 0 }));
  const tDown = TSC.measureTrend(tside({ caught: i => i % 2 === 0 }), tside({ caught: () => false }));
  assert.strictEqual(PR.combinedScreen({ curated: ok }).verdict, 'helped', 'the curated screen alone, without a trend set');
  assert.strictEqual(PR.combinedScreen({ curated: ok, trend: tUp, trendTarget: false }).verdict, 'helped');
  assert.strictEqual(PR.combinedScreen({ curated: ok, trend: tDown, trendTarget: false }).verdict, 'hurt', 'a trend harm stops a curated gain');
  assert.strictEqual(PR.combinedScreen({ curated: none, curatedTarget: false, trend: tUp, trendTarget: true }).verdict, 'helped');
  assert.strictEqual(PR.combinedScreen({ curated: ok, curatedTarget: false, trend: TSC.measureTrend(champ, champ), trendTarget: true }).verdict, 'no effect', 'a curated gain is no trend finding\'s gain');
  assert.strictEqual(PR.combinedScreen({ curated: { harms: ['reads: worse'], gain: false }, curatedTarget: false, trend: tUp, trendTarget: true }).verdict, 'hurt');
  assert.strictEqual(PR.combinedScreen({ curated: none, curatedTarget: false, trend: tUp, trendTarget: true, regression: ['regression days: 1 leg(s)'] }).verdict, 'hurt');
});

// --- the findings ----------------------------------------------------------------------------------------------------

const cyc = (code, by, step, reads = [], message = 'why') => ({ code, by, step, reads, message });
// Every leg here learnable (a valid plan existed: trend-facts.js); the not-learnable ones in train-trend-facts.test.js.
const leg = (id, { captured = false, availableR = 1, blocker = null, cycles = [], facts = { learnable: true, bars: [], owner: null } } = {}) => ({ id, day: id.slice(0, 10), captured, availableR, blocker, cycles, facts });

test('trend findings: missed legs grouped by step and owner, ranked by the R they left; rules and positions never', () => {
  const read = (skill, verified = false, step = 'entry') => ({ step, read: 'x', skill, verified });
  const legs = [
    leg('2022-03-07|a', { availableR: 3, blocker: { step: 'entry', code: 'entry:momentum', by: 'compose_check' }, cycles: [cyc('entry:momentum', 'compose_check', 'entry', [read('multi-timeframe-analysis', true, 'bias'), read('candle-reading')], 'momentum: no')] }),
    leg('2022-03-07|b', { availableR: 2, blocker: { step: 'entry', code: 'entry:close', by: 'compose_check' }, cycles: [cyc('entry:close', 'compose_check', 'entry', [read('candle-reading')])] }),
    leg('2022-03-08|c', { availableR: 4, blocker: { step: 'risk', code: 'veto', by: 'phase2' }, cycles: [cyc('veto', 'phase2', 'risk', [], 'VERDICT: VETO - room')] }),
    leg('2022-03-08|d', { availableR: 9, blocker: { step: null, code: 'news', by: 'rule' } }),
    leg('2022-03-08|e', { availableR: 9, blocker: { step: null, code: 'position-open', by: 'head' } }),
    leg('2022-03-09|f', { availableR: 9, captured: true }),
    leg('2022-03-09|g', { availableR: 1.5, blocker: { step: 'execution', code: 'unfilled', by: 'gate' }, cycles: [cyc('unfilled', 'gate', 'execution')] }),
    leg('2022-03-09|h', { availableR: null, blocker: { step: 'execution', code: 'executor-abort', by: 'executor' }, cycles: [cyc('executor-abort', 'executor', 'execution', [], 'ABORTED')] }),
    leg('2022-03-10|i', { availableR: 1, blocker: { step: 'stop', code: 'stop:wide', by: 'compose_check' }, cycles: [cyc('stop:wide', 'compose_check', 'stop', [read('position-sizing', false, 'stop')])] }),
  ];
  const found = TF.trendFindings([{ legs }]);
  assert.deepStrictEqual(found.map(f => [f.step, f.skill || f.agent || null, f.count, f.cost, f.code]), [
    ['entry', 'candle-reading', 2, 5, 'entry:close'], ['risk', 'risk-manager', 1, 4, 'veto'], ['execution', null, 1, 1.5, 'unfilled'],
    ['stop', null, 1, 1, 'stop:wide'], ['execution', 'trade-executor', 1, 0, 'executor-abort'],
  ]);
  assert.ok(found.every(f => f.kind === 'trend-blocker' && f.of === legs.length));
  assert.strictEqual(found[0].detail, 'entry:close (1); entry:momentum (1)');
  assert.deepStrictEqual(found[0].examples, [], 'no example without its facts\' bars');
  // A leg no valid plan existed for (a correct pass) or whose facts are unknown is no finding.
  for (const facts of [{ learnable: false, bars: [], owner: null }, { learnable: null, bars: [], owner: null }, undefined]) {
    assert.deepStrictEqual(TF.trendFindings([{ legs: [{ ...legs[2], facts }] }]), [], JSON.stringify(facts));
  }
  // A skill the tree doesn't hold owns nothing; the cap.
  assert.strictEqual(TF.trendFindings([{ legs }], { exists: s => s !== 'candle-reading' })[0].skill, null);
  assert.strictEqual(TF.trendFindings([{ legs }], { max: 2 }).length, 2);
  assert.deepStrictEqual(TF.trendFindings([]), []);
  // A tie on cost: more legs first, then the earlier step.
  const tie = TF.trendFindings([{ legs: [
    leg('a', { availableR: 2, blocker: { step: 'target', code: 'target:x', by: 'compose_check' }, cycles: [cyc('target:x', 'compose_check', 'target')] }),
    leg('b', { availableR: 2, blocker: { step: 'bias', code: 'bias:x', by: 'compose_check' }, cycles: [cyc('bias:x', 'compose_check', 'bias')] }),
    leg('c', { availableR: 1, blocker: { step: 'location', code: 'location:x', by: 'compose_check' }, cycles: [cyc('location:x', 'compose_check', 'location')] }),
    leg('d', { availableR: 1, blocker: { step: 'location', code: 'location:x', by: 'compose_check' }, cycles: [cyc('location:x', 'compose_check', 'location')] }),
  ] }]);
  assert.deepStrictEqual(tie.map(f => f.step), ['location', 'bias', 'target']);
  assert.deepStrictEqual(TF.ownerOf(legs[2]), { agent: 'risk-manager' });
  assert.deepStrictEqual(TF.ownerOf(legs[0]), { skill: 'candle-reading' }, 'the unverified read at the failing step, not a verified one');
  const verifiedFirst = leg('x', { blocker: { step: 'entry', code: 'entry:x', by: 'compose_check' }, cycles: [cyc('entry:x', 'compose_check', 'entry', [read('momentum-and-volume', true), read('candle-reading')])] });
  assert.deepStrictEqual(TF.ownerOf(verifiedFirst), { skill: 'candle-reading' }, 'a verified read at the same step never owns it');
  const byCost = TF.trendFindings([{ legs: [
    leg('a', { availableR: 9, blocker: { step: 'stop', code: 'stop:x', by: 'compose_check' }, cycles: [cyc('stop:x', 'compose_check', 'stop')] }),
    leg('b', { availableR: 1, blocker: { step: 'bias', code: 'bias:x', by: 'compose_check' }, cycles: [cyc('bias:x', 'compose_check', 'bias')] }),
    leg('c', { availableR: 1, blocker: { step: 'bias', code: 'bias:x', by: 'compose_check' }, cycles: [cyc('bias:x', 'compose_check', 'bias')] }),
  ] }]);
  assert.deepStrictEqual(byCost.map(x => [x.step, x.count, x.cost]), [['stop', 1, 9], ['bias', 2, 2]], 'the R left ranks, not the count');
});

test('the merged ranking: trend findings first by cost, then the curated ones; numbered again; each with its step', () => {
  const trend = [{ kind: 'trend-blocker', step: 'risk', agent: 'risk-manager', code: 'veto', count: 3, cost: 6, of: 9, detail: 'veto (3)' }];
  const reads = [{ id: 'F1', skill: 'take-profit', kind: 'misread', count: 4, of: 9, detail: '' }, { id: 'F2', skill: null, kind: 'wrong-reason refusal', count: 1, detail: '' }];
  const m = F.mergeFindings(trend, reads, { max: 8 });
  assert.deepStrictEqual(m.map(f => [f.id, f.kind, f.step]), [['F1', 'trend-blocker', 'risk'], ['F2', 'misread', 'target'], ['F3', 'wrong-reason refusal', null]]);
  assert.strictEqual(F.mergeFindings(trend, reads, { max: 2 }).length, 2);
  assert.match(F.findingLine(m[0]), /^F1\. agent risk-manager: trend-blocker at risk: blocked 3 of 9 trend legs, each with a valid plan at the time\. Most often: veto \(3\)$/);
  assert.match(F.findingLine({ ...m[0], agent: undefined, skill: null }), /^F1\. \(no skill or role named\): trend-blocker/);
  assert.doesNotMatch(F.findingLine(m[0]), /\bR\b|left/, 'the proposer reads what blocked the plan, never the move');
});

// --- the config ------------------------------------------------------------------------------------------------------

test('probe.trend: whole-session stage-1 runs on the loop\'s trader; its days practice-train, outside the tuning windows; regression apart', () => {
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
  const curated = { stage: 1, curatedList: { file: 'c.json', list: 'mix' }, practice: { mode: 'setup-focus' } };
  const leg = (id, day, side) => ({ id, day, side, start: `${day}T14:30:00.000Z`, end: `${day}T14:51:00.000Z`, points: 10 });
  const order = [leg('2022-03-07|long|a', '2022-03-07', 'long'), leg('2022-03-08|short|b', '2022-03-08', 'short'), leg('2021-05-04|long|c', '2021-05-04', 'long'), leg('2022-09-07|long|d', '2022-09-07', 'long')];
  const span = g => ({ day: g.day, side: g.side, start: g.start, end: g.end, points: g.points });
  const set = { kind: 'leg-census', fingerprint: 'fp', order };
  const base = { replay: curated, windows: [{ from: '2022-03-07', to: '2022-03-19' }] };
  const tuning = [{ from: '2022-10-03', to: '2022-10-15' }];
  const go = (t, over = {}) => PC.resolveProbe({ ...base, trend: t }, { read: x => x, readCensus: () => set, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: tuning, ...over });
  const ok = go({ replay: { stage: 1 }, census: 'c.json', from: '2021-05-03', to: '2022-09-01', regression: { days: ['2021-05-04', '2021-05-04'] } });
  const TB = require('../../scripts/lib/tunables').training().trendBatch;
  assert.deepStrictEqual(ok.trend, { replay: { stage: 1, autotrader: trader }, set: { file: 'c.json', fingerprint: 'fp', from: '2021-05-03', to: '2022-09-01', days: ['2022-03-07', '2022-03-08'], legs: ['2022-03-07|long|a', '2022-03-08|short|b'], spans: Object.fromEntries(order.slice(0, 3).map(g => [g.id, span(g)])) }, batch: TB, regression: { days: ['2021-05-04'] } });
  // A regression day the census holds no leg on would never run (its runs step windows around legs): refused.
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', regression: { days: ['2021-05-04', '2021-05-03'] } }), /probe.trend.regression 2021-05-03: the census holds no leg that day/);
  // The loop sets each trend run's stepped windows: a config's own is refused.
  assert.throws(() => go({ replay: { stage: 1, stepWindows: { kind: 'trend-set', windows: [] } }, census: 's', from: '2021-05-03', to: '2022-09-01' }), /probe.trend.replay.stepWindows: set by the loop/);
  // The batch: config/training.json trendBatch, its start, max and half overridable by the loop config, within bounds.
  assert.deepStrictEqual(go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', batch: { start: 10, max: 40, half: 0.4 } }).trend.batch, { ...TB, start: 10, max: 40, half: 0.4 });
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', batch: { growAfter: 1 } }), /probe.trend.batch.growAfter: not a setting \(start, max, half\)/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', batch: { start: 1 } }), /probe.trend.batch.start: a whole number of legs, two or more/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', batch: { start: 50, max: 40 } }), /probe.trend.batch.max: a whole number of legs, at least start/);
  for (const half of [0, 1, '0.5']) assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', batch: { half } }), /probe.trend.batch.half: the probe half's share/, String(half));
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01' }, { readCensus: () => ({ ...set, order: [order[0]] }) }), /a pool of two legs or more/);
  assert.strictEqual(go(undefined).trend, undefined, 'none without it');
  assert.throws(() => go({ replay: { stage: 1, curatedList: {} }, census: 's', from: '2021-05-03', to: '2022-09-01' }), /probe.trend.replay.curatedList: not here/);
  assert.throws(() => go({ replay: { stage: 1, practice: {} }, census: 's', from: '2021-05-03', to: '2022-09-01' }), /probe.trend.replay.practice/);
  assert.throws(() => go({ replay: { stage: 2 }, census: 's', from: '2021-05-03', to: '2022-09-01' }), /probe.trend.replay.stage: 1/);
  assert.throws(() => go({ replay: { stage: 1, autotrader: { ...trader, timeframe: 1 } }, census: 's', from: '2021-05-03', to: '2022-09-01' }), /probe.trend.replay.autotrader: the loop's replay.autotrader/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', extra: 1 }), /probe.trend.extra: not a setting/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01' }, { readCensus: () => { throw new Error('no such file'); } }), /probe.trend.census: no such file/);
  // The regression days are left out of the pool (2021-05-04's leg); the period's end is exclusive (2022-09-07's out).
  assert.ok(!ok.trend.set.legs.includes('2021-05-04|long|c') && !ok.trend.set.legs.includes('2022-09-07|long|d'));
  assert.ok(go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01' }).trend.set.legs.includes('2021-05-04|long|c'), 'without regression days it stays');
  // A screen period inside a tuning window, or outside practice-train: refused.
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01' }, { tuningWindows: [{ from: '2022-03-08', to: '2022-03-09' }] }), /probe.trend.census 2022-03-08: inside the tuning window 2022-03-08..2022-03-09[\s\S]*probe.trend.from..to 2021-05-03..2022-09-01: shares session dates with the tuning window/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2024-09-01' }, { readCensus: () => ({ ...set, order: [...order, { id: '2024-08-05|long|e', day: '2024-08-05' }] }) }), /probe.trend.census 2024-08-05: probes run on practice-train only/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2022-09-01', to: '2021-05-03' }), /probe.trend.from, to: the screen period/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', regression: { days: ['2022-10-04'] } }), /probe.trend.regression 2022-10-04: inside the tuning window/);
  assert.throws(() => go({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01', regression: { days: [] } }), /probe.trend.regression: \{ days/);
  // parallel above 1: no latency charged on the trend runs either.
  const par = t => PC.resolveProbe({ ...base, replay: { ...curated, latency: false }, parallel: 2, trend: t }, { read: x => x, readCensus: () => set, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: tuning });
  assert.throws(() => par({ replay: { stage: 1 }, census: 's', from: '2021-05-03', to: '2022-09-01' }), /probe.parallel: more than 1 only with probe.trend.replay.latency false/);
  assert.strictEqual(par({ replay: { stage: 1, latency: false }, census: 's', from: '2021-05-03', to: '2022-09-01' }).parallel, 2);
});

test('the default trendData step: a run\'s capture report from its own folder, written there, with its days', () => {
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId: 'r1' }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, sessions: [NY] }));
  fs.writeFileSync(path.join(runDir, '2022-03-07.jsonl'), `${JSON.stringify({ t: '2022-03-07T14:33:02.000Z', day: '2022-03-07', kind: 'trade' })}\n`);
  const got = PR.trendData({ runDir });
  assert.deepStrictEqual(Object.keys(got.days), ['2022-03-07']);
  assert.deepStrictEqual([got.capture.runId, got.capture.legs, got.capture.detector.session], ['r1', [], NY]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'trend-capture.json'), 'utf8')), got.capture);
  // Its sessions: this one never reached its end of day; the translator's day file gives its front month.
  assert.deepStrictEqual(got.sessions, [{ day: '2022-03-07', complete: false, why: 'stopped before the session ended (a call limit or an interruption)', rollMonth: false }]);
  fs.writeFileSync(path.join(home, 'contracts-sim.2022-03-07.json'), JSON.stringify({ front: { MNQ: { month: '2022-03', day: '2022-03-07' } } }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, sessions: [NY], symbols: ['MNQ'] }));
  fs.appendFileSync(path.join(runDir, '2022-03-07.jsonl'), `${JSON.stringify({ t: '2022-03-07T20:50:00.000Z', day: '2022-03-07', kind: 'eod' })}\n`);
  assert.deepStrictEqual(PR.trendData({ runDir }).sessions, [{ day: '2022-03-07', complete: true, why: null, rollMonth: true }]);
  // A windowed run (the loop's legs and windows given): the census's legs, each window's state, the stepped times.
  const legs = [{ id: '2022-03-07|long|2022-03-07T14:42:00.000Z', day: '2022-03-07', side: 'long', start: '2022-03-07T14:42:00.000Z', end: '2022-03-07T15:30:00.000Z', points: 30 }];
  const windows = [{ id: '2022-03-07|leg|2022-03-07T14:30:00.000Z', day: '2022-03-07', kind: 'leg', legs: [legs[0].id], from: Date.parse('2022-03-07T14:30:00Z'), to: Date.parse('2022-03-07T15:06:00Z') }];
  const w = PR.trendData({ runDir, legs, windows });
  assert.deepStrictEqual(w.capture.legs.map(l => [l.id, l.captured, l.availableR]), [[legs[0].id, false, null]], 'the given leg (no bar served: its available R unknown)');
  assert.deepStrictEqual(w.sessions, [{ unit: windows[0].id, day: '2022-03-07', kind: 'leg', complete: true, why: null, ran: 1, skipped: 0, legSkipped: false, rollMonth: true }]);
  assert.deepStrictEqual([w.stepped, w.minutes], [['2022-03-07T14:33:02.000Z', '2022-03-07T20:50:00.000Z'], 3]);
});

// --- the batch size and the learning curve --------------------------------------------------------------------------

const TC = require('../../scripts/lib/train/trend-curve');
const CFG = { start: 100, max: 400, half: 0.5, growAfter: 2, growFactor: 2, plateauRounds: 3 };

test('a round\'s outcome: kept, improved (the combined change confirmed), no improvement, or neutral (nothing judged, or every edit worse)', () => {
  assert.strictEqual(TC.outcomeOf({ probes: [{ verdict: 'helped' }], composed: { verdict: 'helped' }, kept: true }), 'kept');
  assert.strictEqual(TC.outcomeOf({ probes: [{ verdict: 'helped' }], composed: { verdict: 'helped' } }), 'improved');
  assert.strictEqual(TC.outcomeOf({ probes: [{ verdict: 'helped' }], composed: { verdict: 'no effect' } }), 'no-improvement', 'not confirmed');
  assert.strictEqual(TC.outcomeOf({ probes: [{ verdict: 'no effect' }, { verdict: 'hurt' }] }), 'no-improvement', 'inconclusive or no gain');
  assert.strictEqual(TC.outcomeOf({ probes: [{ verdict: 'hurt' }, { verdict: 'hurt' }] }), 'neutral', 'a clearly worse edit is rejected, never a reason to grow');
  assert.strictEqual(TC.outcomeOf({ probes: [] }), 'neutral');
});

test('the batch size: start, kept after one round without an improvement, doubled after two, capped, reset after a keep', () => {
  const h = list => list.map(([size, outcome]) => ({ size, outcome }));
  assert.deepStrictEqual(TC.planBatch([], { cfg: CFG }), { size: 100, trigger: 'start', why: 'the loop\'s first round: 100 legs' });
  assert.deepStrictEqual(TC.planBatch(h([[100, 'no-improvement']]), { cfg: CFG }).size, 100, 'one round is not enough');
  assert.deepStrictEqual(TC.planBatch(h([[100, 'no-improvement'], [100, 'no-improvement']]), { cfg: CFG }), { size: 200, trigger: 'grow', why: '2 rounds without an improvement at 100 legs: 200 legs' });
  assert.strictEqual(TC.planBatch(h([[100, 'no-improvement'], [100, 'neutral'], [100, 'no-improvement']]), { cfg: CFG }).size, 200, 'a neutral round between them is skipped');
  assert.strictEqual(TC.planBatch(h([[100, 'no-improvement'], [100, 'improved'], [100, 'no-improvement']]), { cfg: CFG }).size, 100, 'an improvement breaks the run');
  assert.strictEqual(TC.planBatch(h([[100, 'no-improvement'], [100, 'no-improvement'], [200, 'no-improvement']]), { cfg: CFG }).size, 200, 'rounds at the old size never count at the new');
  assert.deepStrictEqual(TC.planBatch(h([[200, 'no-improvement'], [200, 'no-improvement']]), { cfg: { ...CFG, max: 300 } }), { size: 300, trigger: 'grow', why: '2 rounds without an improvement at 200 legs: 300 legs' }, 'capped');
  assert.strictEqual(TC.planBatch(h([[400, 'no-improvement'], [400, 'no-improvement']]), { cfg: CFG }).trigger, 'cap');
  assert.strictEqual(TC.planBatch(h([[100, 'no-improvement'], [100, 'no-improvement']]), { cfg: CFG, pool: 150 }).size, 150, 'never more than the pool');
  assert.deepStrictEqual(TC.planBatch(h([[200, 'no-improvement'], [200, 'kept']]), { cfg: CFG }), { size: 100, trigger: 'restart', why: 'round 2 kept a change (a new champion): back to 100 legs' });
  assert.strictEqual(TC.planBatch([], { cfg: CFG, pool: 60 }).size, 60);
  assert.strictEqual(TC.planBatch(h([[100, 'neutral'], [100, 'neutral']]), { cfg: CFG }).trigger, 'keep', 'neutral rounds never grow it');
});

test('the learning curve: each round\'s confirm half as the champion after its keep; pooled; a plateau and memorization flagged, never judged', () => {
  const champion = { legs: 50, caught: 10, netR: 0.2 };
  const composed = { capture: { b: 8, c: 2, pairs: 50 }, netR: { diff: 0.3 } };
  assert.deepStrictEqual(TC.curvePoint({ round: 1, size: 100, champion, composed, kept: false }), { round: 1, batch: 100, legs: 50, caught: 10, rate: 0.2, lo: 0.1235, hi: 0.3073, netR: 0.2, firstTry: null, selection: null, source: 'champion', unit: 'window' });
  const k = TC.curvePoint({ round: 2, size: 100, champion, composed, kept: true });
  assert.deepStrictEqual([k.caught, k.rate, k.netR, k.source], [16, 0.32, 0.5, 'kept change'], 'the kept change\'s legs: the champion\'s, plus fixed, minus broken');
  const pt = (round, caught, legs = 50) => TC.curvePoint({ round, size: 100, champion: { legs, caught, netR: 0 } });
  const flat = TC.curveOf([pt(1, 10), pt(2, 11), pt(3, 12), pt(4, 11)], { plateauRounds: 3 });
  assert.deepStrictEqual([flat.pooled, flat.plateau, flat.excluded], [{ legs: 200, caught: 44, rate: 0.22, rounds: 4 }, true, undefined]);
  // A point from before the stepped windows (no unit: whole sessions) never pools with them: kept, flagged, left out.
  const old = { round: 0, batch: 100, legs: 80, caught: 40, rate: 0.5, lo: 0.4, hi: 0.6, netR: 0, source: 'champion' };
  const mixed = TC.curveOf([old, pt(1, 10), pt(2, 11), pt(3, 12), pt(4, 11)], { plateauRounds: 3 });
  assert.deepStrictEqual([mixed.points.length, mixed.pooled, mixed.plateau, mixed.excluded], [5, { legs: 200, caught: 44, rate: 0.22, rounds: 4 }, true, 1]);
  assert.strictEqual(TC.curveOf([pt(1, 10), pt(2, 11), pt(3, 25), pt(4, 11)], { plateauRounds: 3 }).plateau, false, 'round 3 beat every earlier round beyond its interval');
  assert.strictEqual(TC.curveOf([pt(1, 10), pt(2, 11), pt(3, 12)], { plateauRounds: 3 }).plateau, false, 'too few rounds to say');
  assert.strictEqual(TC.curveOf([pt(1, 10), pt(2, 25), pt(3, 25), pt(4, 25), pt(5, 25)], { plateauRounds: 3 }).plateau, true, 'no new gain in the last three');
  // Memorization: up on the probe half and the regression days, not on the confirm half.
  const probes = [
    { id: 'a', trend: { capture: { b: 6, c: 1 } }, regression: { capture: { b: 2, c: 0 } } },
    { id: 'b', trend: { capture: { b: 6, c: 1 } }, regression: { capture: { b: 0, c: 0 } } },
    { id: 'c', trend: { capture: { b: 6, c: 1 } }, regression: { capture: { b: 2, c: 0 } } },
  ];
  assert.deepStrictEqual(TC.memorizationOf(probes, { parts: ['a', 'b'], trend: { capture: { b: 1, c: 1 } } }), [{ id: 'a', probe: 5, regression: 2, confirm: 0 }]);
  assert.deepStrictEqual(TC.memorizationOf(probes, { parts: ['a'], trend: { capture: { b: 3, c: 1 } } }), [], 'it held on the confirm half');
  assert.deepStrictEqual(TC.memorizationOf(probes, null), []);
});

// --- first-try reasoning --------------------------------------------------------------------------------------------

const FT = require('../../scripts/lib/train/first-try');

/** A compose record (trade-lifecycle.js fields): its time, side, bar, OK, reads (check true or not), problems. */
const rec = (at, side, ok, checks, { bar = '2022-03-07T14:30:00.000Z', root = 'MNQ', problems = [] } = {}) => ({ at, root, side, bar, ok, problems, reads: checks.map(([step, check]) => ({ step, skill: `s-${step}`, read: 'x', check })) });

test('first tries: per root, bar and side the first record by time; later ones after a hint; the other side apart', () => {
  const records = [
    rec('2022-03-07T14:31:20Z', 'long', true, [['bias', true], ['entry', true]]), // the retry, written later
    rec('2022-03-07T14:31:05Z', 'long', false, [['bias', true], ['entry', false]], { problems: ['steps not stated: stop, target'] }), // the first try
    rec('2022-03-07T14:31:10Z', 'short', false, [['bias', false]]),
    rec('2022-03-07T14:34:05Z', 'long', true, [['bias', true]], { bar: '2022-03-07T14:33:00.000Z' }),
    { at: 'x', side: 'long' }, // no bar: no point
  ];
  const pts = FT.firstTries(records);
  assert.deepStrictEqual(pts.map(p => [p.key, p.first.ok, p.first.failed, p.tries, p.rescued, p.finalOk]), [
    ['MNQ|2022-03-07T14:30:00.000Z|long', false, ['entry', 'stop', 'target'], 2, true, true],
    ['MNQ|2022-03-07T14:30:00.000Z|short', false, ['bias'], 1, false, false],
    ['MNQ|2022-03-07T14:33:00.000Z|long', true, [], 1, false, true],
  ]);
  assert.deepStrictEqual(pts[0].first.reads, [{ step: 'bias', skill: 's-bias', check: true }, { step: 'entry', skill: 's-entry', check: false }], 'the first try\'s reads, never the retry\'s');
  assert.deepStrictEqual(FT.summarize(pts), { points: 3, reads: 4, readAccuracy: 0.5, decisionAccuracy: 0.3333, okRate: 0.3333, rescueRate: 0.3333 });
  assert.deepStrictEqual(FT.summarize([]), { points: 0, reads: 0, readAccuracy: null, decisionAccuracy: null, okRate: null, rescueRate: null });
  assert.strictEqual(FT.keyOf({ side: 'long' }), null);
  // OK first, then composed again: never rescued (no hint was needed).
  const again = FT.firstTries([rec('2022-03-07T14:37:05Z', 'long', true, [['bias', true]], { bar: '2022-03-07T14:36:00.000Z' }), rec('2022-03-07T14:37:30Z', 'long', true, [['bias', true]], { bar: '2022-03-07T14:36:00.000Z' })]);
  assert.deepStrictEqual(again.map(p => [p.first.ok, p.tries, p.rescued]), [[true, 2, false]]);
});

test('first tries paired: worse under the decision rule is a harm; too few changed points, or better, never', () => {
  const pts = (n, ok) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, first: { ok: ok(i), reads: [{ step: 'entry', check: ok(i) }] } }));
  const champ = pts(20, () => true);
  const rule = { ...require('../../scripts/lib/train/paired').DECISION_RULE };
  const worse = FT.pairFirstTries(champ, pts(20, i => i >= 8));
  assert.deepStrictEqual([worse.pairs, worse.b, worse.c], [20, 0, 8]);
  assert.match(FT.firstTryHarm(worse, rule), /^first-try reads worse \(broken 8, fixed 0 of 20 points, p [\d.]+\): the edit leans on the hints$/);
  const few = FT.pairFirstTries(champ, pts(20, i => i >= rule.minDiscordant - 1));
  assert.strictEqual(FT.firstTryHarm(few, rule), null, 'under minDiscordant changed points');
  assert.strictEqual(FT.firstTryHarm(FT.pairFirstTries(pts(20, i => i >= 8), champ), rule), null, 'better is no harm (and no gain)');
  assert.strictEqual(FT.firstTryHarm(worse, { ...rule, alpha: 0.001 }), null, 'the loop\'s own rule decides');
  assert.strictEqual(FT.pairFirstTries(champ, pts(5, () => true)).pairs, 5, 'only the points both sides have pair');
});

test('the default trendData step reads the run home\'s compose records for its first tries', () => {
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ runId: 'r1' }));
  fs.writeFileSync(path.join(runDir, 'autotrader.json'), JSON.stringify({ timeframe: 3, sessions: [NY] }));
  const TL = require('../../scripts/lib/trading/trade-lifecycle');
  TL.appendRecord(home, rec('2022-03-07T14:31:05Z', 'long', false, [['entry', false]]));
  TL.appendRecord(home, rec('2022-03-07T14:31:20Z', 'long', true, [['entry', true]]));
  const got = PR.trendData({ runDir });
  assert.deepStrictEqual(got.first.map(p => [p.key, p.first.ok, p.rescued]), [['MNQ|2022-03-07T14:30:00.000Z|long', false, true]]);
});

// --- complete sessions only ------------------------------------------------------------------------------------------

test('sessions: complete when the end-of-day step ran; else why it stopped; a roll month flagged', () => {
  const days = {
    '2022-03-07': [{ t: 'a', kind: 'trade' }, { t: 'b', kind: 'eod' }],
    '2022-03-08': [{ t: 'a', kind: 'trade', errors: [] }],
    '2022-03-09': [{ t: 'a', kind: 'trade', errors: ['the harness exited 1'] }],
    '2022-03-10': [{ t: 'a', kind: 'trade' }],
  };
  const combine = [{ kind: 'end', attempt: 1, day: '2022-03-10', outcome: 'blown' }];
  const s = TSC.sessionsOf({ days, combine, fronts: { '2022-03-07': '2022-03', '2022-03-08': '2022-06' } });
  assert.deepStrictEqual(s.map(x => [x.day, x.complete, x.why, x.rollMonth]), [
    ['2022-03-07', true, null, true],
    ['2022-03-08', false, 'stopped before the session ended (a call limit or an interruption)', true],
    ['2022-03-09', false, 'failed cycles (a crash or errors)', false],
    ['2022-03-10', false, 'its combine attempt ended (blown)', false],
  ]);
  // The roll month: the front's expiry month, or the month after its roll (the front three months on); never otherwise.
  assert.deepStrictEqual([['2022-05-16', '2022-06'], ['2022-06-06', '2022-06'], ['2022-06-20', '2022-09'], ['2022-07-01', '2022-09'], ['2022-06-20', null], ['2022-12-20', '2023-03']].map(([d, f]) => TSC.rollMonth(d, f)), [false, true, true, false, false, true], 'across a year end too');
});

test('the trend screen pairs only sessions both runs finished: an incomplete one is neither a miss nor a catch; each side says which and why', () => {
  const day = d => `2022-03-${String(7 + d).padStart(2, '0')}`;
  const side = ({ caught, incomplete = [], r = () => 0 }) => TSC.sideOfTrend({
    captures: [{ legs: Array.from({ length: 20 }, (_, i) => ({ id: `${day(i % 10)}|long|${i}`, day: day(i % 10), captured: caught(i), availableR: 1 })) }],
    days: Object.fromEntries(Array.from({ length: 10 }, (_, d) => [day(d), [{ trades: [{ roundTrip: { r: r(d) } }] }]])),
    first: Array.from({ length: 10 }, (_, d) => ({ key: `MNQ|${day(d)}T14:33:00.000Z|long`, bar: `${day(d)}T14:33:00.000Z`, first: { ok: true, reads: [{ check: true }] } })),
    sessions: Array.from({ length: 10 }, (_, d) => ({ day: day(d), complete: !incomplete.includes(d), why: incomplete.includes(d) ? 'stopped before the session ended (a call limit or an interruption)' : null, rollMonth: d === 9 })),
  });
  // The edit catches every leg, but stopped early on two sessions where the champion had missed its legs.
  const champ = side({ caught: i => i % 10 >= 2 });
  const m = TSC.measureTrend(champ, side({ caught: () => true, incomplete: [0, 1] }));
  assert.deepStrictEqual([m.capture.pairs, m.capture.b, m.capture.c], [16, 0, 0], 'the legs of the unfinished sessions dropped: no catch counted');
  assert.strictEqual(m.netR.pairs, 8);
  assert.strictEqual(m.firstTry.paired.pairs, 8, 'first tries on unfinished sessions dropped too');
  assert.deepStrictEqual(m.sides.probe, { found: 20, paired: 16, dropped: [{ day: day(0), why: 'stopped before the session ended (a call limit or an interruption)' }, { day: day(1), why: 'stopped before the session ended (a call limit or an interruption)' }], rollMonth: [day(9)] });
  assert.deepStrictEqual(m.sides.champion.dropped, [{ day: day(0), why: 'the other side did not finish it' }, { day: day(1), why: 'the other side did not finish it' }]);
  // And the champion's unfinished session is no miss of the edit's either.
  const m2 = TSC.measureTrend(side({ caught: () => true, incomplete: [3] }), side({ caught: i => i % 10 !== 3 }));
  assert.deepStrictEqual([m2.capture.pairs, m2.capture.c], [18, 0]);
  // Without session state, no session is known finished: nothing pairs (fail closed), never every day.
  const bare = caught => TSC.sideOfTrend({ captures: [{ legs: [{ id: '2022-03-07|long|0', day: '2022-03-07', captured: caught }] }], days: { '2022-03-07': [] } });
  const none = TSC.measureTrend(bare(false), bare(true));
  assert.deepStrictEqual([none.capture.pairs, none.capture.b, none.netR.pairs], [0, 0, 0]);
  // Each side without it says why, never an empty list; a side with it lists its own (the other's missing state).
  const NO_STATE = [{ day: null, why: 'the step reported no session state' }];
  assert.deepStrictEqual([none.sides.champion.dropped, none.sides.probe.dropped], [NO_STATE, NO_STATE]);
  const half = TSC.measureTrend(champ, bare(true));
  assert.deepStrictEqual(half.sides.probe.dropped, NO_STATE);
  assert.strictEqual(half.sides.champion.dropped.length, 10, 'the champion\'s finished sessions, none paired');
  assert.ok(half.sides.champion.dropped.every(x => x.why === 'the other side did not finish it'));
});

// --- selection value ------------------------------------------------------------------------------------------------

const SEL = require('../../scripts/lib/train/selection');

test('selection value: the scan reactions the model took minus those it passed, by the standard trade\'s R', () => {
  const m = (day, bar, side, R, status = 'traded') => ({ day, bar, side, minutes: 3, validBars: 2, standard: { status }, outcome: { R } });
  const moments = [
    m('2022-03-07', '2022-03-07T14:30:00.000Z', 'long', 2), m('2022-03-07', '2022-03-07T15:00:00.000Z', 'short', -1),
    m('2022-03-07', '2022-03-07T15:30:00.000Z', 'long', -1), m('2022-03-08', '2022-03-08T14:30:00.000Z', 'long', 1),
    m('2022-03-07', '2022-03-07T16:00:00.000Z', 'long', 5, 'no-room'), m('2022-03-09', '2022-03-09T14:30:00.000Z', 'long', 3),
  ];
  const reactions = SEL.reactionsOf(moments, { days: ['2022-03-07', '2022-03-08'] });
  assert.deepStrictEqual(reactions.map(r => [r.day, r.R]), [['2022-03-07', 2], ['2022-03-07', -1], ['2022-03-07', -1], ['2022-03-08', 1]], 'traded reactions of those days only');
  // Taken: an entry its side from the bar's close to the end of its entry window (validBars bars).
  const entries = SEL.entriesOf([
    { at: '2022-03-07T14:33:30.000Z', composed: { side: 'long' } }, // the 14:30 long, in its window
    { at: '2022-03-07T15:03:30.000Z', side: 'buy' }, // a long while the 15:00 reaction was a short: not it
    { at: '2022-03-07T15:42:00.000Z', side: 'buy' }, // after the 15:30 long's window
    { at: 'x', side: 'buy' },
  ]);
  assert.deepStrictEqual(entries.map(e => e.side), ['long', 'long', 'long']);
  assert.deepStrictEqual(SEL.selectionOf(reactions, entries), { reactions: 4, taken: { n: 1, meanR: 2 }, passed: { n: 3, meanR: -0.3333 }, value: 2.3333 });
  assert.deepStrictEqual(SEL.selectionOf(reactions, []), { reactions: 4, taken: { n: 0, meanR: null }, passed: { n: 4, meanR: 0.25 }, value: null }, 'nothing taken: no value');
  assert.strictEqual(SEL.selectionOf(reactions, [{ at: '2022-03-07T14:30:00.000Z', side: 'long' }]).taken.n, 0, 'before the bar closed is not taking it');
});

test('selection value counts only reactions the model could act on: inside the runner\'s sessions, on bars the run stepped', () => {
  const m = (bar, side, R) => ({ day: '2022-03-07', bar, side, minutes: 3, validBars: 2, standard: { status: 'traded' }, outcome: { R } });
  // 09:30 to 12:00 ET (EST: 14:30Z to 17:00Z): the 14:30Z bar closes 09:33 ET, inside; 13:00Z (08:00 ET) and 17:30Z outside.
  const moments = [m('2022-03-07T14:30:00.000Z', 'long', 2), m('2022-03-07T13:00:00.000Z', 'long', -1), m('2022-03-07T17:30:00.000Z', 'short', -1), m('2022-03-07T15:00:00.000Z', 'short', 1)];
  const NY = ['09:30-12:00@America/New_York'];
  const inside = SEL.reactionsOf(moments, { days: ['2022-03-07'], sessions: NY });
  assert.deepStrictEqual(inside.map(r => r.bar), ['2022-03-07T14:30:00.000Z', '2022-03-07T15:00:00.000Z'], 'outside the sessions: never counted (it could only count as passed)');
  assert.strictEqual(SEL.reactionsOf(moments, { days: ['2022-03-07'], sessions: NY.join(',') }).length, 2, 'a spec string too');
  assert.strictEqual(SEL.reactionsOf(moments, { days: ['2022-03-07'] }).length, 4, 'no sessions given: every hour');
  assert.throws(() => SEL.reactionsOf(moments, { days: ['2022-03-07'], sessions: 'nonsense' }), /no session in nonsense/);
  // Stepped: a decision time from the reaction bar's close until the next bar's; a reaction on a bar the run never
  // stepped (a windowed run's gap) is not counted.
  const stepped = ['2022-03-07T14:33:02.000Z'];
  assert.deepStrictEqual(SEL.selectionOf(inside, [], { stepped }), { reactions: 1, taken: { n: 0, meanR: null }, passed: { n: 1, meanR: 2 }, value: null });
  assert.strictEqual(SEL.selectionOf(inside, [], { stepped: ['2022-03-07T14:36:00.000Z'] }).reactions, 0, 'the next bar\'s close is another bar');
  assert.strictEqual(SEL.selectionOf(inside, [], { stepped: [] }).reactions, 0);
  assert.strictEqual(SEL.selectionOf(inside, []).reactions, 2, 'none given: every reaction');
});

test('the curve carries the selection value: the kept change\'s when kept', () => {
  const champion = { legs: 10, caught: 2, netR: 0, selection: { value: 0 } };
  assert.deepStrictEqual(TC.curvePoint({ round: 1, size: 10, champion }).selection, { value: 0 });
  assert.deepStrictEqual(TC.curvePoint({ round: 1, size: 10, champion, composed: { capture: { b: 1, c: 0 }, selection: { value: 0.5 } }, kept: true }).selection, { value: 0.5 });
});

test('a side\'s trend catch & ride: only its own legs in finished windows, each entry to the window it was placed in; unknown is null', () => {
  const day = '2022-03-07';
  const ms = s => Date.parse(`${day}T${s}Z`);
  const windows = [{ id: 'w1', day, from: ms('14:30:00'), to: ms('15:00:00') }, { id: 'w2', day, from: ms('15:30:00'), to: ms('16:00:00') }];
  const ride = r => ({ entryLag: 0.2, captureShare: r / 4, rideShare: r / 3, peakR: r + 1, peakFrom: 'round-trip', givebackR: 1, r, open: false });
  const side = {
    legs: new Map([['L1', { day, captured: true, unit: 'w1' }], ['L2', { day, captured: true, unit: 'w2' }]]),
    sessions: [{ unit: 'w1', day, complete: true }, { unit: 'w2', day, complete: false, why: 'stopped' }],
  };
  const rides = [{
    windows,
    ride: {
      legs: [
        { id: 'L1', captured: true, availableR: 4, size: { bucket: '2-4x' }, ride: ride(2) },
        { id: 'L2', captured: true, availableR: 6, size: { bucket: '4x+' }, ride: ride(3) }, // its window not finished
        { id: 'OTHER', captured: false, availableR: 9, size: { bucket: '1-2x' }, ride: null }, // another half's leg
      ],
      entries: [{ at: `${day}T14:42:00.000Z`, side: 'long', kind: 'in-trend', r: 2 }, { at: `${day}T15:05:00.000Z`, side: 'short', kind: 'none', r: -1 }, { at: `${day}T15:45:00.000Z`, side: 'long', kind: 'in-trend', r: 3 }],
    },
  }];
  const t = TSC.rideOfSide(side, rides);
  assert.deepStrictEqual([t.legs, t.caught, t.rCaught, t.rAvailable, t.captureShare.median], [1, 1, 2, 4, 0.5]);
  // The entry after w1's end follows w1 (the management after it, as unitOfRecord): counted; w2's is not.
  assert.deepStrictEqual([t.entries.filled, t.entries.inTrend.n, t.entries.none.n], [2, 1, 1]);
  // A run whose ride is unknown (a phase kept before rides were recorded): the side's total unknown, never partial.
  assert.strictEqual(TSC.rideOfSide(side, [...rides, { windows, ride: null }]), null);
  assert.strictEqual(TSC.rideOfSide(side, []), null);
});
