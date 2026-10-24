'use strict';

// The trend set's stepped windows (scripts/lib/train/trend-windows.js, scripts/lib/replay/step-windows.js): built around
// each leg and its control windows, stepped as a curated run's windows are, paired window by window; nothing of their
// choice reaches the model; and the training preflight takes the loop's trend-set and keep-rule runs, built the way
// the loop builds them (train/loop.js windowRun), only in those roles.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const TW = require('../../scripts/lib/train/trend-windows');
const SW = require('../../scripts/lib/replay/step-windows');
const TSC = require('../../scripts/lib/train/trend-screen');
const L = require('../../scripts/lib/train/loop');
const P = require('../../scripts/lib/learning/preflight');
const { resolveLoop } = require('../../scripts/lib/train/config');
const { resolveReplay, replayEnv, configHash, setupHash } = require('../../scripts/lib/replay/config');
const { curatedPoints } = require('../../scripts/lib/learning/curated-lists');
const { decisionPoints } = require('../../scripts/lib/replay/schedule');
const { validateConfig } = require('../../scripts/lib/autotrader');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN3 = 180000;
const ms0 = iso => Date.parse(iso);
const DAY = '2022-03-07';
const TRADER = { harness: 'claude', model: 'm', symbols: ['MNQ'], account: '1', timeframe: 3, premarketAt: '', sessions: ['09:30-12:00@America/New_York'] };
const CFG = validateConfig(TRADER);
const CLOSES = TW.dayCloses(CFG, DAY);
const leg = (side, start, end, day = DAY) => ({ id: `${day}|${side}|${start}`, day, side, start, end, points: 30 });
// 09:42 ET to 10:30 ET (EST: 14:42Z to 15:30Z): its catch window, the first half, ends 15:06Z (15:07:30Z, whole bars).
const A = leg('long', `${DAY}T14:42:00.000Z`, `${DAY}T15:30:00.000Z`);
// The run home's brokers.json, as the loop seeds it (a replay broker entry).
const seedBrokers = run => { fs.mkdirSync(run.paths.runHome, { recursive: true }); fs.writeFileSync(path.join(run.paths.runHome, 'brokers.json'), JSON.stringify({ broker: 'backtester', brokers: { backtester: { command: ['x'], replay: true, journalEnv: 'SIM_JOURNAL', env: [] } } })); };
const OPTS = { day: DAY, closes: CLOSES, minutes: 3, seed: 1, leadBars: 4, controlPerLeg: 1, catchShare: 0.5 };

test('a leg window: leadBars bars before the start through its catch window, whole bars, clipped to the runner\'s sessions', () => {
  assert.deepStrictEqual([CLOSES[0], CLOSES[CLOSES.length - 1]].map(c => new Date(c).toISOString()), [`${DAY}T14:30:00.000Z`, `${DAY}T16:57:00.000Z`], 'the session\'s bar closes, 09:30 to 11:57 ET (each decided at its close plus the poll delay, before 12:00)');
  const { windows, dropped } = TW.windowsFor({ ...OPTS, legs: [A], controlPerLeg: 0 });
  assert.deepStrictEqual(dropped, []);
  assert.deepStrictEqual(windows.map(w => [w.kind, w.legs, new Date(w.from).toISOString(), new Date(w.to).toISOString()]), [['leg', [A.id], `${DAY}T14:30:00.000Z`, `${DAY}T15:06:00.000Z`]]);
  // Its bars: the four before the start bar (closes 14:33 to 14:42), the start bar (14:45) through the catch window's last.
  const w = windows[0];
  const inside = CLOSES.filter(c => c > w.from && c <= w.to);
  assert.deepStrictEqual([inside.length, new Date(inside[0]).toISOString()], [12, `${DAY}T14:33:00.000Z`]);
  // At the session's open: the lead-in clipped to the session (no bar before 09:30 ET is stepped).
  const early = TW.windowsFor({ ...OPTS, legs: [leg('short', `${DAY}T14:30:00.000Z`, `${DAY}T15:00:00.000Z`)], controlPerLeg: 0 }).windows[0];
  assert.strictEqual(new Date(early.from).toISOString(), `${DAY}T14:27:00.000Z`, 'its first bar the session\'s first, the 09:30 ET close');
  // A leg outside the runner's sessions: dropped, said why.
  const late = TW.windowsFor({ ...OPTS, legs: [leg('long', `${DAY}T18:00:00.000Z`, `${DAY}T18:30:00.000Z`)] });
  const NONE = 'no decision time of the runner\'s sessions (outside them, or an exchange holiday)';
  assert.deepStrictEqual([late.windows, late.dropped.map(d => d.why)], [[], [NONE]]);
  // An exchange holiday (Memorial Day 2021): no decision time, as the run's own config closes it; its legs dropped.
  const HOL = '2021-05-31';
  assert.deepStrictEqual(TW.dayCloses(CFG, HOL), []);
  assert.ok(TW.dayCloses(CFG, '2021-06-01').length > 0);
  assert.deepStrictEqual(TW.windowsFor({ ...OPTS, day: HOL, closes: TW.dayCloses(CFG, HOL), legs: [leg('long', `${HOL}T13:42:00.000Z`, `${HOL}T14:30:00.000Z`, HOL)] }).dropped.map(d => d.why), [NONE]);
  // A different lead-in or catch share: a different window.
  assert.strictEqual(new Date(TW.windowsFor({ ...OPTS, legs: [A], leadBars: 2, controlPerLeg: 0 }).windows[0].from).toISOString(), `${DAY}T14:36:00.000Z`);
});

