'use strict';

/**
 * The open trade's read facts (the pullback-vs-reversal skill's three-way read for an OPEN trade: a healthy pullback,
 * the trend weakening, a reversal), computed by code from closed bars and measured from the trade's own entry, so a
 * managed cycle reads them instead of judging the chart by eye. Pure: the bars and the trade in, the facts out; only
 * bars closed by the last one are read (no look-ahead), so the post-hoc exit scorecard (replay/exit-scorecard.js)
 * computes the same facts at a past decision by passing the bars up to it.
 *
 * The trade's structure is read on the structure frame (the highest of config/analysis.json tradeRead.frames, 15m: the
 * frame the runner's own structure trail stands behind), never on the base bars' 3m swings, which turn every few bars
 * inside a trend. Every definition is an existing one (one home each), on completed candles (candle-facts.js
 * completedCandlesAt, the briefing's candle rule):
 *
 *   extreme       the best price since entry (a long's highest high on the base candles opened at or after the fill)
 *   pushes        the trade's way's confirmed swings on the structure frame since entry (structure-events.js pivots,
 *                 swingK): each push's swing price, its size from the lowest low (a short: highest high) since the push
 *                 before (or the first candle since entry) in the frame's ATR(14) now, and its momentum candles (momentum.js
 *                 momentumRead the trade's way)
 *   failed        the last push's swing failed to exceed the one before (a long's lower high, a short's higher low): two
 *                 pushes since entry needed, else null
 *   fading        two or more pushes and the last smaller than the one before with no more momentum candles
 *   pullback      the last impulse: from the extreme against between the last confirmed structure-frame swing against
 *                 before the best and the best, to the best; `depth` the share of it the last close gave back
 *   vwap, ema20   the last close against the RTH VWAP (null outside 09:30-16:00 ET) and the base EMA20, side-signed in
 *                 base ATR(14): + is the trade's way
 *   against       per timeframe (base, structure frame), the latest structure break (structure-events.js breaksOf) when
 *                 it is against the trade, happened since entry, and stands (no break the trade's way after it)
 *   displacement  the latest structure-frame displacement candle against the trade since entry (candle-facts.js
 *                 patternsOf), when it closed through the last confirmed structure-frame swing against before it and no
 *                 break the trade's way (base or structure frame) came after it; else null
 *   compression   per timeframe (base, structure frame) compression.js against the trade: expanding against it, or a
 *                 box whose pole is against it; null otherwise
 *   bias          the higher-timeframe bias (entry-rule.js BIAS_FRAMES order: the first of 4h, 1h that trends) at entry
 *                 (the bars closed by the fill) and now; `flipAgainst`: now against the trade, at entry not
 *   signs         the weakening signs that hold, each one independent sign (the count decides: weakening needs
 *                 tradeRead.minSigns of them, one per kind of evidence): 'failed extreme', 'pushes fading', 'deep
 *                 retrace' (one sign however it shows: depth past tradeRead.deepPullback, or the close against the EMA20
 *                 and the RTH VWAP, or the EMA20 with no RTH VWAP), 'compression against', 'HTF flip' (a flip alone is
 *                 one sign)
 *   reversal      what confirms one, by structure only: the structure frame's break against (`against`), or its
 *                 displacement through the last swing (`displacement`); null otherwise
 *   trail         the level the runner's own structure trail stands behind (exit-trail.js swingSeries on the trade's
 *                 exit plan's swing timeframe, `exit.swingMinutes`, as the runner reads it; null with a trail by R or no
 *                 plan given, `trailBy` 'r' or 'none'): the last confirmed swing low (a short: high) and the stop just beyond it (a tick, snapped as the
 *                 runner snaps it, when the tick is known): the tightest a tighten may go, never tighter
 *
 *   tradeRead({ side, entry, openedAt, bars, base, tick, exit })   the facts above, or { unavailable } with why
 *   tradeReadLine(read, { level })                     one line for the managed cycle's prompt (level: a price as shown)
 *   SIGNS                                              the weakening signs' names, in order
 */

