'use strict';

// P1 (feat/p1-mtf-entries): the pullback's rank in its parent leg (mtf-structure.js levelSeries), the MTF entry mode's
// record fields (entry origin, target, rank) and withheld reasons (no first-pullback rule: the rank is a fact), and the mode's line
// clauses. The rank counts the instances that reached DEVELOPING (a setup CHoCH against the parent: a real setup-frame
// pullback) since the parent's last break the side's way; a new parent BOS the side's way, or the break that turned the
// parent (turn-confirmed, or a CHoCH promoted after the old protected swing broke), resets it. Causal: a prefix of the
// bars gives the same rank at its last bar as the full run. Without a mode the record and lines are today's exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../scripts/lib/trading/mtf-structure');
const { analysis } = require('../../scripts/lib/tunables');
const W = require('../fixtures/mtf-structure/world');

const AN = analysis();
const CFG = AN.mtfStructure;
const OPTS = { tick: 0.25, bufferTicks: 1, equalAtr: AN.marketState.equalAtr, k: AN.indicators.swingK, depth: CFG.depth, sideMode: 'rule', warmBars: 0, hierarchy: CFG.hierarchy };
const MODE = Object.freeze({ arm: 'A', entryMode: 'mtf_only', hierarchies: ['intraday'], exitMode: 'trail', minStage: 'established' });
const run = (w, o = {}) => M.recordsOf({ ...OPTS, bars: w.bars, minutes: w.base, levels: [w.level, w.below], side: 'long', prims: w.prims, ...o });
const P = r => r.levels[0];

// One up leg with two setup pullbacks (each ends before ESTABLISHED: a setup break up), a 3m-only POTENTIAL (never
// counted), a parent continuation BOS (the reset), a third pullback, then the parent turns down (CHoCH, then BOS: the
// turn confirmed) and a pullback against the down leg.
const KEYS = [[0, 105], [4, 100], [32, 200], [47, 150]];
const EVENTS = [
  { f: 'parent', at: 1, kind: 'BOS', dir: 1, swing: 0, level: 104 },
  { f: 'timing', at: [9, 0], kind: 'CHoCH', dir: -1, swing: [8, 2], level: 120 },  // POTENTIAL (3m only) ...
  { f: 'timing', at: [9, 3], kind: 'BOS', dir: 1, swing: [9, 1], level: 121 },     // ... closed: timing only (not ranked)
  { f: 'setup', at: 10, kind: 'CHoCH', dir: -1, swing: 9, level: 122 },            // pullback #1 (DEVELOPING)
  { f: 'setup', at: 12, kind: 'BOS', dir: 1, swing: 11, level: 130 },              // ended before ESTABLISHED
  { f: 'setup', at: 14, kind: 'CHoCH', dir: -1, swing: 13, level: 133 },           // pullback #2
  { f: 'setup', at: 16, kind: 'BOS', dir: 1, swing: 15, level: 140 },              // ended
  { f: 'parent', at: 5, kind: 'BOS', dir: 1, swing: 4, level: 150 },               // a new 1h BOS up: the leg resets
  { f: 'setup', at: 26, kind: 'CHoCH', dir: -1, swing: 25, level: 175 },           // pullback #1 of the new leg
  { f: 'parent', at: 8, kind: 'CHoCH', dir: -1, swing: 7, level: 190 },            // the 1h CHoCH down: transitioning
  { f: 'setup', at: 36, kind: 'CHoCH', dir: -1, swing: 35, level: 195 },           // a pullback while transitioning: the old leg's
  { f: 'parent', at: 9, kind: 'BOS', dir: -1, swing: 7, level: 180 },              // the turn confirmed: a down leg
  { f: 'setup', at: 41, kind: 'CHoCH', dir: 1, swing: 40, level: 172 },            // pullback #1 of the down leg
];
const Wd = W.world({ keys: KEYS, events: EVENTS });
const R = run(Wd, { mode: MODE });
const rankAt = j => { const i = P(R[j]).instance; return i ? i.rank : undefined; };

