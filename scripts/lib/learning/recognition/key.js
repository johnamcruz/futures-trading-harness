'use strict';

/**
 * The recognition test's present key (docs/TRAINING.md, "The recognition test"): the facts of ONE candle's briefing
 * (the harness's own buildBriefing at that bar close, built from bars closed by it: trace.js), the chop-class signals per
 * side, and two class words defined on them. Read-only measurement, pure: it reads a briefing object and returns data;
 * nothing that decides reads it.
 *
 * The signals (the chop-class ids, per side; all present facts of the candle's bar). c = chop ids, t = trend ids:
 *   C1 / T1  the day so far reads rotational / directional the side's way          (field day-so-far)
 *   C2 / T2  the 15m trend ranges / runs the side's way; C9 the 15m against           (field 15m)
 *   C3 / T3  the 3m regime ranges / trends the side's way; C9 trends against (once)  (field regime)
 *   C4       the Bias line names no side (neutral or no side) and not this side     (field bias)
 *   C7 / T6  session VWAP crosses at or above crossesChop / at or below crossesTrendMax with price on the side's side
 *                                                                                   (field vwap)
 *   C8 / T7  inside the initial balance and opened inside the prior value area / the IB day type trends the side's way
 *                                                                                   (field day-type)
 *   T5       the day's trend is declared for the side (entry-rule.js declaredOf)     (field declared)
 * classOf: A no signal; C trend only; B chop outnumbers trend; D both, trend at least chop.
 *
 *   evidenceWord(key)  the class the VISIBLE evidence supports (the reference for guess and lag): with exactly one side the
 *                      trend rule allows (bias-line.js biasSides), its class C -> trend-<way>, B -> chop, A or D -> unclear;
 *                      no such side: the side-free signals (C1 C2 C3 C4 C7 C8) class B -> chop, else unclear
 *   codedWord(key)     the briefing's labels restated (never the model's): the day so far rotational -> chop; 4h and 1h
 *                      agree up or down -> trend-<way>; the 15m and the 3m regime both range -> chop; else unclear
 *
 *   facts(briefing), signals(facts, side, thresholds), classOf({ c, t }), presentKey(briefing, thresholds),
 *   evidenceWord(key), codedWord(key), metFields(key, side)
 */

const { biasLine, biasSides } = require('../../trading/bias-line');
const { declaredOf } = require('../../trading/entry-rule');

const SIDES = ['long', 'short'];
const WAY = { long: 'up', short: 'down' };
const OPP = { up: 'down', down: 'up' };
const SIDE_FREE = ['C1', 'C2', 'C3', 'C4', 'C7', 'C8'];
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const at = (o, ...ks) => ks.reduce((x, k) => (isObj(x) ? x[k] : undefined), o);
const data = (b, s) => at(b, 'sections', s, 'data') || null;
const orNull = v => (v === undefined ? null : v);

/** The day so far as the briefing shows it (m3 today.soFar): { word: directional | rotational | mixed | too early | unknown, dir }. */
function dayOf(m3) {
  const d = at(m3, 'today', 'soFar');
  if (!isObj(d)) return { word: 'unknown', dir: null };
  if (d.status === 'read' && typeof d.read === 'string') return { word: d.read, dir: orNull(d.direction) };
  return { word: d.status === 'too early' ? 'too early' : 'unknown', dir: null };
}

function facts(b) {
  const m3 = data(b, 'm3') || {};
  const h1 = data(b, 'h1') || {};
  const m15 = data(b, 'm15') || {};
  let bias = null;
  let sides = { long: false, short: false };
  try { bias = biasLine(b); sides = biasSides(b); } catch (_err) { /* a briefing the entry rule can't read: no side */ }
  return {
    frames: { '4h': orNull(at(h1, 'h4', 'trend')), '1h': orNull(at(h1, 'h1', 'trend')), '15m': orNull(at(m15, 'frame', 'trend')) },
    regime: orNull(at(m3, 'regime', 'primary')), sessionCrosses: orNull(at(m3, 'vwap', 'sessionCrossesLast30')), vwapSide: orNull(at(m3, 'vwap', 'side')),
    dayType: orNull(at(m3, 'today', 'dayType')), openVs: orNull(at(m3, 'today', 'openVs')), windowEntries: orNull(m3.windowEntries),
    bias, biasSides: sides, declared: Object.fromEntries(SIDES.map(s => [s, (() => { try { return declaredOf(b, s); } catch (_err) { return null; } })()])),
    day: dayOf(m3),
  };
}

