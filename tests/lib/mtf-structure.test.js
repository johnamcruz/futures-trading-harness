'use strict';

// The multi-timeframe nested structure read (scripts/lib/trading/mtf-structure.js), spec v2 sections 2 and 3: every stage
// transition, each closure, the order, the reset, B2's stop-traded rule, the protected swings, the warning, the side, the
// impulse recompute, the parent's BOS, non-repainting, window independence, symmetry, the levels and the warm-up. The
// synthetic worlds inject the breaks per frame (tests/fixtures/mtf-structure/world.js); the real ones are four small real
// 3m slices (4,400 bars each).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const M = require('../../scripts/lib/trading/mtf-structure');
const GF = require('../../scripts/lib/eval/goal-fixture');
const { analysis } = require('../../scripts/lib/tunables');
const W = require('../fixtures/mtf-structure/world');

const AN = analysis();
const CFG = AN.mtfStructure;
const LEVELS = M.levelsOf(CFG);
const OPTS = { tick: 0.25, bufferTicks: 1, equalAtr: AN.marketState.equalAtr, k: AN.indicators.swingK, depth: CFG.depth, sideMode: 'rule', warmBars: CFG.warmBars, hierarchy: CFG.hierarchy };

/** Records of a synthetic world at every bar (the primary level, and the level below it). */
function run(w, o = {}) {
  return M.recordsOf({ ...OPTS, bars: w.bars, minutes: w.base, levels: [w.level, w.below], warmBars: 0, side: 'long', prims: w.prims, ...o });
}
const P = r => r.levels[0];
const stageAt = (recs, j) => P(recs[j]).stage;
const ev = (events, patch) => events.map(e => ({ ...e })).concat(patch || []);
const without = (events, pred) => events.filter(e => !pred(e));
const A = W.world({ keys: W.KEYS, events: W.EVENTS });
const RA = run(A);

const realCache = new Map();
function real(day) {
  if (!realCache.has(day)) realCache.set(day, GF.decodeBars(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'mtf-structure', `${day}.json.gz`)))).bars));
  return realCache.get(day);
}

test('levels: the intraday hierarchy gives 4h>1h above (derived from hierarchies), 1h>15m primary, 15m>3m below with no timing frame', () => {
  assert.deepEqual(LEVELS, [
    { name: '4h>1h', parent: 240, setup: 60, timing: 15, role: 'above' },
    { name: '1h>15m', parent: 60, setup: 15, timing: 3, role: 'primary' },
    { name: '15m>3m', parent: 15, setup: 3, timing: null, role: 'below' },
  ]);
  assert.deepEqual(M.levelsOf({ hierarchy: 'x', hierarchies: { x: [60, 15, 3] } }).map(l => l.role), ['primary', 'below']);
  assert.throws(() => M.levelsOf({ hierarchy: 'nope', hierarchies: CFG.hierarchies }), /hierarchy nope/);
  assert.deepEqual(M.WEAKENING_EVENTS, ['CHoCH', 'CISD']);
});

test('every stage transition, parent up: POTENTIAL, DEVELOPING, ESTABLISHED, WEAKENING, REVERSING, CONFIRMED REVERSAL, conservative ready, COMPLETED, then NONE with last', () => {
  const at = A.at;
  const want = [[at(17, 0) - 1, 'NONE'], [at(17, 0), 'POTENTIAL'], [A.end(17), 'DEVELOPING'], [A.end(20) - 1, 'DEVELOPING'], [A.end(20), 'ESTABLISHED'],
    [at(25, 1) - 1, 'ESTABLISHED'], [at(25, 1), 'WEAKENING'], [at(27, 1), 'REVERSING'], [A.end(35) - 1, 'REVERSING'], [A.end(35), 'CONFIRMED REVERSAL'],
    [A.end(38) - 1, 'CONFIRMED REVERSAL'], [A.end(38), 'COMPLETED'], [A.end(38) + 1, 'NONE']];
  for (const [j, s] of want) assert.equal(stageAt(RA, j), s, `bar ${j}`);
  const p = P(RA[at(25, 1)]);
  assert.deepEqual([p.instance.impulseExtreme, p.instance.protected, p.instance.extreme, p.instance.depth, p.instance.depthClass], [150, 145, 130, 0.4, 'moderate']);
  assert.deepEqual([p.instance.weakening.by, p.instance.weakening.origin], ['CHoCH', 130]);
  assert.deepEqual([p.entry.model, p.entry.side, p.entry.stop, p.entryWithheld], ['aggressive', 'long', 129.75, null]);
  const r = P(RA[at(27, 1)]);
  assert.deepEqual([r.entry.model, r.entry.stop, r.entry.also], ['balanced', 132.75, { what: 'aggressive', stop: 129.75 }]);
  const c0 = P(RA[at(37, 1) - 1]);
  assert.equal(c0.entry, null, 'no conservative entry before its BOS');
  assert.equal(c0.instance.conservative.first.kind, 'CHoCH', 'the first break back up is the CHoCH (I7: the second, the BOS, is the one)');
  const c = P(RA[at(37, 1)]);
  assert.deepEqual([c.entry.model, c.entry.stop, c.entry.also.what, c.entry.also.level], ['conservative', 147.75, '15m CHoCH origin', 130]);
  const done = P(RA[A.end(38)]);
  assert.deepEqual([done.instance.closed.why, done.instance.closed.close], ['completed', 151]);
  const after = P(RA[A.end(38) + 5]);
  assert.deepEqual([after.stage, after.last.why, after.instance, after.setupAgainst], ['NONE', 'completed', null, null], 'I8 never names the closed instance\'s own BOS');
});

