'use strict';

/**
 * Structure events computed from closed bars, so no role reads them by eye
 * (the market-structure and liquidity-concepts skills' definitions):
 *
 *   pivots(bars, k)              confirmed fractal swings: a high (low) above (below) the k bars on each side,
 *                                 confirmed k bars later; [{ type, price, t, i, confirmedAt }]
 *   lastBreaks(bars, k)          the latest close through a confirmed swing that hadn't been broken, labelled BOS
 *                                 when it continues the previous break's direction and CHoCH when it reverses it;
 *                                 { last, previous } each { kind, direction, level, swingAt, at } or null
 *   sweeps(bars, levels, n)      in the last n bars, a high level traded above and closed back below within 1-3
 *                                 bars (a low level the same below): [{ name, price, side, key, at, back, bars,
 *                                 wick, close }], one per level, key levels first, then most recent first
 *   untestedSwings(bars, swings) the swings price hasn't traded back to since their candle closed (swing.end)
 */

/** Confirmed fractal swings, oldest first. */
function pivots(bars, k = 2) {
  const out = [];
  for (let j = k; j < bars.length - k; j += 1) {
    let hi = true;
    let lo = true;
    for (let m = j - k; m <= j + k; m += 1) {
      if (m === j) continue;
      if (!(bars[j].h > bars[m].h)) hi = false;
      if (!(bars[j].l < bars[m].l)) lo = false;
    }
    if (hi) out.push({ type: 'high', price: bars[j].h, t: bars[j].t, i: j, confirmedAt: j + k });
    if (lo) out.push({ type: 'low', price: bars[j].l, t: bars[j].t, i: j, confirmedAt: j + k });
  }
  return out;
}

/** The latest structure breaks: a close through the last confirmed, unbroken swing high (up) or low (down). */
function lastBreaks(bars, k = 2) {
  const ps = pivots(bars, k);
  let hi = null; // the last confirmed swing high not yet broken
  let lo = null;
  let p = 0;
  const breaks = [];
  for (let i = 0; i < bars.length; i += 1) {
    while (p < ps.length && ps[p].confirmedAt <= i) {
      if (ps[p].type === 'high') hi = ps[p]; else lo = ps[p];
      p += 1;
    }
    const c = bars[i].c;
    for (const [swing, direction] of [[hi, 'up'], [lo, 'down']]) {
      if (!swing || i <= swing.confirmedAt - 1) continue;
      if ((direction === 'up' && c > swing.price) || (direction === 'down' && c < swing.price)) {
        const prev = breaks[breaks.length - 1];
        breaks.push({ kind: prev && prev.direction !== direction ? 'CHoCH' : 'BOS', direction, level: swing.price, swingAt: swing.t, at: bars[i].t });
        if (direction === 'up') hi = null; else lo = null;
      }
    }
  }
  return { last: breaks[breaks.length - 1] || null, previous: breaks[breaks.length - 2] || null };
}

/**
 * Sweeps of named levels in the last n bars (the liquidity-concepts skill: trade through the level and close back
 * inside within 1-3 bars). A high level: a bar trading above it, from a close at or below it, and a close back below
 * within that bar or the next two; a low level the same below. One per level (the most recent), key levels first
 * (`key: true`), then most recent first.
 */
function sweeps(bars, levels, n = 10) {
  const out = [];
  const from = Math.max(1, bars.length - n);
  const seen = new Set();
  for (const { name, price, side, key = false } of levels) {
    if (!Number.isFinite(price) || !['high', 'low'].includes(side) || seen.has(`${side}:${price}`)) continue;
    seen.add(`${side}:${price}`);
    const through = b => (side === 'high' ? b.h > price : b.l < price);
    const inside = b => (side === 'high' ? b.c < price : b.c > price);
    const atOrInside = b => (side === 'high' ? b.c <= price : b.c >= price);
    for (let j = bars.length - 1; j >= from; j -= 1) {
      if (!inside(bars[j])) continue;
      // The first bar through the level, at most two bars before the close back inside, coming from inside.
      const i = [j, j - 1, j - 2].reverse().find(x => x >= from && through(bars[x]) && atOrInside(bars[x - 1]) && bars.slice(x, j).every(b => !inside(b)));
      if (i === undefined) continue;
      const span = bars.slice(i, j + 1);
      const wick = side === 'high' ? Math.max(...span.map(b => b.h)) : Math.min(...span.map(b => b.l));
      out.push({ name, price, side, key, at: bars[i].t, back: bars[j].t, bars: j - i + 1, wick, close: bars[j].c });
      break;
    }
  }
  return out.sort((a, b) => (b.key - a.key) || Date.parse(b.back) - Date.parse(a.back));
}

/**
 * The swings price hasn't traded back to since they formed: a high not reached again, a low not reached again, by
 * the bars from the swing's `end` (the close of the candle that made it, e.g. its 1h candle; default its own time,
 * exclusive) on.
 */
function untestedSwings(bars, swings) {
  return swings.filter(s => {
    const end = s.end ? Date.parse(s.end) : Date.parse(s.t) + 1;
    return !bars.some(b => Date.parse(b.t) >= end && (s.type === 'high' ? b.h >= s.price : b.l <= s.price));
  }).map(({ type, price, t }) => ({ type, price, t }));
}

module.exports = { pivots, lastBreaks, sweeps, untestedSwings };
