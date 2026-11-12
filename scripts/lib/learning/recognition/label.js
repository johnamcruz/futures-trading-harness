'use strict';

/**
 * The recognition test's bars-only chop label v2 (docs/TRAINING.md, "The recognition test"). Uses only the base bars'
 * prices: no day so far, no briefing word, no VWAP, regime or IB field. A LABEL, hindsight over the window by design: it
 * picks which days are chop cases; it is never shown to the model and never grades a read. The thresholds are frozen in
 * config/recognition.json chopLabel (written before any day was labelled).
 *
 *   n           the bars opening inside the window (chopLabel.window, a session spec, '09:30-12:00@America/New_York') on
 *               the day; under minBars: not eligible
 *   efficiency  |last close - the first window bar's open| / the closes' path (sum |close - previous close| over the
 *               window, plus |first close - first open|): path efficiency
 *   netAtr      (last close - first open) / ATR; rangeAtr (window high - low) / ATR; ATR = Wilder's of atrPeriod
 *               (indicators.js atr) over the bars given up to the last window bar
 *   chop        efficiency <= 1 / sqrt(n) (a driftless random walk's expected efficiency: derived, not tuned) AND
 *               |netAtr| <= netAtrMax (no real net move) AND rangeAtr >= rangeAtrMin (it rotated: not a dead tape)
 *
 *   erMax(n)
 *   chopLabel(bars, { window, minBars, netAtrMax, rangeAtrMin, atrPeriod, day })   bars sorted ({ t | ms, o, h, l, c });
 *               day 'YYYY-MM-DD' (in the window's zone), default the day of the last window bar
 *               -> { eligible, chop (null when not eligible), day, n, efficiency, netAtr, rangeAtr, erMax }
 */

const { parseWindows, inWindow } = require('../../trading/clock');
const { atr } = require('../../trading/indicators');

const erMax = n => 1 / Math.sqrt(n);
const msOf = b => (Number.isFinite(b.ms) ? b.ms : Date.parse(b.t));

function chopLabel(bars, { window, minBars, netAtrMax, rangeAtrMin, atrPeriod, day = null }) {
  const w = parseWindows(window).windows[0];
  if (!w) throw new Error(`chop label: the window ${window} is not a session spec`);
  // The window's own calendar day (YYYY-MM-DD in its zone).
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: w.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = ms => fmt.format(new Date(ms));
  const list = Array.isArray(bars) ? bars : [];
  const inside = list.map((b, i) => ({ i, ms: msOf(b) })).filter(x => Number.isFinite(x.ms) && inWindow(new Date(x.ms), w)).map(x => ({ ...x, day: dayOf(x.ms) }));
  const d = day || (inside.length ? inside[inside.length - 1].day : null);
  const idx = inside.filter(x => x.day === d).map(x => x.i);
  const none = { eligible: false, chop: null, day: d, n: idx.length };
  if (idx.length < minBars) return none;
  const first = idx[0];
  const last = idx[idx.length - 1];
  const a = atr(list.slice(0, last + 1), atrPeriod)[last];
  if (!(a > 0)) return none;
  const win = idx.map(i => list[i]);
  let path = Math.abs(win[0].c - win[0].o);
  for (let i = first + 1; i <= last; i += 1) path += Math.abs(list[i].c - list[i - 1].c);
  const net = win[win.length - 1].c - win[0].o;
  const range = Math.max(...win.map(b => b.h)) - Math.min(...win.map(b => b.l));
  const efficiency = path ? Math.abs(net) / path : 0;
  const netAtr = net / a;
  const rangeAtr = range / a;
  const n = idx.length;
  return { eligible: true, day: d, n, efficiency, netAtr, rangeAtr, erMax: erMax(n), chop: efficiency <= erMax(n) && Math.abs(netAtr) <= netAtrMax && rangeAtr >= rangeAtrMin };
}

module.exports = { erMax, chopLabel };