test('the level below never prints POTENTIAL, WEAKENING or REVERSING; the same series rescaled (240/60/15 on 15m bars) gives the same stages', () => {
  for (const r of RA) assert.ok(!['POTENTIAL', 'WEAKENING', 'REVERSING'].includes(r.levels[1].stage));
  const B = W.world({ per: 4, base: 15, keys: W.KEYS, events: W.EVENTS });
  assert.deepEqual([B.level.parent, B.level.setup, B.level.timing], [240, 60, 15]);
  const RB = run(B);
  const seq = (recs, w) => recs.map((r, j) => [Math.floor(j / w.per), P(r).stage]).filter((x, i, a) => !i || x[1] !== a[i - 1][1]).map(x => x[1]);
  assert.deepEqual(seq(RB, B), seq(RA, A));
  assert.deepEqual(seq(RA, A), ['NONE', 'POTENTIAL', 'DEVELOPING', 'ESTABLISHED', 'WEAKENING', 'REVERSING', 'CONFIRMED REVERSAL', 'COMPLETED', 'NONE']);
});

test('symmetry: the mirrored world gives the mirrored record (ways flipped, prices about the pivot, the same stages and ages)', () => {
  const Mw = W.world({ keys: W.KEYS, events: W.EVENTS, mirror: true });
  const RM = run(Mw, { side: 'short' });
  const flip = x => (x === 'up' ? 'down' : x === 'down' ? 'up' : x === 'long' ? 'short' : x === 'short' ? 'long' : x === 'low' ? 'high' : x === 'high' ? 'low' : x);
  const PRICE = new Set(['level', 'origin', 'close', 'stop', 'extreme', 'impulseExtreme', 'protected', 'from', 'to']);
  const norm = (o, mirror) => {
    if (Array.isArray(o)) return o.map(x => norm(x, mirror));
    if (!o || typeof o !== 'object') return mirror ? flip(o) : o;
    const out = {};
    for (const [k, v] of Object.entries(o)) out[k] = PRICE.has(k) && Number.isFinite(v) ? (mirror ? 300 - v : v) : k === 'stopTicks' ? v : norm(v, mirror);
    return out;
  };
  for (let j = 0; j < A.n; j += 1) assert.deepEqual(norm(RM[j], true), norm(RA[j], false), `bar ${j}`);
});

