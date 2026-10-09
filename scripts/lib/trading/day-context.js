'use strict';

/**
 * The day's context, as a market-profile trader reads it before a trade:
 *
 *   open       where the RTH session opened against the prior RTH day: inside
 *              its value area, outside value but inside its range, or outside
 *              its range (above or below), and the gap from its close
 *   open type  the first 30 minutes (Dalton's opening types, a mechanical
 *              approximation): open-drive (one-way from the open), open-test-
 *              drive (a short test one way, then a drive the other), open-
 *              rejection-reverse (a move one way rejected back through the
 *              open), or open-auction (rotation around the open)
 *   IB         the initial balance: the first hour's high and low (09:30-10:30
 *              ET), its size against the average daily range, and how far the
 *              day has extended beyond it
 *   day type   so far, from the IB extensions (Dalton): inside the IB (balance
 *              so far), normal variation (one side extended, under 2 IBs),
 *              trend (one side extended 2 IBs or more, or 1 IB or more from a
 *              narrow IB, under 0.35 of the ADR), or neutral (both sides)
 *   ADR        the average RTH range of the last `adrDays` complete days, and
 *              how much of it today has used
 *
 * Causal: bar i's values use bars 0..i only (the IB and the open type are
 * known from the bar whose close completes them). A day the bars start in the
 * middle of has no context (no 09:30 bar, or nothing before it).
 */

const ind = require('./indicators');
const { profileSeries, optionsFromParams } = require('./volume-profile');

const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const DEFAULTS = { ibMinutes: 60, openMinutes: 30, adrDays: 10 };