function signals(f, side, th) {
  const dir = WAY[side];
  const other = OPP[dir];
  const c = [];
  const t = [];
  const met = [];
  const add = (list, id, field) => { list.push(id); met.push({ id, field }); };
  if (f.day.word === 'rotational') add(c, 'C1', 'day-so-far'); else if (f.day.word === 'directional' && f.day.dir === dir) add(t, 'T1', 'day-so-far');
  const f15 = f.frames['15m'];
  if (f15 === 'range') add(c, 'C2', '15m'); else if (f15 === dir) add(t, 'T2', '15m'); else if (f15 === other) add(c, 'C9', '15m');
  const rg = f.regime;
  if (rg === 'range') add(c, 'C3', 'regime'); else if (rg === `trend-${dir}`) add(t, 'T3', 'regime'); else if (rg === `trend-${other}` && !c.includes('C9')) add(c, 'C9', 'regime');
  if (/^Bias: (neutral|no side)/.test(f.bias || '') && !String(f.bias).includes(`→ ${side} only`)) add(c, 'C4', 'bias');
  const x = f.sessionCrosses;
  if (Number.isFinite(x)) {
    if (x >= th.crossesChop) add(c, 'C7', 'vwap');
    else if (x <= th.crossesTrendMax && f.vwapSide === (side === 'long' ? 'above' : 'below')) add(t, 'T6', 'vwap');
  }
  if (f.dayType === 'inside the initial balance' && f.openVs === 'inside the prior value area') add(c, 'C8', 'day-type');
  else if (f.dayType === `trend ${dir}`) add(t, 'T7', 'day-type');
  if (f.declared[side] === true) add(t, 'T5', 'declared');
  return { c, t, met };
}

const classOf = ({ c, t }) => (!c.length && !t.length ? 'A' : !c.length ? 'C' : c.length > t.length ? 'B' : 'D');

function presentKey(b, th) {
  const f = facts(b);
  const allowed = SIDES.filter(s => f.biasSides[s]);
  const sig = Object.fromEntries(SIDES.map(s => [s, signals(f, s, th)]));
  // Side-free: only the signals that depend on no side (a read naming no side is compared with these).
  const seen = new Set();
  const met = [...sig.long.met, ...sig.short.met].filter(m => SIDE_FREE.includes(m.id) && !seen.has(m.id) && seen.add(m.id));
  const none = { c: met.map(m => m.id), t: [], met };
  return { facts: f, biasSide: allowed.length === 1 ? allowed[0] : null, signals: { ...sig, none }, cls: { long: classOf(sig.long), short: classOf(sig.short), none: classOf(none) } };
}

const WORD_OF = { long: 'trend-up', short: 'trend-down' };
function evidenceWord(key) {
  const s = key.biasSide;
  const c = s ? key.cls[s] : key.cls.none;
  if (s) return c === 'C' ? WORD_OF[s] : c === 'B' ? 'chop' : 'unclear';
  return c === 'B' ? 'chop' : 'unclear';
}

function codedWord(key) {
  const fr = key.facts.frames;
  if (key.facts.day.word === 'rotational') return 'chop';
  if (fr['4h'] === fr['1h'] && (fr['4h'] === 'up' || fr['4h'] === 'down')) return fr['4h'] === 'up' ? 'trend-up' : 'trend-down';
  if (fr['15m'] === 'range' && key.facts.regime === 'range') return 'chop';
  return 'unclear';
}

const metFields = (key, side) => [...new Set(key.signals[side || 'none'].met.map(m => m.field))];

module.exports = { facts, signals, classOf, presentKey, evidenceWord, codedWord, metFields };