test('legs whose windows touch merge into one; control windows are as long, in the session, clear of every census leg, seeded', () => {
  const B = leg('short', `${DAY}T15:00:00.000Z`, `${DAY}T15:24:00.000Z`);
  const other = leg('long', `${DAY}T16:00:00.000Z`, `${DAY}T16:30:00.000Z`);
  // A session to 15:50 New York time: room for both legs' controls clear of every leg's whole extent.
  const WIDE = TW.dayCloses(validateConfig({ ...TRADER, sessions: ['09:30-15:50@America/New_York'] }), DAY);
  const OW = { ...OPTS, closes: WIDE };
  const { windows } = TW.windowsFor({ ...OW, legs: [A, B], others: [other] });
  const legsW = windows.filter(w => w.kind === 'leg');
  assert.deepStrictEqual(legsW.map(w => w.legs), [[A.id, B.id]], 'one merged window');
  const controls = windows.filter(w => w.kind === 'control');
  assert.strictEqual(controls.length, 2, 'one a leg');
  const own = l => TW.windowsFor({ ...OPTS, legs: [l], controlPerLeg: 0 }).windows[0];
  for (const c of controls) {
    const forLeg = own(c.for === A.id ? A : B);
    assert.strictEqual(c.to - c.from, forLeg.to - forLeg.from, 'the same length as its leg\'s window');
    for (let t = c.from + MIN3; t <= c.to; t += MIN3) assert.ok(WIDE.includes(t), 'every bar in the session');
  }
  // No window shares a bar with another; no control window with any census leg (the batch's own or not), from its
  // lead-in to its end (its tail past the catch window included).
  const overlap = (a, b) => a.from < b.to && b.from < a.to;
  const extents = [A, B, other].map(g => TW.legExtent(g, { step: MIN3, leadBars: 4 }));
  for (let i = 0; i < windows.length; i += 1) for (let j = i + 1; j < windows.length; j += 1) assert.ok(!overlap(windows[i], windows[j]), `windows ${i} and ${j} overlap`);
  for (const c of controls) for (const x of extents) assert.ok(!overlap(c, x), 'a control window on a leg');
  for (let i = 1; i < windows.length; i += 1) assert.ok(windows[i].from >= windows[i - 1].to, 'in order');
  // Whatever the seed: a leg's own control never sits in its tail (14:42 to 15:30, its catch window ending 15:06).
  const tail = TW.legExtent(A, { step: MIN3, leadBars: 4 });
  assert.deepStrictEqual([new Date(tail.from).toISOString(), new Date(tail.to).toISOString()], [`${DAY}T14:30:00.000Z`, `${DAY}T15:33:00.000Z`]);
  for (let seed = 1; seed <= 40; seed += 1) {
    for (const c of TW.windowsFor({ ...OPTS, seed, legs: [A] }).windows.filter(w => w.kind === 'control')) assert.ok(!overlap(c, tail), `seed ${seed}`);
  }
  // Seeded: the same inputs the same windows (the champion and every edit step these); another seed may move a control.
  assert.deepStrictEqual(TW.windowsFor({ ...OW, legs: [A, B], others: [other] }).windows, windows);
  const seeds = new Set([1, 2, 3, 4, 5].map(seed => JSON.stringify(TW.windowsFor({ ...OW, seed, legs: [A, B], others: [other] }).windows.filter(w => w.kind === 'control').map(w => w.from))));
  assert.ok(seeds.size > 1, 'the seed picks the control windows');
  // Two sessions with a gap between: a control window never spans the gap (every bar of it a decision bar).
  const seg = (from, n) => Array.from({ length: n }, (_, i) => ms0(from) + (i + 1) * MIN3);
  const gapped = [...seg(`${DAY}T14:30:00.000Z`, 20), ...seg(`${DAY}T16:27:00.000Z`, 5)];
  const split = TW.windowsFor({ ...OPTS, closes: gapped, legs: [A] });
  assert.deepStrictEqual([split.windows.map(w => w.kind), split.dropped.map(d => d.why)], [['leg'], ['no free stretch of the same length in the session']]);
  // No free stretch: the control is dropped, said why, never placed on a leg.
  const full = TW.windowsFor({ ...OPTS, legs: [A], others: [leg('short', `${DAY}T14:30:00.000Z`, `${DAY}T19:40:00.000Z`)] });
  assert.deepStrictEqual([full.windows.filter(w => w.kind === 'control'), full.dropped.map(d => d.why)], [[], ['no free stretch of the same length in the session']]);
});