const ind = require('./indicators');
const { pivots, breaksOf } = require('./structure-events');
const { completedCandlesAt, factsOf } = require('./candle-facts');
const { momentumRead } = require('./momentum');
const { compressionFrames } = require('./compression');
const { mtfRead, label } = require('./mtf');
const { BIAS_FRAMES } = require('./entry-rule');
const { swingSeries } = require('./exit-trail');
const { snapStop } = require('./trail');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('./clock');

const AN = require('../tunables').analysis(); // config/analysis.json: the swing confirmation, the EMA, the read's settings
const K = AN.indicators.swingK;
const EMA = AN.snapshot.emaSlow;
const TR = AN.tradeRead; // frames, deepPullback, minSigns
const FRAME = Math.max(...TR.frames); // the structure frame
const SIGNS = Object.freeze(['failed extreme', 'pushes fading', 'deep retrace', 'compression against', 'HTF flip']);
/** A frame label's minutes ('15m' 15, '4h' 240). */
const minutesOf = tf => { const m = /^(\d+)([mh])$/.exec(tf); return m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : NaN; };

const r2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const lastOf = xs => { for (let i = xs.length - 1; i >= 0; i -= 1) if (Number.isFinite(xs[i])) return xs[i]; return null; };
const opp = d => (d === 'up' ? 'down' : 'up');

/** The completed `minutes` candles as of the last bar ([] when unavailable). */
function candlesOf(bars, base, minutes) {
  const c = completedCandlesAt({ bars, base, minutes });
  return c.unavailable ? [] : c.candles.slice(0, c.j + 1);
}

/** The higher-timeframe bias of the bars: { frame, dir } of the first of BIAS_FRAMES that trends, else { dir: 'none' }. */
function biasOf(bars) {
  let read;
  try { read = mtfRead(bars, { timeframes: BIAS_FRAMES.map(minutesOf) }); } catch (_err) { return null; }
  for (const f of BIAS_FRAMES) {
    const fr = read.frames.find(x => x.minutes === minutesOf(f));
    const t = fr && fr.read ? fr.read.trend : null;
    if (t === 'up' || t === 'down') return { frame: f, dir: t };
  }
  return { frame: null, dir: 'none' };
}

/** The latest break against `way`, since index `sinceIdx`, standing (the last break of all), on candles cs. */
function againstOf(cs, way, sinceIdx) {
  const all = breaksOf(cs, K);
  const last = all[all.length - 1];
  if (!last || last.direction === way || last.i < sinceIdx) return null;
  return { kind: last.kind, direction: last.direction, level: last.level, at: last.at, barsAgo: cs.length - 1 - last.i };
}

/**
 * The latest displacement candle against `way` since index `from` on cs that closed through the last confirmed swing
 * against before it, unless a break the trade's way came after it (`undone(atMs)`): the fact is spent then.
 */
function displacementOf(cs, way, from, tf, undone) {
  if (!cs.length) return null;
  const facts = factsOf(cs);
  const sw = pivots(cs, K);
  for (let j = cs.length - 1; j >= Math.max(from, 1); j -= 1) {
    const c = cs[j];
    const dir = c.c > c.o ? 'up' : c.c < c.o ? 'down' : null;
    if (dir !== opp(way) || !facts[j].patterns.includes('displacement')) continue;
    const swing = [...sw].reverse().find(p => p.type === (way === 'up' ? 'low' : 'high') && p.confirmedAt <= j);
    if (!swing || !(way === 'up' ? c.c < swing.price : c.c > swing.price) || undone(Date.parse(c.t))) return null;
    return { tf, at: c.t, barsAgo: cs.length - 1 - j, swing: swing.price };
  }
  return null;
}

