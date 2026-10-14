'use strict';

/**
 * CISD, change in state of delivery, on COMPLETED candles of a timeframe, and
 * the OTE zone of its displacement leg (trading/fib.js). Causal: the value at
 * base bar i reads only bars 0..i, and a candle counts only once its last bar
 * has closed. The `cisd` skill teaches the read; the `cisd_ote` strategy trades
 * the bounce; the briefing shows the facts (cisdFacts); the rules language names
 * the series (rules.js: cisd_dir(m), cisd_level(m), ote_top(m), ote_bot(m),
 * in_ote(m), cisd_sweep(m), cisd_entry(m), cisd_risk(m)).
 *
 * Definitions (each a HYPOTHESIS, fixed here and tested in tests/lib/cisd.test.js; the
 * census in docs/research/cisd-ote-textbook.md measures them):
 *
 *   Run         a maximal series of at least `minRun` (2) consecutive bearish
 *               candles (close < open) for a bullish CISD, bullish ones
 *               (close > open) for a bearish CISD. A doji (close = open) ends a run.
 *               "Lower highs and lows" is not checked separately: a series of
 *               bearish candles is the definition used.
 *   Level       the OPEN of the run's first candle (the candle that started the
 *               most recent opposing run).
 *   CISD        bullish: the first completed candle, within `maxWait` (6) candles
 *               of the run's last candle, that CLOSES above the level (bearish: below).
 *               The most recent qualifying run is the reference; a newer run
 *               replaces it, and a confirmed run is used up. A candle that would
 *               confirm both directions confirms neither.
 *   Displacement the confirming candle must be STRONG for a zone: body >= `minBody`
 *               (0.6) of its range, its close in the extreme third the CISD's way,
 *               and its range >= `minRangeAtr` (1.0) x ATR(14) of the CISD
 *               timeframe's completed candles OR its body engulfing the prior
 *               candle's (opposite colour). A weak one (a doji, a small body, long
 *               wicks, a close mid-range) is still reported as a CISD, with no
 *               zone, no fib and no entry (status `weak`).
 *   Known       a CISD counts from the bar its confirming candle is known complete:
 *               that candle's last bar when it closes the candle's boundary, else
 *               the next bar (the last one is missing: a feed gap).
 *   Sweep       confluence, reported, never required: a key level the run traded
 *               through and closed back beyond, by the confirming candle. For a
 *               bullish CISD a key LOW L at or below the level (the run started at
 *               or above it), some candle from the run's start to the confirmation
 *               with low < L, and a close > L at or after it. Key levels: the prior
 *               RTH day's high/low, the overnight high/low (complete, so only when
 *               the run starts in RTH), and the prior session's (the 18:00 ET
 *               day's) high/low, each as it stood at the run's first bar (never a
 *               level the run itself made). A CISD after a sweep is stronger
 *               confluence (the `cisd` skill).
 *   Leg         the displacement leg: ORIGIN = the run's extreme, the lowest low
 *               (bullish; bearish: the highest high) from the run's first bar to
 *               the confirming candle's last bar (the sweep extreme when there was
 *               a sweep); EXTREME = the highest high from the origin to the
 *               confirmation, then extended by each later base bar that makes a
 *               new high before price first trades into the zone (frozen at that
 *               first touch; a bar that touches never extends it).
 *   OTE         fib.zone(leg): the 0.62-0.79 retracement, mid 0.705 (fib.OTE).
 *   Touch       a base bar whose range reaches the zone (bullish: low <= top).
 *   Bounce      after (or on) the touch, a completed base bar that traded in the
 *               zone (bullish: low <= top) and closes back in the trade direction:
 *               above the zone's top, or bullish with its close in the upper third
 *               of its range and at or above the zone's bottom. One per CISD. The
 *               entry is that close; the stop sits `bufferAtr` (0.1) x ATR(20) of
 *               the base bars beyond the origin.
 *   Void        a base bar that closes beyond the origin, or beyond the 0.79
 *               level by more than `voidTol` (0.05) of the leg (bullish: close
 *               < bottom - 0.05 x leg). A void zone takes no entry.
 *   Expired     `expiry` (12) CISD-timeframe candles after the confirmation closed.
 *   Replaced    by a newer CISD, either way, from the bar it is known: that bar is
 *               read for the newer CISD only (a bounce of the older zone on it is
 *               not taken).
 *
 * A timeframe the base bars can't build (5m from 3m bars, or one finer than the
 * bars) is unavailable. The completed-candle helpers on the candle-facts branch
 * (5m from a 1m lane's bars) should replace mtf.candles here once merged
 * (noted in the tech-debt list).
 *
 *   PARAMS                                  the defaults above
 *   findCisds(candles, params)              [{ dir, level, runStart, runEnd, confirm }] (candle indexes)
 *   strongCandle(k, prev, dir, atr, p)      the displacement strength rule, { strong, engulfing, body, rangeAtr } (also the FVG's middle candle)
 *   cisdSeries(bars, minutes, { levels, atr, params, barMinutes })   the series by base bar, and the latest state
 *   cisdFacts(bars, minutes, opts)          the latest CISD on that timeframe as the briefing shows it
 *   paramsFrom(strategyParams)              PARAMS overridden by cisdMinRun, cisdMaxWait, cisdExpiry, cisdVoidTol, cisdBufferAtr
 */

