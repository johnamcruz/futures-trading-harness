'use strict';

// The exit-decision scorecard (replay/exit-scorecard.js): every exit and every model stop tighten, scored post-hoc by what
// price did next; who exited; late; flip-decided; and the model's and the runner's actions as the run recorded them.
const test = require('node:test');
const assert = require('node:assert');
const ES = require('../../scripts/lib/replay/exit-scorecard');

const T0 = Date.parse('2026-10-05T14:00:00.000Z');
const STEP = 180000;
const P = { cutR: 1, rightR: 1, lateGivebackR: 1, horizonBars: 10, matchBars: 2 };
/** Bars from [high, low] pairs, one per 3m from `from`. */
const mk = (rows, from = T0) => rows.map(([h, l], i) => ({ t: new Date(from + i * STEP).toISOString(), o: (h + l) / 2, h, l, c: (h + l) / 2 }));

test('classify: cut a trend, right, unclear, unresolved, from the exit price on', () => {
  // A long exited at 120 with 10 points of risk: price runs to 131 (1.1R the trade's way) before 110.
  const up = mk([[121, 118], [126, 119], [131, 124], [133, 125], [126, 109]]);
  assert.deepStrictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars: up, from: T0, params: P }), { cls: 'cut', leftR: 1.3, savedR: null });
  // It drops to 109 (1.1R against) first: the exit was right; the most it went against before 130.
  const down = mk([[121, 115], [119, 109], [118, 104], [131, 112]]);
  assert.deepStrictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars: down, from: T0, params: P }), { cls: 'right', leftR: null, savedR: 1.6 });
  // Both on one bar: its order is unknown.
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars: mk([[131, 109]]), from: T0, params: P }).cls, 'unclear');
  // Neither within the horizon, no bars, or no risk: unresolved.
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars: mk(Array(12).fill([125, 115])), from: T0, params: P }).cls, 'unresolved');
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars: [], from: T0, params: P }).cls, 'unresolved');
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 0, bars: up, from: T0, params: P }).cls, 'unresolved');
  // The horizon counts: a cut on the 11th bar is past a 10-bar horizon.
  const late = mk([...Array(10).fill([125, 115]), [140, 121]]);
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars: late, from: T0, params: P }).cls, 'unresolved');
  // A short mirrors it: down is its way.
  const sDown = mk([[121, 118], [119, 112], [114, 108], [112, 107]]);
  assert.strictEqual(ES.classify({ side: 'short', price: 120, risk: 10, bars: sDown, from: T0, params: P }).cls, 'cut');
});

test('classify: only the bars from the exit on are read (bars before the exit never score it)', () => {
  const bars = mk([[160, 150], [121, 118], [119, 109]]);
  // The 160 high is before the exit: the exit at bar 1 was right.
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars, from: T0 + STEP, params: P }).cls, 'right');
});

test('barsClosedBy: the bars a decision at ms could read (closed by then), never the bar still forming', () => {
  const bars = mk([[1, 0], [1, 0], [1, 0]]);
  assert.deepStrictEqual(ES.barsClosedBy(bars, T0 + 2 * STEP, STEP).map(b => b.t), [bars[0].t, bars[1].t]);
  assert.deepStrictEqual(ES.barsClosedBy(bars, T0 + 2 * STEP - 1, STEP).map(b => b.t), [bars[0].t]);
  assert.deepStrictEqual(ES.barsClosedBy(null, T0, STEP), []);
});

const trip = (x = {}) => ({ id: 1, contractId: 'MNQ', side: 'long', open: false, entry: 100, entryMs: T0, exitMs: T0 + 10 * STEP, exitPrice: 120, risk: 10, r: 2, mfeR: 2.5, reason: 'stop', ...x });
const after = mk([[121, 118], [126, 119], [131, 124]], T0 + 10 * STEP);