test('closures that are not stages: timing only, ended before ESTABLISHED, superseded (with a new DEVELOPING on the same bar, I5), parent turned; the closing bar is NONE with last', () => {
  // timing only: POTENTIAL, then a 3m BOS up before any 15m CHoCH down.
  const t = W.world({ keys: W.KEYS, events: [W.EVENTS[0], W.EVENTS[1], { f: 'timing', at: [17, 3], kind: 'BOS', dir: 1, swing: [17, 1], level: 148 }] });
  const rt = run(t);
  assert.equal(stageAt(rt, t.at(17, 2)), 'POTENTIAL');
  assert.deepEqual([stageAt(rt, t.at(17, 3)), P(rt[t.at(17, 3)]).last.why, P(rt[t.at(17, 3)]).instance], ['NONE', 'timing only', null]);
  // ended before ESTABLISHED: DEVELOPING, then a 15m break up.
  const e = W.world({ keys: W.KEYS, events: [...W.EVENTS.slice(0, 3), { f: 'setup', at: 19, kind: 'CHoCH', dir: 1, swing: 18 }] });
  const re = run(e);
  assert.deepEqual([stageAt(re, e.end(19)), P(re[e.end(19)]).last.why], ['NONE', 'ended before established']);
  // superseded: CONFIRMED REVERSAL, then a 15m CHoCH down: the instance closes and a new one opens at DEVELOPING.
  const s = W.world({ keys: W.KEYS, events: ev(W.EVENTS, { f: 'setup', at: 36, kind: 'CHoCH', dir: -1, swing: 34 }) });
  const rs = run(s);
  assert.equal(stageAt(rs, s.end(36) - 1), 'CONFIRMED REVERSAL');
  const x = P(rs[s.end(36)]);
  assert.deepEqual([x.stage, x.last.why, x.instance.openedBy, x.instance.id], ['DEVELOPING', 'superseded', 'setup CHoCH', 2]);
  // parent turned: a 1h CHoCH down (a warning), then a 1h BOS down, the 1h protected low never closed through.
  const pt = W.world({ keys: W.KEYS, events: ev(W.EVENTS.slice(0, 4), [{ f: 'parent', at: 6, kind: 'CHoCH', dir: -1, swing: 4, level: 140 }, { f: 'parent', at: 7, kind: 'BOS', dir: -1, swing: 5, level: 132 }]) });
  const rp = run(pt);
  const w6 = P(rp[pt.endP(6)]);
  assert.deepEqual([w6.stage, w6.parent.way, w6.parent.against.kind, w6.parent.against.direction], ['ESTABLISHED', 'up', 'CHoCH', 'down']);
  const w7 = P(rp[pt.endP(7)]);
  assert.deepEqual([w7.stage, w7.last.why, w7.parent.way], ['NONE', 'parent turned', 'down']);
});

test('INVALIDATED: a 1h close through the 1h protected low past the tie closes the instance from each open stage; the next bar is NONE with last INVALIDATED and no 1h structure', () => {
  // The crash: every setup candle from the stage's own on closes at 90 (the 3m tie made wide so no reset fires first).
  const cases = [['POTENTIAL', 17, W.EVENTS.slice(0, 2)], ['DEVELOPING', 18, W.EVENTS.slice(0, 3)], ['ESTABLISHED', 21, W.EVENTS.slice(0, 4)],
    ['WEAKENING', 26, W.EVENTS.slice(0, 5)], ['REVERSING', 28, W.EVENTS.slice(0, 6)], ['CONFIRMED REVERSAL', 36, W.EVENTS.slice(0, 6)]];
  for (const [stage, s, events] of cases) {
    const keys = W.KEYS.filter(([x]) => x < s - 1).concat([[s - 1, W.pathAt(W.KEYS, s - 1)], [s + 3, 90], [47, 90]]);
    const w = W.world({ keys, events, atr: { timing: 2000 } });
    const rr = run(w);
    const pEnd = Math.floor((s + 3) / 4);
    const before = rr[w.endP(pEnd) - 1];
    assert.equal(P(before).stage, stage, `${stage}: open before the 1h close`);
    const inv = P(rr[w.endP(pEnd)]);
    assert.equal(inv.stage, 'INVALIDATED', stage);
    assert.deepEqual([inv.invalidated.level, inv.invalidated.way, inv.parent], [100, 'up', null], stage);
    assert.ok(inv.invalidated.close < 100);
    const next = P(rr[w.endP(pEnd) + 1]);
    assert.deepEqual([next.stage, next.last.why, next.parent], ['NONE', 'invalidated', null], stage);
  }
});

test('order: a timing turn before ESTABLISHED is not WEAKENING; one on the ESTABLISHED close is not either; a setup BOS against with no DEVELOPING changes no stage and sets setupAgainst; DEVELOPING opens directly', () => {
  const early = W.world({ keys: W.KEYS, events: ev(without(W.EVENTS, e => e.at && e.at[0] === 25), { f: 'timing', at: [19, 1], kind: 'CHoCH', dir: 1, swing: [18, 1] }) });
  const re = run(early);
  assert.equal(stageAt(re, early.at(19, 2)), 'DEVELOPING');
  assert.equal(stageAt(re, early.at(26, 0)), 'ESTABLISHED', 'the next 3m break up (a BOS) is neither WEAKENING nor REVERSING');
  const same = W.world({ keys: W.KEYS, events: ev(without(W.EVENTS, e => e.at && e.at[0] === 25), { f: 'timing', at: [20, 4], kind: 'CHoCH', dir: 1, swing: [20, 1] }) });
  assert.equal(stageAt(run(same), same.end(20)), 'ESTABLISHED');
  assert.equal(stageAt(run(same), same.at(26, 0)), 'ESTABLISHED');
  const orphan = W.world({ keys: W.KEYS, events: [W.EVENTS[0], W.EVENTS[1], { f: 'setup', at: 17, kind: 'BOS', dir: -1, swing: 15 }] });
  const ro = P(run(orphan)[orphan.end(17)]);
  assert.deepEqual([ro.stage, ro.setupAgainst.kind, ro.setupAgainst.direction], ['POTENTIAL', 'BOS', 'down']);
  const direct = W.world({ keys: W.KEYS, events: without(W.EVENTS, e => e.f === 'timing' && e.at[0] === 17) });
  const rd = run(direct);
  assert.equal(stageAt(rd, direct.end(17) - 1), 'NONE');
  assert.deepEqual([stageAt(rd, direct.end(17)), P(rd[direct.end(17)]).instance.openedBy], ['DEVELOPING', 'setup CHoCH']);
});

