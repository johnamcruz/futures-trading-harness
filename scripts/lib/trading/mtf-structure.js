'use strict';

/**
 * The multi-timeframe nested structure read (the `bos-vs-choch` skill's "Multi-timeframe structure"): the pullback against
 * a parent frame's structure, staged on the setup frame and timed on the frame below, at three nested levels (4h > 1h,
 * 1h > 15m, 15m > 3m for the intraday hierarchy). A READ the briefing prints as facts (two lines under the Market state
 * line), never a setup, a trigger, a stop or a wait: no gate, hook, compose, order-plan, exit, entry-rule or trend-rule
 * code and no Market state module reads it (tests/plugin/market-state-readers.test.js). It feeds nothing in the Market
 * state: that line's state and class word are unchanged.
 *
 * Pure and causal: no config read, no clock, no I/O; every threshold is passed in (config/analysis.json mtfStructure,
 * marketState.equalAtr, indicators.swingK). A row at base bar j reads the base bars 0..j and the higher-frame candles known
 * complete by j; a pivot counts from its confirmation.
 *
 * Definitions, all existing code, nothing redefined:
 *   swings, BOS / CHoCH     structure-events.js pivots / breaksOf (k = indicators.swingK)
 *   protected swing         structure-events.js protectedLevel's rule (protectedAt below, by index)
 *   close through, the tie  protected-status.js through / tieAt (equalAtr x the candle's own frame's ATR(14); a wick never
 *                           counts)
 *   CISD                    cisd.js findCisds
 *   a frame's candles       candle-facts.js completedSeries, each used from the base bar it is known complete at
 *
 * A level is (parent, setup, timing) minutes. With the parent up (mirror for down), one open instance per level:
 *   POTENTIAL           a timing CHoCH down while the parent's protected low holds (opens the instance)
 *   DEVELOPING          a setup CHoCH down (freezes the parent impulse extreme; opens the instance if none is open)
 *   ESTABLISHED         then a setup BOS down (sets the pullback's protected high)
 *   WEAKENING           then the first timing CHoCH up or CISD up (WEAKENING_EVENTS), on a later base bar than ESTABLISHED
 *   REVERSING           then the first timing BOS up
 *   CONFIRMED REVERSAL  a setup close above the pullback's protected high past the tie (from ESTABLISHED on)
 *   COMPLETED           a setup close above the frozen impulse extreme past the tie (from DEVELOPING on): closes
 *   INVALIDATED         a parent close below the parent's protected low past the tie: closes
 * On one base-bar close: the timing frame's events, then the setup frame's, then the parent's. A timing close below the
 * pullback low recorded at WEAKENING (past the tie) while WEAKENING or REVERSING resets to ESTABLISHED. Closures that are
 * not stages (timing only, ended before ESTABLISHED, superseded, parent turned) print NONE with `last` on their bar.
 * Entry-ready (the primary level only): aggressive at WEAKENING, balanced at REVERSING, conservative after CONFIRMED
 * REVERSAL then a timing CHoCH down then the timing break up breaksOf labels BOS; withheld (the candidate kept) off the
 * side, under a warning, or once a base bar since the event traded through the structural stop.
 *
 *   WEAKENING_EVENTS                       ['CHoCH', 'CISD']: the aggressive trigger's one definition
 *   levelsOf({ hierarchy, hierarchies })    [{ name, parent, setup, timing, role }] above, primary, below
 *   configProblem(cfg)                      why the briefing refuses the config (only GATED is printed), or null
 *   candlesOf(bars, minutes, base)          the completed candles with first and known (the base bar it is known at)
 *   protectedAt(candles, swingI, breakI, d) protectedLevel's rule by index: { level, i } or null
 *   parentSeries({ exec, parent, equalAtr, k, prims })   the parent's break record per base bar (the owner's clean CHoCH)
 *   levelSeries({ exec, base, level, equalAtr, k, depth, prims, cache, keep, trackEarly })   { rows, instances } (trackEarly:
 *                                          an MTF arm's early candidates, P1)
 *   mtfStructure(o)                         the record at the last bar (m3.mtfStructure), or null (no bars)
 *   recordsOf(o)                            the record at every bar (one pass per level; gates and tests)
 *   mtfLines(record, { lineBytes, primaryBytes, level, cut })   the two summary lines, or [] without a record (cut: that
 *                                          cut level only, the tests' step-by-step check)
 */

const { through, tieAt } = require('./protected-status');
const { onTick } = require('./contracts'); // the structural stop on the contract's tick, its decimals exact (review m1)
const { label: tfLabel } = require('./mtf');
const { RTH_OPEN_MIN } = require('./clock');

/** The aggressive trigger (owner-delegated, final): the first of an aligned timing CHoCH or an aligned timing CISD. */
const WEAKENING_EVENTS = Object.freeze(['CHoCH', 'CISD']);
const STAGES = Object.freeze(['NONE', 'POTENTIAL', 'DEVELOPING', 'ESTABLISHED', 'WEAKENING', 'REVERSING', 'CONFIRMED REVERSAL', 'COMPLETED', 'INVALIDATED']);
const OPEN_PULLBACK = Object.freeze(['ESTABLISHED', 'WEAKENING', 'REVERSING']);
const SIDE_MODES = Object.freeze(['rule', 'parent']);
const LEVEL_FRAMES = Object.freeze(['parent', 'setup', 'timing']); // a hierarchy's minutes, in this order
const DEPTH_CLASSES = Object.freeze(['shallow', 'moderate', 'deep']);
/** P1, mtfEntry.minStage: the earliest stage a ready may fire at, and the stages each lets an early candidate fire in. */
const MIN_STAGES = Object.freeze({ established: Object.freeze([]), developing: Object.freeze(['DEVELOPING']), potential: Object.freeze(['POTENTIAL', 'DEVELOPING']) }); // config depth: each class's upper bound; past the last: breached
const sgn = d => (d === 'up' ? 1 : -1);
const legSide = d => (d > 0 ? 'up' : 'down');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** The default primitives: the harness's own breaks, CISDs and ATR(14). */
function defaultPrims() {
  const SE = require('./structure-events');
  const CI = require('./cisd');
  const ind = require('./indicators');
  return { breaksOf: SE.breaksOf, findCisds: CI.findCisds, atr: cs => ind.atr(cs, ind.ATR_PERIOD) };
}

/** The levels of a hierarchy: the one above (derived from `hierarchies`), the primary, the one below (no timing frame). */
function levelsOf({ hierarchy, hierarchies } = {}) {
  const P = isObj(hierarchies) ? hierarchies[hierarchy] : null;
  if (!Array.isArray(P) || P.length !== LEVEL_FRAMES.length || !P.every(m => Number.isInteger(m) && m > 0)) throw new Error(`mtf-structure: hierarchy ${hierarchy} is not [parent, setup, timing] minutes`);
  const name = (a, b) => `${tfLabel(a)}>${tfLabel(b)}`;
  const out = [];
  const above = Object.values(hierarchies).find(h => Array.isArray(h) && h[1] === P[0] && h[2] === P[1]);
  if (above) out.push({ name: name(above[0], P[0]), parent: above[0], setup: P[0], timing: P[1], role: 'above' });
  out.push({ name: name(P[0], P[1]), parent: P[0], setup: P[1], timing: P[2], role: 'primary' });
  out.push({ name: name(P[1], P[2]), parent: P[1], setup: P[2], timing: null, role: 'below' });
  return out;
}

/** The one hierarchy and side mode this build gates and prints (decision 19; spec 4.4): any other loads, never prints. */
const GATED = Object.freeze({ hierarchy: 'intraday', sideMode: 'rule' });
/** Why the briefing refuses this config (no record, no lines), or null. */
function configProblem(cfg, mode = null) {
  if (!isObj(cfg)) return 'no mtfStructure config';
  if (isObj(mode) && mode.entryMode && mode.entryMode !== 'today') {
    // An MTF entry arm (P1, trading/mtf-entry.js): the side is the parent's (the 1h structure) or, on arm B's execution
    // record, the 1h side passed in as the rule's; its hierarchy is the arm's (arm B: the intraday one gives the 1h side).
    const hs = Array.isArray(mode.hierarchies) ? mode.hierarchies : [];
    const allowed = hs.includes('execution') ? [GATED.hierarchy, 'execution'] : [GATED.hierarchy];
    if (!allowed.includes(cfg.hierarchy)) return `hierarchy ${cfg.hierarchy}: arm ${mode.arm} reads ${allowed.join(' and ')}`;
    if (!SIDE_MODES.includes(cfg.sideMode)) return `sideMode ${cfg.sideMode}: one of ${SIDE_MODES.join(', ')}`;
    try { levelsOf(cfg); } catch (err) { return err.message; }
    return null;
  }
  if (cfg.hierarchy !== GATED.hierarchy) return `hierarchy ${cfg.hierarchy}: only ${GATED.hierarchy} is gated`;
  if (cfg.sideMode !== GATED.sideMode) return `sideMode ${cfg.sideMode}: only ${GATED.sideMode} is printed`;
  try { levelsOf(cfg); } catch (err) { return err.message; }
  return null;
}

