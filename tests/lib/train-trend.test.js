'use strict';

// The probe round's trend set (train/trend-set.js), its screen (train/trend-screen.js) and its findings
// (train/trend-findings.js), the merged ranking (findings.js mergeFindings), the `probe.trend` config
// (probe-config.js) and the screen of both sets together (probe.js combinedScreen), with the trend-move fixture's bars.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const TS = require('../../scripts/lib/train/trend-set');
const TSC = require('../../scripts/lib/train/trend-screen');
const TF = require('../../scripts/lib/train/trend-findings');
const F = require('../../scripts/lib/train/findings');
const SC = require('../../scripts/lib/train/screen');
const PC = require('../../scripts/lib/train/probe-config');
const PR = require('../../scripts/lib/train/probe');
const { FLOW_STEPS } = require('../../scripts/lib/trading/composed-reads');
const FL = require('../../scripts/lib/train/flow');
const moves = require('../fixtures/trend-moves');

const ROOT = path.resolve(__dirname, '..', '..');
const NY = '09:30-12:00@America/New_York';

test('the flow\'s steps are the harness\'s one list (composed-reads.js FLOW_STEPS)', () => {
  assert.strictEqual(FL.FLOW_STEPS, FLOW_STEPS);
});

test('the trend pool: every leg of the screen period, by the capture report\'s detector and ids; excluded days never in it; pinned', () => {
  const { bars } = moves.load();
  const all = TS.sessionDays(bars.m3, NY);
  assert.deepStrictEqual(all, ['2021-05-03', '2021-05-04', '2021-05-05', '2021-05-06']);
  const legs = require('../../scripts/lib/replay/trend-capture').legsOf(bars.m3, { session: NY });
  const a = TS.buildTrendSet({ bars: bars.m3, session: NY, from: '2021-05-03', to: '2021-05-07' });
  assert.deepStrictEqual(a, TS.buildTrendSet({ bars: bars.m3, session: NY, from: '2021-05-03', to: '2021-05-07' }));
  assert.deepStrictEqual(a.legs.map(l => l.id), legs.map(l => `${l.day}|${l.side}|${l.start}`), 'the capture report\'s own leg ids');
  assert.strictEqual(a.days.reduce((n, d) => n + d.legs, 0), legs.length);
  assert.deepStrictEqual(a.detector, { version: 'zigzag-session-tr-v1', minMoveAtr: require('../../scripts/lib/tunables').replay().trendCapture.minMoveAtr, session: NY });
  // The regression days are left out; to is exclusive.
  const x = TS.buildTrendSet({ bars: bars.m3, session: NY, from: '2021-05-03', to: '2021-05-06', exclude: ['2021-05-04'] });
  assert.deepStrictEqual(x.days.map(d => d.day), ['2021-05-03', '2021-05-05']);
  assert.ok(x.legs.every(l => ['2021-05-03', '2021-05-05'].includes(TS.dayOfLeg(l.id))));
  assert.throws(() => TS.buildTrendSet({ bars: bars.m3, session: NY, from: '2021-05-03', to: '2021-05-07', exclude: all }), /no session/);
  assert.throws(() => TS.buildTrendSet({ bars: bars.m3, session: NY, from: '2021-05-07', to: '2021-05-03', exclude: 'x' }), /from, to[\s\S]*exclude/);
  // Pinned: written, read back, a changed one refused.
  const dir = tmpDir();
  const file = TS.writeTrendSet(dir, a);
  assert.deepStrictEqual(TS.readTrendSet(file), a);
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  t.legs.pop();
  fs.writeFileSync(file, JSON.stringify(t));
  assert.throws(() => TS.readTrendSet(file), /doesn't match its fingerprint/);
});

const POOL = Array.from({ length: 40 }, (_, i) => `2022-03-${String(1 + Math.floor(i / 4)).padStart(2, '0')}|${i % 2 ? 'short' : 'long'}|${i}`);

test('a round\'s batch: deterministic from the seed, a new one each round, without replacement until the pool is used up', () => {
  const r1 = TS.drawRound(POOL, { seed: 3, round: 1, per: 12 });
  assert.deepStrictEqual(r1, TS.drawRound(POOL, { seed: 3, round: 1, per: 12 }), 'the same seed and round, the same batch');
  assert.notDeepStrictEqual(r1.items, TS.drawRound(POOL, { seed: 4, round: 1, per: 12 }).items, 'another seed, another batch');
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

test('the trend-set CLI builds and shows a pool from a bars file', () => {
  const { bars } = moves.load();
  const dir = tmpDir();
  const file = path.join(dir, 'm3.json');
  fs.writeFileSync(file, JSON.stringify(bars.m3));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'trend-set.js'), 'build', '--bars', file, '--from', '2021-05-03', '--to', '2021-05-07', '--minutes', '3', '--exclude', '2021-05-04', '--out', dir], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /leg\(s\) in 3 session\(s\) of 2021-05-03\.\.2021-05-07/);
  assert.match(r.stdout, /excluded: 2021-05-04/);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'trend-set.js'), 'build', '--bars', file], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /required/);
});

// --- the screen ------------------------------------------------------------------------------------------------------