test('the aggressive trigger: a timing CISD up after ESTABLISHED makes WEAKENING (by CISD, the stop at the pullback low); either member of WEAKENING_EVENTS alone is not enough', () => {
  const w = W.world({ keys: W.KEYS, events: ev(without(W.EVENTS, e => e.at && e.at[0] === 25), { f: 'timing', at: [25, 2], cisd: true, dir: 1, level: 131 }) });
  const p = P(run(w)[w.at(25, 2)]);
  assert.deepEqual([p.stage, p.instance.weakening.by, p.instance.weakening.origin, p.entry.stop], ['WEAKENING', 'CISD', 130, 129.75]);
  // The first of the two: a CHoCH on the bar before a CISD keeps the CHoCH.
  const both = W.world({ keys: W.KEYS, events: ev(W.EVENTS, { f: 'timing', at: [25, 2], cisd: true, dir: 1, level: 131 }) });
  assert.equal(P(run(both)[both.at(25, 2)]).instance.weakening.by, 'CHoCH');
});

test('reset: a timing close below the pullback low recorded at WEAKENING past the tie returns to ESTABLISHED (from WEAKENING and from REVERSING); a close at the tie or a wick does not; a new turn makes WEAKENING again', () => {
  const dip = (b, c, extra = {}) => ({ [b]: { c, ...extra } });
  const fromW = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: dip(A.at(26, 0), 129.25), atr: { timing: 10 } });
  const rw = run(fromW);
  const x = P(rw[A.at(26, 0)]);
  assert.deepEqual([x.stage, x.instance.resets.length, x.instance.resets[0].from, x.instance.resets[0].extreme, x.instance.weakening], ['ESTABLISHED', 1, 'WEAKENING', 130, null]);
  assert.equal(P(rw[A.at(27, 1)]).stage, 'ESTABLISHED', 'the 3m BOS up after a reset is not REVERSING');
  const fromR = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: dip(A.at(28, 0), 129.25), atr: { timing: 10 } });
  assert.deepEqual([stageAt(run(fromR), A.at(28, 0)), P(run(fromR)[A.at(28, 0)]).instance.resets[0].from], ['ESTABLISHED', 'REVERSING']);
  // At the tie (10 x 0.05 = 0.5): 129.5 is not past it.
  const tie = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: dip(A.at(26, 0), 129.5), atr: { timing: 10 } });
  assert.equal(stageAt(run(tie), A.at(26, 0)), 'WEAKENING');
  const wick = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(26, 0)]: { l: 128, c: 131 } }, atr: { timing: 10 } });
  assert.equal(stageAt(run(wick), A.at(26, 0)), 'WEAKENING');
  const again = W.world({ keys: W.KEYS, events: ev(without(W.EVENTS, e => e.at && e.at[0] === 27), { f: 'timing', at: [26, 3], kind: 'CHoCH', dir: 1, swing: [26, 1] }), overrides: dip(A.at(26, 0), 129.25), atr: { timing: 10 } });
  const ra = P(run(again)[A.at(26, 3)]);
  assert.deepEqual([ra.stage, ra.instance.resets.length], ['WEAKENING', 1]);
});

