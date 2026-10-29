'use strict';

// The probe round's curriculum (scripts/lib/train/curriculum.js, probe-config.js): 'all' (the default, today's round)
// or 'trend' (the trend set only); a trend run's read data merged for the findings and the screens; the round report's
// mastery read (legs caught, R caught / available, the control windows' false starts, blows).

const test = require('node:test');
const assert = require('node:assert');
const CU = require('../../scripts/lib/train/curriculum');
const PC = require('../../scripts/lib/train/probe-config');
const SC = require('../../scripts/lib/train/screen');
const F = require('../../scripts/lib/train/findings');
const IR = require('../../scripts/lib/train/iteration-report');

const PEAK = require('../../scripts/lib/tunables').training().trendReport.falseStartPeakR;

// --- the probe setting --------------------------------------------------------------------------------------------

const trader = { harness: 'custom', command: ['x', '{prompt}'], symbols: ['MNQ'], timeframe: 3 };
const curated = { stage: 1, curatedList: { file: 'c.json', list: 'mix' }, practice: { mode: 'setup-focus' } };
const leg = (id, day, side) => ({ id, day, side, start: `${day}T14:30:00.000Z`, end: `${day}T14:51:00.000Z`, points: 10 });
const census = { kind: 'leg-census', fingerprint: 'fp', order: [leg('2022-03-07|long|a', '2022-03-07', 'long'), leg('2022-03-08|short|b', '2022-03-08', 'short'), leg('2021-05-04|long|c', '2021-05-04', 'long')] };
const trendSet = { replay: { stage: 1 }, census: 'c.json', from: '2021-05-03', to: '2022-09-01', regression: { days: ['2021-05-04'] } };
const WINDOWS = [{ from: '2022-03-07', to: '2022-03-19' }];
const read = x => { if (x === undefined) throw new Error('no replay config given'); return x; };
const go = raw => PC.resolveProbe(raw, { read, readCensus: () => census, modelScore: { account: 'a' }, autotrader: trader, tuningWindows: [{ from: '2022-10-03', to: '2022-10-15' }] });

test('probe.curriculum: all (the default) is today\'s setting, byte for byte; it adds no key', () => {
  const before = go({ replay: curated, windows: WINDOWS, trend: trendSet });
  assert.strictEqual(before.curriculum, undefined);
  assert.deepStrictEqual(go({ replay: curated, windows: WINDOWS, trend: trendSet, curriculum: 'all' }), before);
  assert.deepStrictEqual(Object.keys(before), ['replay', 'windows', 'k', 'parallel', 'trend']);
  assert.strictEqual(CU.curriculumOf(before), 'all');
  // Under all, the curated replay and windows are required as ever, the trend set optional.
  assert.throws(() => go({ windows: WINDOWS, curriculum: 'all' }), /probe\.replay: no replay config given/);
  assert.throws(() => go({ replay: curated, curriculum: 'all' }), /probe\.windows: one or more/);
  assert.doesNotThrow(() => go({ replay: curated, windows: WINDOWS }));
  assert.throws(() => go({ replay: curated, windows: WINDOWS, curriculum: 'trends' }), /probe\.curriculum: one of all, trend \(default all\)/);
  assert.throws(() => go({ replay: curated, windows: WINDOWS, curriculum: null }), /probe\.curriculum: one of/);
});

test('probe.curriculum trend: the trend set required; no curated replay or windows (refused when set)', () => {
  const t = go({ curriculum: 'trend', trend: trendSet });
  assert.deepStrictEqual([t.curriculum, t.replay, t.windows, t.k, t.parallel], ['trend', null, [], 4, 1]);
  assert.deepStrictEqual(t.trend.set.legs, ['2022-03-07|long|a', '2022-03-08|short|b']);
  assert.strictEqual(CU.curriculumOf(t), 'trend');
  assert.throws(() => go({ curriculum: 'trend' }), /probe\.trend: curriculum trend replays the trend set: set it/);
  assert.throws(() => go({ curriculum: 'trend', trend: trendSet, replay: curated }), /probe\.replay: not read under curriculum trend/);
  assert.throws(() => go({ curriculum: 'trend', trend: trendSet, windows: WINDOWS }), /probe\.windows: not read under curriculum trend/);
  // The trend set's own checks hold as ever (here: a stage-2 trend replay).
  assert.throws(() => go({ curriculum: 'trend', trend: { ...trendSet, replay: { stage: 2 } } }), /probe\.trend\.replay\.stage: 1/);
  // parallel above 1 still needs the trend replay's latency off.
  assert.throws(() => go({ curriculum: 'trend', trend: trendSet, parallel: 2 }), /probe\.trend\.replay\.latency false/);
  assert.strictEqual(go({ curriculum: 'trend', trend: { ...trendSet, replay: { stage: 1, latency: false } }, parallel: 2 }).parallel, 2);
});