/** The completed candles of `minutes` from `base` bars, each with first and known (the base bar it is known complete at). */
function candlesOf(bars, minutes, base) {
  if (minutes === base) return bars.map((b, i) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, first: i, known: i }));
  const CF = require('./candle-facts');
  const step = base * 60000;
  return CF.completedSeries(bars, minutes, base).candles
    .map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, first: c.first, known: Date.parse(bars[c.last].t) + step === Date.parse(c.closedAt) ? c.last : c.last + 1 }))
    .filter(c => c.known < bars.length);
}

/** protectedLevel's rule by index: the extreme against the break from the candle after the broken swing's to the break's. */
function protectedAt(bars, swingI, breakI, dir) {
  let lv = null;
  let at = null;
  for (let q = swingI + 1; q <= breakI; q += 1) {
    const v = dir > 0 ? bars[q].l : bars[q].h;
    if (lv === null || (dir > 0 ? v < lv : v > lv)) { lv = v; at = q; }
  }
  return lv === null ? null : { level: lv, i: at };
}

/**
 * The parent frame's break record per base bar, changed only when a parent candle is known (the owner's clean CHoCH rule,
 * from the superseded 15m structure phase, unchanged but for `protI`): `none`; `bias` (a break with a protected swing);
 * `transitioning` (a break against while the protected swing holds: the way stays, a warning; a BOS against confirms the
 * turn; a close through the CHoCH's own protected swing past the tie invalidates the CHoCH and the old parent returns; a
 * close back through its broken level is a warning only: kept as `failedBreak` and a `choch-failed` event in this series,
 * record-only, never printed and never a change of state). A parent close through the protected swing past the tie is
 * `invalid` (tested first); the break against is then promoted when its own protected swing has no close through it.
 */
function parentSeries({ exec, parent, equalAtr, k, prims = defaultPrims() }) {
  const n = exec.length;
  const pT = new Map(parent.map((c, i) => [c.t, i]));
  const atrP = prims.atr(parent);
  const tie = i => tieAt(atrP, i, equalAtr);
  const thru = (close, level, d, tol) => through(close, level, legSide(d), tol);
  const at = new Map();
  for (const b of prims.breaksOf(parent, k)) {
    const d = sgn(b.direction);
    const sw = pT.get(b.swingAt);
    const x = { ...b, d, prot: sw === undefined ? null : protectedAt(parent, sw, b.i, d) };
    if (!at.has(b.i)) at.set(b.i, []);
    at.get(b.i).push(x);
  }
  const known = new Map();
  parent.forEach((c, i) => {
    if (!Number.isInteger(c.known) || c.known < 0) return;
    if (!known.has(c.known)) known.set(c.known, []);
    known.get(c.known).push(i);
  });
  const series = new Array(n).fill(null);
  const events = new Array(n).fill(null);
  const count = new Array(n).fill(0);
  let S = { mode: 'none' };
  let key = 0;
  let seen = 0;
  const brkOf = b => ({ kind: b.kind, level: b.level, at: b.at, protAt: parent[b.prot.i].t });
  const biasOf = b => { key += 1; return { mode: 'bias', key, d: b.d, level: b.prot.level, protI: b.prot.i, legFrom: Math.max(0, parent[b.prot.i].first), brk: brkOf(b), via: 'break' }; };
  // The break against promoted: only when its own protected swing has no close through it since (kept for the definition;
  // unreachable today, an equivalent mutant: see the superseded build's note).
  const promote = (x, pi) => {
    if (!x || !x.prot) return { mode: 'none' };
    for (let q = x.i + 1; q <= pi; q += 1) if (thru(parent[q].c, x.prot.level, x.d, tie(q))) return { mode: 'none' };
    return biasOf(x);
  };
  const against = b => ({ kind: b.kind, level: b.level, d: b.d, at: b.at, prot: b.prot ? b.prot.level : null });
  // P1, the parent's turn (the MTF candidate's context): the CHoCH that turned the way and the BOS that confirmed it, the
  // BOS the way since; or, with no turn seen, the trend since its first break. Carried with the state; no state reads it.
  const withTurn = (X, turn) => (X.mode === 'bias' ? { ...X, turn } : X);
  const firstTurn = b => ({ way: legSide(b.d), choch: null, bos: null, since: { at: b.at }, bosCount: b.kind === 'BOS' ? 1 : 0 });
  const counted = (turn, b) => (!turn || b.kind !== 'BOS' ? turn : { ...turn, bosCount: turn.bosCount + 1, bos: turn.choch && !turn.bos ? { at: b.at } : turn.bos });
  const promoted = (b, pi) => withTurn(promote(b, pi), { way: legSide(b.d), choch: { kind: b.kind, at: b.at }, bos: b.kind === 'BOS' ? { at: b.at } : null, since: null, bosCount: b.kind === 'BOS' ? 1 : 0 });
  for (let j = 0; j < n; j += 1) {
    const ev = [];
    for (const pi of known.get(j) || []) {
      seen += 1;
      const close = parent[pi].c;
      const t = parent[pi].t;
      for (const b of at.get(pi) || []) {
        if (S.mode === 'none') {
          if (b.prot) { S = withTurn(biasOf(b), firstTurn(b)); ev.push({ type: 'bias', d: b.d, kind: b.kind, level: b.level, t }); }
          continue;
        }
        if (S.mode === 'bias') {
          if (b.d === S.d) {
            if (b.prot) { S = { ...S, level: b.prot.level, protI: b.prot.i, brk: brkOf(b), via: 'break', turn: counted(S.turn, b) }; ev.push({ type: 'continuation', d: b.d, kind: b.kind, level: b.level, prot: b.prot.level, t }); }
            continue;
          }
          if (thru(close, S.level, S.d, tie(pi))) { ev.push({ type: 'invalid', d: S.d, level: S.level, close, against: against(b), t }); S = promoted(b, pi); } else { ev.push({ type: 'transitioning', d: S.d, level: S.level, against: against(b), t }); S = { mode: 'transitioning', old: S, against: b }; }
          continue;
        }
        if (b.d === S.against.d) {
          if (thru(close, S.old.level, S.old.d, tie(pi))) { ev.push({ type: 'invalid', d: S.old.d, level: S.old.level, close, against: against(b), t }); S = promoted(b, pi); } else { ev.push({ type: 'turn-confirmed', d: b.d, kind: b.kind, level: b.level, old: S.old.level, t }); S = b.prot ? withTurn(biasOf(b), { way: legSide(b.d), choch: { kind: S.against.kind, at: S.against.at }, bos: { at: b.at }, since: null, bosCount: 1 }) : { mode: 'none' }; }
        } else {
          ev.push({ type: 'resumed-by-break', d: b.d, kind: b.kind, level: b.level, t });
          key += 1;
          S = b.prot ? { ...S.old, key, level: b.prot.level, protI: b.prot.i, brk: brkOf(b), via: 'break', turn: counted(S.old.turn, b) } : { ...S.old, key };
        }
      }
      if (S.mode === 'bias' && thru(close, S.level, S.d, tie(pi))) { ev.push({ type: 'invalid', d: S.d, level: S.level, close, against: null, t }); S = { mode: 'none' }; } else if (S.mode === 'transitioning') {
        if (thru(close, S.old.level, S.old.d, tie(pi))) { ev.push({ type: 'invalid', d: S.old.d, level: S.old.level, close, against: against(S.against), t }); S = promoted(S.against, pi); } else if (pi > S.against.i && S.against.prot && thru(close, S.against.prot.level, S.against.d, tie(pi))) {
          ev.push({ type: 'choch-invalidated', d: S.old.d, level: S.against.prot.level, close, against: against(S.against), t });
          key += 1;
          S = { ...S.old, key, via: 'choch invalidated' };
        } else if (pi > S.against.i && !S.failedBreak && thru(close, S.against.level, S.against.d, tie(pi))) {
          ev.push({ type: 'choch-failed', d: S.old.d, level: S.against.level, close, t });
          S = { ...S, failedBreak: { close, level: S.against.level, j } };
        }
      }
    }
    series[j] = S;
    events[j] = ev;
    count[j] = seen;
  }
  return { series, events, count };
}