test('B2, stop traded: a wick through the structural stop withholds the entry and keeps the stage; a close inside the tie of the pullback low does not reset but withholds; conservative too; the entry stays filled', () => {
  const wick = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(26, 0)]: { l: 129.75, c: 131 } }, atr: { timing: 10 } });
  const rw = run(wick);
  const p = P(rw[A.at(26, 1)]);
  assert.deepEqual([p.stage, p.entry.model, p.entry.stop, p.entryWithheld, p.stopTraded.barsAgo], ['WEAKENING', 'aggressive', 129.75, 'stop traded', 1]);
  assert.equal(P(rw[A.at(25, 4)]).entryWithheld, null, 'ready before the trade');
  // A close at 129.5 (inside the tie of 130): no reset, but the stop 129.75 traded.
  const inTie = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(26, 0)]: { c: 129.5 } }, atr: { timing: 10 } });
  const q = P(run(inTie)[A.at(26, 0)]);
  assert.deepEqual([q.stage, q.entryWithheld], ['WEAKENING', 'stop traded']);
  const cons = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(37, 3)]: { l: 147.5, c: 149.5 } } });
  const c = P(run(cons)[A.at(37, 3)]);
  assert.deepEqual([c.stage, c.entry.model, c.entryWithheld], ['CONFIRMED REVERSAL', 'conservative', 'stop traded']);
});

test('protected swings: the pullback\'s protected high moves on any setup break against the parent whatever its label (minor cleared); a minor break up prints early weakening and leaves it', () => {
  const w = W.world({ keys: W.KEYS, events: ev(W.EVENTS, [{ f: 'setup', at: 21, kind: 'CHoCH', dir: 1, swing: 20, level: 141.5 }, { f: 'setup', at: 23, kind: 'CHoCH', dir: -1, swing: 22, level: 135 }]) });
  const rw = run(w);
  const m = P(rw[w.end(21)]);
  assert.deepEqual([m.stage, m.instance.minor.level, m.instance.protected], ['ESTABLISHED', 141.5, 145]);
  const mv = P(rw[w.end(23)]);
  assert.equal(mv.instance.minor, null);
  assert.deepEqual([mv.instance.protMoves.length, mv.instance.protMoves[0].kind, mv.instance.protMoves[0].from], [1, 'CHoCH', 145]);
  assert.equal(mv.instance.protected, mv.instance.protMoves[0].to);
  assert.ok(mv.instance.protected < 145);
});

test('the warning: a 15m close or a 3m close through the 1h protected low past the tie (1h not closed through) withholds the entry; the next close back clears it', () => {
  // A deep pullback (its low 95, under the 1h protected low 100, by a wick) so a close at 99 warns without a reset.
  const keys = [[0, 105], [4, 100], [16, 150], [24, 101], [44, 160], [47, 162]];
  const ov = { [A.at(24, 1)]: { l: 95, c: 101 }, [A.at(26, 2)]: { c: 99 }, [A.at(26, 3)]: { c: 104 } };
  const w3 = W.world({ keys, events: W.EVENTS, overrides: ov });
  const r3 = run(w3);
  const x = P(r3[A.at(26, 2)]);
  assert.deepEqual([x.stage, x.warning.frame, x.warning.close, x.entryWithheld], ['WEAKENING', '3m', 99, 'warning']);
  assert.equal(P(r3[A.at(26, 3)]).warning, null, 'the next 3m close back above clears it');
  const w15 = W.world({ keys, events: W.EVENTS, overrides: { [A.at(24, 1)]: { l: 95, c: 101 }, [A.end(26)]: { c: 99 } } });
  const r15 = run(w15);
  const y = P(r15[A.end(26)]);
  assert.deepEqual([y.warning.frame, y.warning.close, y.entryWithheld], ['15m', 99, 'warning']);
  assert.equal(P(r15[A.end(27)]).warning, null, 'the next 15m close back above clears it');
});

test('side: rule (the entry rule\'s) and parent (the 1h) are both in the record; the record\'s side is the rule\'s; an entry withheld off the side stays filled', () => {
  const r = M.recordsOf({ ...OPTS, bars: A.bars, minutes: 3, levels: [A.level, A.below], warmBars: 0, side: 'short', prims: A.prims });
  const p = r[A.at(25, 1)];
  assert.deepEqual([p.sideMode, p.side, p.sides.rule, p.sides.parent], ['rule', 'short', 'short', 'long']);
  assert.deepEqual([P(p).entry.model, P(p).entryWithheld], ['aggressive', 'against the side']);
  const none = M.recordsOf({ ...OPTS, bars: A.bars, minutes: 3, levels: [A.level, A.below], warmBars: 0, side: null, prims: A.prims })[A.at(25, 1)];
  assert.equal(P(none).entryWithheld, 'no side');
  const par = M.recordsOf({ ...OPTS, bars: A.bars, minutes: 3, levels: [A.level, A.below], warmBars: 0, side: 'short', sideMode: 'parent', prims: A.prims })[A.at(25, 1)];
  assert.deepEqual([par.side, P(par).entryWithheld], ['long', null]);
  assert.throws(() => M.mtfStructure({ ...OPTS, bars: A.bars, minutes: 3, levels: [A.level], sideMode: 'both', prims: A.prims }), /sideMode/);
});

