'use strict';

/**
 * The flat cycle's Pullback read: when price has moved against the prevailing side on the structure frame (15m), the
 * pieces the pullback-vs-reversal skill weighs, computed by code from closed bars so the model reads them instead of
 * judging the chart by eye. Facts only: no verdict (the owner: no single readable fact separates a pullback from a
 * reversal; confirmation at a level decides), nothing in the gate, compose_check, order_plan or the trend rule reads it.
 * Pure: the bars in, the facts out; only bars closed by the last one are read (no look-ahead).
 *
 * The leg's impulse is the Trade read's own definition (impulseOf, one home: trade-read.js measures an open trade's
 * last impulse with it), so once a trade opens on the same leg both reads give the same origin, extreme and depth:
 *
 *   impulseOf({ cs, hc, s, iBest, fromMs, search })   the impulse to the best base candle cs[iBest] (s: +1 long, -1
 *                    short): from the extreme against between the last confirmed structure-frame swing against before
 *                    the best (searched only when `search`) and the best, else from `fromMs`, to the best; `depth` the
 *                    share of it the last close gave back. { o, back, origin, best, depth }
 *
 *   pullbackRead({ bars, base, prevailing })   null when absent: no prevailing trend ('4h up', the trend rule's), no
 *                    structure-frame break its way in the bars, or no counter-move (fewer than swingK completed
 *                    structure-frame candles since the extreme's: price is with the trend). Else:
 *     side, frame, prevailing
 *     leg            { origin, extreme, at, atr }: the best base price since the open of the structure frame's last break
 *                    the prevailing way (the first base candle at it), its origin by impulseOf, its size in base ATR(14)
 *                    (the line shows no depth under pullbackRead.minLegAtr, nor past the origin)
 *     depth, close   the share of the leg the last close gave back (past 1: beyond the origin)
 *     swing          per frame (15m, 1h) the leg's swing against (15m: impulseOf's; 1h: the last confirmed 1h swing
 *                    against before the extreme) and whether it `holds`: no base close beyond it after both its candle
 *                    closed and the extreme (the pullback's closes; m3.htfLevels brokenAt counts every close since the
 *                    swing formed, so a leg's own close can break it there and not here: the line names its rule)
 *     counter        { bars, volRatio, volume, rangeRatio }: the base candles since the extreme, their mean volume and
 *                    range per bar against the leg's (origin to extreme), only when every bar of both is in one session
 *                    part (RTH or not: the open's volume never compared with the night's); volume 'falling' (< 1),
 *                    'rising' (> 1) or 'even', a plain comparison; null when not computable (the line then says nothing)
 *     against        per frame (15m, 1h) its last structure break (structure-events.js lastBreaks) when it is against
 *                    the leg: { kind, direction, level, barsAgo }, else null
 *     stacked        both frames' last breaks against the leg
 *   pullbackLine(p, { level })   the summary's one line (null when absent)
 */

const { pivots, breaksOf, lastBreaks } = require('./structure-events');
const { completedCandlesAt } = require('./candle-facts');
const { label, RULE_FRAMES } = require('./mtf');
const ind = require('./indicators');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN, MARKET_TZ, minutesOfDay } = require('./clock');

const AN = require('../tunables').analysis(); // config/analysis.json: the swing confirmation, the read's structure frame
const K = AN.indicators.swingK;
const FRAME = Math.max(...AN.tradeRead.frames); // the structure frame (the Trade read's)
// The frame above it: the trend rule's next frame up (config/analysis.json mtf.ruleFrames: the 1h above the 15m).
const HOUR = Math.min(...RULE_FRAMES.filter(m => m > FRAME));

// The smallest leg a depth is measured against, in base ATR(14) (config/analysis.json pullbackRead.minLegAtr): a floor
// against measuring a pullback on a leg of a few ticks, not a tuned value.
const MIN_LEG_ATR = AN.pullbackRead.minLegAtr;
const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const lastOf = xs => { for (let i = xs.length - 1; i >= 0; i -= 1) if (Number.isFinite(xs[i])) return xs[i]; return null; };
const opp = d => (d === 'up' ? 'down' : 'up');
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

/** The completed `minutes` candles as of the last bar ([] when unavailable). */
function candlesOf(bars, base, minutes) {
  const c = completedCandlesAt({ bars, base, minutes });
  return c.unavailable ? [] : c.candles.slice(0, c.j + 1);
}