const fib = require('./fib');
const ind = require('./indicators');
const { candles: mtfCandles } = require('./mtf');
const { zonedParts } = require('./clock');

const PARAMS = Object.freeze({ minRun: 2, maxWait: 6, expiry: 12, voidTol: 0.05, bufferAtr: 0.1, minBody: 0.6, minRangeAtr: 1 });
const ATR_LEN = 14; // the displacement's range is measured against ATR(14) of the CISD timeframe's completed candles
const DEAD = new Set(['void', 'expired', 'weak']);
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const UPPER_THIRD = 2 / 3;

// The same defaults as strategy params (market-snapshot PARAMS, so a strategy's `params` may set them).
const SNAPSHOT_PARAMS = Object.freeze({
  cisdMinRun: PARAMS.minRun, cisdMaxWait: PARAMS.maxWait, cisdExpiry: PARAMS.expiry, cisdVoidTol: PARAMS.voidTol, cisdBufferAtr: PARAMS.bufferAtr,
  cisdMinBody: PARAMS.minBody, cisdMinRangeAtr: PARAMS.minRangeAtr,
  // A second, higher CISD timeframe for cisd_entry(m) / cisd_risk(m) (rules.js): 0 = none (the default).
  cisdHigherMinutes: 0,
});

/** The CISD params from a strategy's params (cisdMinRun, ...), else the defaults. */
function paramsFrom(p = {}) {
  const pick = (k, d) => (Number.isFinite(p[k]) ? p[k] : d);
  return {
    minRun: pick('cisdMinRun', PARAMS.minRun), maxWait: pick('cisdMaxWait', PARAMS.maxWait), expiry: pick('cisdExpiry', PARAMS.expiry),
    voidTol: pick('cisdVoidTol', PARAMS.voidTol), bufferAtr: pick('cisdBufferAtr', PARAMS.bufferAtr),
    minBody: pick('cisdMinBody', PARAMS.minBody), minRangeAtr: pick('cisdMinRangeAtr', PARAMS.minRangeAtr),
  };
}

/**
 * Every CISD in completed candles [{ o, h, l, c }], oldest first: { dir (1 bullish, -1 bearish), level, runStart,
 * runEnd, confirm } (indexes into `candles`).
 */
function findCisds(candles, params = PARAMS) {
  const { minRun, maxWait } = { ...PARAMS, ...params };
  const out = [];
  let bear = { start: -1, len: 0 };
  let bull = { start: -1, len: 0 };
  let refBear = null; // the reference bearish run (for a bullish CISD)
  let refBull = null;
  for (let j = 0; j < candles.length; j += 1) {
    const k = candles[j];
    // The runs as of the candle before this one: a newer qualifying run replaces the reference.
    if (bear.len >= minRun && bear.start + bear.len === j) refBear = { start: bear.start, end: j - 1, level: candles[bear.start].o };
    if (bull.len >= minRun && bull.start + bull.len === j) refBull = { start: bull.start, end: j - 1, level: candles[bull.start].o };
    if (refBear && j - refBear.end > maxWait) refBear = null;
    if (refBull && j - refBull.end > maxWait) refBull = null;
    const up = refBear && k.c > refBear.level;
    const down = refBull && k.c < refBull.level;
    if (up && !down) { out.push({ dir: 1, level: refBear.level, runStart: refBear.start, runEnd: refBear.end, confirm: j }); refBear = null; }
    if (down && !up) { out.push({ dir: -1, level: refBull.level, runStart: refBull.start, runEnd: refBull.end, confirm: j }); refBull = null; }
    if (k.c < k.o) { bear = bear.len && bear.start + bear.len === j ? { start: bear.start, len: bear.len + 1 } : { start: j, len: 1 }; bull = { start: -1, len: 0 }; }
    else if (k.c > k.o) { bull = bull.len && bull.start + bull.len === j ? { start: bull.start, len: bull.len + 1 } : { start: j, len: 1 }; bear = { start: -1, len: 0 }; }
    else { bear = { start: -1, len: 0 }; bull = { start: -1, len: 0 }; }
  }
  return out;
}