/** The pushes the trade's way on candles cs since index `from` (see the header), oldest first. */
function pushesOf(cs, s, from, way) {
  if (from < 0) return [];
  const hi = c => (s > 0 ? c.h : -c.l);
  const lo = c => (s > 0 ? c.l : -c.h);
  const atr = lastOf(ind.atr(cs, ind.ATR_PERIOD));
  const facts = factsOf(cs);
  const out = [];
  let start = from;
  for (const p of pivots(cs, K).filter(x => x.type === (s > 0 ? 'high' : 'low') && x.i >= from)) {
    let o = start;
    for (let i = start; i <= p.i; i += 1) if (lo(cs[i]) < lo(cs[o])) o = i;
    let mom = 0;
    for (let i = o; i <= p.i; i += 1) {
      const f = facts[i];
      if (momentumRead({ rangeAtr: r2(f.rangeAtr), closeLocation: f.closeLocation, volRatio: r2(f.volRatio) }) === way) mom += 1;
    }
    out.push({ at: cs[p.i].t, swing: p.price, sizeAtr: atr > 0 ? r2((hi(cs[p.i]) - lo(cs[o])) / atr) : null, momentum: mom });
    start = p.i;
  }
  return out;
}

function tradeRead({ side, entry, openedAt, bars, base, tick = null, exit = null }) {
  const s = side === 'long' ? 1 : side === 'short' ? -1 : 0;
  const opened = Date.parse(openedAt);
  if (!s || !Number.isFinite(entry) || !Number.isFinite(opened)) return { unavailable: 'no side, entry or fill time' };
  const list = (Array.isArray(bars) ? bars : []).filter(b => b && Number.isFinite(Date.parse(b.t)) && [b.o, b.h, b.l, b.c].every(Number.isFinite));
  const cs = candlesOf(list, base, base);
  const i0 = cs.findIndex(c => Date.parse(c.t) >= opened);
  if (i0 < 0) return { unavailable: 'no closed bar since the fill yet' };
  const way = s > 0 ? 'up' : 'down';
  const hi = c => (s > 0 ? c.h : -c.l); // the trade's way's extreme, as a number that grows the trade's way
  const lo = c => (s > 0 ? c.l : -c.h);
  const unsign = x => s * x;
  const atr = lastOf(ind.atr(cs, ind.ATR_PERIOD));
  const now = cs[cs.length - 1].c;

  let iBest = i0;
  for (let i = i0; i < cs.length; i += 1) if (hi(cs[i]) > hi(cs[iBest])) iBest = i;
  const extreme = { best: unsign(hi(cs[iBest])), at: cs[iBest].t, barsAgo: cs.length - 1 - iBest };

  // The structure frame's candles since entry (a candle that closed after the fill), its pushes and their swings.
  const hc = FRAME > base ? candlesOf(list, base, FRAME) : cs;
  const j0 = FRAME > base ? hc.findIndex(c => Date.parse(c.closedAt) > opened) : i0;
  const pushes = pushesOf(hc, s, j0, way);
  const [a, b] = [pushes[pushes.length - 2], pushes[pushes.length - 1]];
  const failed = pushes.length > 1 ? (s * b.swing <= s * a.swing ? { level: a.swing, swing: b.swing, at: b.at } : false) : null;
  const fading = pushes.length > 1 && a.sizeAtr !== null && b.sizeAtr !== null ? b.sizeAtr < a.sizeAtr && b.momentum <= a.momentum : null;

  // The last impulse: from the extreme against since the last structure-frame swing against before the best, to the best.
  const back = j0 >= 0 ? [...pivots(hc, K)].reverse().find(p => p.type === (s > 0 ? 'low' : 'high') && Date.parse(hc[p.i].t) < Date.parse(cs[iBest].t)) : null;
  const fromMs = back ? Date.parse(hc[back.i].t) : opened;
  let o = iBest;
  for (let i = 0; i <= iBest; i += 1) if (Date.parse(cs[i].t) >= fromMs && lo(cs[i]) < lo(cs[o])) o = i;
  const span = hi(cs[iBest]) - lo(cs[o]);
  const pullback = { origin: unsign(lo(cs[o])), best: extreme.best, depth: span > 0 ? r2((hi(cs[iBest]) - s * now) / span) : null };

  const vwap = lastOf(ind.anchoredVwap(cs, RTH_OPEN_MIN, RTH_CLOSE_MIN).slice(-1));
  const ema = lastOf(ind.ema(cs.map(c => c.c), EMA));
  const dist = v => (Number.isFinite(v) && atr > 0 ? r2((s * (now - v)) / atr) : null);
  const vwapAtr = dist(vwap);
  const emaAtr = dist(ema);

  // Structure against: the base frame (a fact, a pullback inside intact structure) and the structure frame (a reversal).
  const tfB = label(base);
  const tfH = label(FRAME);
  const against = { [tfB]: againstOf(cs, way, i0), ...(FRAME > base ? { [tfH]: j0 >= 0 ? againstOf(hc, way, j0) : null } : {}) };
  // A displacement is spent once a break the trade's way (base or structure frame) followed it.
  const ways = [...breaksOf(cs, K), ...(FRAME > base ? breaksOf(hc, K) : [])].filter(x => x.direction === way).map(x => Date.parse(x.at));
  const displacement = j0 >= 0 ? displacementOf(hc, way, j0, tfH, ms => ways.some(t => t > ms)) : null;
  const comp = {};
  const frames = compressionFrames({ bars: list, base, frames: [...new Set([base, FRAME])] });
  for (const [tf, x] of Object.entries(frames)) {
    if (!x || typeof x !== 'object') { comp[tf] = null; continue; }
    if (x.state === 'expanding' && x.break && x.break.dir === opp(way)) comp[tf] = { kind: `expanding ${opp(way)}`, barsAgo: x.break.barsAgo };
    else if (x.state === 'compressing' && x.box && x.box.pole && x.box.pole.dir === opp(way)) comp[tf] = { kind: `${x.box.flavor} box after a ${opp(way)} pole` };
    else comp[tf] = null;
  }

  const stepMs = base * 60000;
  const atEntry = biasOf(list.filter(x => Date.parse(x.t) + stepMs <= opened));
  const nowBias = biasOf(list);
  const flipAgainst = atEntry && nowBias ? nowBias.dir === opp(way) && atEntry.dir !== opp(way) : null;

  const held = {
    'failed extreme': Boolean(failed),
    'pushes fading': fading === true,
    // One sign for the retrace, however it shows: its depth, or the close below the EMA20 and the RTH VWAP (they move
    // together in a pullback: one piece of evidence, never two).
    'deep retrace': (pullback.depth !== null && pullback.depth > TR.deepPullback) || (emaAtr !== null && emaAtr < 0 && (vwapAtr === null || vwapAtr < 0)),
    'compression against': Object.values(comp).some(Boolean),
    'HTF flip': flipAgainst === true,
  };
  const signs = SIGNS.filter(x => held[x]);
  const brk = FRAME > base ? against[tfH] : against[tfB];
  const reversal = brk ? `${tfH} ${brk.kind} ${brk.direction}` : displacement ? `${tfH} displacement through the swing` : null;

  // The runner's own structure trail level, read as the runner does (exit-trail.js swingSeries on the policy's swing_tf
  // candles, its default k): the tightest a tighten may go. `exit`: the trade's exit plan's afterTarget (trailBy,
  // swingMinutes), as the runner holds it; none known, or a trail by R, has no swing level.
  const how = exit && exit.trailBy === 'structure' && exit.swingMinutes ? 'structure' : exit && exit.trailBy ? 'r' : 'none';
  let trail = null;
  if (how === 'structure') {
    const sw = swingSeries(list, exit.swingMinutes);
    const swing = (s > 0 ? sw.low : sw.high)[list.length - 1];
    trail = Number.isFinite(swing) ? { swing, stop: tick > 0 ? snapStop(swing - s * tick, s, tick) : swing, minutes: exit.swingMinutes } : { swing: null, stop: null, minutes: exit.swingMinutes };
  }

  return {
    side, entry, bars: cs.length - i0, atr: r2(atr), close: now, extreme, pushes, failed, fading, pullback,
    vwap: { rth: r2(vwap), distAtr: vwapAtr }, ema20: { value: r2(ema), distAtr: emaAtr },
    against, displacement, compression: comp, bias: { entry: atEntry, now: nowBias, flipAgainst },
    signs, weakening: signs.length >= TR.minSigns, reversal, trail, trailBy: how,
  };
}