/** A frame's candles with their breaks (each with its protected swing), CISDs and closes keyed by the base bar known at. */
function framed(c, { prims, k }) {
  const tI = new Map(c.map((x, i) => [x.t, i]));
  const push = (m, key, x) => { if (!m.has(key)) m.set(key, []); m.get(key).push(x); };
  const breaksAt = new Map();
  for (const b of prims.breaksOf(c, k)) {
    const d = sgn(b.direction);
    const sw = tI.get(b.swingAt);
    push(breaksAt, c[b.i].known, { kind: b.kind, d, level: b.level, at: b.at, ci: b.i, prot: sw === undefined ? null : protectedAt(c, sw, b.i, d) });
  }
  const cisdAt = new Map();
  for (const e of prims.findCisds(c)) push(cisdAt, c[e.confirm].known, { d: e.dir, level: e.level, ci: e.confirm, runStart: e.runStart });
  const knownAt = new Map();
  c.forEach((x, i) => push(knownAt, x.known, i));
  return { c, atr: prims.atr(c), breaksAt, cisdAt, knownAt };
}

/**
 * One level over the base bars: one forward pass, rows[j] for each j `keep(j)` accepts (all by default). A row is
 * { parent, inst, closedNow, last, evs, setupLast, warning, count } with plain copies (a later bar never changes it).
 */