/** The smallest gap between the first bars, in minutes (a bar's length), unless given. */
function stepMinutes(bars, barMinutes) {
  if (Number.isFinite(barMinutes) && barMinutes > 0) return barMinutes;
  let step = Infinity;
  for (let i = 1; i < Math.min(bars.length, 51); i += 1) {
    const d = Date.parse(bars[i].t) - Date.parse(bars[i - 1].t);
    if (d > 0 && d < step) step = d;
  }
  return Number.isFinite(step) ? step / 60000 : 1;
}

/** The completed m-minute candles of the bars (start/end: base bar indexes), or why there are none. */
function candlesOf(bars, minutes, step) {
  if (minutes < step) return { unavailable: `finer than the ${step}m bars` };
  if (minutes % step !== 0) return { unavailable: `not built from ${step}m bars` };
  if (minutes === step) return { candles: bars.map((b, i) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, start: i, end: i })) };
  return { candles: mtfCandles(bars, minutes).filter(c => c.complete) };
}

/**
 * The base bar at which candle `c` is known complete: its last bar when that bar's close is the candle's boundary,
 * else the next bar (its last bar is missing, a feed gap: only a later bar shows the candle ended); -1 when no such
 * bar is in `bars` yet.
 */
function knownAt(bars, c, minutes, step) {
  const end = Date.parse(bars[c.end].t) + step * 60000;
  const p = zonedParts(new Date(end), 'America/New_York');
  const sinceOpen = (p.hour * 60 + p.minute - 18 * 60 + 1440) % 1440;
  if (minutes === step || (sinceOpen % minutes === 0 && end % 60000 === 0)) return c.end;
  return c.end + 1 < bars.length ? c.end + 1 : -1;
}

/** The key levels at each base bar: [{ name, price, side }] (levels: rules.causalLevels of the bars). */
function keyLevelsAt(bars, levels) {
  const day = ind.htfCandles(bars, 1440);
  return i => {
    const p = zonedParts(new Date(bars[i].t), 'America/New_York');
    const m = p.hour * 60 + p.minute;
    const rth = m >= RTH_OPEN && m < RTH_CLOSE;
    return [
      ['prior RTH high', levels.prior_high[i], 'high'], ['prior RTH low', levels.prior_low[i], 'low'],
      ...(rth ? [['overnight high', levels.overnight_high[i], 'high'], ['overnight low', levels.overnight_low[i], 'low']] : []),
      ['prior session high', day.prevH[i], 'high'], ['prior session low', day.prevL[i], 'low'],
    ].filter(([, price]) => Number.isFinite(price)).map(([name, price, side]) => ({ name, price, side }));
  };
}

/** The key level the run swept before its CISD (the one nearest the sweep extreme), or null. */
function sweepOf(ev, candles, keyAt) {
  const lows = ev.dir === 1;
  const swept = [];
  // The key levels as they stood at the run's first bar: never one the run's own candles made (a run across the
  // 18:00 ET open would otherwise "sweep" the prior-session low its own earlier candles set).
  const keys = keyAt(candles[ev.runStart].start);
  for (let k = ev.runStart; k <= ev.confirm; k += 1) {
    for (const lv of keys) {
      if (lv.side !== (lows ? 'low' : 'high')) continue;
      if (lows ? lv.price > ev.level : lv.price < ev.level) continue;
      if (lows ? !(candles[k].l < lv.price) : !(candles[k].h > lv.price)) continue;
      let back = false;
      for (let j = k; j <= ev.confirm && !back; j += 1) back = lows ? candles[j].c > lv.price : candles[j].c < lv.price;
      if (back && !swept.some(x => x.name === lv.name)) swept.push({ name: lv.name, price: lv.price });
    }
  }
  if (!swept.length) return null;
  return swept.sort((a, b) => (lows ? a.price - b.price : b.price - a.price))[0];
}