test('rank: counts setup pullbacks (DEVELOPING) of the parent leg; a 3m-only POTENTIAL is not one', () => {
  assert.equal(P(R[Wd.at(9, 0)]).stage, 'POTENTIAL');
  assert.equal(rankAt(Wd.at(9, 0)), 1, 'a POTENTIAL: the rank it takes if it develops');
  assert.equal(rankAt(Wd.end(10)), 1, 'the 3m-only one closed uncounted: the first 15m pullback is #1');
  assert.equal(rankAt(Wd.end(14)), 2);
  const leg = P(R[Wd.end(14)]).instance.leg;
  assert.equal(leg.kind, 'BOS');
  assert.equal(leg.at, Wd.bars[0].t === leg.at ? leg.at : leg.at); // a time string
  assert.match(leg.et, /^\d\d:\d\d$|^\d\d-\d\d \d\d:\d\d$/);
});

test('rank: a new parent BOS the side\'s way resets the count (the next pullback is #1 again, its leg the new BOS)', () => {
  const r = P(R[Wd.end(26)]);
  assert.equal(r.instance.rank, 1);
  assert.notEqual(r.instance.leg.at, P(R[Wd.end(14)]).instance.leg.at);
});

test('rank: while the parent is transitioning the old leg counts on; the turn confirmed starts the new way\'s count', () => {
  assert.equal(rankAt(Wd.end(36)), 2, 'the pullback while transitioning: #2 of the up leg (no reset on a CHoCH against)');
  const d = P(R[Wd.end(41)]);
  assert.equal(d.instance.pullbackWay, 'up');
  assert.equal(d.instance.rank, 1);
  assert.equal(d.instance.leg.kind, 'BOS');
});

test('rank: the CHoCH that turned the parent (promoted after the old protected low broke) resets the count', () => {
  // The old up leg's protected low breaks on the parent candle that makes the CHoCH down: invalid, the CHoCH promoted.
  const keys = [[0, 105], [4, 100], [30, 190], [32, 200], [35, 120], [47, 100]];
  const events = [
    { f: 'parent', at: 1, kind: 'BOS', dir: 1, swing: 0, level: 104 },
    { f: 'setup', at: 10, kind: 'CHoCH', dir: -1, swing: 9, level: 122 },
    { f: 'setup', at: 12, kind: 'BOS', dir: 1, swing: 11, level: 130 },
    { f: 'parent', at: 5, kind: 'BOS', dir: 1, swing: 4, level: 150 },
    { f: 'parent', at: 8, kind: 'CHoCH', dir: -1, swing: 7, level: 185 },
    { f: 'setup', at: 38, kind: 'CHoCH', dir: 1, swing: 37, level: 118 },
  ];
  const w = W.world({ keys, events });
  const r = run(w, { mode: MODE });
  const p = P(r[w.end(38)]);
  assert.equal(p.parent.way, 'down', JSON.stringify(p.parent));
  assert.equal(p.instance.rank, 1);
  assert.equal(p.instance.leg.kind, 'CHoCH');
});

test('rank: causal (a prefix of the bars gives the same rank at its last bar) and a mirrored world ranks the same', () => {
  for (const j of [Wd.end(10), Wd.end(14), Wd.end(26), Wd.end(36), Wd.end(41)]) {
    const pre = M.mtfStructure({ ...OPTS, bars: Wd.bars.slice(0, j + 1), minutes: Wd.base, levels: [Wd.level, Wd.below], side: 'long', prims: Wd.prims, mode: MODE });
    assert.deepEqual(P(pre).instance && P(pre).instance.rank, rankAt(j), `bar ${j}`);
  }
  const m = W.world({ keys: KEYS, events: EVENTS, mirror: true });
  const rm = run(m, { mode: MODE, side: 'short' });
  for (const j of [Wd.end(10), Wd.end(14), Wd.end(26), Wd.end(41)]) assert.equal(P(rm[j]).instance.rank, rankAt(j), `mirror bar ${j}`);
});

test('no mode: the record carries no rank, leg, origin or target, and its lines are today\'s exactly', () => {
  const R0 = run(Wd);
  const j = Wd.end(14);
  assert.equal(P(R0[j]).instance.rank, undefined);
  assert.equal(P(R0[j]).instance.leg, undefined);
  assert.equal(R0[j].mode, undefined);
  // With a mode only the MTF clauses are added: the record otherwise equal.
  const strip = rec => JSON.parse(JSON.stringify(rec, (k, v) => (['rank', 'leg', 'mode', 'context', 'origin', 'target', 'targetR', 'pullbacks', 'by', 'triggerClose', 'turn', 'windowStart', 'maxRun'].includes(k) ? undefined : v)));
  assert.deepEqual(strip(R[j]), strip(R0[j]));
});