function levelSeries({ exec, base, level, equalAtr, k, prims = defaultPrims(), cache = new Map(), keep = () => true, trackEarly = false }) {
  const n = exec.length;
  const frame = m => {
    const key = `frame:${m}`;
    if (!cache.has(key)) cache.set(key, framed(candlesOf(exec, m, base), { prims, k }));
    return cache.get(key);
  };
  const Pf = frame(level.parent);
  const Sf = frame(level.setup);
  const Tf = level.timing ? frame(level.timing) : null;
  const pKey = `parent:${level.parent}`;
  if (!cache.has(pKey)) cache.set(pKey, parentSeries({ exec, parent: Pf.c, equalAtr, k, prims }));
  const P = cache.get(pKey);
  const hi = (b, D) => (D > 0 ? b.h : b.l);
  const lo = (b, D) => (D > 0 ? b.l : b.h);
  const par = X => (!X || X.mode === 'none' ? null : X.mode === 'bias' ? { D: X.d, prot: X.level, protI: X.protI, legFrom: X.legFrom, key: X.key, via: X.via || 'break', brk: X.brk, turn: X.turn || null, against: null, failedBreak: null }
    : { D: X.old.d, prot: X.old.level, protI: X.old.protI, legFrom: X.old.legFrom, key: X.old.key, via: X.old.via || 'break', brk: X.old.brk, turn: X.old.turn || null, against: X.against, failedBreak: X.failedBreak || null });
  const rows = new Array(n).fill(null);
  const instances = [];
  let inst = null;
  let lastClosed = null;
  let extKey = null;
  let ext = null;
  let extBar = -1;
  let seq = 0;
  let setupLast = null;
  let lastS = null; // the latest setup candle known: { i, close, j }
  let lastT = null; // the latest timing candle known
  // P1, the pullback's rank in its parent leg: the setup pullbacks (DEVELOPING) since the parent's last break its way
  // (`brk`: a BOS or CHoCH that set or continued the way, the turn confirmed, a break that resumed it, or the CHoCH promoted
  // after the old protected swing broke). A CHoCH against while transitioning keeps the old leg (its brk).
  const legKeyOf = X => (X && X.brk ? `${X.D}:${X.brk.at}` : null);
  let rankLeg = null;
  let rankN = 0;
  // P1, the impulse the pullback came from (its context): the last setup break the parent's way, from its protected swing
  // (the leg protectedLevel defines), frozen on the instance at DEVELOPING; reset when the parent leg changes.
  let lastPush = null;
  const recomputeExt = (pp, upto) => {
    ext = null; extBar = -1;
    for (let q = Math.max(0, pp.legFrom); q <= upto; q += 1) { const v = hi(exec[q], pp.D); if (ext === null || pp.D * (v - ext) > 0) { ext = v; extBar = q; } }
  };
  // A closure: the impulse extreme is recomputed from the parent leg's start at once (highs made while it was open count;
  // a new instance on the same bar, I5, freezes the recomputed one).
  const close = (j, why, extra, pp) => {
    inst.closed = { why, j, ...extra };
    lastClosed = inst;
    inst = null;
    if (pp) { extKey = `${pp.key}:${pp.legFrom}`; recomputeExt(pp, j); } else extKey = null;
  };
  const lowFrom = (D, from, to) => { let v = null; let at = to; for (let q = Math.max(0, from); q <= to; q += 1) { const x = lo(exec[q], D); if (v === null || D * (v - x) > 0) { v = x; at = q; } } return v === null ? { v: lo(exec[to], D), at: to } : { v, at }; };
  const open = (j, D, stage, by) => {
    seq += 1;
    const l = lowFrom(D, extBar + 1, j);
    // P1: a POTENTIAL's rank is the one it takes if it develops (the leg's next pullback); DEVELOPING confirms it.
    const lk0 = legKeyOf(par(j > 0 ? P.series[j - 1] : null));
    const pp0 = par(j > 0 ? P.series[j - 1] : null);
    inst = { id: seq, D, stage, openedAt: j, openedBy: by, push: null, rank: lk0 ? (lk0 === rankLeg ? rankN : 0) + 1 : null, leg: lk0 ? { kind: pp0.brk.kind, at: pp0.brk.at } : null, early: null, lowAtEarly: null, potential: null, developing: null, established: null, weakening: null, reversing: null, confirmed: null, conservative: null, impulse: null, low: l.v, lowAt: l.at, lowAtWeak: null, protHigh: null, protMoves: [], minor: null, resets: [], closed: null };
    instances.push(inst);
  };
  for (let j = 0; j < n; j += 1) {
    const pp = par(j > 0 ? P.series[j - 1] : null);
    const pd = pp ? pp.D : 0;
    const evs = [];
    let closedNow = null;
    const closeNow = (why, extra = {}) => { close(j, why, extra, pp); closedNow = lastClosed; evs.push(why); };
    // The parent impulse extreme: from the parent leg's start, frozen while an instance is DEVELOPING or later.
    if (pp) {
      const key = `${pp.key}:${pp.legFrom}`;
      if (extKey !== key) { extKey = key; recomputeExt(pp, j - 1); }
      if (!inst || inst.stage === 'POTENTIAL') {
        const v = hi(exec[j], pd);
        if (ext === null || pd * (v - ext) > 0) { ext = v; extBar = j; if (inst) { inst.low = lo(exec[j], pd); inst.lowAt = j; } }
      }
    } else { extKey = null; ext = null; extBar = -1; }
    if (inst && !(inst.stage === 'POTENTIAL' && extBar === j)) { const v = lo(exec[j], inst.D); if (inst.D * (inst.low - v) > 0) { inst.low = v; inst.lowAt = j; } }
    // ---- 1. the timing frame (its candles known at this close): the reset, then its breaks, then its CISDs
    if (Tf) {
      for (const ti of Tf.knownAt.get(j) || []) {
        lastT = { i: ti, close: Tf.c[ti].c, j };
        if (inst && (inst.stage === 'WEAKENING' || inst.stage === 'REVERSING') && through(Tf.c[ti].c, inst.lowAtWeak, legSide(inst.D), tieAt(Tf.atr, ti, equalAtr))) {
          inst.resets.push({ j, from: inst.stage, extreme: inst.lowAtWeak, close: Tf.c[ti].c });
          inst.stage = 'ESTABLISHED'; inst.weakening = null; inst.reversing = null; inst.lowAtWeak = null;
          evs.push('reset');
        }
        // P1: an early candidate (POTENTIAL or DEVELOPING) resets the same way: a timing close past the low it was taken at.
        // P1: early candidates are an MTF arm's only; today's record never carries their events.
        if (trackEarly && inst && inst.early && through(Tf.c[ti].c, inst.lowAtEarly, legSide(inst.D), tieAt(Tf.atr, ti, equalAtr))) { inst.early = null; inst.lowAtEarly = null; evs.push('early reset'); }
      }
      for (const b of Tf.breaksAt.get(j) || []) {
        if (!inst) {
          if (pd && b.kind === 'CHoCH' && b.d === -pd) { open(j, pd, 'POTENTIAL', 'timing CHoCH'); inst.potential = { j, level: b.level }; evs.push('potential'); }
          continue;
        }
        const d = inst.D;
        const origin = b.prot ? b.prot.level : inst.low;
        // P1, the early trigger (minStage): the first aligned timing CHoCH (or CISD, below) in POTENTIAL or DEVELOPING, after
        // the stage began; kept per stage (DEVELOPING starts its own). Read only through an MTF entry mode's minStage.
        if (trackEarly && (inst.stage === 'POTENTIAL' || inst.stage === 'DEVELOPING') && !inst.early && b.d === d && b.kind === 'CHoCH' && j > (inst.stage === 'DEVELOPING' ? inst.developing.j : inst.openedAt)) {
          inst.early = { by: b.kind, j, level: b.level, origin, stage: inst.stage }; inst.lowAtEarly = inst.low;
        }
        if (inst.stage === 'POTENTIAL') { if (b.kind === 'BOS' && b.d === d) closeNow('timing only'); continue; }
        if (inst.stage === 'ESTABLISHED' && b.d === d && WEAKENING_EVENTS.includes(b.kind) && j > inst.established.j) {
          inst.stage = 'WEAKENING'; inst.weakening = { by: b.kind, j, level: b.level, origin }; inst.lowAtWeak = inst.low; evs.push('weakening');
          continue;
        }
        if (inst.stage === 'WEAKENING' && b.d === d && b.kind === 'BOS') { inst.stage = 'REVERSING'; inst.reversing = { j, level: b.level, origin }; evs.push('reversing'); continue; }
        if (inst.stage === 'CONFIRMED REVERSAL') {
          const cons = inst.conservative;
          if (!cons && b.d === -d && b.kind === 'CHoCH' && j > inst.confirmed.j) inst.conservative = { pullbackAt: j, first: null, bos: null };
          else if (cons && b.d === d) {
            if (!cons.first) cons.first = { j, kind: b.kind, level: b.level, origin };
            if (!cons.bos && b.kind === 'BOS') { cons.bos = { j, level: b.level, origin }; evs.push('conservative'); }
          }
        }
      }
      if (trackEarly && inst && (inst.stage === 'POTENTIAL' || inst.stage === 'DEVELOPING') && !inst.early && j > (inst.stage === 'DEVELOPING' ? inst.developing.j : inst.openedAt)) {
        const e = (Tf.cisdAt.get(j) || []).find(x => x.d === inst.D);
        if (e) { inst.early = { by: 'CISD', j, level: e.level, origin: inst.low, stage: inst.stage }; inst.lowAtEarly = inst.low; }
      }
      if (inst && inst.stage === 'ESTABLISHED' && WEAKENING_EVENTS.includes('CISD') && j > inst.established.j) {
        const e = (Tf.cisdAt.get(j) || []).find(x => x.d === inst.D);
        if (e) { inst.stage = 'WEAKENING'; inst.weakening = { by: 'CISD', j, level: e.level, origin: inst.low }; inst.lowAtWeak = inst.low; evs.push('weakening'); }
      }
    }
    // ---- 2. the setup frame's candles known at this close
    for (const si of Sf.knownAt.get(j) || []) {
      const c = Sf.c[si];
      const tie = tieAt(Sf.atr, si, equalAtr);
      lastS = { i: si, close: c.c, j };
      // COMPLETED first (from DEVELOPING on): a close beyond the frozen impulse extreme closes the instance.
      if (inst && inst.impulse && Number.isFinite(inst.impulse.extreme) && through(c.c, inst.impulse.extreme, legSide(-inst.D), tie)) closeNow('completed', { close: c.c, level: inst.impulse.extreme });
      for (const b of (Sf.breaksAt.get(j) || []).filter(x => x.ci === si)) {
        if (pd && b.d === pd && b.prot) lastPush = { level: b.prot.level, ci: b.prot.i, leg: legKeyOf(pp) };
        // I8: a setup BOS against the parent with no DEVELOPING open (no CHoCH inside this structure) changes no stage; the
        // fact stands until the next setup break.
        setupLast = (!inst || inst.stage === 'POTENTIAL') && pd && b.kind === 'BOS' && b.d === -pd ? { kind: b.kind, d: b.d, level: b.level, j } : null;
        const d = inst ? inst.D : pd;
        if (!d) continue;
        if (b.d === -d) {
          if (inst && inst.stage === 'CONFIRMED REVERSAL') closeNow('superseded');
          if ((!inst || inst.stage === 'POTENTIAL') && b.kind === 'CHoCH') {
            if (!inst) open(j, d, 'DEVELOPING', 'setup CHoCH');
            inst.stage = 'DEVELOPING';
            inst.early = null; inst.lowAtEarly = null;
            inst.developing = { j, level: b.level, origin: b.prot ? b.prot.level : null };
            inst.push = lastPush && lastPush.leg === legKeyOf(pp) ? { level: lastPush.level, ci: lastPush.ci } : null;
            const lk = legKeyOf(pp);
            if (lk !== rankLeg) { rankLeg = lk; rankN = 0; }
            rankN += 1;
            inst.rank = lk ? rankN : null;
            inst.leg = lk ? { kind: pp.brk.kind, at: pp.brk.at } : null;
            inst.impulse = { extreme: ext, j: extBar };
            const l = lowFrom(d, extBar + 1, j);
            inst.low = l.v; inst.lowAt = l.at;
            evs.push('developing');
          } else if (inst && inst.stage === 'DEVELOPING' && b.kind === 'BOS') {
            inst.stage = 'ESTABLISHED';
            inst.early = null; inst.lowAtEarly = null;
            inst.established = { j, level: b.level };
            inst.protHigh = b.prot ? b.prot.level : inst.developing.origin;
            evs.push('established');
          } else if (inst && OPEN_PULLBACK.includes(inst.stage) && b.prot) {
            // Any setup break against the parent moves the pullback's protected swing, whatever breaksOf labels it.
            inst.protMoves.push({ j, kind: b.kind, from: inst.protHigh, to: b.prot.level });
            inst.protHigh = b.prot.level;
            inst.minor = null;
          }
        } else if (inst) {
          if (inst.stage === 'DEVELOPING') closeNow('ended before established');
          else if (OPEN_PULLBACK.includes(inst.stage) && b.level !== inst.protHigh) inst.minor = { j, level: b.level };
        }
      }
      if (inst && OPEN_PULLBACK.includes(inst.stage) && Number.isFinite(inst.protHigh) && through(c.c, inst.protHigh, legSide(-inst.D), tie)) {
        inst.stage = 'CONFIRMED REVERSAL'; inst.confirmed = { j, level: inst.protHigh, close: c.c }; evs.push('confirmed');
      }
    }
    // ---- 3. then the parent
    const pn = par(P.series[j]);
    if (inst && (!pn || pn.D !== inst.D)) {
      const inv = (P.events[j] || []).find(e => e.type === 'invalid');
      closeNow(inv ? 'invalidated' : 'parent turned', inv ? { close: inv.close, level: inv.level } : {});
    }
    if (!keep(j)) continue;
    // The warning: the latest setup close (or else the latest timing close) through the parent's protected swing past the tie.
    let warning = null;
    if (pn) {
      const w = (x, f, name) => (x && through(x.close, pn.prot, legSide(pn.D), tieAt(f.atr, x.i, equalAtr)) ? { frame: name, j: x.j, close: x.close } : null);
      warning = w(lastS, Sf, level.setup) || (Tf ? w(lastT, Tf, level.timing) : null);
    }
    const snap = x => (x ? { ...x, resets: x.resets.slice(), protMoves: x.protMoves.slice(), conservative: x.conservative ? { ...x.conservative } : null, closed: x.closed ? { ...x.closed } : null } : null);
    rows[j] = {
      parent: pn ? { ...pn, events: P.events[j] || [] } : null,
      parentEvents: P.events[j] || [],
      inst: snap(inst),
      closedNow: snap(closedNow),
      last: lastClosed && lastClosed !== closedNow ? { why: lastClosed.closed.why, j: lastClosed.closed.j } : (closedNow && inst ? { why: closedNow.closed.why, j } : null),
      evs,
      setupLast: setupLast ? { ...setupLast } : null,
      ext: pn && ext !== null ? { v: ext, j: extBar } : null,
      push: lastPush && pn && lastPush.leg === legKeyOf(pn) ? { level: lastPush.level, ci: lastPush.ci } : null,
      warning,
      count: P.count[j],
    };
  }
  return { rows, instances, frames: { parent: Pf, setup: Sf, timing: Tf } };
}