/**
 * A strong displacement candle `k` the `dir` way (1 up, -1 down), the one strength rule (hypotheses), shared with the
 * fair value gap's middle candle (market-snapshot.js fairValueGaps): it closes the `dir` way, its body is at least
 * `minBody` (0.6) of its range, its close sits in the extreme third the `dir` way, and either its range is at least
 * `minRangeAtr` (1.0) x `atr` (ATR(14) of its own timeframe as known at `k`) or its body engulfs the body of `prev`
 * (the candle before it, the opposite colour: the candle-reading skill's engulfing). Strong when all hold; else weak
 * (a doji, a small body, long wicks, a close mid-range, or a small candle that engulfs nothing).
 */
function strongCandle(k, prev, dir, atr, p = PARAMS) {
  const range = k.h - k.l;
  const body = range > 0 ? Math.abs(k.c - k.o) / range : 0;
  const loc = range > 0 ? (dir === 1 ? (k.c - k.l) / range : (k.h - k.c) / range) : 0;
  const withDir = dir === 1 ? k.c > k.o : k.c < k.o;
  const prevOpposite = prev && (dir === 1 ? prev.c < prev.o : prev.c > prev.o);
  const engulfing = Boolean(withDir && prevOpposite && Math.min(k.o, k.c) <= Math.min(prev.o, prev.c) && Math.max(k.o, k.c) >= Math.max(prev.o, prev.c));
  const rangeAtr = Number.isFinite(atr) && atr > 0 ? range / atr : null;
  const strong = withDir && body >= p.minBody && loc >= UPPER_THIRD && (engulfing || (rangeAtr !== null && rangeAtr >= p.minRangeAtr));
  return { strong, engulfing, body, rangeAtr };
}

/**
 * The confirming candle as a displacement: strongCandle on the CISD timeframe's candle `j`, the prior candle and
 * ATR(14) of the timeframe's completed candles at `j`. Strong, a zone; weak, none.
 */
function displacementOf(candles, j, dir, atrTf, p = PARAMS) {
  return strongCandle(candles[j], j > 0 ? candles[j - 1] : null, dir, atrTf ? atrTf[j] : NaN, p);
}

/** A new CISD's state at the base bar its confirming candle closes on. */
function openState(ev, candles, bars, keyAt, minutes, step, expiry, disp) {
  const from = candles[ev.runStart].start;
  const to = candles[ev.confirm].end;
  const bull = ev.dir === 1;
  let originIdx = from;
  for (let i = from; i <= to; i += 1) if (bull ? bars[i].l < bars[originIdx].l : bars[i].h > bars[originIdx].h) originIdx = i;
  const origin = bull ? bars[originIdx].l : bars[originIdx].h;
  let extreme = bull ? -Infinity : Infinity;
  for (let i = originIdx; i <= to; i += 1) extreme = bull ? Math.max(extreme, bars[i].h) : Math.min(extreme, bars[i].l);
  const closeMs = Date.parse(bars[to].t) + step * 60000;
  return {
    dir: ev.dir, level: ev.level, minutes,
    runStartAt: candles[ev.runStart].t, runCandles: ev.runEnd - ev.runStart + 1,
    confirmedAt: candles[ev.confirm].t, confirmedClose: new Date(closeMs).toISOString(), confirmClose: candles[ev.confirm].c,
    sweep: sweepOf(ev, candles, keyAt), origin, originAt: bars[originIdx].t, extreme,
    displacement: disp.strong ? 'strong' : 'weak', engulfing: disp.engulfing, bodyShare: disp.body, rangeAtr: disp.rangeAtr,
    // A weak displacement has no zone: no fib, no entry.
    status: !disp.strong ? 'weak' : origin === extreme ? 'void' : 'waiting', touched: false, entered: false, entryAt: null,
    expiresMs: closeMs + expiry * minutes * 60000,
  };
}

