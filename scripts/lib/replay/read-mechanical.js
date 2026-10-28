'use strict';

/**
 * The open trade's read applied mechanically (analysis only, never the live path): how much of a move the
 * pullback-vs-reversal read keeps when its actions are taken to the letter on every closed bar, against the runner's own
 * structure trail. The check the read's teaching must pass (feat/ride-or-exit, review round 2): applied mechanically, it
 * keeps at least as much of a trend as the runner's trail, and weakening is rare on healthy trend bars.
 *
 * On each closed base bar after the fill, oldest first (each read sees only the bars closed by then: trade-read.js):
 *   the stop    a bar trading through the working stop exits there (the stop's price)
 *   the runner  (trail: true) the stop ratchets to the runner's structure trail level (trade-read.js `trail.stop`)
 *   the read    (read: true) a reversal exits at the bar's close; weakening tightens the stop to the trail level, never
 *               tighter, never looser; a healthy pullback holds
 *   the end     an exit the trade really made (`exitAt`, ms, `exitPrice`) ends it there when nothing came first; else the
 *               last bar's close
 *
 *   applyRead({ side, entry, openedAt, stop, bars, base, tick, trail, read, exitAt, exitPrice })
 *       { exit: { at, price, why }, points, moves, weakBars, bars }   points: the trade's way, from the entry
 */

const { tradeRead } = require('../trading/trade-read');

function applyRead({ side, entry, openedAt, stop: initial, bars, base, tick = null, trail = false, read = true, exitAt = null, exitPrice = null }) {
  const s = side === 'short' ? -1 : 1;
  const opened = Date.parse(openedAt);
  const stepMs = base * 60000;
  let stop = initial;
  let moves = 0;
  let weakBars = 0;
  let n = 0;
  const done = (b, price, why) => ({ exit: { at: b.t, price, why }, points: s * (price - entry), moves, weakBars, bars: n });
  const tighten = level => { if (Number.isFinite(level) && (!Number.isFinite(stop) || s * (level - stop) > 0)) { stop = level; moves += 1; } };
  for (let k = 0; k < bars.length; k += 1) {
    const b = bars[k];
    if (Date.parse(b.t) < opened) continue;
    if (exitAt !== null && Date.parse(b.t) + stepMs > exitAt) return done(b, exitPrice, 'the trade\'s own exit');
    n += 1;
    if (Number.isFinite(stop) && (s > 0 ? b.l <= stop : b.h >= stop)) return done(b, stop, 'stop');
    const r = tradeRead({ side, entry, openedAt, bars: bars.slice(0, k + 1), base, tick });
    if (r.unavailable) continue;
    if (r.weakening) weakBars += 1;
    if (read && r.reversal) return done(b, b.c, `reversal: ${r.reversal}`);
    if (r.trail && (trail || (read && r.weakening))) tighten(r.trail.stop);
  }
  const last = bars[bars.length - 1];
  return done(last, exitPrice !== null && exitAt !== null ? exitPrice : last.c, 'end');
}

module.exports = { applyRead };