const REQUIRED = ['minutes', 'tick', 'bufferTicks', 'equalAtr', 'k', 'warmBars'];
function required(o) {
  for (const name of REQUIRED) if (!Number.isFinite(o[name])) throw new Error(`mtf-structure: ${name} is required (config, never a literal)`);
  if (!Array.isArray(o.depth) || o.depth.length !== DEPTH_CLASSES.length || !o.depth.every(Number.isFinite)) throw new Error('mtf-structure: depth is required ([shallow, moderate, deep] upper bounds, config)');
  if (!Array.isArray(o.levels) || !o.levels.length) throw new Error('mtf-structure: levels is required (levelsOf on the config\'s hierarchy)');
  if (!SIDE_MODES.includes(o.sideMode)) throw new Error(`mtf-structure: sideMode must be one of ${SIDE_MODES.join(', ')}`);
  if (o.mode && !Object.prototype.hasOwnProperty.call(MIN_STAGES, o.mode.minStage)) throw new Error(`mtf-structure: minStage must be one of ${Object.keys(MIN_STAGES).join(', ')} (config mtfEntry.minStage)`);
}

const ET_TZ = 'America/New_York';
const ET_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const etParts = ms => {
  const p = ET_FMT.formatToParts(new Date(ms));
  const g = t => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, md: `${g('month')}-${g('day')}`, hm: `${g('hour')}:${g('minute')}` };
};
const r2 = x => Math.round(x * 100) / 100;
const wayOf = D => (D > 0 ? 'up' : 'down');
const sideOfD = D => (D > 0 ? 'long' : 'short');

/** The record of one level at bar j (spec 3.1). */
function levelRecord(L, R, j, o, ctx) {
  const { exec, minutes } = o;
  const row = R.rows[j];
  const closeMs = i => Date.parse(exec[i].t) + minutes * 60000;
  const today = etParts(closeMs(j)).date;
  const when = i => {
    const p = etParts(closeMs(i));
    const [h, m] = p.hm.split(':').map(Number);
    return { at: new Date(closeMs(i)).toISOString(), barsAgo: j - i, minAgo: Math.round((closeMs(j) - closeMs(i)) / 60000), et: p.date === today ? p.hm : `${p.md} ${p.hm}`, beforeOpen: p.date !== today || h * 60 + m < RTH_OPEN_MIN };
  };
  const frames = { parent: tfLabel(L.parent), setup: tfLabel(L.setup), timing: L.timing ? tfLabel(L.timing) : null };
  const pn = row.parent;
  // Partial: fewer than warmBars parent candles before the parent's leg start (or, with no parent, known by this bar).
  const anchor = pn ? pn.protI : row.count;
  const partial = !Number.isInteger(anchor) || anchor < o.warmBars;
  const biasRead = ctx.bias && typeof ctx.bias[frames.parent] === 'string' ? ctx.bias[frames.parent] : null;
  const parent = pn ? {
    way: wayOf(pn.D),
    protected: { side: pn.D > 0 ? 'low' : 'high', level: pn.prot, at: R.frames.parent.c[pn.protI] ? R.frames.parent.c[pn.protI].t : null },
    via: pn.via,
    against: pn.against ? { kind: pn.against.kind, direction: wayOf(pn.against.d), level: pn.against.level, at: pn.against.at } : null,
    biasRead,
    differs: biasRead !== null && biasRead !== wayOf(pn.D),
  } : null;
  // P1: the parent leg's anchor (its last break the way's, the rank's reset), as the break candle's close.
  if (parent && o.mode) {
    parent.leg = pn.brk ? legWhen(pn.brk, L.parent, today) : null;
    const tn = pn.turn;
    const w = x => (x && x.at ? strip(legWhen({ kind: null, at: x.at }, L.parent, today)) : null);
    parent.turn = tn ? { way: tn.way, choch: tn.choch ? { kind: tn.choch.kind, ...w(tn.choch) } : null, bos: w(tn.bos), since: w(tn.since), bosCount: tn.bosCount } : null;
  }
  const raw = row.inst || row.closedNow;
  const stage = row.inst ? row.inst.stage : row.closedNow && row.closedNow.closed.why === 'completed' ? 'COMPLETED' : row.closedNow && row.closedNow.closed.why === 'invalidated' ? 'INVALIDATED' : 'NONE';
  // An event with its time (the window-relative bar index left out: a record never depends on where the window starts).
  const at = x => { if (!x) return null; const { j: bar, ...rest } = x; return { ...rest, ...when(bar) }; };
  let instance = null;
  if (raw && (row.inst || stage !== 'NONE')) {
    const i = raw;
    const span = i.impulse && pn && Number.isFinite(i.impulse.extreme) && i.D === pn.D ? i.D * (i.impulse.extreme - pn.prot) : null;
    const depth = span && span > 0 ? r2(i.D * (i.impulse.extreme - i.low) / span) : null;
    const cls = d => DEPTH_CLASSES[o.depth.findIndex((x, n) => (n < DEPTH_CLASSES.length - 1 ? d < x : d <= x))] || 'breached';
    instance = {
      id: i.id, openedAt: when(i.openedAt), openedBy: i.openedBy, pullbackWay: wayOf(-i.D),
      potential: at(i.potential), developing: at(i.developing), established: at(i.established),
      weakening: at(i.weakening), reversing: at(i.reversing), confirmed: at(i.confirmed),
      conservative: i.conservative ? { pullbackAt: when(i.conservative.pullbackAt), first: at(i.conservative.first), bos: at(i.conservative.bos) } : null,
      impulseExtreme: i.impulse ? i.impulse.extreme : null, extreme: i.low, extremeAt: when(i.lowAt),
      protected: i.protHigh, protMoves: i.protMoves.map(at), minor: at(i.minor), resets: i.resets.map(at),
      depth, depthClass: depth === null ? null : cls(depth),
      closed: i.closed ? at(i.closed) : null,
    };
    if (o.mode) {
      // P1: the pullback's rank in its parent leg and that leg's break (its candle's close, ET).
      instance.rank = Number.isInteger(i.rank) ? i.rank : null;
      instance.leg = i.leg ? legWhen(i.leg, L.parent, today) : null;
    }
  }
  const last = !row.inst && row.closedNow && stage === 'NONE' ? { why: row.closedNow.closed.why, ...when(j) } : row.last ? { why: row.last.why, ...when(row.last.j) } : null;
  const sa = row.setupLast;
  const setupAgainst = pn && sa && sa.d === -pn.D && sa.kind === 'BOS' && (stage === 'NONE' || stage === 'POTENTIAL') ? { kind: sa.kind, direction: wayOf(sa.d), level: sa.level, ...when(sa.j) } : null;
  const warning = row.warning ? { frame: tfLabel(row.warning.frame), close: row.warning.close, ...when(row.warning.j) } : null;
  const out = { name: L.name, role: L.role, frames, partial, parent, setupAgainst, stage, instance, last, warning, event: row.evs.slice(), entry: null, entryWithheld: null, stopTraded: null };
  // P1: every setup pullback's DEVELOPING time so far in the bars (the window bounds it): a lower hierarchy's rank in the 1h leg.
  if (o.mode) out.pullbacks = R.instances.filter(x => x.developing && x.developing.j <= j).map(x => ({ at: when(x.developing.j).at, way: wayOf(-x.D) }));
  if (stage === 'INVALIDATED' && raw && raw.closed) out.invalidated = { close: raw.closed.close, level: raw.closed.level, way: wayOf(raw.D) };
  if (L.role === 'primary' && !partial && raw && row.inst) entryOf(out, row.inst, j, { ...o, series: R }, when);
  return out;
}

const strip = x => (x ? { at: x.at, et: x.et } : null);
/** A parent break's time as its candle's close: { kind, at (ISO), et ('HH:MM', or 'MM-DD HH:MM' before today) }. */
function legWhen(leg, parentMinutes, today) {
  const ms = Date.parse(leg.at) + parentMinutes * 60000;
  if (!Number.isFinite(ms)) return { kind: leg.kind, at: null, et: null };
  const p = etParts(ms);
  return { kind: leg.kind, at: new Date(ms).toISOString(), et: p.date === today ? p.hm : `${p.md} ${p.hm}` };
}