test('scoreExits: who exited, by the actions around the exit', () => {
  const run = (x, actions) => ES.scoreExits({ trips: [trip(x)], bars: after, stepMs: STEP, params: P, ...actions }).decisions[0].exitBy;
  assert.strictEqual(run({}, { closes: [{ ms: T0 + 9 * STEP, by: 'model', contractId: 'MNQ' }] }), 'model-exit');
  assert.strictEqual(run({}, { closes: [{ ms: T0 + 10 * STEP, by: 'runner' }] }), 'runner-exit');
  // A close too far from the exit (past matchBars) is not this exit's.
  assert.strictEqual(run({}, { closes: [{ ms: T0 + 5 * STEP, by: 'model' }] }), 'initial-stop');
  assert.strictEqual(run({ reason: 'target' }, {}), 'target');
  assert.strictEqual(run({}, { moves: [{ ms: T0 + 3 * STEP, by: 'model', to: 110 }] }), 'model-stop');
  // The last move before the exit decides: the runner's trail after the model's.
  assert.strictEqual(run({}, { moves: [{ ms: T0 + 3 * STEP, by: 'model', to: 110 }, { ms: T0 + 6 * STEP, by: 'runner', to: 115 }] }), 'runner-trail');
  // The plan's stop after the fill is still the initial stop.
  assert.strictEqual(run({}, { moves: [{ ms: T0 + STEP, by: 'plan', to: 95 }] }), 'initial-stop');
  // Another contract's actions are not this trade's; a move before the entry neither.
  assert.strictEqual(run({}, { closes: [{ ms: T0 + 10 * STEP, by: 'model', contractId: 'MES' }] }), 'initial-stop');
  assert.strictEqual(run({}, { moves: [{ ms: T0 - STEP, by: 'model', to: 90 }] }), 'initial-stop');
});

test('scoreExits: class, late, flip and the model\'s tightens; an open or riskless trip is not scored', () => {
  const facts = { bias: { flipAgainst: true } };
  const seen = [];
  const factsAt = (t, ms) => { seen.push(ms); return facts; };
  const moves = [{ ms: T0 + 3 * STEP, by: 'model', to: 105 }, { ms: T0 + 7 * STEP, by: 'model', to: 112 }];
  const s = ES.scoreExits({ trips: [trip({ r: 1.2, mfeR: 2.6 }), trip({ id: 2, open: true }), trip({ id: 3, risk: 0 })], moves, bars: after, stepMs: STEP, factsAt, params: P });
  assert.strictEqual(s.decisions.length, 1);
  const d = s.decisions[0];
  assert.deepStrictEqual([d.exitBy, d.cls, d.leftR, d.late, d.givebackR, d.flip, d.decidedAt], ['model-stop', 'cut', 1.1, true, 1.4, true, new Date(T0 + 7 * STEP).toISOString()]);
  // The facts are read at each decision's bar, never the exit's later one.
  assert.ok(seen.includes(T0 + 7 * STEP) && seen.includes(T0 + 3 * STEP));
  assert.deepStrictEqual(s.tightens.map(x => [x.stopped, x.cls]), [[false, null], [true, 'cut']]);
  // A loser that was never in profit is not late; a runner's exit takes no flip tag (no model decision).
  const loser = ES.scoreExits({ trips: [trip({ r: -1, mfeR: 0.1, exitPrice: 90 })], closes: [{ ms: T0 + 10 * STEP, by: 'runner' }], bars: after, stepMs: STEP, factsAt, params: P }).decisions[0];
  assert.deepStrictEqual([loser.late, loser.flip, loser.exitBy], [false, null, 'runner-exit']);
});