/** A side from leg states: legs(i) -> captured; days -> net R. */
function tside({ n = 20, caught = () => false, r = () => 0, blows = 0 } = {}) {
  const legs = Array.from({ length: n }, (_, i) => ({ id: `2022-03-${String(7 + (i % 10)).padStart(2, '0')}|long|${i}`, day: `2022-03-${String(7 + (i % 10)).padStart(2, '0')}`, captured: caught(i), availableR: 2 }));
  const days = {};
  for (let d = 0; d < 10; d += 1) days[`2022-03-${String(7 + d).padStart(2, '0')}`] = [{ trades: [{ roundTrip: { r: r(d) } }] }];
  return TSC.sideOfTrend({ captures: [{ legs }], days, scorecard: Array.from({ length: blows }, () => ({ blow: true })) });
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
  assert.match(TSC.screenTrend(greedy).harms.join(), /net R per session worse/);
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
const leg = (id, { captured = false, availableR = 1, blocker = null, cycles = [] } = {}) => ({ id, day: id.slice(0, 10), captured, availableR, blocker, cycles });

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
  assert.match(found[0].detail, /entry:close \(1\); entry:momentum \(1\); e\.g\. /);
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
  assert.match(F.findingLine(m[0]), /^F1\. agent risk-manager: trend-blocker at risk: blocked 3 of 9 trend legs\. Most often: veto \(3\)$/);
  assert.match(F.findingLine({ ...m[0], agent: undefined, skill: null }), /^F1\. \(no skill or role named\): trend-blocker/);
  assert.doesNotMatch(F.findingLine(m[0]), /\bR\b|left/, 'the proposer reads what blocked the plan, never the move');
});

// --- the config ------------------------------------------------------------------------------------------------------

test('probe.trend: whole-session stage-1 runs on the loop\'s trader; its days practice-train, outside the tuning windows; regression apart', () => {
  const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
  const curated = { stage: 1, curatedList: { file: 'c.json', list: 'mix' }, practice: { mode: 'setup-focus' } };
  const set = { kind: 'trend-set', fingerprint: 'fp', days: [{ day: '2022-03-07' }, { day: '2022-03-08' }], legs: [{ id: '2022-03-07|long|a' }, { id: '2022-03-08|short|b' }] };
  const base = { replay: curated, windows: [{ from: '2022-03-07', to: '2022-03-19' }] };
  const tuning = [{ from: '2022-06-06', to: '2022-06-18' }];
  const go = (t, over = {}) => PC.resolveProbe({ ...base, trend: t && typeof t === 'object' ? { batch: 2, half: 0.5, ...t } : t }, { read: x => x, readSet: () => set, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: tuning, ...over });
  const ok = go({ replay: { stage: 1 }, set: 'set.json', regression: { days: ['2021-05-04', '2021-05-03'] } });
  assert.deepStrictEqual(ok.trend, { replay: { stage: 1, autotrader: trader }, set: { file: 'set.json', fingerprint: 'fp', days: ['2022-03-07', '2022-03-08'], legs: ['2022-03-07|long|a', '2022-03-08|short|b'] }, batch: 2, half: 0.5, regression: { days: ['2021-05-03', '2021-05-04'] } });
  // The batch and its halves' share: from the loop config, bounded by the pool.
  assert.throws(() => go({ replay: { stage: 1 }, set: 's', batch: 3 }), /probe.trend.batch: the legs a round draws, a whole number from 1 to the pool's 2/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's', batch: undefined }), /probe.trend.batch/);
  for (const half of [0, 1, '0.5', undefined]) assert.throws(() => go({ replay: { stage: 1 }, set: 's', half }), /probe.trend.half: the probe half's share/, String(half));
  assert.strictEqual(go(undefined).trend, undefined, 'none without it');
  assert.throws(() => go({ replay: { stage: 1, curatedList: {} }, set: 's' }), /probe.trend.replay.curatedList: not here/);
  assert.throws(() => go({ replay: { stage: 1, practice: {} }, set: 's' }), /probe.trend.replay.practice/);
  assert.throws(() => go({ replay: { stage: 2 }, set: 's' }), /probe.trend.replay.stage: 1/);
  assert.throws(() => go({ replay: { stage: 1, autotrader: { ...trader, timeframe: 1 } }, set: 's' }), /probe.trend.replay.autotrader: the loop's replay.autotrader/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's', extra: 1 }), /probe.trend.extra: not a setting/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's' }, { readSet: () => { throw new Error('no such file'); } }), /probe.trend.set: no such file/);
  // Days inside a tuning window, outside practice-train, or in both the set and the regression days: refused.
  assert.throws(() => go({ replay: { stage: 1 }, set: 's' }, { tuningWindows: [{ from: '2022-03-08', to: '2022-03-09' }] }), /probe.trend.set 2022-03-08: inside the tuning window 2022-03-08..2022-03-09/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's' }, { readSet: () => ({ ...set, days: [{ day: '2024-08-05' }] }) }), /probe.trend.set 2024-08-05: probes run on practice-train only/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's', regression: { days: ['2022-03-07'] } }), /also in the trend set: the regression days judge harm only/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's', regression: { days: ['2022-06-07'] } }), /probe.trend.regression 2022-06-07: inside the tuning window/);
  assert.throws(() => go({ replay: { stage: 1 }, set: 's', regression: { days: [] } }), /probe.trend.regression: \{ days/);
  // parallel above 1: no latency charged on the trend runs either.
  const par = t => PC.resolveProbe({ ...base, replay: { ...curated, latency: false }, parallel: 2, trend: { batch: 2, half: 0.5, ...t } }, { read: x => x, readSet: () => set, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: tuning });
  assert.throws(() => par({ replay: { stage: 1 }, set: 's' }), /probe.parallel: more than 1 only with probe.trend.replay.latency false/);
  assert.strictEqual(par({ replay: { stage: 1, latency: false }, set: 's' }).parallel, 2);
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
});