/** The primary level's entry-ready candidate and why it is withheld (spec 2.4). */
function entryOf(out, i, j, o, when) {
  const buf = o.tick * o.bufferTicks;
  const D = i.D;
  const stopOf = x => onTick(x - D * buf, o.tick);
  let model = null;
  let ev = null;
  let also = null;
  if (i.stage === 'WEAKENING' && i.weakening) { model = 'aggressive'; ev = i.weakening; }
  else if (i.stage === 'REVERSING' && i.reversing) { model = 'balanced'; ev = i.reversing; also = i.weakening ? { what: 'aggressive', stop: stopOf(i.weakening.origin) } : null; }
  else if (i.stage === 'CONFIRMED REVERSAL' && i.conservative && i.conservative.bos) { model = 'conservative'; ev = i.conservative.bos; also = { what: '15m CHoCH origin', level: i.low, stop: stopOf(i.low) }; }
  // P1, minStage: an early aggressive candidate in POTENTIAL or DEVELOPING (the mode's stages only), the same trigger.
  let early = null;
  if (!model && o.mode && i.early && MIN_STAGES[o.mode.minStage].includes(i.stage) && i.early.stage === i.stage) { model = 'aggressive'; ev = i.early; early = i.stage; }
  if (!model || (!i.established && !early)) return;
  const stop = stopOf(ev.origin);
  out.entry = { model, side: sideOfD(D), since: when(ev.j), stop, stopTicks: Math.round(Math.abs(o.exec[j].c - stop) / o.tick), also };
  if (early) out.entry.early = early;
  if (o.mode) out.entry.by = ev.by || 'BOS'; // P1: the trigger's kind (WEAKENING's CHoCH or CISD, an early one's; a BOS otherwise)
  if (o.mode) {
    // P1: the structural level before the buffer, and the target the exit option reads: the parent impulse extreme (the
    // COMPLETED level), with its R from this close by this stop (null when either distance is not the trade's way).
    const close = o.exec[j].c;
    const target = i.impulse && Number.isFinite(i.impulse.extreme) ? i.impulse.extreme : null;
    const risk = D * (close - stop);
    const reward = target === null ? NaN : D * (target - close);
    Object.assign(out.entry, { origin: ev.origin, target, targetR: risk > 0 && reward >= 0 ? r2(reward / risk) : null, triggerClose: o.exec[ev.j].c, context: contextOf(i, j, o) });
  }
  // B2: a base bar since the event that traded through the structural stop (a wick counts: a stop fills on a trade).
  for (let q = ev.j + 1; q <= j; q += 1) if (D > 0 ? o.exec[q].l <= stop : o.exec[q].h >= stop) { out.stopTraded = when(q); break; }
  // P1: the farthest close past the trigger's close since the trigger, the trade's way,
  // in points (causal: the closes up to this bar; 0 on the trigger's own bar). Once past the void, always past it.
  if (o.mode) {
    let run = 0;
    for (let q = ev.j + 1; q <= j; q += 1) run = Math.max(run, D * (o.exec[q].c - o.exec[ev.j].c));
    out.entry.maxRun = r2(run);
  }
}

/**
 * P1, an entry's CONTEXT (mtf-context.js): the impulse's quality on the setup frame's completed candles, as known at bar j: the frozen impulse (DEVELOPING on),
 * else the extreme so far (the row's); never a later high.
 */
function contextOf(i, j, o) {
  const MC = require('./mtf-context');
  const R = o.series;
  const row = R.rows[j];
  const pn = row.parent;
  if (!pn) return { impulse: null };
  const D = i.D;
  const ext = i.impulse && Number.isFinite(i.impulse.extreme) ? { v: i.impulse.extreme, j: i.impulse.j } : row.ext;
  let impulse = null;
  const S = R.frames.setup;
  if (ext && Number.isInteger(ext.j) && ext.j >= 0) {
    // From the last push's protected swing (the instance's, frozen at DEVELOPING; else the row's so far); none: the leg's.
    const push = i.developing ? i.push : row.push;
    const known = S.c.map((c, k) => k).filter(k => S.c[k].known <= j);
    const legFrom = known.find(k => S.c[k].first <= pn.legFrom && (k === S.c.length - 1 || S.c[k + 1].first > pn.legFrom));
    const to = known.filter(k => S.c[k].first <= ext.j).pop();
    // A push after the leg's extreme (a lower high: the extreme came earlier) is not the impulse: the leg's start then.
    const usePush = push && Number.isInteger(push.ci) && Number.isInteger(to) && push.ci <= to;
    const from = usePush ? push.ci : legFrom;
    const start = usePush ? push.level : pn.prot;
    if (Number.isInteger(from) && Number.isInteger(to) && to >= from) {
      // The displacement label: the one rule (cisd.js strongCandle, which displacement.js reads as candleDisplaced), on the
      // ATR known at the candle before, as displacement.js strengthAt reads it.
      const { strongCandle } = require('./cisd');
      impulse = MC.impulseQuality({ candles: S.c, from, to, start, extreme: ext.v, dir: D, atr: S.atr, displaced: k => strongCandle(S.c[k], k > 0 ? S.c[k - 1] : null, D, k > 0 ? S.atr[k - 1] : NaN).strong });
    }
  }
  return { impulse };
}

/** Every level over the bars (one pass each, the candles shared). */
function computeAll(o) {
  const cache = new Map();
  const prims = o.prims || defaultPrims();
  const series = o.levels.map(L => levelSeries({ exec: o.bars, base: o.minutes, level: L, equalAtr: o.equalAtr, k: o.k, prims, cache, keep: o.keep, trackEarly: Boolean(o.mode) }));
  return series;
}

function recordFrom(series, j, o, ctx) {
  const levels = o.levels.map((L, x) => levelRecord(L, series[x], j, { ...o, exec: o.bars }, ctx));
  const primary = levels.find(l => l.role === 'primary');
  const pD = primary && primary.parent ? primary.parent.way : null;
  const sides = { rule: ctx.sides ? ctx.sides.rule : null, parent: pD === 'up' ? 'long' : pD === 'down' ? 'short' : null };
  const rec = { hierarchy: o.hierarchy || null, sideMode: o.sideMode, side: sides[o.sideMode] || null, sides, levels };
  if (o.mode) {
    // P1: the entry arm the record was built under, and the level above's parent structure (the 4h: context only).
    const above = levels.find(l => l.role === 'above');
    rec.mode = { ...o.mode };
    rec.windowStart = o.bars[0].t; // the bars' first: a lower hierarchy's rank is unknown for a leg begun before it
    rec.context = above ? { frame: above.frames.parent, way: !above.partial && above.parent ? above.parent.way : null } : null;
  }
  return rec;
}

/** The side at a bar: `sideAt(j)` or the constant `side` ('long' | 'short' | null, the entry rule's: biasSides). */
const ctxAt = (o, j) => {
  const rule = o.sideAt ? o.sideAt(j) : o.side;
  const sides = { rule: rule === 'long' || rule === 'short' ? rule : null };
  return { sides, bias: o.biasAt ? o.biasAt(j) : o.bias || null };
};

/**
 * The record at the last bar (m3.mtfStructure), or null without bars. o: { bars, minutes, levels, tick, bufferTicks,
 * equalAtr, k, depth, sideMode, side (the entry rule's), bias ({ '4h': 'up'|'down'|'range', '1h': ... }: the Bias line's
 * frame reads), warmBars, hierarchy, prims }.
 */
function mtfStructure(o = {}) {
  if (!Array.isArray(o.bars) || !o.bars.length) return null;
  required(o);
  const lastJ = o.bars.length - 1;
  const series = computeAll({ ...o, keep: j => j === lastJ });
  return withSide(recordFrom(series, lastJ, o, ctxAt(o, lastJ)));
}

/** The record at every bar (tests, gates): sideAt(j) and biasAt(j) give the entry rule's side and the Bias reads at j. */
function recordsOf(o = {}) {
  if (!Array.isArray(o.bars) || !o.bars.length) return [];
  required(o);
  const series = computeAll({ ...o, keep: o.keep || (() => true) });
  return o.bars.map((_, j) => (series[0].rows[j] ? withSide(recordFrom(series, j, o, ctxAt(o, j))) : null));
}