test('the window guard: a window counts only when its own bars ran to its end; an end of day alone, a latency skip or a failed cycle never count', () => {
  const { windows } = TW.windowsFor({ ...OPTS, legs: [A] });
  const [first, second] = windows;
  const rec = (t, extra = {}) => ({ t, day: DAY, kind: 'trade', ...extra });
  const at = ms => new Date(ms).toISOString();
  const states = (recs, minutes = 3) => TW.windowStates({ days: { [DAY]: recs }, windows, minutes });
  const ran = w => rec(at(w.to + 2000)); // its last bar's cycle
  const one1 = states([ran(first)]);
  assert.deepStrictEqual(one1.map(s => [s.kind, s.complete]), windows.map(w => [w.kind, w.id === first.id]));
  assert.match(one1.find(s => !s.complete).why, /stopped before the window ended|no trade cycle on its bars/);
  // Both ran: both count; the last record of a window failed: it doesn't.
  assert.ok(states([ran(first), ran(second)].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))).every(s => s.complete));
  const failed = states([rec(at(first.to + 2000), { errors: ['crash'] }), ran(second)]);
  assert.deepStrictEqual(failed.map(s => s.complete), windows.map(w => w.id !== first.id));
  // An end of day reaches every window of the day, but a window none of whose bars ran saw nothing: not finished.
  const eod = rec(`${DAY}T20:50:00.000Z`, { kind: 'eod', trades: [{ roundTrip: { r: -1 } }] });
  assert.deepStrictEqual(states([eod]).map(s => [s.complete, s.why]), windows.map(() => [false, 'no trade cycle on its bars']));
  assert.ok(states([ran(first), ran(second), eod].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))).every(s => s.complete));
  // A decision time inside it passed without a step (latency charged, a slow cycle): not finished, said why.
  const slow = states([rec(at(first.from + MIN3 + 2000)), rec(at(first.to + 2000), { skipped: [at(first.from + 2 * MIN3 + 2000)] }), ran(second), eod].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)));
  assert.deepStrictEqual(slow.map(s => s.complete), windows.map(w => w.id !== first.id));
  assert.match(slow.find(s => !s.complete).why, /1 decision time\(s\) inside it passed without a step/);
  // A management record after the window doesn't count as a cycle of its bars.
  assert.ok(!TW.windowStates({ days: { [DAY]: [rec(at(first.to + 3 * MIN3 + 2000)), eod] }, windows: [first], minutes: 3 })[0].complete);
  assert.throws(() => TW.windowStates({ days: {}, windows }), /minutes, the run's base timeframe/);
  // R: each round trip to the window it was opened in. A trade closed while managing after the window, and the end of
  // day's flatten, with no opening known: the window their close followed; a record before the first window: none.
  const one = TW.windowsFor({ ...OPTS, legs: [A], controlPerLeg: 0 }).windows;
  const managed = rec(at(one[0].to + MIN3 * 3 + 2000), { trades: [{ roundTrip: { r: 2 } }] });
  const pre = rec(`${DAY}T13:00:00.000Z`, { trades: [{ roundTrip: { r: 5 } }] });
  assert.deepStrictEqual(TW.unitR({ days: { [DAY]: [pre, managed, eod] }, windows: one }), { [one[0].id]: 1 });
  assert.deepStrictEqual(TW.unitR({ days: { [DAY]: [rec(at(one[0].from + MIN3 + 2000), { trades: [{ roundTrip: { r: 1.5 } }] })] }, windows }), Object.fromEntries(windows.map(w => [w.id, w.kind === 'leg' ? 1.5 : 0])));
  // A trade opened in the earlier window and closed inside the later one stays the earlier one's: by its opening fill,
  // or by its roundTrip's openMs.
  const [w1, w2] = windows;
  const closeIn2 = trades => rec(at(w2.from + MIN3 + 2000), { trades });
  const openFill = rec(at(w1.from + MIN3 + 2000), { trades: [{ roundTripId: 9, profitAndLoss: null, creationTimestamp: at(w1.from + MIN3 + 1000) }] });
  const r1 = TW.unitR({ days: { [DAY]: [openFill, closeIn2([{ roundTripId: 9, profitAndLoss: 50, roundTrip: { r: 3 } }])] }, windows });
  assert.deepStrictEqual([r1[w1.id], r1[w2.id]], [3, 0]);
  const r2 = TW.unitR({ days: { [DAY]: [closeIn2([{ roundTripId: 4, profitAndLoss: 50, roundTrip: { r: -1, openMs: w1.from + MIN3 } }])] }, windows });
  assert.deepStrictEqual([r2[w1.id], r2[w2.id]], [-1, 0]);
  const r3 = TW.unitR({ days: { [DAY]: [closeIn2([{ roundTripId: 5, profitAndLoss: 50, roundTrip: { r: 2 } }])] }, windows });
  assert.deepStrictEqual([r3[w1.id], r3[w2.id]], [0, 2], 'no opening known: the window its close followed');
  assert.strictEqual(TW.unitOfBar(windows, new Date(first.from).toISOString(), 3), first.id, 'the bar that closes first in it');
  assert.strictEqual(TW.unitOfBar(windows, new Date(first.from - MIN3).toISOString(), 3), null, 'its close is the window\'s from: outside');
});