function impulseOf({ cs, hc, s, iBest, fromMs, search = true }) {
  const hi = c => (s > 0 ? c.h : -c.l); // the leg's way's extreme, as a number that grows the leg's way
  const lo = c => (s > 0 ? c.l : -c.h);
  const now = cs[cs.length - 1].c;
  const tBest = Date.parse(cs[iBest].t);
  const back = search ? [...pivots(hc, K)].reverse().find(p => p.type === (s > 0 ? 'low' : 'high') && Date.parse(hc[p.i].t) < tBest) || null : null;
  const from = back ? Date.parse(hc[back.i].t) : fromMs;
  let o = iBest;
  for (let i = 0; i <= iBest; i += 1) if (Date.parse(cs[i].t) >= from && lo(cs[i]) < lo(cs[o])) o = i;
  const span = hi(cs[iBest]) - lo(cs[o]);
  const raw = span > 0 ? (hi(cs[iBest]) - s * now) / span : null;
  return { o, back, origin: s * lo(cs[o]), best: s * hi(cs[iBest]), depth: r2(raw), raw };
}

/**
 * The swing `p` on `minutes` candles: { price, holds }, holds while no base close beyond it came after both its candle's
 * close and the leg's extreme (`afterMs`): the pullback broke it, never the leg's own bars before the extreme. Or null.
 */
function swingOf(p, minutes, base, s, afterMs) {
  if (!p) return null;
  const end = Date.parse(p.t) + minutes * 60000;
  return { price: p.price, holds: !base.some(c => Date.parse(c.t) >= end && Date.parse(c.t) > afterMs && (s > 0 ? c.c < p.price : c.c > p.price)) };
}

/** The last break on candles cs when it is against `way`: { kind, direction, level, barsAgo }, else null. */
function againstOf(cs, way) {
  const b = lastBreaks(cs, K).last;
  return b && b.direction === opp(way) ? { kind: b.kind, direction: b.direction, level: b.level, barsAgo: b.barsAgo } : null;
}

const rth = c => { const m = minutesOfDay(new Date(c.t), MARKET_TZ); return m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN; };
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The counter-move's bars against the leg's: { bars, volRatio, volume, rangeRatio } (ratios null when not comparable). */
function counterOf(cs, o, iBest) {
  const leg = cs.slice(o, iBest + 1);
  const ctr = cs.slice(iBest + 1);
  // Comparable only when every bar of both is in one session part (RTH or not): the open's bars never against the night's.
  const one = [...leg, ...ctr].every(c => rth(c) === rth(cs[cs.length - 1]));
  const ratio = f => {
    if (!one || !leg.length || !ctr.length || ![...leg, ...ctr].every(c => Number.isFinite(f(c)))) return null;
    const l = mean(leg.map(f));
    return l > 0 ? r2(mean(ctr.map(f)) / l) : null;
  };
  const volRatio = ratio(c => c.v);
  const volume = volRatio === null ? null : volRatio < 1 ? 'falling' : volRatio > 1 ? 'rising' : 'even';
  return { bars: cs.length - 1 - iBest, volRatio, volume, rangeRatio: ratio(c => c.h - c.l) };
}

function pullbackRead({ bars, base, prevailing } = {}) {
  const m = /^(\S+) (up|down)$/.exec(String(prevailing || ''));
  if (!m) return null;
  const way = m[2];
  const s = way === 'up' ? 1 : -1;
  const list = (Array.isArray(bars) ? bars : []).filter(b => b && Number.isFinite(Date.parse(b.t)) && [b.o, b.h, b.l, b.c].every(Number.isFinite));
  if (!list.length) return null;
  const cs = candlesOf(list, base, base);
  const hc = FRAME > base ? candlesOf(list, base, FRAME) : cs;
  if (!cs.length || !hc.length) return null;
  const brk = [...breaksOf(hc, K)].reverse().find(x => x.direction === way);
  if (!brk) return null;
  const fromMs = Date.parse(hc[brk.i].t);
  const hi = c => (s > 0 ? c.h : -c.l);
  let iBest = -1;
  for (let i = 0; i < cs.length; i += 1) if (Date.parse(cs[i].t) >= fromMs && (iBest < 0 || hi(cs[i]) > hi(cs[iBest]))) iBest = i;
  if (iBest < 0) return null;
  // A counter-move: the extreme's structure-frame candle completed and swingK completed candles since it (its swing
  // confirmed); else price is with the trend (or the extreme is in the candle forming): absent.
  const tBest = Date.parse(cs[iBest].t);
  const jBest = hc.findIndex(c => Date.parse(c.t) <= tBest && tBest < Date.parse(c.closedAt));
  if (jBest < 0 || hc.length - 1 - jBest < K) return null;
  const imp = impulseOf({ cs, hc, s, iBest, fromMs, search: true });
  const h1 = candlesOf(list, base, HOUR);
  const h1Swing = [...pivots(h1, K)].reverse().find(p => p.type === (s > 0 ? 'low' : 'high') && Date.parse(p.t) < tBest) || null;
  const tfH = label(FRAME);
  const against = { [tfH]: againstOf(hc, way), [label(HOUR)]: h1.length ? againstOf(h1, way) : null };
  const atr = lastOf(ind.atr(cs, ind.ATR_PERIOD));
  return {
    side: s > 0 ? 'long' : 'short', frame: tfH, prevailing: `${m[1]} ${way}`,
    leg: { origin: imp.origin, extreme: imp.best, at: cs[iBest].t, atr: atr > 0 ? r2((s * (imp.best - imp.origin)) / atr) : null },
    // pastOrigin from the unrounded depth: 0.996 is a depth (shown 100%), never given back.
    depth: imp.depth, pastOrigin: imp.raw !== null && imp.raw >= 1, close: cs[cs.length - 1].c,
    swing: { [tfH]: imp.back ? swingOf(imp.back, FRAME, cs, s, tBest) : null, [label(HOUR)]: swingOf(h1Swing, HOUR, cs, s, tBest) },
    counter: counterOf(cs, imp.o, iBest),
    against, stacked: Object.values(against).every(Boolean),
  };
}