test('summarize and exitLines: counts and R per who exited, the flip-decided ones apart, the tightens', () => {
  const decisions = [
    { exitBy: 'model-exit', cls: 'cut', leftR: 1.5, late: false, flip: true, r: 1, peakR: 1.2 },
    { exitBy: 'model-exit', cls: 'right', savedR: 2, late: true, lateR: 0.5, flip: false, r: 0.5, peakR: 2 },
    { exitBy: 'runner-trail', cls: 'cut', leftR: 3, late: true, lateR: 1, flip: null, r: 2, peakR: 4 },
    { exitBy: 'initial-stop', cls: 'cut', leftR: 2.5, late: false, flip: null, r: -1, peakR: 0.2 },
    { exitBy: 'initial-stop', cls: 'right', savedR: 1, late: false, flip: null, r: -1, peakR: 0.1 },
  ];
  const sum = ES.summarize({ decisions, tightens: [{ stopped: true, cls: 'cut', flip: true }, { stopped: false, cls: null, flip: false }], thresholds: { cutR: 1, rightR: 1, lateGivebackR: 1.5, horizonBars: 60 } });
  assert.deepStrictEqual(sum.byExit['model-exit'], { n: 2, cut: 1, right: 1, unclear: 0, unresolved: 0, late: 1, leftR: 1.5, savedR: 2, givebackR: 0.5 });
  assert.deepStrictEqual([sum.byExit['runner-trail'].late, sum.byExit['runner-trail'].givebackR], [1, 1]);
  assert.deepStrictEqual([sum.flip.n, sum.flip.cut], [1, 1]);
  assert.deepStrictEqual(sum.tightens, { n: 2, stopped: 1, held: 1, cut: 1, right: 0, flip: 1 });
  const lines = ES.exitLines(sum);
  assert.match(lines[0], /Exit decisions/);
  assert.ok(lines.some(l => /model-exit: 2 exit\(s\): cut a trend 1 \(1\.5R left\), right 1 \(2R saved\)/.test(l)));
  assert.ok(lines.some(l => /with the HTF bias flipped against \(model decisions\): 1 exit/.test(l)));
  assert.ok(lines.some(l => /model stop tightens: 2: stopped the trade 1 \(cut 1, right 0\), held 1/.test(l)));
  // The run's own thresholds (the late one never below the rulebook's lock), and the stop's placement as its own row.
  assert.match(lines[0], /to the session's end: 1R the trade's way first = cut, 1R against first = right; late = gave back over 1\.5R of open profit/);
  assert.deepStrictEqual(sum.stopPlacement, { n: 1, of: 2, ranR: 2.5 });
  assert.ok(lines.some(l => /stop placement \(the initial stop, not an exit decision\): 1 of 2 initial-stop exits then ran 1R the trade's way \(2\.5R\)/.test(l)));
  assert.deepStrictEqual(ES.exitLines(ES.summarize({})), []);
  assert.deepStrictEqual(ES.exitLines(null), []);
});

test('modelActions: modify_order with a stop, closes and market [exit] orders from the cycle transcripts, at the bar\'s close', () => {
  const calls = [
    { name: 'mcp__broker__modify_order', input: { orderId: 9, stopPrice: 21450.25, contractId: 'MNQ' } },
    { name: 'mcp__broker__modify_order', input: { orderId: 9, size: 1 } }, // a size cut: no stop move
    { name: 'mcp__broker__close_position', input: { contractId: 'MNQ' } },
    { name: 'mcp__broker__place_order', input: { contractId: 'MNQ', type: 'market', rationale: '[exit] reversal' } },
    { name: 'mcp__broker__place_order', input: { contractId: 'MNQ', type: 'limit', rationale: 'setup:x long' } },
    { name: 'mcp__broker__modify_order', input: { stopPrice: 1 }, failed: true },
  ];
  const cycles = [{ timing: { barClose: '2026-10-05T14:12:00.000Z' }, transcript: 'x' }, { timing: { barClose: null }, transcript: 'x' }, { timing: { barClose: '2026-10-05T14:15:00.000Z' } }];
  const a = ES.modelActions(cycles, { toolCalls: () => calls });
  const ms = Date.parse('2026-10-05T14:12:00.000Z');
  assert.deepStrictEqual(a.moves, [{ ms, by: 'model', to: 21450.25, contractId: 'MNQ', orderId: 9 }]);
  assert.deepStrictEqual(a.closes, [{ ms, by: 'model', contractId: 'MNQ' }, { ms, by: 'model', contractId: 'MNQ' }]);
  // A transcript the parser can't read gives none, never a throw.
  assert.deepStrictEqual(ES.modelActions(cycles, { toolCalls: () => { throw new Error('bad'); } }), { moves: [], closes: [] });
});

test('runnerActions and tripsOf: the event log\'s moves (the plan stop apart) and closes; each closed round trip once', () => {
  const r = ES.runnerActions([
    { at: '2026-10-05T14:00:02Z', kind: 'stop_moved', to: 15430, peakR: 2.6, contractId: 'MNQ' },
    { at: '2026-10-05T13:51:02Z', kind: 'stop_moved', to: 15035, why: 'plan stop' },
    { at: '2026-10-05T14:30:00Z', kind: 'position_closed' },
    { at: 'bad', kind: 'stop_moved' },
  ]);
  assert.deepStrictEqual(r.moves.map(m => m.by), ['runner', 'plan']);
  assert.strictEqual(r.closes.length, 1);
  // The runner's events name their contract: another contract's trail never attributes this trade's exit.
  assert.deepStrictEqual(r.moves.map(m => m.contractId), ['MNQ', null]);
  const rt = { id: 5, contractId: 'MNQ', direction: 'short', open: false, entryTime: '2026-10-05T14:00:00Z', exitTime: '2026-10-05T14:30:00Z', averageEntryPrice: 100, exitPrice: 90, risk: 5, r: 2, mfeR: 3, reason: 'trail' };
  const trips = ES.tripsOf({ '2026-10-05': [{ trades: [{ roundTrip: rt }, { roundTrip: rt }, { price: 1 }] }], '2026-10-06': [{}] });
  assert.deepStrictEqual(trips, [{ id: 5, contractId: 'MNQ', side: 'short', open: false, entry: 100, entryMs: Date.parse(rt.entryTime), exitMs: Date.parse(rt.exitTime), exitPrice: 90, risk: 5, r: 2, mfeR: 3, reason: 'trail' }]);
});

test('factsText: the facts as words, no date, time or price', () => {
  const t = {
    extreme: { best: 21455.25 }, failed: { level: 21450, swing: 21440 }, pushes: [{}, {}], fading: true, pullback: { depth: 0.64 },
    vwap: { distAtr: 0.4 }, ema20: { distAtr: -0.2 }, against: { '3m': { kind: 'CHoCH' }, '15m': null },
    displacement: { tf: '15m', swing: 21430 }, compression: { '15m': { kind: 'nr7 box after a down pole' } }, bias: { flipAgainst: true },
    signs: ['failed extreme', 'pushes fading', 'HTF flip'], reversal: '15m displacement through the swing',
  };
  const s = ES.factsText(t);
  assert.strictEqual(s, 'the last push failed (a lower high or higher low); 2 push(es) fading; pullback 64% of the impulse; RTH VWAP +0.4 ATR, EMA20 -0.2 ATR; 3m CHoCH against, 15m none against; displacement against on 15m through the last swing; compression against 15m nr7 box after a down pole; HTF bias flipped against; weakening signs 3 (failed extreme, pushes fading, HTF flip); reversal 15m displacement through the swing');
  assert.doesNotMatch(s, /\d{4,}/);
  assert.strictEqual(ES.factsText({ unavailable: 'x' }), 'facts unavailable');
});

test('classify and sessionEnds: the horizon ends with the session the exit was in (unresolved beyond it)', () => {
  // Exit at 11:54 ET in a 09:30-12:00 session; the 1R move comes at 12:03, after the session's end.
  const ends = ES.sessionEnds('09:30-12:00@America/New_York');
  const exitMs = Date.parse('2026-10-05T15:54:00.000Z');
  assert.strictEqual(ends(exitMs), Date.parse('2026-10-05T16:00:00.000Z'));
  assert.strictEqual(ends(Date.parse('2026-10-05T17:00:00.000Z')), Date.parse('2026-10-05T17:00:00.000Z'), 'outside every window: itself');
  const bars = mk([[121, 118], [121, 118], [131, 119]], exitMs);
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars, from: exitMs, params: P }).cls, 'cut');
  assert.strictEqual(ES.classify({ side: 'long', price: 120, risk: 10, bars, from: exitMs, until: ends(exitMs), params: P }).cls, 'unresolved');
  // scoreExits passes each trip's session end.
  const t = trip({ exitMs, exitPrice: 120 });
  assert.strictEqual(ES.scoreExits({ trips: [t], bars, stepMs: STEP, params: P, sessionEnd: ends }).decisions[0].cls, 'unresolved');
});

