'use strict';

/**
 * The open trade's read facts (the pullback-vs-reversal skill's three-way read for an OPEN trade: a healthy pullback,
 * the trend weakening, a reversal), computed by code from closed bars and measured from the trade's own entry, so a
 * managed cycle reads them instead of judging the chart by eye. Pure: the bars and the trade in, the facts out; only
 * bars closed by the last one are read (no look-ahead), so the post-hoc exit scorecard (replay/exit-scorecard.js)
 * computes the same facts at a past decision by passing the bars up to it.
 *
 * Every definition is an existing one (one home each), read on completed candles of the base timeframe and of config/analysis.json tradeRead.frames (15m)
 * (candle-facts.js completedCandlesAt, the briefing's candle rule):
 *
 *   extreme       the best price since entry (the highest high of a long's candles opened at or after the fill, the
 *                 lowest low of a short's), and `failed`: the candle that made it traded past the best before it and
 *                 CLOSED back at or inside that prior best (null when the first candle made it: no prior extreme)
 *   pushes        the trade's way's confirmed swings since entry (structure-events.js pivots, swingK): each push's size,
 *                 from the lowest low (a short: highest high) since the push before (or the entry candle) to its swing,
 *                 in base ATR(14) now, and its momentum candles (momentum.js momentumRead the trade's way); `fading`:
 *                 two or more pushes and the last smaller than the one before with no more momentum candles
 *   pullback      the last impulse: from the lowest low (a short: highest high) between the last confirmed swing
 *                 against before the best candle and the best candle, to the best; `depth` the share of it given back by
 *                 the last close (0 at the best, 1 back at the impulse's origin)
 *   vwap, ema20   the last close against the RTH VWAP (null outside 09:30-16:00 ET) and the base EMA20, side-signed in
 *                 base ATR(14): + is the trade's way (the market-snapshot's VWAP and EMA definitions)
 *   against       per timeframe (base, 15m), the latest structure break (structure-events.js breaksOf: BOS or CHoCH) when
 *                 it is against the trade, happened since entry, and stands (no break the trade's way after it)
 *   displacement  the latest displacement candle against the trade since entry (candle-facts.js patternsOf), base or
 *                 15m, and whether it closed through the last confirmed swing low (a short: high) before it
 *   compression   per timeframe (base, 15m) compression.js against the trade: expanding against it, or a box whose pole
 *                 is against it (a flag against); null otherwise
 *   bias          the higher-timeframe bias (entry-rule.js BIAS_FRAMES order: the first of 4h, 1h that trends, mtf.js
 *                 mtfRead) at entry (the bars closed by the fill) and now; `flipAgainst`: now against the trade, at
 *                 entry not
 *
 *   tradeRead({ side, entry, openedAt, bars, base })   the facts above, or { unavailable } with why
 *   tradeReadLine(read, { level })                     one line for the managed cycle's prompt (level: a price as shown)
 */