// --- a trend run's read data ----------------------------------------------------------------------------------------

const decision = (bar, check) => ({ root: 'MNQ', bar, decision: 'passed', outcome: { R: 0 }, reads: [{ step: 'zone', skill: 'a', read: 'y', check, agrees: true }] });
const card = (bar, category) => ({ key: `${bar}|MNQ`, t: bar, barT: bar, symbol: 'MNQ', category, actual: { action: 'none' }, falseReasons: category === 'wrong stated reason' ? ['no room'] : [], blow: false });
const usage = (wrong, reads) => ({ skills: [{ skill: 'a', reads, correct: reads - wrong, wrong, available: reads, used: reads, relevant: reads, missed: 0, topRefusals: wrong ? [{ what: 'false: y', count: wrong }] : [], topMissed: [] }] });

test('a trend run\'s read data: reduced as the screen reads a side; runs merged into one side as the curated one', () => {
  const A = ['2022-03-07T14:33:00.000Z', '2022-03-07T14:36:00.000Z'];
  const B = ['2022-03-08T14:33:00.000Z'];
  const a = CU.readPart({ data: { decisions: [decision(A[0], false), decision(A[1], true)], usage: usage(1, 2), points: [], records: [{ root: 'MNQ', bar: A[0], reads: [{ step: 'zone', skill: 'a', read: 'y' }] }] }, scorecard: [card(A[0], 'wrong stated reason'), card(A[1], 'right')] });
  const b = CU.readPart({ data: { decisions: [decision(B[0], false)], usage: usage(1, 1), points: [], records: [] }, scorecard: [card(B[0], 'right')] });
  assert.deepStrictEqual(a.side, SC.sideOf({ decisions: [decision(A[0], false), decision(A[1], true)], scorecard: [card(A[0], 'wrong stated reason'), card(A[1], 'right')] }));
  assert.deepStrictEqual(a.refusals, [{ key: `${A[0]}|MNQ`, skills: ['a'], falseReasons: ['no room'] }]);
  const m = CU.readSideOf([a, b]);
  assert.deepStrictEqual(m.side.decisions.map(d => d.key), [...a.side.decisions, ...b.side.decisions].map(d => d.key));
  assert.strictEqual(m.side.scorecard.length, 3);
  assert.deepStrictEqual(m.skills, F.mergeUsage([usage(1, 2), usage(1, 1)]));
  assert.deepStrictEqual([m.skills[0].wrong, m.skills[0].reads], [2, 3]);
  assert.deepStrictEqual(m.side.usage, SC.sideOf({ usage: m.skills }).usage);
  assert.deepStrictEqual(m.refusals, a.refusals);
  // The merged side pairs as one: a misread finding's scope counts every run's claimed decisions.
  assert.strictEqual(SC.targetScope(m.side, { skill: 'a', kind: 'misread' }), 3);
  assert.strictEqual(SC.targetScope(m.side, { skill: 'a', kind: 'wrong-reason refusal' }), 3);
  // One exit plan across the runs (sorted, once): a run under another plan shows as two, which measure refuses.
  const planned = p => ({ ...a, side: { ...a.side, exitPlans: [p] } });
  assert.deepStrictEqual(CU.readSideOf([planned('x'), planned('x')]).side.exitPlans, ['x']);
  assert.deepStrictEqual(CU.readSideOf([planned('y'), planned('x')]).side.exitPlans, ['x', 'y']);
  assert.deepStrictEqual(CU.readSideOf([]), { side: { decisions: [], exitPlans: [], scorecard: [], usage: [] }, skills: [], refusals: [] });
});

// --- the mastery read -----------------------------------------------------------------------------------------------

const done = (unit, complete = true) => ({ unit, complete });
const exit = (unit, r, peakR) => ({ unit, r, peakR });