/** One base bar's effect on a live CISD: expiry, the leg's extension, the touch, the void, the bounce. */
function step1(s, b, ms, atr, p) {
  if (DEAD.has(s.status)) return 0;
  if (ms >= s.expiresMs) { s.status = 'expired'; return 0; }
  const bull = s.dir === 1;
  let z = fib.zone({ origin: s.origin, extreme: s.extreme });
  if (!s.touched) {
    if (bull ? b.l <= z.top : b.h >= z.bottom) { s.touched = true; if (s.status === 'waiting') s.status = 'touched'; }
    else {
      if (bull ? b.h > s.extreme : b.l < s.extreme) s.extreme = bull ? b.h : b.l;
      return 0;
    }
  }
  z = fib.zone({ origin: s.origin, extreme: s.extreme });
  const leg = Math.abs(s.extreme - s.origin);
  if (bull ? (b.c <= s.origin || b.c < z.bottom - p.voidTol * leg) : (b.c >= s.origin || b.c > z.top + p.voidTol * leg)) { s.status = 'void'; return 0; }
  if (s.entered) return 0;
  const third = b.h > b.l ? (bull ? (b.c - b.l) / (b.h - b.l) : (b.h - b.c) / (b.h - b.l)) : 0;
  const inZone = bull ? b.l <= z.top : b.h >= z.bottom;
  const back = bull ? b.c > z.top || (b.c > b.o && third >= UPPER_THIRD && b.c >= z.bottom)
    : b.c < z.bottom || (b.c < b.o && third >= UPPER_THIRD && b.c <= z.top);
  if (!(inZone && back)) return 0;
  const stop = bull ? s.origin - p.bufferAtr * atr : s.origin + p.bufferAtr * atr;
  const risk = bull ? b.c - stop : stop - b.c;
  if (!(Number.isFinite(risk) && risk > 0)) return 0;
  s.entered = true;
  s.status = 'bounced';
  s.entryAt = b.t;
  s.stop = stop;
  return risk;
}

/**
 * The CISD series of `bars` (normalized, oldest first) on `minutes`-minute completed candles, by base bar:
 * { dir, level, top, bottom, mid, inOte, sweep, entry, risk, entries (bar index -> what the entry saw) } and `last` (the latest CISD's state at the last bar, or null), or { unavailable }. `levels`: rules.causalLevels(bars);
 * `atr`: ATR(20) of the bars (for the stop's buffer).
 */
function cisdSeries(bars, minutes, { levels, atr, params = PARAMS, barMinutes = null } = {}) {
  const p = { ...PARAMS, ...params };
  const n = bars.length;
  const step = stepMinutes(bars, barMinutes);
  const built = candlesOf(bars, minutes, step);
  if (built.unavailable) return { unavailable: built.unavailable };
  const candles = built.candles;
  const keyAt = keyLevelsAt(bars, levels);
  const atrTf = ind.atr(candles, ATR_LEN);
  // Each CISD from the bar its confirming candle is known complete (knownAt), never sooner.
  const byEnd = new Map(findCisds(candles, p).map(ev => [knownAt(bars, candles[ev.confirm], minutes, step), ev]).filter(([k]) => k >= 0));
  const out = {
    dir: new Array(n).fill(0), level: new Array(n).fill(NaN), top: new Array(n).fill(NaN), bottom: new Array(n).fill(NaN),
    mid: new Array(n).fill(NaN), inOte: new Array(n).fill(0), sweep: new Array(n).fill(0), entry: new Array(n).fill(0), risk: new Array(n).fill(NaN),
    entries: new Map(),
  };
  let s = null;
  for (let i = 0; i < n; i += 1) {
    const b = bars[i];
    const ev = byEnd.get(i);
    if (ev) s = openState(ev, candles, bars, keyAt, minutes, step, p.expiry, displacementOf(candles, ev.confirm, ev.dir, atrTf, p));
    // A newer CISD replaces the older one on the bar it is known (that bar is read only for the newer one). A bar
    // after the confirming candle (it was known only from this bar: a gap) is read for the bounce at once.
    if (s && (!ev || i > candles[ev.confirm].end)) {
      const risk = step1(s, b, Date.parse(b.t), atr ? atr[i] : NaN, p);
      if (risk > 0) {
        out.entry[i] = s.dir;
        out.risk[i] = risk;
        const z = fib.zone({ origin: s.origin, extreme: s.extreme });
        out.entries.set(i, { direction: s.dir === 1 ? 'long' : 'short', level: s.level, origin: s.origin, extreme: s.extreme, oteTop: z.top, oteBottom: z.bottom, stop: s.stop, sweep: s.sweep ? s.sweep.name : null, confirmedAt: s.confirmedAt });
      }
    }
    if (!s) continue;
    out.dir[i] = s.dir;
    out.level[i] = s.level;
    out.sweep[i] = s.sweep ? 1 : 0;
    if (!DEAD.has(s.status)) {
      const z = fib.zone({ origin: s.origin, extreme: s.extreme });
      out.top[i] = z.top; out.bottom[i] = z.bottom; out.mid[i] = z.mid;
      out.inOte[i] = b.c >= z.bottom && b.c <= z.top ? 1 : 0;
    }
  }
  const lastBar = bars[n - 1];
  out.last = s && lastBar ? { ...s, zone: DEAD.has(s.status) ? null : fib.zone({ origin: s.origin, extreme: s.extreme }), price: lastBar.c } : null;
  return out;
}