test('the screen on windows: legs pair only in windows both sides finished; net R per window; a control window\'s losses are a harm', () => {
  const day2 = '2022-03-08';
  const B = leg('long', `${day2}T14:42:00.000Z`, `${day2}T15:30:00.000Z`, day2);
  const wa = TW.windowsFor({ ...OPTS, legs: [A] }).windows;
  const wb = TW.windowsFor({ ...OPTS, day: day2, closes: TW.dayCloses(CFG, day2), legs: [B] }).windows;
  const windows = [...wa, ...wb];
  const eod = d => ({ t: `${d}T20:50:00.000Z`, day: d, kind: 'eod' });
  // Every window's bars ran (a cycle on its first bar), then the day's end of day.
  const cycles = (ws, d) => ws.filter(w => w.day === d).map(w => ({ t: new Date(w.from + MIN3 + 2000).toISOString(), day: d, kind: 'trade' }));
  const sorted = recs => recs.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const side = ({ caught, finished = [DAY, day2], controlR = 0 }) => {
    const days = Object.fromEntries(finished.map(d => [d, sorted([...cycles(windows, d), ...(controlR ? windows.filter(w => w.day === d && w.kind === 'control').map(w => ({ t: new Date(w.to - 1000).toISOString(), day: d, kind: 'trade', trades: [{ roundTrip: { r: controlR } }] })) : []), eod(d)])]));
    return TSC.sideOfTrend({ captures: [{ legs: [A, B].map(l => ({ id: l.id, day: l.day, captured: caught.includes(l.id) })) }], days, windows, minutes: 3, sessions: TW.windowStates({ days, windows, minutes: 3 }) });
  };
  const champ = side({ caught: [] });
  const both = TSC.measureTrend(champ, side({ caught: [A.id, B.id] }));
  assert.deepStrictEqual([both.capture.pairs, both.capture.b, both.netR.pairs], [2, 2, 4], 'two legs, four windows (two leg, two control)');
  // The edit left day 2 early: its window pairs nothing (neither a miss nor a catch); each side says which.
  const early = TSC.measureTrend(champ, side({ caught: [A.id, B.id], finished: [DAY] }));
  assert.deepStrictEqual([early.capture.pairs, early.netR.pairs], [1, 2]);
  assert.deepStrictEqual(early.sides.probe.dropped.map(d => d.day).sort(), wb.map(w => w.id).sort());
  // Control windows with losses: net R per window worse once there are enough windows (a looser rule's harm).
  const many = Array.from({ length: 12 }, (_, i) => `2022-03-${String(9 + i).padStart(2, '0')}`).filter(d => ![12, 13, 19, 20].includes(Number(d.slice(8))));
  const wins = many.flatMap(d => TW.windowsFor({ ...OPTS, day: d, closes: TW.dayCloses(CFG, d), legs: [leg('long', `${d}T14:42:00.000Z`, `${d}T15:30:00.000Z`, d)] }).windows);
  const mk = r => {
    const days = Object.fromEntries(many.map(d => [d, sorted([...cycles(wins, d), ...wins.filter(w => w.day === d && w.kind === 'control').map(w => ({ t: new Date(w.to - 1000).toISOString(), day: d, kind: 'trade', trades: [{ roundTrip: { r } }] })), eod(d)])]));
    return TSC.sideOfTrend({ captures: [{ legs: [] }], days, windows: wins, minutes: 3, sessions: TW.windowStates({ days, windows: wins, minutes: 3 }) });
  };
  const m = TSC.measureTrend(mk(0), mk(-1));
  assert.ok(m.netR.pairs >= 10);
  assert.match(TSC.trendHarms(m).join(), /net R per window worse/);
  // finishedOf: one side's finished windows alone (the learning curve): day 2 left early is out.
  const fin = TSC.finishedOf(side({ caught: [A.id], finished: [DAY] }));
  assert.deepStrictEqual([fin.legs.length, fin.units.sort()], [1, wa.map(w => w.id).sort()]);
});