const ind = require('./indicators');
const { pivots, breaksOf } = require('./structure-events');
const { completedCandlesAt, factsOf } = require('./candle-facts');
const { momentumRead } = require('./momentum');
const { compressionFrames } = require('./compression');
const { mtfRead, label } = require('./mtf');
const { BIAS_FRAMES } = require('./entry-rule');
const { RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('./clock');

const AN = require('../tunables').analysis(); // config/analysis.json: the swing confirmation, the EMA, ATR
const K = AN.indicators.swingK;
const EMA = AN.snapshot.emaSlow;
const FRAMES = AN.tradeRead.frames; // the structure timeframes read above the base (config/analysis.json tradeRead)
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

/** The latest break since `fromMs` against `way`, standing (the last break of all), on candles cs. */
function againstOf(cs, way, sinceIdx) {
  const all = breaksOf(cs, K);
  const last = all[all.length - 1];
  if (!last || last.direction === way || last.i < sinceIdx) return null;
  return { kind: last.kind, direction: last.direction, level: last.level, at: last.at, barsAgo: cs.length - 1 - last.i };
}

/** The latest displacement candle against `way` since index `from` on cs, with whether it closed through the last swing. */
function displacementOf(cs, way, from, tf) {
  if (!cs.length) return null;
  const facts = factsOf(cs);
  const sw = pivots(cs, K);
  for (let j = cs.length - 1; j >= Math.max(from, 1); j -= 1) {
    const c = cs[j];
    const dir = c.c > c.o ? 'up' : c.c < c.o ? 'down' : null;
    if (dir !== opp(way) || !facts[j].patterns.includes('displacement')) continue;
    const type = way === 'up' ? 'low' : 'high';
    const swing = [...sw].reverse().find(p => p.type === type && p.confirmedAt <= j);
    const through = swing ? (way === 'up' ? c.c < swing.price : c.c > swing.price) : null;
    return { tf, at: c.t, barsAgo: cs.length - 1 - j, throughSwing: through, swing: swing ? swing.price : null };
  }
  return null;
}

function tradeRead({ side, entry, openedAt, bars, base }) {
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
  const since = cs.slice(i0);
  const atr = lastOf(ind.atr(cs, ind.ATR_PERIOD));
  const now = cs[cs.length - 1].c;

  // The best since entry, and whether the candle that made it closed back inside the best before it.
  let iBest = i0;
  for (let i = i0; i < cs.length; i += 1) if (hi(cs[i]) > hi(cs[iBest])) iBest = i;
  let failed = null;
  if (iBest > i0) {
    let prior = -Infinity;
    for (let i = i0; i < iBest; i += 1) prior = Math.max(prior, hi(cs[i]));
    failed = s * cs[iBest].c <= prior ? { level: unsign(prior), at: cs[iBest].t, barsAgo: cs.length - 1 - iBest } : false;
  }
  const extreme = { best: unsign(hi(cs[iBest])), at: cs[iBest].t, barsAgo: cs.length - 1 - iBest, failed };

  // The pushes: the trade's way's confirmed swings since entry, each from the low since the push before.
  const facts = factsOf(cs);
  const sw = pivots(cs, K);
  const mine = sw.filter(p => p.type === (s > 0 ? 'high' : 'low') && p.i >= i0);
  const pushes = [];
  let from = i0;
  for (const p of mine) {
    let o = from;
    for (let i = from; i <= p.i; i += 1) if (lo(cs[i]) < lo(cs[o])) o = i;
    let mom = 0;
    for (let i = o; i <= p.i; i += 1) {
      const f = facts[i];
      if (momentumRead({ rangeAtr: r2(f.rangeAtr), closeLocation: f.closeLocation, volRatio: r2(f.volRatio) }) === way) mom += 1;
    }
    pushes.push({ at: cs[p.i].t, sizeAtr: atr > 0 ? r2((hi(cs[p.i]) - lo(cs[o])) / atr) : null, momentum: mom });
    from = p.i;
  }
  const a = pushes[pushes.length - 2];
  const b = pushes[pushes.length - 1];
  const fading = pushes.length > 1 && a.sizeAtr !== null && b.sizeAtr !== null ? b.sizeAtr < a.sizeAtr && b.momentum <= a.momentum : null;

  // The last impulse: from the extreme against since the last confirmed swing against before the best, to the best.
  const back = [...sw].reverse().find(p => p.type === (s > 0 ? 'low' : 'high') && p.i < iBest);
  let o = back ? back.i : i0;
  for (let i = o; i <= iBest; i += 1) if (lo(cs[i]) < lo(cs[o])) o = i;
  const span = hi(cs[iBest]) - lo(cs[o]);
  const pullback = { origin: unsign(lo(cs[o])), best: extreme.best, depth: span > 0 ? r2((hi(cs[iBest]) - s * now) / span) : null };

  // The close against the RTH VWAP and the EMA20, side-signed in ATR (+ the trade's way).
  const vwap = lastOf(ind.anchoredVwap(cs, RTH_OPEN_MIN, RTH_CLOSE_MIN).slice(-1));
  const ema = lastOf(ind.ema(cs.map(c => c.c), EMA));
  const dist = v => (Number.isFinite(v) && atr > 0 ? r2((s * (now - v)) / atr) : null);

  // Structure, displacement and compression against the trade, on the base and each higher frame's candles since entry
  // (a candle that closed after the fill).
  const tfs = [{ tf: label(base), cs, from: i0 }, ...FRAMES.filter(m => m > base).map(m => {
    const hc = candlesOf(list, base, m);
    return { tf: label(m), cs: hc, from: hc.findIndex(c => Date.parse(c.closedAt) > opened) };
  })];
  const against = Object.fromEntries(tfs.map(x => [x.tf, x.from >= 0 ? againstOf(x.cs, way, x.from) : null]));
  const disp = tfs.map(x => (x.from >= 0 ? displacementOf(x.cs, way, x.from, x.tf) : null)).filter(Boolean)
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0] || null;
  const comp = {};
  const frames = compressionFrames({ bars: list, base, frames: [base, ...FRAMES.filter(m => m > base)] });
  for (const [tf, x] of Object.entries(frames)) {
    if (!x || typeof x !== 'object') { comp[tf] = null; continue; }
    if (x.state === 'expanding' && x.break && x.break.dir === opp(way)) comp[tf] = { kind: `expanding ${opp(way)}`, barsAgo: x.break.barsAgo };
    else if (x.state === 'compressing' && x.box && x.box.pole && x.box.pole.dir === opp(way)) comp[tf] = { kind: `${x.box.flavor} box after a ${opp(way)} pole` };
    else comp[tf] = null;
  }

  // The higher-timeframe bias at entry (the bars closed by the fill) and now.
  const stepMs = base * 60000;
  const atEntry = biasOf(list.filter(x => Date.parse(x.t) + stepMs <= opened));
  const nowBias = biasOf(list);
  const flipAgainst = atEntry && nowBias ? nowBias.dir === opp(way) && atEntry.dir !== opp(way) : null;

  return {
    side, entry, bars: since.length, atr: r2(atr), close: now, extreme, pushes, fading, pullback,
    vwap: { rth: r2(vwap), distAtr: dist(vwap) }, ema20: { value: r2(ema), distAtr: dist(ema) },
    against, displacement: disp, compression: comp, bias: { entry: atEntry, now: nowBias, flipAgainst },
  };
}