/**
 * The latest CISD on `minutes`-minute completed candles as of the last bar, as the briefing shows it: { tf, dir,
 * level, confirmedAt (the confirming candle's open), confirmedClose, run, displacement, engulfing, sweep, leg, ote, status, priceInOte,
 * retracement, bounce ('up' | 'down': the last bar is the bounce out of the zone; only then) } or { tf, none } / { tf, unavailable }. `round` puts a price on the contract's tick (display only).
 */
function cisdFacts(bars, minutes, { levels, atr, params = PARAMS, barMinutes = null, round = x => x } = {}) {
  const tf = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
  const s = cisdSeries(bars, minutes, { levels, atr, params, barMinutes });
  if (s.unavailable) return { tf, unavailable: s.unavailable };
  const st = s.last;
  if (!st) return { tf, none: true };
  const leg = { origin: st.origin, extreme: st.extreme };
  const live = st.zone !== null;
  const r2 = x => Math.round(x * 1000) / 1000;
  return {
    tf, dir: st.dir === 1 ? 'bullish' : 'bearish', level: round(st.level), confirmedAt: st.confirmedAt, confirmedClose: st.confirmedClose,
    run: { startAt: st.runStartAt, candles: st.runCandles },
    displacement: st.displacement, engulfing: st.engulfing,
    sweep: st.sweep ? { name: st.sweep.name, price: round(st.sweep.price) } : null,
    leg: { origin: round(st.origin), originAt: st.originAt, extreme: round(st.extreme) },
    ote: live ? { top: round(st.zone.top), bottom: round(st.zone.bottom), mid: round(st.zone.mid) } : null,
    status: st.status,
    priceInOte: live ? st.price >= st.zone.bottom && st.price <= st.zone.top : false,
    retracement: st.origin !== st.extreme ? r2(fib.retracementOf(leg, st.price)) : null,
    // The bounce out of the OTE zone on this (the last) bar, only when it happened: the entry the series reads.
    ...(s.entry[bars.length - 1] ? { bounce: s.entry[bars.length - 1] > 0 ? 'up' : 'down' } : {}),
  };
}

/**
 * cisd_entry / cisd_risk over two CISD timeframes: the lower one's series (`own`), with the `higher` one's bounce taking
 * the bar when both fire (the higher timeframe preferred); every other series stays the lower one's. Entries say which.
 */
function combineHigher(own, higher, higherMinutes) {
  if (own.unavailable) return own;
  if (higher.unavailable) return own;
  const entry = own.entry.slice();
  const risk = own.risk.slice();
  const entries = new Map(own.entries);
  for (const [i, x] of higher.entries) {
    entry[i] = higher.entry[i];
    risk[i] = higher.risk[i];
    entries.set(i, { ...x, minutes: higherMinutes });
  }
  return { ...own, entry, risk, entries };
}

module.exports = { PARAMS, SNAPSHOT_PARAMS, paramsFrom, findCisds, strongCandle, displacementOf, combineHigher, candlesOf, knownAt, stepMinutes, keyLevelsAt, sweepOf, cisdSeries, cisdFacts };