test('control false starts: of the trades in finished control windows, the losers whose peak never rose above the config\'s R', () => {
  const sessions = [done('d|control|1'), done('d|control|2'), done('d|leg|1'), done('d|control|3', false)];
  const controls = ['d|control|1', 'd|control|2', 'd|control|3'];
  const exits = [
    exit('d|control|1', -1, 0), exit('d|control|1', -1, PEAK), // false starts (at the threshold too)
    exit('d|control|2', -1, PEAK + 0.25), exit('d|control|2', 0.5, 0.75), exit('d|control|2', 0, 0), // a loser that ran, a winner, a scratch
    exit('d|control|2', -1, null), // peak unknown
    exit('d|leg|1', -1, 0), // a leg window's: not a control
    exit('d|control|3', -1, 0), // a control window not finished: left out
  ];
  assert.deepStrictEqual(CU.falseStarts(exits, { controls, sessions, peakR: PEAK }), { windows: 2, entries: 6, falseStarts: 2, unknown: 1, share: 0.4 });
  assert.deepStrictEqual(CU.falseStarts([], { controls, sessions, peakR: PEAK }), { windows: 2, entries: 0, falseStarts: 0, unknown: 0, share: null });
  assert.strictEqual(CU.falseStarts(null, { controls, sessions, peakR: PEAK }), null, 'exits unknown: unknown, never zero');
  assert.throws(() => CU.falseStarts([], { controls, sessions }), /peakR/);
  assert.ok(PEAK > 0, 'config/training.json trendReport.falseStartPeakR');
});