const sAtr = x => (x === null ? '?' : `${x >= 0 ? '+' : ''}${x} ATR`);
const biasText = b => (!b ? 'unknown' : b.dir === 'none' ? 'none' : `${b.frame} ${b.dir}`);

function tradeReadLine(t, { level = r2 } = {}) {
  if (!t || t.unavailable) return `Trade read: unavailable (${t ? t.unavailable : 'not computed'}).`;
  const tf = label(FRAME);
  const failed = t.failed ? `${tf} push FAILED (swing ${level(t.failed.swing)} short of ${level(t.failed.level)})` : t.failed === false ? `${tf} push made a new extreme` : `under two ${tf} pushes`;
  const pushes = t.pushes.length ? `${tf} pushes ${t.pushes.map(p => `${p.sizeAtr ?? '?'} ATR/${p.momentum} mom`).join(', ')}${t.fading ? ': fading' : t.fading === false ? ': not fading' : ''}` : `no confirmed ${tf} push`;
  const depth = t.pullback.depth === null ? 'pullback ?' : `pullback ${Math.round(t.pullback.depth * 100)}% of the last impulse ${level(t.pullback.origin)}-${level(t.pullback.best)}`;
  const brk = Object.entries(t.against).map(([k, x]) => (x ? `${k} ${x.kind} ${x.direction} ${level(x.level)} ${x.barsAgo} bars ago` : `${k} none`)).join(', ');
  const d = t.displacement;
  const disp = d ? `${d.tf} ${d.barsAgo} bars ago, through the swing ${level(d.swing)}` : 'none';
  const comp = Object.entries(t.compression).filter(([, x]) => x).map(([k, x]) => `${k} ${x.kind}`).join(', ') || 'none';
  const b = t.bias;
  const flip = b.flipAgainst ? 'FLIPPED against the trade' : b.flipAgainst === false ? 'no flip against' : 'flip unknown';
  const trail = t.trailBy === 'structure' && t.trail
    ? (t.trail.swing === null ? `no confirmed ${t.trail.minutes}m swing (the runner's trail has no level yet)` : `the last confirmed ${t.trail.minutes}m swing ${level(t.trail.swing)} (stop ${level(t.trail.stop)}, the runner's trail level)`)
    : t.trailBy === 'r' ? 'no swing level: the runner trails this trade by R behind the best price' : 'no swing level: the runner holds no structure trail for this trade';
  return `Trade read (closed bars since entry; pullback-vs-reversal): best ${level(t.extreme.best)}; ${failed}; ${pushes}; ${depth}; close vs RTH VWAP ${t.vwap.rth === null ? 'n/a' : sAtr(t.vwap.distAtr)}, vs EMA20 ${sAtr(t.ema20.distAtr)} (+ the trade's way); structure against since entry: ${brk}; ${tf} displacement against: ${disp}; compression against: ${comp}; HTF bias at entry ${biasText(b.entry)}, now ${biasText(b.now)} (${flip}). Weakening signs: ${t.signs.length} of ${SIGNS.length}${t.signs.length ? ` (${t.signs.join(', ')})` : ''}, ${TR.minSigns} needed; reversal: ${t.reversal || 'none'}; tighten at most to ${trail}.`;
}

module.exports = { SIGNS, tradeRead, tradeReadLine, biasOf };