// The line says only what no other summary line does (the owner: no redundant bytes): the price, the clock and the
// prevailing side are on their own lines, and that it is a read to weigh is said once, in the skills.
function pullbackLine(p, { level = x => x } = {}) {
  if (!p || typeof p !== 'object' || !isObj(p.leg) || !Number.isFinite(p.leg.origin) || !Number.isFinite(p.leg.extreme)) return null;
  const c = isObj(p.counter) ? p.counter : {};
  const fin = Number.isFinite;
  // No depth number on a leg too small to measure one against, nor once the leg is given back past its origin (the
  // skill's Depth row: past the impulse origin; an older record without pastOrigin: its depth); never another leg.
  const small = fin(p.leg.atr) && p.leg.atr < MIN_LEG_ATR;
  const given = typeof p.pastOrigin === 'boolean' ? p.pastOrigin : fin(p.depth) && p.depth >= 1;
  const depth = small ? `leg ${p.leg.atr}x ATR(14), under the ${MIN_LEG_ATR}x floor: no depth`
    : given ? 'the leg given back past its origin' : fin(p.depth) ? `depth ${Math.round(p.depth * 100)}% of the leg` : 'depth unknown';
  // Volume and range only when comparable, and not on a leg given back (its window is stale): no words then (the skill
  // says what a missing phrase means).
  const ratios = given ? [] : [fin(c.volRatio) && c.volume ? `volume ${c.volRatio}x the leg's per bar (${c.volume})` : null, fin(c.rangeRatio) ? `range ${c.rangeRatio}x` : null].filter(Boolean);
  const bars = [Number.isInteger(c.bars) ? `${c.bars} bars since the extreme` : null, ...ratios].filter(Boolean).join(', ');
  // The swings' rule named once: closes since the extreme (htfLevels' brokenAt counts since the swing formed).
  const sw = Object.entries(isObj(p.swing) ? p.swing : {}).map(([tf, x]) => (!isObj(x) ? `${tf} unknown` : fin(x.price) && typeof x.holds === 'boolean' ? `${tf} ${level(x.price)} ${x.holds ? 'holds' : 'broken by a close'}` : null)).filter(Boolean);
  const swings = sw.length ? `swings since the extreme: ${sw.join(', ')}` : '';
  const brk = Object.entries(isObj(p.against) ? p.against : {}).map(([tf, x], i) => `${i ? `${tf}` : `${tf} break against`}: ${isObj(x) && x.kind ? `${x.kind} ${x.direction} ${level(x.level)} (${x.barsAgo} bars ago)` : 'none'}`).join(', ');
  const parts = [depth, bars, swings, brk && `${brk}${p.stacked === true ? '; stacked' : ''}`].filter(Boolean);
  return `- Pullback (${p.frame}, ${p.side} leg ${level(p.leg.origin)} -> ${level(p.leg.extreme)}): ${parts.join('; ')}.`;
}

/**
 * The Pullback line's few words (pullbackLine's own depth rule): `depth 40%`, `leg given back`, `small leg` or `depth
 * unknown`, `, breaks against stacked` when both frames' last breaks are against the leg; `none` when the briefing's
 * read found no pullback (null); null when it wasn't computed (undefined). A record of what the line said (state-read.js
 * stateFacts; the trade feedback), never read by a decision.
 */
function pullbackWord(p) {
  if (p === null) return 'none';
  if (!p || typeof p !== 'object' || !isObj(p.leg)) return null;
  const fin = Number.isFinite;
  const given = typeof p.pastOrigin === 'boolean' ? p.pastOrigin : fin(p.depth) && p.depth >= 1;
  const word = fin(p.leg.atr) && p.leg.atr < MIN_LEG_ATR ? 'small leg' : given ? 'leg given back' : fin(p.depth) ? `depth ${Math.round(p.depth * 100)}%` : 'depth unknown';
  return `${word}${p.stacked === true ? ', breaks against stacked' : ''}`;
}

module.exports = { impulseOf, swingOf, pullbackRead, pullbackLine, pullbackWord };