// ---- the entry fields and withheld reasons (the shipped world: every stage through conservative ready)
const A = W.world({ keys: W.KEYS, events: W.EVENTS });

test('mode: the ready entry carries its origin (before the buffer), the target (the impulse extreme) and its R from the close; side = the parent', () => {
  const r = M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], side: null, sideMode: 'parent', prims: A.prims, mode: MODE });
  const p = P(r[A.at(25, 1)]);
  assert.equal(r[A.at(25, 1)].side, 'long', 'the parent mode: the side is the parent\'s way');
  assert.equal(p.entry.model, 'aggressive');
  assert.equal(p.entry.origin, 130);
  assert.equal(p.entry.stop, 129.75);
  assert.equal(p.entry.target, 150);
  const close = A.bars[A.at(25, 1)].c;
  assert.equal(p.entry.targetR, Math.round(((150 - close) / (close - 129.75)) * 100) / 100);
  assert.equal(p.entryWithheld, null);
  assert.equal(p.instance.rank, 1);
});

test('an MTF mode has no first-pullback rule (REVIEW-3 O1): the ranked pullback is ready, and no rank filter is exported', () => {
  const base = { ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], sideMode: 'parent', prims: A.prims };
  const j = A.at(25, 1);
  const rec = M.recordsOf({ ...base, mode: MODE })[j];
  assert.equal(P(rec).entryWithheld, null);
  assert.equal('withSide' in M, false, 'not exported');
});

test('configProblem: today\'s config as before; an MTF mode accepts the parent side mode, and the execution hierarchy only in arm B', () => {
  assert.equal(M.configProblem(CFG), null);
  assert.match(M.configProblem({ ...CFG, sideMode: 'parent' }), /sideMode parent: only rule is printed/);
  assert.equal(M.configProblem({ ...CFG, sideMode: 'parent' }, MODE), null);
  assert.match(M.configProblem({ ...CFG, hierarchy: 'execution', sideMode: 'parent' }, MODE), /hierarchy execution/);
  assert.equal(M.configProblem({ ...CFG, hierarchy: 'execution', sideMode: 'rule' }, { ...MODE, arm: 'B', hierarchies: ['execution'] }), null);
});

// ---- the MTF mode's line clauses (the primary line only; the below line and today's lines unchanged)
const lines = (rec, o = {}) => M.mtfLines(rec, o);
const recA = (mode, j = A.at(25, 1)) => M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [{ ...A.level, role: 'above', name: 'x>p' }, A.level, A.below].map((l, n) => (n === 0 ? { name: 'q>p', parent: A.level.parent * 4, setup: A.level.parent, timing: A.level.setup, role: 'above' } : l)), sideMode: 'parent', prims: A.prims, mode })[j];

test('lines, MTF mode: the primary line names no model (its Entry clause points to the candidate lines: no "NOT ready" to misread); the below line is labelled an early 3m read; today\'s lines otherwise', () => {
  const rec = recA(MODE);
  const [one, two] = lines(rec);
  assert.match(one, / Entry: on the MTF candidate lines\.$/);
  assert.doesNotMatch(one, /ready|NOT ready|structural stop/);
  assert.match(two, /^- MTF structure below \(3m timing read, early and noisy; the 15m line decides the pullback\): s > t \(context\): /);
  const today = lines(M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], side: 'long', prims: A.prims })[A.at(25, 1)]);
  assert.equal(two.replace(' (3m timing read, early and noisy; the 15m line decides the pullback)', ''), today[1]);
  assert.equal(one.replace(/ Entry: on the MTF candidate lines\.$/, ''), today[0].replace(/ Entry: .*$/, ''));
  // Today's record (no mode): the Entry clause exactly as before.
  assert.match(today[0], /Entry: aggressive ready LONG new this bar, structural stop 129\.75 \(a structure level, not an order stop\); balanced NOT ready/);
});

// ---- minStage (mtfEntry.minStage): an early ready at POTENTIAL or DEVELOPING on the same trigger (an aligned timing
// CHoCH or CISD; its origin the stop), printed with its stage. established (the default): the module's own rule only.
const EARLY = W.world({ keys: W.KEYS, events: W.EVENTS.concat([
  { f: 'timing', at: [17, 2], kind: 'CHoCH', dir: 1, swing: [17, 1], level: 148 }, // aligned, while POTENTIAL
  { f: 'timing', at: [19, 1], kind: 'CHoCH', dir: 1, swing: [18, 3], level: 140 }, // aligned, while DEVELOPING
]) });
const early = minStage => M.recordsOf({ ...OPTS, bars: EARLY.bars, minutes: EARLY.base, levels: [EARLY.level, EARLY.below], sideMode: 'parent', prims: EARLY.prims, mode: { ...MODE, minStage } });