/** The bar step in minutes (the smallest gap between bars). */
function stepMinutes(bars) {
  let step = Infinity;
  for (let i = 1; i < bars.length; i += 1) {
    const d = Date.parse(bars[i].t) - Date.parse(bars[i - 1].t);
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step / 60000 : 1;
}

/**
 * Dalton's opening type from the opening window: open o, high h at bar index
 * th, low l at tl, close c. A mechanical approximation; null without range.
 */
function openingType({ o, h, l, c, th, tl }) {
  const r = h - l;
  if (!(r > 0)) return null;
  const up = h - o;
  const dn = o - l;
  const net = c - o;
  if (dn <= 0.1 * r && net >= 0.5 * r) return 'open-drive up';
  if (up <= 0.1 * r && -net >= 0.5 * r) return 'open-drive down';
  // Which side was tested first.
  const lowFirst = tl < th;
  if (lowFirst && dn <= 0.4 * r && net >= 0.5 * r) return 'open-test-drive up';
  if (!lowFirst && up <= 0.4 * r && -net >= 0.5 * r) return 'open-test-drive down';
  if (lowFirst && dn > 0.4 * r && net >= 0.25 * r) return 'open-rejection-reverse up';
  if (!lowFirst && up > 0.4 * r && -net >= 0.25 * r) return 'open-rejection-reverse down';
  return 'open-auction';
}

/** The day type so far from the initial balance, the day's extremes, and the ADR (optional). */
function dayType(ibHigh, ibLow, high, low, adr = null) {
  const ib = ibHigh - ibLow;
  const up = Math.max(0, high - ibHigh);
  const dn = Math.max(0, ibLow - low);
  if (up > 0 && dn > 0) return 'neutral';
  const ext = Math.max(up, dn);
  const narrow = adr > 0 && ib < 0.35 * adr;
  if (ib > 0 && (ext >= 2 * ib || (narrow && ext >= ib))) return `trend ${up > 0 ? 'up' : 'down'}`;
  if (up > 0) return 'normal variation up';
  if (dn > 0) return 'normal variation down';
  return 'inside the initial balance';
}

/**
 * Per-bar day context: { day: [obj|null] } where obj = { date, open, gap,
 * openVs, openType, ibHigh, ibLow, ibRange, extUp, extDown, dayType, high,
 * low, range, adr, adrDays } (fields not known yet are null), plus series for
 * the rules: ib_high, ib_low, and adr (NaN where unknown).
 */
function dayContextSeries(bars, { ibMinutes = DEFAULTS.ibMinutes, openMinutes = DEFAULTS.openMinutes, adrDays = DEFAULTS.adrDays, params = {} } = {}) {
  const n = bars.length;
  const step = stepMinutes(bars);
  const prior = profileSeries(bars, 'prior_rth', { options: optionsFromParams(params) });
  const out = { day: new Array(n).fill(null), ib_high: new Array(n).fill(NaN), ib_low: new Array(n).fill(NaN), adr: new Array(n).fill(NaN) };
  const ranges = []; // complete RTH days' ranges, oldest first
  let cur = null; // the RTH day in progress
  let last = null; // the last complete RTH day: { high, low, close }
  const finish = () => {
    if (cur && cur.whole) { ranges.push(cur.high - cur.low); last = { high: cur.high, low: cur.low, close: cur.close }; }
    cur = null;
  };
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const { day, minute } = ind.etInfo(b.t);
    const inRth = minute >= RTH_OPEN && minute < RTH_CLOSE;
    if (cur && (cur.date !== day || !inRth)) finish();
    const adr = ranges.length >= adrDays ? ranges.slice(-adrDays).reduce((a, x) => a + x, 0) / adrDays : NaN;
    if (!inRth) continue;
    if (!cur) {
      // Whole only when its 09:30 bar is here with bars before it.
      cur = { date: day, whole: i > 0 && minute === RTH_OPEN, open: b.o, high: b.h, low: b.l, close: b.c, oh: b.h, ol: b.l, oc: b.c, oth: i, otl: i, ibh: b.h, ibl: b.l, ib: null, openType: null, prior: last };
      const p = prior.profile[i];
      cur.openVs = !last ? null
        : p && b.o >= p.val && b.o <= p.vah ? 'inside the prior value area'
          : b.o > last.high ? 'above the prior range'
            : b.o < last.low ? 'below the prior range'
              : p ? `${b.o > p.vah ? 'above' : 'below'} the prior value area, inside the prior range` : null;
    }
    cur.high = Math.max(cur.high, b.h); cur.low = Math.min(cur.low, b.l); cur.close = b.c;
    if (!cur.whole) continue;
    const end = minute + step;
    // The opening window: its extremes and when they came. It completes on the bar that ends it,
    // or (a missing bar) on the first bar after it, from the window's own bars.
    if (minute < RTH_OPEN + openMinutes) {
      if (b.h > cur.oh) { cur.oh = b.h; cur.oth = i; }
      if (b.l < cur.ol) { cur.ol = b.l; cur.otl = i; }
      cur.oc = b.c;
    }
    if (cur.openType === null && end >= RTH_OPEN + openMinutes) cur.openType = openingType({ o: cur.open, h: cur.oh, l: cur.ol, c: cur.oc, th: cur.oth, tl: cur.otl });
    // The initial balance, likewise, from the first hour's bars only.
    if (minute < RTH_OPEN + ibMinutes) { cur.ibh = Math.max(cur.ibh, b.h); cur.ibl = Math.min(cur.ibl, b.l); }
    if (!cur.ib && end >= RTH_OPEN + ibMinutes) cur.ib = { high: cur.ibh, low: cur.ibl };
    const ib = cur.ib;
    if (ib) { out.ib_high[i] = ib.high; out.ib_low[i] = ib.low; }
    out.adr[i] = adr;
    out.day[i] = {
      date: cur.date, open: cur.open, gap: cur.prior ? cur.open - cur.prior.close : null, openVs: cur.openVs, openType: cur.openType,
      ibHigh: ib ? ib.high : null, ibLow: ib ? ib.low : null, ibRange: ib ? ib.high - ib.low : null,
      extUp: ib ? Math.max(0, cur.high - ib.high) : null, extDown: ib ? Math.max(0, ib.low - cur.low) : null,
      dayType: ib ? dayType(ib.high, ib.low, cur.high, cur.low, Number.isFinite(adr) ? adr : null) : null,
      high: cur.high, low: cur.low, range: cur.high - cur.low, adr: Number.isFinite(adr) ? adr : null, adrDays,
    };
  }
  return out;
}