test('a stepped-windows replay: steps the windows\' bars and those days\' end of day, manages what is open after; refused with a curated list or practice', () => {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  const { windows } = TW.windowsFor({ ...OPTS, legs: [A] });
  const base = { runId: 'tw', workDir: path.join(user, 'work'), broker: 'backtester', start: `${DAY}T00:00:00Z`, end: '2022-03-08T00:00:00Z', autotrader: TRADER };
  const run = resolveReplay({ ...base, stepWindows: TW.asConfig(windows) }, { baseDir: user, env, root: ROOT });
  assert.strictEqual(run.stepWindows.kind, 'trend-set');
  const all = decisionPoints(run.cfg, { start: run.start, end: run.end });
  const pts = curatedPoints(all, run.stepWindows, run.cfg.barDelaySeconds * 1000);
  const stepped = pts.filter(p => p.kind === 'trade' && !p.manage).map(p => p.t.getTime() - run.cfg.barDelaySeconds * 1000);
  assert.ok(stepped.length > 0 && stepped.every(c => windows.some(w => c > w.from && c <= w.to)), 'only the windows\' bars');
  assert.strictEqual(stepped.length, windows.reduce((n, w) => n + CLOSES.filter(c => c > w.from && c <= w.to).length, 0), 'every bar of them');
  assert.ok(pts.some(p => p.kind === 'eod' && !p.manage), 'the day\'s end of day');
  assert.ok(pts.some(p => p.manage), 'the times between: managed only while something is open');
  // Its hashes name the windows: another set of windows is another run.
  const other = resolveReplay({ ...base, stepWindows: TW.asConfig(windows.slice(0, 1)) }, { baseDir: user, env, root: ROOT });
  seedBrokers(run);
  assert.notStrictEqual(configHash(run, env), configHash(other, env));
  assert.notStrictEqual(setupHash(run), setupHash(other));
  for (const [k, v] of [['curatedList', { file: 'c.json' }], ['practice', { mode: 'setup-focus' }], ['prop', 'acct'], ['everyNthBar', 2], ['learning', false]]) {
    assert.throws(() => resolveReplay({ ...base, [k]: v, stepWindows: TW.asConfig(windows) }, { baseDir: user, env, root: ROOT }), /stepWindows: not with|stepWindows: every bar|stepWindows: a learning run only/, k);
  }
  assert.throws(() => resolveReplay({ ...base, learning: false, stepWindows: TW.asConfig(windows) }, { baseDir: user, env, root: ROOT }), /stepWindows: a learning run only/);
  assert.throws(() => resolveReplay({ ...base, stepWindows: { kind: 'trend-set', windows: [{ from: `${DAY}T20:00:00.000Z`, to: `${DAY}T20:30:00.000Z` }] } }, { baseDir: user, env, root: ROOT }), /hold no decision time/);
  assert.throws(() => resolveReplay({ ...base, stepWindows: { kind: 'trend-set', windows: [{ from: '2022-03-09T14:30:00.000Z', to: '2022-03-09T15:00:00.000Z' }] } }, { baseDir: user, env, root: ROOT }), /outside the run's/);
  assert.deepStrictEqual(SW.validateStepWindows({ kind: 'x', windows: [] }).errors.length, 2);
  assert.match(SW.validateStepWindows({ kind: 'trend-set', windows: [{ from: `${DAY}T15:00:00Z`, to: `${DAY}T15:30:00Z` }, { from: `${DAY}T15:10:00Z`, to: `${DAY}T15:40:00Z` }] }).errors.join(), /never overlapping/);
});

test('no look-ahead: nothing of the windows\' choice reaches the model; the runner config, environment and run home are a whole-session run\'s', () => {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  const base = { runId: 'tw', workDir: path.join(user, 'work'), broker: 'backtester', start: `${DAY}T00:00:00Z`, end: '2022-03-08T00:00:00Z', autotrader: TRADER };
  const whole = resolveReplay(base, { baseDir: user, env, root: ROOT });
  const windowed = resolveReplay({ ...base, stepWindows: TW.asConfig(TW.windowsFor({ ...OPTS, legs: [A] }).windows) }, { baseDir: user, env, root: ROOT });
  // The runner config the run writes (autotrader.json: every cycle's prompt is built from it and the bars) is the same.
  assert.deepStrictEqual(windowed.derived, whole.derived);
  assert.deepStrictEqual(windowed.cfg, whole.cfg);
  // The environment of every process the run starts, at the same bar: the same (no variable names a window).
  const at = new Date(`${DAY}T14:45:02.000Z`);
  seedBrokers(whole);
  assert.deepStrictEqual(replayEnv(env, windowed, { at }), replayEnv(env, whole, { at }));
});

/** A loop whose runs are built the way the loop builds them (train/loop.js windowRun), on the repository's tree. */
function loopCtx(replayOver = {}) {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  fs.mkdirSync(env.FTH_HOME);
  const replay = { workDir: path.join(user, 'work'), broker: 'backtester', autotrader: TRADER, ...replayOver };
  const loop = resolveLoop({ loopId: 'tw', replay, tuningWindows: [{ from: '2022-09-01', to: '2023-02-01' }], proposer: TRADER, modelScore: { account: 'acct_a' } }, { baseDir: user });
  return { loop, root: ROOT, env };
}

/**
 * The real training preflight (learning/preflight.js preflightForRun, the repository's readers) on a run; only the replay
 * broker server's own reply (get_server_config, which needs a running server) is given: limits equal to the account's.
 */
function preflight(ctx, { run, gate }) {
  const read = P.defaultReaders(ROOT, ctx.env);
  read.brokerConfig = r => ({ replay: true, maxOrderSize: r.limits.maxOrderSize, maxPositionSize: r.limits.maxPositionSize, maxDailyLoss: r.limits.dailyLoss > 0 ? r.limits.dailyLoss : 'off' });
  try {
    return { ok: true, results: P.preflightForRun(run, gate, { root: ROOT, env: ctx.env, noBars: 'no bars given', read }).results };
  } catch (err) {
    return { ok: false, fails: err.message.split('\n').filter(l => /^FAIL/.test(l)) };
  }
}

test('the real preflight passes the loop\'s trend-set run (stage 1, stepped windows, no curated list) and its keep-rule run; an ordinary stage-1 run without a list is still refused', () => {
  const ctx = loopCtx();
  const replay = { ...ctx.loop.replay, stage: 1 };
  const windows = TW.windowsFor({ ...OPTS, legs: [A] }).windows;
  const window = { from: DAY, to: '2022-03-08' };
  // The trend set's run, as probe.js builds it: the trend replay, the day's windows, the trend-set role.
  const trend = L.windowRun(ctx, { label: 'pc-t1', window, tree: ROOT, look: {}, replay: { ...replay, stepWindows: TW.asConfig(windows) }, role: 'trend-set' });
  assert.strictEqual(trend.gate.loopRole, 'trend-set');
  const t = preflight(ctx, trend);
  assert.ok(t.ok, (t.fails || []).join('\n'));
  assert.match(t.results.find(x => x.check === 'loop-role').detail, /the trend set's run: stage 1, 2 stepped window\(s\)/);
  assert.match(t.results.find(x => x.check === 'stage').detail, /the training loop's trend-set run \(no curated list by design\)/);
  // Whole sessions in the role pass too.
  assert.ok(preflight(ctx, L.windowRun(ctx, { label: 'pc-t2', window, tree: ROOT, look: {}, replay, role: 'trend-set' })).ok);
  // The keep rule's run, as the loop builds it (its own replay under modelScore): whole days, no practice, no list.
  const keep = L.windowRun(ctx, { label: 'champion-t0', window: ctx.loop.tuningWindows[0], tree: ROOT, look: {} });
  assert.strictEqual(keep.gate.loopRole, 'keep-rule');
  const k = preflight(ctx, keep);
  assert.ok(k.ok, (k.fails || []).join('\n'));
  assert.match(k.results.find(x => x.check === 'practice-mode').detail, /the training loop's keep-rule run: no setup focus/);
  // An ordinary stage-1 replay of the same day without a curated list (no loop role): still refused, as before.
  const plain = preflight(ctx, L.windowRun(ctx, { label: 'x', window, tree: ROOT, look: {}, replay }));
  assert.ok(!plain.ok);
  assert.deepStrictEqual(plain.fails.map(l => l.split(':')[0]), ['FAIL practice-mode', 'FAIL stage']);
  // A curated probe run (replay given, no role) gets no role.
  assert.strictEqual(L.windowRun(ctx, { label: 'p', window, tree: ROOT, look: {}, replay }).gate.loopRole, undefined);
});

test('the loop roles only in their role: stepped windows without it, a trend-set run with practice or out of stage 1, an unknown role: refused', () => {
  const ctx = loopCtx();
  const window = { from: DAY, to: '2022-03-08' };
  const windows = TW.asConfig(TW.windowsFor({ ...OPTS, legs: [A] }).windows);
  const fails = x => preflight(ctx, x).fails || [];
  // Stepped windows on a run of no loop role (a hand-made replay config): refused.
  assert.ok(fails(L.windowRun(ctx, { label: 'a', window, tree: ROOT, look: {}, replay: { ...ctx.loop.replay, stage: 1, stepWindows: windows } })).some(l => /^FAIL loop-role: stepped windows .* trend-set runs only/.test(l)));
  // The trend-set role on a run without stage 1, or with a practice mode: refused.
  assert.ok(fails(L.windowRun(ctx, { label: 'b', window, tree: ROOT, look: {}, replay: { ...ctx.loop.replay, stepWindows: windows }, role: 'trend-set' })).some(l => /^FAIL loop-role: .*stage 1/.test(l)));
  assert.ok(fails(L.windowRun(ctx, { label: 'c', window, tree: ROOT, look: {}, replay: { ...ctx.loop.replay, stage: 1, practice: { mode: 'setup-focus' } }, role: 'trend-set' })).some(l => /^FAIL loop-role: .*no practice mode/.test(l)));
  // The keep-rule role with stepped windows: refused (whole days); an unknown role: refused.
  const keepW = { ...L.windowRun(ctx, { label: 'e', window, tree: ROOT, look: {}, replay: { ...ctx.loop.replay, stage: 1, stepWindows: windows }, role: 'trend-set' }) };
  assert.ok(fails({ run: keepW.run, gate: { ...keepW.gate, loopRole: 'keep-rule' } }).some(l => /^FAIL loop-role: .*no stepped windows/.test(l)));
  assert.ok(fails({ run: keepW.run, gate: { ...keepW.gate, loopRole: 'probe' } }).some(l => /^FAIL loop-role: "probe": the loop's roles are keep-rule, trend-set/.test(l)));
  // A keep-rule replay that sets practice (a diagnostic score): still runs, its score labelled diagnostic.
  const diag = L.windowRun(loopCtx({ practice: { mode: 'setup-focus', setupTf: 15, quietSample: 1, seed: 1 } }), { label: 'f', window: ctx.loop.tuningWindows[0], tree: ROOT, look: {} });
  assert.ok(preflight(ctx, diag).ok);
});

test('the replay gate never carries a loop role from a replay config: replay.js run\'s gate options have none', () => {
  const user = tmpDir();
  const env = { PATH: process.env.PATH, HOME: user, FTH_HOME: path.join(user, 'home') };
  const run = resolveReplay({ runId: 'g', workDir: path.join(user, 'work'), broker: 'backtester', start: `${DAY}T00:00:00Z`, end: '2022-03-08T00:00:00Z', autotrader: TRADER, loopRole: 'trend-set' }, { baseDir: user, env, root: ROOT });
  assert.strictEqual(P.gateOptions(run).loopRole, undefined);
});

test('the driver steps a stepped-windows run\'s windows, its days\' end of day, and manages what is open after a window until flat', async () => {
  const { seedRunHome, runReplay } = require('../../scripts/lib/replay/driver');
  const dir = tmpDir();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true, journalEnv: 'SIM_JOURNAL' } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  const trader = { harness: 'custom', command: ['true', '{prompt}'], symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-12:00@America/New_York'], eodAt: '15:50@America/New_York' };
  const { windows } = TW.windowsFor({ ...OPTS, closes: TW.dayCloses(validateConfig(trader), DAY), legs: [A], controlPerLeg: 0 });
  const run = resolveReplay({ runId: 's1', workDir: path.join(dir, 'replays'), broker: 'sim', start: `${DAY}T00:00:00Z`, end: '2022-03-09T00:00:00Z', premarket: false, latency: false, autotrader: trader, stepWindows: TW.asConfig(windows) }, { baseDir: dir, env, home: dir, root: null });
  seedRunHome(run, { root: ROOT, userEnv: env });
  const steps = [];
  const deps = {
    serverCheck: async () => null,
    async step(point) {
      steps.push(`${point.kind}@${point.t.toISOString().slice(5, 16)}`);
      if (point.kind === 'eod') fs.writeFileSync(path.join(run.paths.runHome, 'autotrader-state.json'), JSON.stringify({ day: point.day, eodDone: true }));
      return { code: 0, output: `REPLAY STEP ${JSON.stringify({ asked: point.kind, ran: [] })}\n` };
    },
    async trades() { return []; },
    // A position opened in the window (14:45Z) and open until 15:15Z; flat before and after.
    async open(e) { return e.FTH_REPLAY_NOW >= `${DAY}T14:45:00Z` && e.FTH_REPLAY_NOW <= `${DAY}T15:15:59Z`; },
  };
  const res = await runReplay({ run, baseEnv: env, root: ROOT, deps });
  assert.strictEqual(res.done, true);
  const trade = steps.filter(s => s.startsWith('trade@')).map(s => s.slice('trade@'.length));
  // The window's bars (closes 14:33 to 15:06), then managed while open (15:09 to 15:15), then nothing until end of day.
  assert.deepStrictEqual([trade[0], trade[trade.length - 1]], ['03-07T14:33', '03-07T15:15']);
  assert.strictEqual(trade.length, 12 + 3);
  assert.deepStrictEqual(steps.filter(s => s.startsWith('eod')), ['eod@03-07T20:50'], 'the window day\'s end of day; the next day, no window, is never stepped');
  // Its manifest names the windows (kind, hash, count), so no scorer reads it as whole days.
  const manifest = JSON.parse(fs.readFileSync(run.paths.manifest, 'utf8'));
  assert.deepStrictEqual(manifest.stepWindows, { kind: 'trend-set', hash: run.stepWindows.hash, windows: 1 });
});