test('minStage: established gives no early candidate; developing adds the DEVELOPING one; potential adds both, each with its stage, origin and stop', () => {
  const jp = EARLY.at(17, 2);
  const jd = EARLY.at(19, 1);
  const est = early('established');
  assert.equal(P(est[jp]).stage, 'POTENTIAL');
  assert.equal(P(est[jd]).stage, 'DEVELOPING');
  assert.equal(P(est[jp]).entry, null);
  assert.equal(P(est[jd]).entry, null);
  const dev = early('developing');
  assert.equal(P(dev[jp]).entry, null, 'developing: no POTENTIAL candidate');
  const ed = P(dev[jd]).entry;
  assert.deepEqual([ed.model, ed.early, ed.side, ed.stop, ed.origin], ['aggressive', 'DEVELOPING', 'long', ed.origin - 0.25, ed.origin]);
  const pot = early('potential');
  const ep = P(pot[jp]).entry;
  assert.deepEqual([ep.model, ep.early, ep.stop], ['aggressive', 'POTENTIAL', ep.origin - 0.25]);
  assert.equal(ep.target, null, 'no impulse frozen at POTENTIAL: no target');
  assert.equal(P(pot[jd]).entry.early, 'DEVELOPING', 'the DEVELOPING stage starts its own early trigger');
  // From ESTABLISHED on, the module's own rule: the same as established.
  for (const j of [EARLY.end(20), EARLY.at(25, 1), EARLY.at(27, 1)]) assert.deepEqual(P(pot[j]).entry, P(est[j]).entry, `bar ${j}`);
  assert.match(M.mtfLines(pot[jd])[0], /stage DEVELOPING\. .* 3m turning back UP: \d\d:\d\d\. Entry: on the MTF candidate lines\.$/);
  assert.match(M.mtfLines(pot[jp])[0], /stage POTENTIAL\. .* 3m turning back UP: \d\d:\d\d\. Entry: on the MTF candidate lines\.$/);
  assert.match(M.mtfLines(est[jd])[0], /Track only\. Entry: on the MTF candidate lines\.$/);
});

test('minStage: no look-ahead (a prefix of the bars gives the same early candidate), and an unknown value is refused (fails closed)', () => {
  const pot = early('potential');
  for (const j of [EARLY.at(17, 2), EARLY.at(17, 3), EARLY.at(19, 1), EARLY.end(19)]) {
    const pre = M.mtfStructure({ ...OPTS, bars: EARLY.bars.slice(0, j + 1), minutes: EARLY.base, levels: [EARLY.level, EARLY.below], sideMode: 'parent', prims: EARLY.prims, mode: { ...MODE, minStage: 'potential' } });
    assert.deepEqual(P(pre).entry, P(pot[j]).entry, `bar ${j}`);
  }
  assert.throws(() => early('weakening'), /minStage must be one of established, developing, potential/);
  assert.throws(() => early(undefined), /minStage must be one of/);
});

test('mode record: the entry names its trigger (CHoCH or CISD, BOS for balanced and conservative), the parent its leg anchor, and the level its pullbacks\' DEVELOPING times (to rank a lower hierarchy in the 1h leg)', () => {
  const r = M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], sideMode: 'parent', prims: A.prims, mode: MODE });
  assert.equal(P(r[A.at(25, 1)]).entry.by, 'CHoCH');
  assert.equal(P(r[A.at(27, 1)]).entry.by, 'BOS');
  const leg = P(r[A.at(25, 1)]).parent.leg;
  assert.equal(leg.kind, 'BOS');
  assert.equal(leg.at, P(r[A.at(25, 1)]).instance.leg.at);
  const pbs = P(r[A.at(25, 1)]).pullbacks;
  assert.equal(pbs.length, 1);
  assert.deepEqual(Object.keys(pbs[0]).sort(), ['at', 'way']);
  assert.equal(pbs[0].way, 'down');
  assert.equal(pbs[0].at, P(r[A.at(25, 1)]).instance.developing.at);
  assert.deepEqual(P(r[A.end(16)]).pullbacks, [], 'none before the first DEVELOPING');
  assert.equal(P(run(A)[A.at(25, 1)]).pullbacks, undefined, 'no mode: none');
  const e = P(early('potential')[EARLY.at(17, 2)]).entry;
  assert.equal(e.by, 'CHoCH');
});