/** The primary's withheld reason under the record's side mode (the line always prints the record's side). */
function withSide(rec) {
  const p = rec.levels.find(l => l.role === 'primary');
  if (p && p.entry) {
    const s = rec.side;
    p.entryWithheld = !s ? 'no side' : s !== p.entry.side ? 'against the side' : p.warning ? 'warning' : p.stopTraded ? 'stop traded' : null;
    // P1, entryPullback first: only the leg's first pullback; a rank not known is withheld (fails closed).
    if (!p.entryWithheld && rec.mode && rec.mode.entryPullback === 'first') {
      const rank = p.instance ? p.instance.rank : null;
      p.entryWithheld = !Number.isInteger(rank) ? 'rank unknown' : rank !== 1 ? 'not first' : null;
    }
  }
  return rec;
}

// ---------------------------------------------------------------- the lines (spec 4.2, pilot round three's grammar)

const UPW = w => w.toUpperCase();
const opp = w => (w === 'up' ? 'down' : 'up');
const lowHigh = w => (w === 'up' ? 'low' : 'high');
const highLow = w => (w === 'up' ? 'high' : 'low');
const belowAbove = w => (w === 'up' ? 'below' : 'above');
const aboveBelow = w => (w === 'up' ? 'above' : 'below');
/** The cut order (spec 4.3): cut level n leaves out the first n. Context goes first. */
const CUTS = Object.freeze(['belowShort', 'origin', 'depth', 'last', 'early', 'protected', 'parentChoch', 'notReady']);
const cutOut = (cut, name) => CUTS.indexOf(name) < cut;
const LAST_WORDS = { 'timing only': (S, T) => `a ${T}-only move, no ${S} break`, 'ended before established': () => 'ended before ESTABLISHED', completed: () => 'COMPLETED', invalidated: () => 'INVALIDATED', superseded: () => 'superseded by a new pullback', 'parent turned': (S, T, P) => `the ${P} turned` };

function headOf(lv, cut, L, mode = null) {
  const p = lv.parent;
  const { parent: P } = lv.frames;
  const w = p.way;
  const differ = !p.differs ? '' : mode ? ` (its break record; the Bias line reads the ${P} ${p.biasRead}: in this entry mode the side is the ${P} structure's)` : ` (its break record; the Bias line reads the ${P} ${p.biasRead}: the side is the Bias line's)`;
  const origin = cutOut(cut, 'origin') ? '' : ` (the origin of the last ${P} break)`;
  const status = lv.warning ? `not broken on a ${P} close; WARNING: a ${lv.warning.frame} close ${L(lv.warning.close)} ${belowAbove(w)} it at ${lv.warning.et} (the ${P} close decides)` : `holds on ${P} closes`;
  const ch = p.against && !cutOut(cut, 'parentChoch') ? ` (${P} ${p.against.kind} ${p.against.direction} at ${L(p.against.level)}: a warning, not a reversal)` : '';
  return `${P} structure ${UPW(w)}${differ}, ${P} protected ${lowHigh(w)} ${L(p.protected.level)}${origin} ${status}${ch}`;
}

/**
 * A level's pullback phrase. The below line names its own frame in it (SPEC v4, the coordinator's addition): the model
 * copied the primary's pullback word into the below line's answer when the two differ.
 */
const pbPhrase = (lv, primary) => {
  const { parent: P, setup: S } = lv.frames;
  return `${primary ? '' : `below ${P} > ${S}: `}${S} pullback against the ${P}`;
};

function bodyOf(lv, cut, L, primary, sideText, mode = null) {
  const { parent: P, setup: S, timing: T } = lv.frames;
  const PB = pbPhrase(lv, primary);
  // P1, an MTF entry arm: the primary line names no model (the candidate lines carry the ready ones and the waiting clause;
  // a "NOT ready" model here read as an offer, measured on #348).
  const E = s => (!primary ? '' : mode ? ' Entry: on the MTF candidate lines.' : ` Entry: ${s}.`);
  if (lv.partial) return `stage NONE. Not enough ${P} history.${E('none')}`;
  const i = lv.instance;
  if (lv.stage === 'INVALIDATED' && lv.invalidated) {
    const w = lv.invalidated.way;
    return `stage INVALIDATED. A ${P} close ${L(lv.invalidated.close)} ${belowAbove(w)} the ${P} protected ${lowHigh(w)} ${L(lv.invalidated.level)}: the ${P} structure, ${UPW(w)} until now, is broken. ${P} structure: none until the next ${P} break.${primary ? ' Setup cancelled.' : ''}${E('none')}`;
  }
  if (!lv.parent) return `stage NONE. ${P} structure: none (its protected swing broke; waiting for the next ${P} break). No ${S} pullback read.${E('none')}`;
  const w = lv.parent.way;
  const head = headOf(lv, cut, L, mode);
  const lastText = () => {
    const parts = [];
    if (lv.last) {
      const keepAlways = lv.last.why === 'completed' || lv.last.why === 'invalidated';
      if (keepAlways || !cutOut(cut, 'last')) parts.push(`last: ${LAST_WORDS[lv.last.why] ? LAST_WORDS[lv.last.why](S, T, P) : lv.last.why}, ${lv.last.et}`);
    }
    return parts;
  };
  const against = lv.setupAgainst ? `${S} last break: ${lv.setupAgainst.kind} ${lv.setupAgainst.direction}, against the ${P}; no CHoCH inside this structure` : null;
  const e = lv.entry;
  const why = () => {
    const r = lv.entryWithheld;
    if (r === 'no side') return mode ? `none: no side (no ${mode.sideFrame} structure)` : 'none: no side (4h and 1h not aligned)';
    if (r === 'against the side') return mode ? `none: against the ${mode.sideFrame} structure (${sideText} only)` : `none: against the side (Bias: ${sideText} only)`;
    if (r === 'not first') return `none: not first (pullback #${i.rank} of this ${P} leg): no entry under first-pullback-only`;
    if (r === 'rank unknown') return `none: the pullback's rank in its ${P} leg is unknown: no entry under first-pullback-only`;
    if (r === 'warning') return `none: a close is through the ${P} protected ${lowHigh(w)} (the ${P} close decides)`;
    if (r === 'stop traded') return `none: the ${e.model} structural stop ${L(e.stop)} traded through at ${lv.stopTraded.et}`;
    return null;
  };
  const age = s => (s.barsAgo === 0 ? 'new this bar' : `since ${s.et} (${s.barsAgo} ${s.barsAgo === 1 ? 'bar' : 'bars'})`);
  const ready = extra => why() || `${e.model} ready ${e.side.toUpperCase()} ${age(e.since)}, structural stop ${L(e.stop)} (a structure level, not an order stop)${extra}`;
  if (lv.stage === 'NONE' || !i) {
    const parts = [...lastText(), ...(against ? [against] : [])];
    return `stage NONE. ${head}. ${PB}: NONE${parts.length ? ` (${parts.join('; ')})` : ''}.${E('none')}`;
  }
  if (lv.stage === 'COMPLETED') return `stage COMPLETED. ${head}. ${PB}: NONE now (the last one, ${UPW(opp(w))}, is finished: a ${S} close ${L(i.closed.close)} ${aboveBelow(w)} the ${P} impulse ${highLow(w)} ${L(i.impulseExtreme)}; the ${P} ${w} trend continued).${E('none')}`;
  if (lv.stage === 'POTENTIAL') {
    const no = against ? `no ${S} CHoCH ${opp(w)} yet (${against})` : `no ${S} break ${opp(w)} yet`;
    // P1 (minStage potential): an early ready prints in place of `Monitor only.`, its trigger named.
    if (e && e.early) return `stage POTENTIAL. ${head}. ${PB}: NONE yet (only a ${T} CHoCH ${opp(w)} ${i.potential.et} against the ${P}; ${no}). ${T} turning back ${UPW(w)}: ${e.since.et}.${E(ready(''))}`;
    return `stage POTENTIAL. ${head}. ${PB}: NONE yet (only a ${T} CHoCH ${opp(w)} ${i.potential.et} against the ${P}; ${no}).${primary ? ' Monitor only.' : ''}${E('none')}`;
  }
  const depth = primary && i.depth !== null && !cutOut(cut, 'depth') ? `; depth ${i.depthClass} (${i.depth})` : '';
  const pb = `${PB}: ${UPW(opp(w))} (${S} CHoCH ${opp(w)} ${i.developing.et}`;
  if (lv.stage === 'DEVELOPING' && e && e.early) return `stage DEVELOPING. ${head}. ${pb}, no ${S} BOS ${opp(w)} yet: not established); pullback ${lowHigh(w)} ${L(i.extreme)}${depth}. ${T} turning back ${UPW(w)}: ${e.since.et}.${E(ready(''))}`;
  if (lv.stage === 'DEVELOPING') return `stage DEVELOPING. ${head}. ${pb}, no ${S} BOS ${opp(w)} yet: not established); pullback ${lowHigh(w)} ${L(i.extreme)}${depth}; price has not turned back ${w}.${primary ? ' Track only.' : ''}${E('none')}`;
  const prot = primary && Number.isFinite(i.protected) && !cutOut(cut, 'protected') ? `; its protected ${highLow(w)} ${L(i.protected)}` : '';
  const est = `${pb}, BOS ${opp(w)} ${i.established.et}); pullback ${lowHigh(w)} ${L(i.extreme)}${depth}${prot}`;
  const minor = primary && i.minor && !cutOut(cut, 'early') ? ` Early weakening: a ${S} close ${aboveBelow(w)} the minor ${highLow(w)} ${L(i.minor.level)}.` : '';
  if (lv.stage === 'ESTABLISHED') {
    const r = i.resets.length ? i.resets[i.resets.length - 1] : null;
    const m3 = !T ? '' : r ? ` ${T}: the turn ${w} failed (a ${T} close ${belowAbove(w)} the pullback ${lowHigh(w)} ${L(r.extreme)} at ${r.et}: reset); price has not turned back ${w}.` : ` ${T}: price has not turned back ${w} (no ${T} CHoCH or CISD ${w} yet).`;
    return `stage ESTABLISHED. ${head}. ${est}.${m3}${minor}${E('none yet')}`;
  }
  if (lv.stage === 'WEAKENING') {
    const x = i.weakening;
    const notReady = cutOut(cut, 'notReady') ? '' : `; balanced NOT ready (needs a ${T} BOS ${w})`;
    return `stage WEAKENING. ${head}. ${est}. ${T} turning back ${UPW(w)} with the ${P}: ${x.by} ${w} ${x.et}.${minor}${E(e ? ready(notReady) : 'none')}`;
  }
  if (lv.stage === 'REVERSING') {
    const x = i.weakening;
    const r = i.reversing;
    const aggr = e && e.also ? ` (aggressive structural stop ${L(e.also.stop)})` : '';
    return `stage REVERSING. ${head}. ${est}. ${T} turned back ${UPW(w)} with the ${P}: ${x ? `${x.by} ${w} ${x.et}, then ` : ''}BOS ${w} ${r.et}.${minor}${E(e ? ready(aggr) : 'none')}`;
  }
  if (lv.stage === 'CONFIRMED REVERSAL') {
    const c = i.confirmed;
    const k = i.conservative;
    let entry = '';
    if (primary) {
      if (e) entry = E(ready(` (the ${S} CHoCH origin ${L(e.also.level)}); ${T} BOS ${w} ${k.bos.et} after a ${T} CHoCH ${opp(w)}`));
      else {
        const sideNo = lv.entryWithheld ? why() : null;
        const notYet = k ? `none yet: conservative NOT ready (${T} CHoCH ${opp(w)} ${k.pullbackAt.et} seen; needs a ${T} BOS ${w})` : `none yet: conservative NOT ready (needs a ${T} CHoCH ${opp(w)}, then a ${T} BOS ${w})`;
        entry = E(sideNo || notYet);
      }
    }
    return `stage CONFIRMED REVERSAL. ${head}. ${PB}: ${UPW(opp(w))}, now over on the ${S}: a ${S} close ${L(c.close)} ${aboveBelow(w)} its protected ${highLow(w)} ${L(c.level)} at ${c.et}; price back ${UPW(w)} with the ${P}${primary ? `; the ${P} impulse ${highLow(w)} ${L(i.impulseExtreme)} not yet broken` : ''}.${entry}`;
  }
  return `stage ${lv.stage}. ${head}.${E('none')}`;
}

