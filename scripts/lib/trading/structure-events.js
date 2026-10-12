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
 *   sweeps(bars, levels, n)      in the last n bars, a high level (side 'high') wicked above and closed back below,
 *                                 or a low level wicked below and closed back above:
 *                                 [{ name, price, side, at, wick, close }], most recent first, one per level
 *   untestedSwings(bars, swings) the swings price hasn't traded back to since they formed (by the bars after them)
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

/** Sweeps of named levels in the last n bars: a wick through and a close back inside, most recent first. */
function sweeps(bars, levels, n = 10) {
  const out = [];
  const from = Math.max(0, bars.length - n);
  const seen = new Set();
  for (const { name, price, side } of levels) {
    if (!Number.isFinite(price) || !['high', 'low'].includes(side) || seen.has(`${side}:${price}`)) continue;
    seen.add(`${side}:${price}`);
    for (let i = bars.length - 1; i >= from; i -= 1) {
      const b = bars[i];
      if (side === 'high' && b.h > price && b.c < price) { out.push({ name, price, side, at: b.t, wick: b.h, close: b.c }); break; }
      if (side === 'low' && b.l < price && b.c > price) { out.push({ name, price, side, at: b.t, wick: b.l, close: b.c }); break; }
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The swings (from pivots) price hasn't traded back to since: a high not reached again, a low not reached again. */
function untestedSwings(bars, swings) {
  const after = t => bars.filter(b => Date.parse(b.t) > Date.parse(t));
  return swings.filter(s => !after(s.t).some(b => (s.type === 'high' ? b.h >= s.price : b.l <= s.price)))
    .map(({ type, price, t }) => ({ type, price, t }));
}

module.exports = { pivots, lastBreaks, sweeps, untestedSwings };