const sAtr = x => (x === null ? '?' : `${x >= 0 ? '+' : ''}${x} ATR`);
const biasText = b => (!b ? 'unknown' : b.dir === 'none' ? 'none' : `${b.frame} ${b.dir}`);

function tradeReadLine(t, { level = r2 } = {}) {
  if (!t || t.unavailable) return `Trade read: unavailable (${t ? t.unavailable : 'not computed'}).`;
  const e = t.extreme;
  const failed = e.failed ? `new extreme FAILED (traded past ${level(e.failed.level)}, closed back inside, ${e.failed.barsAgo} bars ago)` : e.failed === false ? 'new extreme held (closed beyond the prior best)' : 'no prior extreme';
  const pushes = t.pushes.length ? `pushes ${t.pushes.map(p => `${p.sizeAtr ?? '?'} ATR/${p.momentum} mom`).join(', ')}${t.fading ? ': fading' : t.fading === false ? ': not fading' : ''}` : 'no confirmed push';
  const depth = t.pullback.depth === null ? 'pullback ?' : `pullback ${Math.round(t.pullback.depth * 100)}% of the last impulse ${level(t.pullback.origin)}-${level(t.pullback.best)}`;
  const brk = Object.entries(t.against).map(([tf, x]) => (x ? `${tf} ${x.kind} ${x.direction} ${level(x.level)} ${x.barsAgo} bars ago` : `${tf} none`)).join(', ');
  const d = t.displacement;
  const disp = d ? `${d.tf} ${d.barsAgo} bars ago${d.throughSwing ? `, closed through the last swing ${level(d.swing)}` : d.throughSwing === false ? ', inside the last swing' : ''}` : 'none';
  const comp = Object.entries(t.compression).filter(([, x]) => x).map(([tf, x]) => `${tf} ${x.kind}`).join(', ') || 'none';
  const b = t.bias;
  const flip = b.flipAgainst ? 'FLIPPED against the trade' : b.flipAgainst === false ? 'no flip against' : 'flip unknown';
  return `Trade read (closed bars since entry; pullback-vs-reversal): best ${level(e.best)}, ${failed}; ${pushes}; ${depth}; close vs RTH VWAP ${t.vwap.rth === null ? 'n/a' : sAtr(t.vwap.distAtr)}, vs EMA20 ${sAtr(t.ema20.distAtr)} (+ the trade's way); structure against since entry: ${brk}; displacement against: ${disp}; compression against: ${comp}; HTF bias at entry ${biasText(b.entry)}, now ${biasText(b.now)} (${flip}).`;
}

module.exports = { tradeRead, tradeReadLine, biasOf };