/** One line for a prompt: "MNQ day: opened 21462.50 below the prior value area ...". */
function describeDay(d, { symbol = '', round = x => Math.round(x * 100) / 100 } = {}) {
  if (!d) return null;
  const r = x => (x === null || x === undefined ? '?' : round(x));
  const adr = x => (d.adr ? `, ${(x / d.adr).toFixed(2)} ADR` : '');
  const parts = [`opened ${r(d.open)}${d.openVs ? ` ${d.openVs}` : ''}${d.gap !== null ? `, gap ${d.gap >= 0 ? '+' : ''}${r(d.gap)} from the prior close${d.adr ? ` (${(Math.abs(d.gap) / d.adr).toFixed(2)} ADR)` : ''}` : ''}`];
  // What isn't known yet (before 10:00 / 10:30 ET, or without enough days for the ADR) is left out.
  if (d.openType) parts.push(`opening type ${d.openType}`);
  if (d.ibRange !== null) parts.push(`initial balance ${r(d.ibLow)}-${r(d.ibHigh)} (${r(d.ibRange)} points${adr(d.ibRange)}), extended ${r(d.extUp)} up and ${r(d.extDown)} down: ${d.dayType}`);
  parts.push(`range so far ${r(d.range)}${d.adr ? ` of a ${d.adrDays}-day average ${r(d.adr)} (${Math.round((d.range / d.adr) * 100)}% used)` : ''}`);
  return `${symbol ? `${symbol} day: ` : ''}${parts.join('; ')}.`;
}

const GLOBEX_OPEN = 18 * 60;

/**
 * Outside RTH (the Globex session, 18:00-09:30 ET), one line in place of the
 * day line: the overnight range so far, the prior RTH day (range, close, value
 * area and POC) with price's place against it, and the time to the RTH open.
 * Null in RTH, or when the bars don't hold the session's start or a whole
 * prior RTH day. From bars 0..last only.
 */
function describeOvernight(bars, { symbol = '', round = x => Math.round(x * 100) / 100, params = {} } = {}) {
  const n = bars.length;
  if (!n) return null;
  const last = bars[n - 1];
  const { minute } = ind.etInfo(last.t);
  if (minute >= RTH_OPEN && minute < RTH_CLOSE) return null;
  const key = ind.sessionKey(last.t, GLOBEX_OPEN);
  let s = n - 1;
  while (s > 0 && ind.sessionKey(bars[s - 1].t, GLOBEX_OPEN) === key) s -= 1;
  if (s === 0 && ind.etInfo(bars[0].t).minute !== GLOBEX_OPEN) return null; // the session started before the data
  // The prior complete RTH day (its 09:30 bar in the data, with bars before it).
  let day = null; let prior = null;
  for (let i = 0; i < s; i += 1) {
    const e = ind.etInfo(bars[i].t);
    const inRth = e.minute >= RTH_OPEN && e.minute < RTH_CLOSE;
    if (day && (e.day !== day.date || !inRth)) { if (day.whole) prior = day; day = null; }
    if (!inRth) continue;
    if (!day) day = { date: e.day, whole: i > 0 && e.minute === RTH_OPEN, high: bars[i].h, low: bars[i].l, close: bars[i].c };
    day.high = Math.max(day.high, bars[i].h); day.low = Math.min(day.low, bars[i].l); day.close = bars[i].c;
  }
  if (day && day.whole) prior = day;
  if (!prior) return null;
  const p = profileSeries(bars, 'prior_rth', { options: optionsFromParams(params) }).profile[n - 1];
  let hi = -Infinity; let lo = Infinity;
  for (let i = s; i < n; i += 1) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
  const r = round;
  const toOpen = minute >= GLOBEX_OPEN ? 24 * 60 - minute + RTH_OPEN : RTH_OPEN - minute;
  const where = !p ? '' : last.c > p.vah ? ': price above the prior value area' : last.c < p.val ? ': price below the prior value area' : ': price inside the prior value area';
  return `${symbol ? `${symbol} ` : ''}overnight (Globex since 18:00 ET): range ${r(lo)}-${r(hi)} so far, last ${r(last.c)}; prior RTH day ${r(prior.low)}-${r(prior.high)}, close ${r(prior.close)}${p ? `, value area ${r(p.val)}-${r(p.vah)} (POC ${r(p.poc)})` : ''}${where}; RTH opens in ${Math.floor(toOpen / 60)} h ${toOpen % 60} min.`;
}

module.exports = { DEFAULTS, openingType, dayType, dayContextSeries, describeDay, describeOvernight, stepMinutes };