test('the impulse extreme is recomputed after a closure that is not COMPLETED: a high made while the instance was open counts for the next one', () => {
  const events = [W.EVENTS[0], W.EVENTS[1], W.EVENTS[2], { f: 'setup', at: 19, kind: 'CHoCH', dir: 1, swing: 18 }, { f: 'setup', at: 22, kind: 'CHoCH', dir: -1, swing: 20 }];
  const w = W.world({ keys: W.KEYS, events, overrides: { [A.at(18, 2)]: { h: 155, c: 145 } } });
  const rw = run(w);
  assert.equal(P(rw[w.end(18)]).instance.impulseExtreme, 150, 'frozen while open');
  assert.equal(P(rw[w.end(19)]).last.why, 'ended before established');
  assert.equal(P(rw[w.end(22)]).instance.impulseExtreme, 155);
});

test('a parent BOS with the parent while an instance is open moves the protected swing the record uses (and its depth)', () => {
  const w = W.world({ keys: W.KEYS, events: ev(W.EVENTS, { f: 'parent', at: 5, kind: 'BOS', dir: 1, swing: 3, level: 148 }) });
  const rw = run(w);
  const before = P(rw[w.endP(5) - 1]);
  const after = P(rw[w.endP(5)]);
  assert.equal(before.parent.protected.level, 100);
  assert.ok(after.parent.protected.level > 100);
  assert.notEqual(after.instance.depth, before.instance.depth);
});

test('warm-up: a level is partial until warmBars parent candles precede its leg start; a partial level leaves the others unaffected', () => {
  const r = run(A, { warmBars: 3 });
  const j = A.at(25, 1);
  assert.deepEqual([P(r[j]).partial, P(r[j]).entry], [true, null], 'the 1h protected swing is parent candle 1: fewer than 3 before it');
  assert.equal(r[j].levels[1].partial, false, 'the level below has its own (15m) parent candles');
  assert.deepEqual(r[j].levels[1], RA[j].levels[1]);
});

test('no protected move without a qualifying event, at every level (real bars): the parent\'s only with a parent event, the pullback\'s only with a recorded move', () => {
  for (const day of ['2022-03-07', '2022-04-25']) {
    const bars = real(day);
    const recs = M.recordsOf({ ...OPTS, bars, minutes: 3, levels: LEVELS, side: null });
    for (let j = 1; j < bars.length; j += 1) {
      for (let x = 0; x < LEVELS.length; x += 1) {
        const a = recs[j - 1].levels[x];
        const b = recs[j].levels[x];
        if (a.parent && b.parent && a.parent.way === b.parent.way && a.parent.protected.level !== b.parent.protected.level) {
          assert.ok(b.event.length || b.parent.via, `${day} ${LEVELS[x].name} bar ${j}: the parent moved`);
        }
        if (a.instance && b.instance && a.instance.id === b.instance.id && Number.isFinite(a.instance.protected) && a.instance.protected !== b.instance.protected) {
          assert.equal(b.instance.protMoves.length, a.instance.protMoves.length + 1, `${day} ${LEVELS[x].name} bar ${j}: a pullback protected move is recorded`);
          assert.equal(b.instance.protMoves[b.instance.protMoves.length - 1].barsAgo, 0);
        }
      }
    }
  }
});

test('stages in order on real bars, every instance at every level: none skipped, none before ESTABLISHED for WEAKENING, no ready entry with a traded stop', () => {
  const order = ['POTENTIAL', 'DEVELOPING', 'ESTABLISHED', 'WEAKENING', 'REVERSING', 'CONFIRMED REVERSAL'];
  for (const day of ['2022-03-07', '2022-04-11', '2022-04-25', '2022-07-12']) {
    const bars = real(day);
    const recs = M.recordsOf({ ...OPTS, bars, minutes: 3, levels: LEVELS, side: null });
    for (let j = 0; j < bars.length; j += 1) {
      for (const lv of recs[j].levels) {
        const i = lv.instance;
        if (!i) continue;
        if (['WEAKENING', 'REVERSING'].includes(lv.stage)) assert.ok(i.established && i.weakening && i.weakening.barsAgo < i.established.barsAgo, `${day} ${lv.name} ${j}: WEAKENING after ESTABLISHED`);
        if (lv.stage === 'REVERSING') assert.ok(i.reversing.barsAgo <= i.weakening.barsAgo);
        if (lv.stage === 'CONFIRMED REVERSAL') assert.ok(i.established && i.confirmed.barsAgo <= i.established.barsAgo);
        if (order.includes(lv.stage) && lv.stage !== 'POTENTIAL') assert.ok(i.developing, `${day} ${lv.name} ${j}: DEVELOPING before ${lv.stage}`);
        if (lv.entry && !lv.entryWithheld) assert.equal(lv.stopTraded, null, `${day} ${j}: a ready entry with a traded stop`);
      }
    }
  }
});