test('the mastery read: legs caught, R caught / available, control false starts, blows; masteryText; the report\'s lines', () => {
  const ride = { legs: 20, caught: 7, catchRate: 0.35, rCaught: 6, rAvailable: 50, rCaughtUnknown: 1, rAvailableUnknown: 0 };
  const controls = { windows: 9, entries: 5, falseStarts: 2, unknown: 1, share: 0.5 };
  const m = CU.mastery({ ride, floorBreaches: 0, controls });
  assert.deepStrictEqual(m, { legs: 20, caught: 7, caughtShare: 0.35, rCaught: 6, rAvailable: 50, rShare: 0.12, rUnknown: 1, controls, combinePass: null, keepRuleBlows: null, floorBreaches: 0 });
  assert.strictEqual(CU.masteryText(m), 'legs caught 35% (7 of 20), R caught / available 12% (6 / 50, 1 unknown), control false starts 50% (2 of 4 known trade(s), 1 unknown, in 9 finished control window(s)), combine pass rate n/a (not judged by the keep rule), keep rule\'s combine blows n/a (not judged by the keep rule), floor breaches in the trend runs 0');
  assert.match(CU.masteryText(CU.mastery({ ride, keepRuleBlows: 2, floorBreaches: 0, keepRulePass: { passed: 3, attempts: 8, rate: 0.375 } })), /combine pass rate 37\.5% \(3 of 8 of the keep rule's real attempts\), keep rule's combine blows 2, floor breaches in the trend runs 0$/);
  assert.deepStrictEqual(CU.mastery({ ride: { ...ride, rAvailable: 0 } }).rShare, null, 'no R available: no share');
  assert.deepStrictEqual(CU.mastery({}), { legs: null, caught: null, caughtShare: null, rCaught: null, rAvailable: null, rShare: null, rUnknown: null, controls: null, combinePass: null, keepRuleBlows: null, floorBreaches: null });
  assert.strictEqual(CU.masteryText(CU.mastery({})), 'legs caught n/a (? of ?), R caught / available n/a (? / ?), control false starts n/a (exits unknown), combine pass rate n/a (not judged by the keep rule), keep rule\'s combine blows n/a (not judged by the keep rule), floor breaches in the trend runs ?');
  // The iteration record: the champion's confirm half and the combined change's, kept or not.
  const probeReport = { iteration: 2, curriculum: 'trend', trend: { set: 'f', batch: { index: 1, size: 4, trigger: 'start' }, probe: { days: [], legs: [] }, confirm: { days: [], legs: [] }, champion: { ride, blows: 0, controls, legs: 20, caught: 7, netR: 0, firstTry: null, sessions: 3 } }, composed: { id: 'c1', verdict: 'helped', trend: { ride: { ...ride, caught: 9, catchRate: 0.45, rCaught: 8 }, blows: 1, controls: null } } };
  const rec = IR.build({ probeReport, entries: [{ iteration: 2, proposalId: 'c1', verdict: 'kept', composition: {}, model: { windows: [{ blows: { a: 4, b: 0 }, challenger: { attempts: 10, passed: 5 } }, { blows: { a: 1, b: 0 }, challenger: { attempts: 6, passed: 1 } }] } }] });
  assert.deepStrictEqual(rec.mastery.champion, m);
  // The combined change: its keep-rule blows from the archive (0: the challenger's), its trend runs' floor breach (1) apart.
  assert.deepStrictEqual([rec.mastery.curriculum, rec.mastery.composed.id, rec.mastery.composed.kept, rec.mastery.composed.caughtShare, rec.mastery.composed.rShare, rec.mastery.composed.keepRuleBlows, rec.mastery.composed.floorBreaches], ['trend', 'c1', true, 0.45, 0.16, 0, 1]);
  assert.strictEqual(IR.build({ probeReport, entries: [{ iteration: 2, proposalId: 'other', verdict: 'kept', composition: {}, model: { windows: [{ blows: { a: 0, b: 0 } }] } }] }).mastery.composed.keepRuleBlows, null, 'another proposal\'s verdict is never this change\'s');
  assert.strictEqual(IR.build({ probeReport }).mastery.composed.keepRuleBlows, null, 'the keep rule did not run');
  // Its combine pass rate: the challenger's real attempts pooled over the windows (6 of 16), the keep rule's alone.
  assert.deepStrictEqual(rec.mastery.composed.combinePass, { passed: 6, attempts: 16, rate: 0.375 });
  assert.strictEqual(rec.mastery.champion.combinePass, null, 'the champion: no keep-rule verdict of its own here');
  assert.strictEqual(IR.build({ probeReport }).mastery.composed.combinePass, null);
  assert.deepStrictEqual(IR.masteryLines(rec), [
    '  Mastery read (iteration 2, curriculum trend, confirm half: held-out trend legs):',
    `    champion: ${CU.masteryText(m)}`,
    `    combined c1 (kept): ${CU.masteryText(rec.mastery.composed)}`,
  ]);
  const rejected = IR.build({ probeReport, entries: [{ iteration: 2, proposalId: 'c1', verdict: 'rejected', composition: {} }] });
  assert.match(IR.masteryLines(rejected)[2], /^ {4}combined c1: /);
  // Without the curriculum key, 'all'; without a trend set, no read.
  assert.strictEqual(IR.build({ probeReport: { ...probeReport, curriculum: undefined } }).mastery.curriculum, 'all');
  assert.strictEqual(IR.build({ probeReport: { iteration: 1 } }).mastery, null);
  assert.deepStrictEqual(IR.masteryLines(IR.build({ probeReport: { iteration: 1 } })), []);
});

test('the exit screen under curriculum trend (onlyTrend): a trade entered at a moment and scored as an exit pairs once', () => {
  const at = '2022-03-07T14:36:30.000Z';
  const side = R => ({ decisions: [{ key: `MNQ|${Date.parse(at)}`, entered: true, side: 'long', R }], scorecard: [], usage: [], exitPlans: [] });
  const trade = r => [{ root: 'MNQ', side: 'long', entryAt: at, unit: 'u1', r, peakR: 2, cls: r > 1 ? 'right' : 'cut', exitBy: 'model-exit', late: false }];
  const exits = { champion: trade(0.5), probe: trade(1.5), stepMs: 180000, done: ['u1'] };
  assert.strictEqual(SC.exitTargetTest(side(0.5), side(1.5), exits).pairs, 2, 'curriculum all: the curated moment and the trend exit are two sets');
  const once = SC.exitTargetTest(side(0.5), side(1.5), { ...exits, onlyTrend: true });
  assert.deepStrictEqual([once.pairs, once.b, once.c, once.unmatched], [1, 1, 0, { champion: 0, probe: 0 }]);
});

test('the keep rule\'s combine blows: the archive entry\'s windows (rule (a)), never the trend runs\' floor breaches', () => {
  const entry = w => ({ proposalId: 'c1', verdict: 'rejected', model: { windows: w } });
  assert.strictEqual(CU.keepRuleBlows(entry([{ blows: { a: 3, b: 1 } }, { blows: { a: 0, b: 2 } }])), 3);
  assert.strictEqual(CU.keepRuleBlows(entry([{ blows: { a: 0, b: 0 } }])), 0);
  assert.strictEqual(CU.keepRuleBlows(entry([{ blows: { a: 0, b: 0 } }, { label: 'x' }])), null, 'a window unscored: unknown');
  assert.strictEqual(CU.keepRuleBlows(entry([])), null);
  assert.strictEqual(CU.keepRuleBlows(null), null);
});

test('the keep rule\'s combine pass rate: the challenger\'s real attempts that passed, pooled over its windows; unknown when a window has none', () => {
  const entry = w => ({ model: { windows: w } });
  assert.deepStrictEqual(CU.keepRulePass(entry([{ challenger: { attempts: 20, passed: 9 } }, { challenger: { attempts: 5, passed: 1 } }])), { passed: 10, attempts: 25, rate: 0.4 });
  assert.deepStrictEqual(CU.keepRulePass(entry([{ challenger: { attempts: 0, passed: 0 } }])), { passed: 0, attempts: 0, rate: null });
  assert.strictEqual(CU.keepRulePass(entry([{ challenger: { attempts: 4, passed: 1 } }, { label: 'x' }])), null);
  assert.strictEqual(CU.keepRulePass(entry([])), null);
  assert.strictEqual(CU.keepRulePass(undefined), null);
});