/** The short below line (cut 1): `stage <WORD>. 15m structure <WAY>; below 15m > 3m: 3m pullback against the 15m: <WAY|NONE>.` */
function belowShort(lv) {
  const { parent: P } = lv.frames;
  if (lv.partial) return `stage NONE. Not enough ${P} history.`;
  const way = lv.stage === 'INVALIDATED' ? 'none' : lv.parent ? UPW(lv.parent.way) : 'none';
  const pb = ['DEVELOPING', 'ESTABLISHED', 'WEAKENING', 'REVERSING'].includes(lv.stage) && lv.parent ? UPW(opp(lv.parent.way)) : 'none';
  const last = lv.stage === 'NONE' && lv.last && (lv.last.why === 'completed' || lv.last.why === 'invalidated') ? ` (last: ${LAST_WORDS[lv.last.why]()}, ${lv.last.et})` : '';
  return `stage ${lv.stage}. ${P} structure ${way}; ${pbPhrase(lv, false)}: ${pb === 'none' ? 'NONE' : pb}${last}.`;
}

/**
 * The level above against the primary, for scorers only (SPEC v4: no `Above:` clause is printed; the model reads the 4h
 * from the Bias line). The 1h is pulling back against the 4h exactly when the primary's 1h structure (its break record,
 * the clean CHoCH rule) runs against the 4h structure; the level above's own instance stays in the record.
 */
function aboveRelation(lv, primary) {
  if (!lv || lv.partial || !lv.parent) return null;
  const pw = primary && !primary.partial && primary.stage !== 'INVALIDATED' && primary.parent ? primary.parent.way : null;
  return { way: lv.parent.way, setupWay: pw, pullback: pw && pw !== lv.parent.way ? pw : null };
}
/**
 * The two summary lines (spec 4.2; v4: no `Above:` clause): the primary with its entry clause, then `below:`. Over the
 * budget (the primary over primaryBytes, or both over lineBytes) the parts are cut in CUTS order. Never cut: a line, a
 * stage word, a structure's way, the pullback's way; on the primary also its protected swing, the Bias disagreement, the
 * WARNING, a ready entry with its age and stop, the reason after `Entry: none:` and `(last: COMPLETED|INVALIDATED ...)`.
 * The first cut (`belowShort`) shortens the below line to its stage, its 15m structure's way and its named pullback
 * phrase (and a COMPLETED or INVALIDATED last): the below line's protected swing and WARNING go with it (the review's m4;
 * on tune and the hold-out no bar reaches a cut at the configured budgets).
 * A record `{ unavailable: reason }` (the briefing without the strategy's stop rule) prints one line saying so.
 */
function mtfLines(rec, { lineBytes = Infinity, primaryBytes = Infinity, level = x => x, cut: atCut = null } = {}) {
  if (isObj(rec) && typeof rec.unavailable === 'string') return [`- MTF structure: unavailable (${rec.unavailable}).`];
  if (!isObj(rec) || !Array.isArray(rec.levels)) return [];
  const L = x => level(x);
  const primary = rec.levels.find(l => l.role === 'primary');
  const below = rec.levels.find(l => l.role === 'below');
  if (!primary || !below) return [];
  const sideText = rec.side || 'no';
  const sp = n => n.replace('>', ' > ');
  // P1: an MTF entry arm's record (rec.mode) adds its clauses to the primary line; without one, today's lines exactly.
  const mode = isObj(rec.mode) ? { ...rec.mode, sideFrame: rec.sideFrame || primary.frames.parent } : null;
  // P1: the below line is an early read in an MTF entry arm (37.7% false ESTABLISHED on the hold-out): labelled so.
  const early = mode ? ` (early read; ${below.frames.setup}, noisy: the ${below.frames.parent} line decides the pullback, the ${below.frames.setup} only times it)` : '';
  const build = cut => {
    const one = `- MTF structure ${sp(primary.name)} (primary): ${bodyOf(primary, cut, L, true, sideText, mode)}`;
    const two = `- MTF structure below${early}: ${sp(below.name)} (context): ${cutOut(cut, 'belowShort') ? belowShort(below) : bodyOf(below, cut, L, false, sideText)}`;
    return [one, two];
  };
  if (Number.isInteger(atCut)) return build(atCut); // one cut level (tests: the order, step by step)
  for (let cut = 0; cut <= CUTS.length; cut += 1) {
    const ls = build(cut);
    const a = Buffer.byteLength(ls[0]);
    if ((a <= primaryBytes && a + Buffer.byteLength(ls[1]) <= lineBytes) || cut === CUTS.length) return ls;
  }
  return [];
}

module.exports = { withSide, aboveRelation, WEAKENING_EVENTS, STAGES, CUTS, SIDE_MODES, GATED, configProblem, defaultPrims, levelsOf, candlesOf, protectedAt, parentSeries, levelSeries, mtfStructure, recordsOf, mtfLines };