test('non-repainting: mtfStructure on the bars up to j equals row j of the full pass, at all three levels (every in-window bar of the last session and a spread of earlier bars)', () => {
  for (const day of ['2022-03-07', '2022-07-12']) {
    const bars = real(day);
    const full = M.recordsOf({ ...OPTS, bars, minutes: 3, levels: LEVELS, side: 'long' });
    const js = [];
    for (let j = bars.length - 51; j < bars.length; j += 1) js.push(j);
    for (let j = 400; j < bars.length - 51; j += 173) js.push(j);
    for (const j of js) assert.deepEqual(M.mtfStructure({ ...OPTS, bars: bars.slice(0, j + 1), minutes: 3, levels: LEVELS, side: 'long' }), full[j], `${day} bar ${j}`);
  }
});

test('non-repainting at data gaps (review m2): at every bar on either side of a gap in the bars (a session break or a missing bar), the prefix equals the full pass, so a higher-frame candle cut short by a gap is used only once complete', () => {
  let gaps = 0;
  for (const day of ['2022-03-07', '2022-04-11', '2022-04-25', '2022-07-12']) {
    const bars = real(day);
    const full = M.recordsOf({ ...OPTS, bars, minutes: 3, levels: LEVELS, side: 'long' });
    for (let j = 1; j < bars.length; j += 1) {
      if (Date.parse(bars[j].t) - Date.parse(bars[j - 1].t) <= 180000) continue;
      gaps += 1;
      for (const q of [j - 1, j, j + 1]) {
        if (q < 400 || q >= bars.length) continue;
        assert.deepEqual(M.mtfStructure({ ...OPTS, bars: bars.slice(0, q + 1), minutes: 3, levels: LEVELS, side: 'long' }), full[q], `${day} bar ${q} (gap before ${j})`);
      }
    }
  }
  assert.ok(gaps >= 4, `gaps sampled: ${gaps}`);
});

test('window independence (B1): once warm, the record at a bar is the same from a window starting at s and at s + 1 (every bar of the last session)', () => {
  for (const day of ['2022-03-07', '2022-04-11', '2022-04-25', '2022-07-12']) {
    const bars = real(day);
    for (const s of [0, 1000]) {
      const a = M.recordsOf({ ...OPTS, bars: bars.slice(s), minutes: 3, levels: LEVELS, side: 'long' });
      const b = M.recordsOf({ ...OPTS, bars: bars.slice(s + 1), minutes: 3, levels: LEVELS, side: 'long' });
      for (let j = bars.length - 50; j < bars.length; j += 1) {
        const x = a[j - s];
        const y = b[j - s - 1];
        for (let l = 0; l < LEVELS.length; l += 1) {
          if (x.levels[l].partial || y.levels[l].partial) continue;
          const strip = r => JSON.parse(JSON.stringify(r, (k, v) => (k === 'id' ? undefined : v)));
          assert.deepEqual(strip(y.levels[l]), strip(x.levels[l]), `${day} from ${s} vs ${s + 1}: ${LEVELS[l].name} bar ${j}`);
        }
      }
    }
  }
});

test('real-bar fixtures pinned at named bars (proto/moments.json moments, a 4,400-bar window)', () => {
  const at = (day, hm) => {
    const bars = real(day);
    const j = bars.findIndex(b => b.t.startsWith(day) && new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Date.parse(b.t) + 180000)) === hm);
    assert.ok(j > 0, `${day} ${hm}`);
    return M.mtfStructure({ ...OPTS, bars: bars.slice(0, j + 1), minutes: 3, levels: LEVELS, side: null });
  };
  const S = r => r.levels.map(l => `${l.name} ${l.stage} ${l.parent ? l.parent.way : 'none'}`);
  // Each equals the reference prototype's record on the runner's 10,280-bar window (proto/moments.json).
  assert.deepEqual(S(at('2022-03-07', '09:45')), ['4h>1h DEVELOPING down', '1h>15m WEAKENING down', '15m>3m DEVELOPING up']);
  assert.deepEqual(S(at('2022-04-11', '09:48')), ['4h>1h NONE down', '1h>15m POTENTIAL down', '15m>3m DEVELOPING down']);
  assert.deepEqual(S(at('2022-04-25', '11:00')), ['4h>1h POTENTIAL down', '1h>15m INVALIDATED none', '15m>3m DEVELOPING up']);
  assert.deepEqual(S(at('2022-07-12', '10:57')), ['4h>1h POTENTIAL down', '1h>15m CONFIRMED REVERSAL down', '15m>3m ESTABLISHED down']);
});