test('lateThreshold: the config\'s late threshold, never below an active policy\'s lock_giveback_r', () => {
  const pol = (x = {}) => ({ name: 'p', valid: true, status: 'active', exit: { mode: 'target_then_trail', lock_giveback_r: 1.5 }, ...x });
  assert.strictEqual(ES.lateThreshold([pol()], P), 1.5);
  assert.strictEqual(ES.lateThreshold([pol({ status: 'retired' }), pol({ valid: false })], P), 1);
  assert.strictEqual(ES.lateThreshold([], { ...P, lateGivebackR: 2 }), 2);
  // With the rulebook's 1.5, a trail that gave back 1.2R of open profit is not late; with the config's 1 it was.
  const t = trip({ r: 1.3, mfeR: 2.5 });
  assert.strictEqual(ES.scoreExits({ trips: [t], bars: after, stepMs: STEP, params: { ...P, lateGivebackR: ES.lateThreshold([pol()], P) } }).decisions[0].late, false);
  assert.strictEqual(ES.scoreExits({ trips: [t], bars: after, stepMs: STEP, params: P }).decisions[0].late, true);
});

test('gateActions and mergeActions: the gateway\'s records in each cycle\'s window (a trade-executor\'s own session too), once each', () => {
  const cycle = { at: '2026-10-05T18:00:00.000Z', durationMs: 30000, timing: { barClose: '2026-10-05T14:12:00.000Z' } };
  const ms = Date.parse(cycle.timing.barClose);
  const log = [
    { ts: '2026-10-05T18:00:10.000Z', source: 'gateway', tool: 'modify_order', decision: 'allowed', orderId: 9, stopPrice: 21450.25, contractId: 'MNQ' },
    { ts: '2026-10-05T18:00:12.000Z', source: 'gateway', tool: 'modify_order', decision: 'blocked', orderId: 9, stopPrice: 21300 },
    { ts: '2026-10-05T18:00:15.000Z', source: 'gateway', tool: 'close_position', decision: 'allowed', ungated: true, contractId: 'MNQ' },
    { ts: '2026-10-05T18:00:16.000Z', source: 'gateway', tool: 'place_order', decision: 'allowed', type: 'market', rationale: '[exit] reversal', contractId: 'MNQ' },
    { ts: '2026-10-05T18:00:16.000Z', source: 'hook', tool: 'modify_order', decision: 'allowed', stopPrice: 1 },
    { ts: '2026-10-05T18:05:00.000Z', source: 'gateway', tool: 'modify_order', decision: 'allowed', orderId: 9, stopPrice: 21460 }, // after the window
  ];
  const g = ES.gateActions([cycle, { at: 'x', timing: {} }], log, { slackMs: 1000 });
  assert.deepStrictEqual(g.moves, [{ ms, by: 'model', to: 21450.25, contractId: 'MNQ', orderId: 9 }]);
  assert.deepStrictEqual(g.closes.map(c => c.contractId), ['MNQ', 'MNQ']);
  assert.strictEqual(g.orders.get('9'), 'MNQ');
  // The same move from the transcript (modify_order names no contract: the real shape) and the gate log counts once, and
  // is one tighten in the score: its order's contract resolved before the two sources merge.
  const fromTranscript = [{ ms, by: 'model', to: 21450.25, contractId: null, orderId: 9 }];
  assert.strictEqual(ES.mergeActions(g.moves, ES.resolveOrders(fromTranscript, g.orders)).length, 1);
  const merged = ES.mergeActions(g.moves, ES.resolveOrders(fromTranscript, g.orders));
  const tr = trip({ entryMs: ms - 3 * STEP, exitMs: ms + 5 * STEP });
  assert.strictEqual(ES.scoreExits({ trips: [tr], moves: merged, bars: after, stepMs: STEP, params: P, orders: g.orders }).tightens.length, 1);
  // A move that names only its order is its order's contract's: another contract's trade never takes it.
  const bare = [{ ms: T0 + 3 * STEP, by: 'model', to: 110, contractId: null, orderId: 9 }];
  const other = trip({ contractId: 'MES' });
  assert.strictEqual(ES.scoreExits({ trips: [other], moves: bare, bars: after, stepMs: STEP, params: P, orders: g.orders }).decisions[0].exitBy, 'initial-stop');
  assert.strictEqual(ES.scoreExits({ trips: [trip()], moves: bare, bars: after, stepMs: STEP, params: P, orders: g.orders }).decisions[0].exitBy, 'model-stop');
});