// ---- the CONTEXT facts (mode only): the parent's turn (the last CHoCH the way and the BOS that confirmed it, the BOS
// count since; or no turn: the trend since its first break) and the parent impulse's quality on the setup frame.
test('context, turn: no turn while the first break holds (trend since, the BOS count); a new BOS counts; the turn confirmed (CHoCH then BOS); a CHoCH promoted after the old protected swing broke', () => {
  const p = j => P(R[j]).parent;
  const t1 = p(Wd.end(10)).turn;
  assert.deepEqual([t1.way, t1.choch, t1.bos, t1.bosCount], ['up', null, null, 1]);
  assert.match(t1.since.et, /\d\d:\d\d$/);
  assert.equal(p(Wd.end(26)).turn.bosCount, 2, 'the continuation BOS up counts');
  const t2 = p(Wd.end(41)).turn;
  assert.deepEqual([t2.way, t2.bosCount, Boolean(t2.choch), Boolean(t2.bos)], ['down', 1, true, true]);
  assert.ok(Date.parse(t2.choch.at) < Date.parse(t2.bos.at), 'the CHoCH, then the BOS that confirmed it');
  const keys = [[0, 105], [4, 100], [30, 190], [32, 200], [35, 120], [47, 100]];
  const events = [{ f: 'parent', at: 1, kind: 'BOS', dir: 1, swing: 0, level: 104 }, { f: 'parent', at: 5, kind: 'BOS', dir: 1, swing: 4, level: 150 }, { f: 'parent', at: 8, kind: 'CHoCH', dir: -1, swing: 7, level: 185 }, { f: 'setup', at: 38, kind: 'CHoCH', dir: 1, swing: 37, level: 118 }];
  const w = W.world({ keys, events });
  const t3 = P(run(w, { mode: MODE })[w.end(38)]).parent.turn;
  assert.deepEqual([t3.way, Boolean(t3.choch), t3.bos, t3.bosCount], ['down', true, null, 0]);
  assert.equal(P(run(Wd)[Wd.end(10)]).parent.turn, undefined, 'no mode: none');
});

test('context, impulse: the candidate\'s impulse quality (bars, cleanness, displacement candles), as known at its bar; no fib depth; a prefix gives the same; the mirror the same', () => {
  const r = M.recordsOf({ ...OPTS, bars: A.bars, minutes: A.base, levels: [A.level, A.below], sideMode: 'parent', prims: A.prims, mode: MODE });
  const e = P(r[A.at(25, 1)]).entry;
  assert.ok(Number.isInteger(e.context.impulse.bars) && e.context.impulse.bars > 0);
  assert.ok(e.context.impulse.cleanness > 0 && e.context.impulse.cleanness <= 1);
  assert.ok(Number.isInteger(e.context.impulse.displaced));
  // The owner's decision (2026-11-18): no fib depth or zone on the candidate (the structure's own depth class stays).
  assert.deepEqual(Object.keys(e.context), ['impulse']);
  const pre = M.mtfStructure({ ...OPTS, bars: A.bars.slice(0, A.at(25, 1) + 1), minutes: A.base, levels: [A.level, A.below], sideMode: 'parent', prims: A.prims, mode: MODE });
  assert.deepEqual(P(pre).entry.context, e.context);
  const m = W.world({ keys: W.KEYS, events: W.EVENTS, mirror: true });
  const rm = M.recordsOf({ ...OPTS, bars: m.bars, minutes: m.base, levels: [m.level, m.below], sideMode: 'parent', prims: m.prims, mode: MODE });
  assert.deepEqual(P(rm[A.at(25, 1)]).entry.context, e.context);
  // An early (POTENTIAL) candidate: the impulse so far (not frozen yet), never a later high.
  const ep = P(early('potential')[EARLY.at(17, 2)]).entry;
  assert.ok(ep.context.impulse && ep.context.impulse.bars > 0);
  const preE = M.mtfStructure({ ...OPTS, bars: EARLY.bars.slice(0, EARLY.at(17, 2) + 1), minutes: EARLY.base, levels: [EARLY.level, EARLY.below], sideMode: 'parent', prims: EARLY.prims, mode: { ...MODE, minStage: 'potential' } });
  assert.deepEqual(P(preE).entry.context, ep.context);
});