test('the tie: a setup close beyond the impulse extreme by exactly the tie is not COMPLETED; a close through the 1h protected low by exactly the tie is no warning', () => {
  // The 15m tie: 10 x 0.05 = 0.5. The impulse high 150: a 15m close at 150.5 is at the tie.
  const keys = [[0, 105], [4, 100], [16, 150], [24, 130], [37, 148], [38, 150.5], [39, 150.5], [40, 151], [47, 162]];
  const w = W.world({ keys, events: W.EVENTS, atr: { setup: 10 } });
  const r = run(w);
  assert.notEqual(stageAt(r, w.end(39)), 'COMPLETED');
  assert.equal(stageAt(r, w.end(40)), 'COMPLETED');
  // The warning at the tie: the 3m tie 10 x 0.05 = 0.5; a 3m close at 99.5 is at it, 99.25 past it.
  const k2 = [[0, 105], [4, 100], [16, 150], [24, 101], [44, 160], [47, 162]];
  const at = W.world({ keys: k2, events: W.EVENTS, overrides: { [A.at(24, 1)]: { l: 95, c: 101 }, [A.at(26, 2)]: { c: 99.5 } }, atr: { timing: 10 } });
  assert.equal(P(run(at)[A.at(26, 2)]).warning, null);
  const past = W.world({ keys: k2, events: W.EVENTS, overrides: { [A.at(24, 1)]: { l: 95, c: 101 }, [A.at(26, 2)]: { c: 99.25 } }, atr: { timing: 10 } });
  assert.equal(P(run(past)[A.at(26, 2)]).warning.close, 99.25);
});

test('the impulse extreme is frozen from DEVELOPING: a later wick above it moves neither the frozen extreme nor the pullback\'s own low', () => {
  const w = W.world({ keys: W.KEYS, events: W.EVENTS, overrides: { [A.at(25, 3)]: { h: 155 } } });
  const p = P(run(w)[A.at(25, 4)]);
  assert.deepEqual([p.stage, p.instance.impulseExtreme, p.instance.extreme], ['WEAKENING', 150, 130]);
});

test('the order on one close: the timing frame first, then the setup frame, then the parent', () => {
  // A 3m CHoCH down and a 15m CHoCH down on one close, no instance open: POTENTIAL opens first, then DEVELOPING.
  const both = W.world({ keys: W.KEYS, events: [W.EVENTS[0], { f: 'timing', at: [17, 4], kind: 'CHoCH', dir: -1, swing: [16, 2] }, W.EVENTS[2]] });
  const b = P(run(both)[both.end(17)]);
  assert.deepEqual([b.stage, b.instance.openedBy, Boolean(b.instance.potential)], ['DEVELOPING', 'timing CHoCH', true]);
  // A 15m CHoCH down on the 1h close through its protected low: DEVELOPING opens, then the parent closes it (INVALIDATED).
  const keys = [[0, 105], [4, 100], [16, 150], [18, 140], [19, 90], [47, 90]];
  const inv = W.world({ keys, events: [W.EVENTS[0], { f: 'setup', at: 19, kind: 'CHoCH', dir: -1, swing: 17 }], atr: { timing: 2000 } });
  const x = P(run(inv)[inv.end(19)]);
  assert.deepEqual([x.stage, x.instance.openedBy], ['INVALIDATED', 'setup CHoCH']);
});

test('configProblem: only the gated intraday hierarchy and the rule side mode are printed; any other loads but is refused here', () => {
  assert.equal(M.configProblem(CFG), null);
  assert.match(M.configProblem({ ...CFG, hierarchy: 'day' }), /hierarchy day: only intraday is gated/);
  assert.match(M.configProblem({ ...CFG, sideMode: 'parent' }), /sideMode parent: only rule is printed/);
  assert.match(M.configProblem({ ...CFG, hierarchies: { intraday: [60, 15] } }), /hierarchy intraday is not/);
  assert.match(M.configProblem(null), /no mtfStructure/);
});