test('gateActions: a window ends at the next cycle\'s start: a record there is counted once, at its own cycle', () => {
  const c1 = { at: '2026-10-05T18:00:00.000Z', durationMs: 30000, timing: { barClose: '2026-10-05T14:12:00.000Z' } };
  const c2 = { at: '2026-10-05T18:00:31.000Z', durationMs: 30000, timing: { barClose: '2026-10-05T14:15:00.000Z' } };
  // 18:00:31.500 is inside cycle 1's slack (to 18:00:32) and in cycle 2's window.
  const log = [{ ts: '2026-10-05T18:00:31.500Z', source: 'gateway', tool: 'modify_order', decision: 'allowed', orderId: 9, stopPrice: 21450, contractId: 'MNQ' }];
  const g = ES.gateActions([c1, c2], log, { slackMs: 2000 });
  assert.deepStrictEqual(g.moves.map(m => m.ms), [Date.parse(c2.timing.barClose)]);
});

test('gateActions: a close the broker refused (its transcript shows the call failed) is not the model\'s exit', () => {
  const cycle = { at: '2026-10-05T18:00:00.000Z', durationMs: 30000, timing: { barClose: '2026-10-05T14:12:00.000Z' }, transcript: 'x' };
  const log = [{ ts: '2026-10-05T18:00:15.000Z', source: 'gateway', tool: 'close_position', decision: 'allowed', ungated: true, contractId: 'MNQ' }];
  const calls = list => () => list;
  const refused = calls([{ name: 'mcp__broker__close_position', input: { contractId: 'MNQ' }, failed: true }]);
  assert.deepStrictEqual(ES.gateActions([cycle], log, { toolCalls: refused }).closes, []);
  // One that went through, one of another contract's failing, or no transcript to say: still the model's.
  assert.strictEqual(ES.gateActions([cycle], log, { toolCalls: calls([{ name: 'mcp__broker__close_position', input: { contractId: 'MNQ' } }]) }).closes.length, 1);
  assert.strictEqual(ES.gateActions([cycle], log, { toolCalls: calls([{ name: 'mcp__broker__close_position', input: { contractId: 'MES' }, failed: true }]) }).closes.length, 1);
  assert.strictEqual(ES.gateActions([{ ...cycle, transcript: undefined }], log, { toolCalls: refused }).closes.length, 1);
  // Only the refused call's record goes: two logged closes, one failed call.
  const two = [...log, { ...log[0], ts: '2026-10-05T18:00:16.000Z' }];
  assert.strictEqual(ES.gateActions([cycle], two, { toolCalls: refused }).closes.length, 1);
});

test('scoreExits: contracts match by family (MNQ and MNQ:<month>), however the record names the contract', () => {
  const tr = trip({ contractId: 'MNQ:2026-12' });
  const mv = [{ ms: T0 + 3 * STEP, by: 'model', to: 110, contractId: 'MNQ' }];
  assert.strictEqual(ES.scoreExits({ trips: [tr], moves: mv, bars: after, stepMs: STEP, params: P }).decisions[0].exitBy, 'model-stop');
  const cl = [{ ms: tr.exitMs, by: 'model', contractId: 'MNQ' }];
  assert.strictEqual(ES.scoreExits({ trips: [tr], closes: cl, bars: after, stepMs: STEP, params: P }).decisions[0].exitBy, 'model-exit');
  assert.strictEqual(ES.scoreExits({ trips: [trip({ contractId: 'MES:2026-12' })], closes: cl, bars: after, stepMs: STEP, params: P }).decisions[0].exitBy, 'initial-stop', 'another family\'s close is not this trade\'s');
  assert.strictEqual(ES.mergeActions([{ ms: 1, by: 'model', to: 5, contractId: 'MNQ' }], [{ ms: 1, by: 'model', to: 5, contractId: 'MNQ:2026-12' }]).length, 1);
});

test('scoreExits: with the runner\'s events unread, an exit that isn\'t the model\'s close or the target is unattributed (no finding)', () => {
  const none = ES.scoreExits({ trips: [trip()], bars: after, stepMs: STEP, params: P, runnerKnown: false });
  assert.strictEqual(none.decisions[0].exitBy, 'unattributed');
  assert.ok(ES.EXIT_BY.includes('unattributed'));
  assert.strictEqual(ES.scoreExits({ trips: [trip({ reason: 'target' })], bars: after, stepMs: STEP, params: P, runnerKnown: false }).decisions[0].exitBy, 'target');
  const cl = [{ ms: trip().exitMs, by: 'model', contractId: 'MNQ' }];
  assert.strictEqual(ES.scoreExits({ trips: [trip()], closes: cl, bars: after, stepMs: STEP, params: P, runnerKnown: false }).decisions[0].exitBy, 'model-exit');
});
