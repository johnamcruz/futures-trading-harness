'use strict';

/**
 * The bar briefing: the analysis of one symbol's closed bars, by timeframe,
 * computed once and reused until it expires. The runner builds it after every
 * closed bar from the bars it hands the cycle; every role reads it (the
 * `bar_briefing` harness tool) instead of fetching and computing the same
 * numbers again.
 *
 * Each section holds what changes on its own clock, and is kept until then:
 *
 *   m3     the trigger bar and everything that moves with it: price, ET time
 *          and session window, regime, EMAs, ADX, Keltner, VWAP side (RTH
 *          VWAP in RTH, else the session's), participation, 3m swings and
 *          liquidity, today so far (open, gap, opening type, opening range,
 *          IB, day type), the overnight range so far, the developing session
 *          profile, the latest BOS or CHoCH, sweeps of the key levels in the
 *          last 10 bars, the 1h swings not traded back to, the nearest
 *          liquidity above and below in points and ATR (room to run), where price is against the value areas, IB and prior RTH
 *          range, the scan's candidates, the trend rule, the latest CISD per timeframe (3m, 5m, 15m, 1h:
 *          cisd.js, completed candles; its OTE zone and whether price is in it now), and the completed-candle facts
 *          (candle-facts.js): per timeframe (3m, 5m, 15m, 60m, 4h) the last COMPLETED candle (never the one forming) with its
 *          shape, pattern and how it met the key levels as they stood (fixed ones complete by its open, moving ones at
 *          its close; 5m from a 1m lane's bars when the base bars can't; each one's sweep of its previous candle),
 *          the next swing target each side on the base bars, 15m, 60m and 4h, the last completed 1h and 4h candle's
 *          high, mid and low as targets (and the side the candle forming since has taken), the half of the session's
 *          range price is in, the unfilled FVGs on 5m, 15m and 1h candles with the last candle's retest
 *          (fvg-frames.js), and the 5m structure (the latest BOS or CHoCH on 5m candles, from 1m bars when the base
 *          bars can't: m5-structure.js), and per timeframe (3m, 5m, 15m, 1h) the compression box and its turn into
 *          expansion with the key levels it sits at (compression.js), and in RTH whether the day's trend has
 *          declared itself each side's way (side-signed, in ATR(14): trend-declared.js)   until the next base-bar close
 *   m15    the 15m read (trend, structure, swings, the latest BOS or CHoCH), the alignment per side,
 *          and the 15m candles' indicators (regime, EMAs, ADX and its slope,
 *          SuperTrend, Keltner, ATR), all from completed 15m candles
 *                                                         until the next 15m close
 *   h1     the 1h and 4h reads, the 1h's latest BOS or CHoCH   until the next 1h close
 *   day    the prior RTH day, as a daily candle, and its volume profile   until the first bar after the 16:00 ET RTH close
 *
 * A value lives in the section whose clock it changes on: anything that
 * moves bar by bar (a running high, a developing profile) is in m3.
 *
 * Sections change only on expiry: m15 and h1 read completed candles only, so nothing in them changes before
 * their next close. What moves with price against them (a 3m close through a 15m or 1h swing, the room to the
 * nearest levels) is in m3. Distances are in points and R: 1R is a setup's own stop, else the reference stop
 * (0.5 x ATR(20) of the briefing's own bars), and every R and ATR names its timeframe ("0.5 x 15m ATR(20)").
 *
 * Each section carries a version that changes only when it is recomputed, so
 * whatever was built on it (an analyst's report) stays valid while the
 * versions it used are unchanged.
 *
 *   buildBriefing({ symbol, bars, minutes, prev, scan, scanError, blackouts, clock, roundSteps, now })   the briefing (prev: the
 *                                                              last one, reused where valid; clock: the gate config's entry
 *                                                              windows; roundSteps: the loaded round-number config,
 *                                                              round-numbers.js, passed by the caller that owns it: none, none shown)
 *   current(b, now)                                              whether it is this bar's (its m3 still holds at now)
 *   renderBriefing(b, { now })                                   one text block per section, with validity
 *   briefingFile(home, root) / writeBriefing / readBriefing      <FTH_HOME>/briefing/<MICRO ROOT>.json
 *   nextClose(at, minutes)                                       when the candle containing `at` closes
 *
 * An analyst on its own timeframe (lanes.js analystFrames: 15m or 1h from 3m bars, or another lane's bars) gets a
 * briefing on that timeframe: its `bar` part is the m3 part's facts computed on its own bars (the trend rule is the
 * runner's, the gate's; setups only on a lane's bars), valid until its next bar close. One fact has one value in every
 * briefing: the session's facts (today, overnight, opening range, IB, the VWAPs, the session profile, `location`) are
 * computed on the runner's bars only, so a frame leaves them out (`sessionLevels` points to the runner's briefing) and
 * its levels, room and sweeps are its own bars' (its swings, equal highs and lows, round numbers). A lane's frame,
 * whose setups are traded, adds the runner's session levels (its `keyLevels`, the same values) to its room and its
 * candidates' levels in the way, so a traded setup's room is never computed without them; only from the runner's
 * briefing holding at the lane bar's close (else it throws, and the runner allows no entry on that bar). The runner's briefing's
 * parts that change no faster than its bars (m15 up to 15m bars, h1 up to 1h, day) are shared: read from that
 * briefing, never copied, so every timeframe's briefing names the same versions.
 *
 *   buildFrameBriefing({ symbol, contractId, bars, minutes, first, lane, scan, scanError, barsFile, blackouts, clock, roundSteps, now })
 *                                                                its `bar` part (first: the runner's briefing)
 *   sharedParts(minutes)                                         the runner's parts it shares: ['m15', 'h1', 'day'] up to 15m
 *   frameHolds(f, at)                                            its bar is the one holding at `at`
 *   wholeBars(bars, minutes)                                     the completed `minutes` bars built from `bars`, each opening on
 *                                                                its boundary (a missing first sub-bar never moves it)
 *   frameUntil(closedAt, minutes)                                its bar's end: the next bar's close in market hours (the
 *                                                                last 1h bar before the 16:00 ET break holds to 19:00 ET)
 *   renderFrameBriefing(f, first, { now })                       as text, its `bar` part and the shared parts
 *   frameBriefingFile(home, root, minutes) / writeFrameBriefing / readFrameBriefing / removeFrameBriefing
 *                                                                <FTH_HOME>/briefing/<MICRO ROOT>-<minutes>m.json
 *   sessionWindow(at, clock)                                     { name, until, entries, marketOpen, text, refusal } (the skill's windows, the gate's clock)
 */

const fs = require('fs');
const path = require('path');
const { snapshot, levelsAsOf, priorDayCandle } = require('./market-snapshot');
const { mtfRead, candles, label: tfLabel, RULE_FRAMES } = require('./mtf');
const { normalizeBars, atr: atrOf, sessionKey } = require('./indicators');
const { tradingDayStart, minutesOfDay, entryClock, inMarketHours } = require('./clock');
const { DEFAULT_ENTRY_HOURS, DEFAULT_NO_ENTRY_WINDOWS } = require('./config');
const { familyRoot, tickOf, levelOnTick } = require('./contracts');
const { candidateTrendRule } = require('./signal-state');
const { sideTarget } = require('./order-plan');
const { roundStepFor, roundStepError } = require('./round-numbers');
const { pivots, lastBreaks, breaksOf, sweeps, untestedSwings, swingLevels } = require('./structure-events');
const { timingOf, timingLine } = require('./ltf-timing');
const { sideValuesText, causalLevels } = require('./rules');
const { cisdFacts } = require('./cisd');
const { briefingCandles, briefingTargets, holdingSwingsAt, briefingRangeTargets } = require('./candle-facts');
const { halfOf } = require('./fib');
const { levelCloses, MAX_CLOSES } = require('./level-closes');
const { brokerFieldsAt, brokerFieldsText } = require('./broker-fields');
const { fvgFrames, fvgLine, fvgEdgesAt } = require('./fvg-frames');
const { VOLUME_HIGH, netAtrOf } = require('./composed-reads');
const { structure5m, structureLine } = require('./m5-structure');
const { compressionFrames, compressionLine } = require('./compression');
const { declaredFacts, declaredLine } = require('./trend-declared');
const { biasLine } = require('./bias-line');
const { GLOBEX_OPEN_MIN, RTH_OPEN_MIN, RTH_CLOSE_MIN } = require('./clock'); // the session boundaries' one home

const SECTIONS = ['m3', 'm15', 'h1', 'day'];
const ET = 'America/New_York';

// The session-timing skill's windows (ET minutes of the day, from 00:00): [start, end, name]. They name the time of
// day; whether a new entry is allowed in them is the order gate's clock (FTH_ENTRY_HOURS, FTH_NO_ENTRY_WINDOWS:
// clock.js entryClock; by default no entries in the opening print 09:30-09:35 and into the close 15:45-16:00). The
// daily break is the market closed: the harness stops at 16:00 ET (inside the Topstep trading day, before its 16:10 ET
// flatten) until the 18:00 ET open.
const WINDOWS = [
  [-360, 180, 'asia'], [180, RTH_OPEN_MIN, 'london'], [RTH_OPEN_MIN, 575, 'opening print'], [575, 660, 'opening drive'],
  [660, 690, 'late morning'], [690, 810, 'lunch lull'], [810, 945, 'afternoon'], [945, RTH_CLOSE_MIN, 'into the close'],
  [RTH_CLOSE_MIN, GLOBEX_OPEN_MIN, 'daily break'], [GLOBEX_OPEN_MIN, 1620, 'asia'],
];
const MARKET_CLOSED_WINDOW = 'daily break';
const DEFAULT_ENTRY_CLOCK = { entryHours: DEFAULT_ENTRY_HOURS, noEntryWindows: DEFAULT_NO_ENTRY_WINDOWS };

/** When the `minutes` candle containing `at` closes (candles from the trading day's 18:00 ET open). */
function nextClose(at, minutes) {
  const start = tradingDayStart(at).getTime();
  const step = minutes * 60000;
  return new Date(start + (Math.floor((at.getTime() - start) / step) + 1) * step);
}

/**
 * The session window at `at`: { name, until, entries, marketOpen, text, refusal }. Every fact states its own scope:
 * `text` says whether the market is open, whether a new entry is allowed, and until when, e.g. "opening drive (market
 * open, entries allowed) until 11:00 ET" or "opening print (market open, no entries) until 09:35 ET". `entries`
 * ('allowed' | 'none') is the gate's clock for `clock` ({ entryHours, noEntryWindows }, the gate config; its defaults
 * when not given; { error } when it couldn't be read: no entries), and `until` is the window's end or, sooner, when
 * that changes. `refusal`: the gate's reason.
 */
function sessionWindow(at, clock = DEFAULT_ENTRY_CLOCK) {
  const m = minutesOfDay(at, ET);
  // Asia runs 18:00-03:00 across midnight: before 03:00 it is the window that started at 18:00 the evening before.
  const [, end, name] = WINDOWS.find(([a, b]) => m >= a && m < b && !(a < 0 && m >= GLOBEX_OPEN_MIN));
  const start = at.getTime() - (at.getUTCSeconds() * 1000 + at.getUTCMilliseconds());
  let until = new Date(start + (end - m) * 60000);
  const marketOpen = name !== MARKET_CLOSED_WINDOW;
  // A gate config that couldn't be read ({ error }): whether the gate allows an entry is unknown, so none.
  const unknown = clock && clock.error ? `the gate config can't be read (${clock.error}): entries refused until it can` : null;
  const refusalAt = unknown ? () => unknown : entryClock(clock || DEFAULT_ENTRY_CLOCK);
  const refusal = marketOpen ? refusalAt(at) : 'closed 16:00-18:00 ET: the harness stops at 16:00 ET, before Topstep\'s 16:10 ET flatten';
  // The gate's windows are minute-grained: the first minute before the window's end where the answer changes.
  if (marketOpen) {
    for (let t = start + 60000; t < until.getTime(); t += 60000) {
      if (!refusalAt(new Date(t)) !== !refusal) { until = new Date(t); break; }
    }
  }
  const entries = refusal ? 'none' : 'allowed';
  const scope = `${marketOpen ? 'market open' : 'market closed'}, ${entries === 'allowed' ? 'entries allowed' : 'no entries'}`;
  return { name, until, entries, marketOpen, text: `${name} (${scope}) until ${etClock(until)} ET`, refusal };
}

/**
 * When the prior RTH day next changes: the first bar that opens at or after 16:00 ET completes today's RTH day, so a
 * section computed on the bar opening at `barOpen` holds until that bar closes (the next 16:00 ET after the bar's
 * open, strictly, plus one bar).
 */
function nextRthRoll(barOpen, minutes) {
  const m = minutesOfDay(barOpen, ET);
  const ahead = (RTH_CLOSE_MIN - m + 1440) % 1440 || 1440;
  return new Date(barOpen.getTime() + (ahead + minutes) * 60000 - (barOpen.getUTCSeconds() * 1000 + barOpen.getUTCMilliseconds()));
}

const etClock = at => new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
const round2 = x => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const frameOf = (read, minutes) => (read.frames.find(f => f.minutes === minutes) || {}).read || null;
// A higher-timeframe read (mtf.js): its EMAs are EMA20 and EMA50 (named so: the 3m and 15m indicators are EMA9/EMA20),
// its swing pattern, and the last 20 candles' range (high, low) with its 50% (not a swing-to-swing dealing range).
// Swing levels against price are in m3 (they move with price).
const brief = (f, level = round2) => (f ? {
  trend: f.trend, bias: f.bias, swingPattern: f.votes && f.votes.structure, close: f.close, ema20: f.emaFast, ema50: f.emaSlow, adx: f.adx, atr: f.atr,
  range: f.levels && Number.isFinite(f.levels.rangeHigh) ? { high: f.levels.rangeHigh, low: f.levels.rangeLow, mid: level((f.levels.rangeHigh + f.levels.rangeLow) / 2) } : null,
  ...(f.note ? { note: f.note } : {}),
} : null);
/** A higher timeframe's break: its times are candle opens (as on the 3m), and knownAt is the breaking candle's close. */
const atClose = (lb, mins) => {
  const shift = x => (x ? { ...x, knownAt: new Date(Date.parse(x.at) + mins * 60000).toISOString() } : null);
  return { last: shift(lb.last), previous: shift(lb.previous) };
};
/** A profile summary's levels to the cent (as the snapshot gives them without a tick): room, R and labels use these. */
const cents = p => (p ? { ...p, ...Object.fromEntries(['poc', 'vah', 'val', 'low', 'high', 'hvnAbove', 'hvnBelow', 'lvnAbove', 'lvnBelow'].map(k => [k, round2(p[k])])), hvn: (p.hvn || []).map(round2), lvn: (p.lvn || []).map(round2) } : {});
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const EQUAL_K = require('../tunables').analysis().briefing.equalK; // the snapshot's swing confirmation (bars after the pivot; config/analysis.json)
// A frame's pointer for what it leaves out: the session's facts are the runner's briefing's, one value each.
const SESSION_ELSEWHERE = 'is in the runner\'s bar briefing (bar_briefing without a timeframe)';
// The m3 fields a frame leaves out: the session's facts (computed on the runner's bars only).
const SESSION_FIELDS = ['vwap', 'today', 'overnight', 'sessionProfile', 'priorProfileNodes', 'location', 'declared'];

// The timeframes the CISD facts are read on (completed candles; one the bars can't build is unavailable).
const CISD_FRAMES = require('../tunables').analysis().briefing.cisdFrames;

/** The latest CISD per timeframe, compact (cisd.js cisdFacts; prices on the tick by `level`). */
function cisdBlock(bars, level, levels = causalLevels(bars)) {
  const atr = atrOf(bars, 20);
  const out = {};
  for (const m of CISD_FRAMES) {
    const f = cisdFacts(bars, m, { levels, atr, round: level });
    if (f.unavailable) { out[f.tf] = `unavailable (${f.unavailable})`; continue; }
    if (f.none) { out[f.tf] = 'none in these bars'; continue; }
    out[f.tf] = {
      dir: f.dir, level: f.level, confirmedClose: f.confirmedClose, displacement: f.displacement, engulfing: f.engulfing, sweep: f.sweep, leg: { origin: f.leg.origin, extreme: f.leg.extreme },
      ote: f.ote, status: f.status, priceInOte: f.priceInOte, retracement: f.retracement, ...(f.bounce ? { bounce: f.bounce } : {}),
    };
  }
  return out;
}

// The key levels a completed candle is read against: value areas, VWAP, the prior day, overnight, IB and opening range
// (and the 15m and 1h swings, the round numbers in its range, its previous candle and the CRT range: candle-facts.js).
// The moving ones among them (read at a candle's close); the rest are fixed (read as they stood at its open).
const MOVING = /^(VWAP|session (POC|VAH|VAL))/;
// The fixed ones a bar's own value includes once it completes them (read on the last bar closed by a candle's open).
const AT_OPEN = /^(overnight|IB)/;
const CANDLE_LEVELS = /^(prior (POC|VAH|VAL|RTH high|RTH low|RTH close)|session (POC|VAH|VAL)|VWAP|overnight (high|low)|IB (high|low)|opening range (high|low))/;
/** The snapshot's levels as of a bar (market-snapshot levelsAsOf), named as the briefing names them. */
function namedLevels(x) {
  const pp = x.priorProfile || {};
  const sp = x.sessionProfile || {};
  const or = x.openingRange || {};
  const ib = x.ib || {};
  return [
    ['IB high', ib.high], ['IB low', ib.low], ['opening range high', or.high], ['opening range low', or.low],
    [`VWAP (${x.vwapApplies})`, round2(x.vwapApplies === 'rth' ? x.vwapRth : x.vwapSession)],
    ['prior RTH high', (x.priorRth || {}).high], ['prior RTH low', (x.priorRth || {}).low], ['prior RTH close', (x.priorRth || {}).close],
    ['overnight high', (x.overnight || {}).high], ['overnight low', (x.overnight || {}).low],
    ['prior VAH', pp.vah], ['prior VAL', pp.val], ['prior POC', pp.poc], ['session VAH', sp.vah], ['session VAL', sp.val], ['session POC', sp.poc],
  ].filter(([, p]) => Number.isFinite(p));
}

/** Each section's data and expiry, from this bar's snapshot and read. */
function computeSections({ bars, fine = null, c15, c60, snap, snap15, read, read15, readH1, scan, scanError, minutes, closedAt, blackouts, clock, tick, grid = null, roundStep = null, roundError = null, own = false, keyLevels = null }) {
  // A price level as the model reads it, on the contract's tick (grid: contracts.js; two decimals for a root it doesn't
  // list). Display only: room, R and every other decision input are computed from the unrounded levels.
  const level = x => (Number.isFinite(x) ? (grid ? levelOnTick(x, grid) : round2(x)) : null);
  const t = snap.trend || {};
  const vp = snap.volumeProfile || {};
  const lv = snap.levels || {};
  const day = snap.day || {};
  const price = snap.last.c;
  const win = sessionWindow(closedAt, clock);
  const f15 = frameOf(read15, 15);
  const f60 = frameOf(readH1, 60);
  // The profiles' exact levels (shown on the tick by `level`), and the same to the cent: what room, R and the value
  // labels are computed from, as they always were.
  const priorX = vp.priorRth || {};
  const sessX = vp.session || {};
  const prior = cents(priorX);
  const sess = cents(sessX);
  const liq = snap.liquidity || {};
  const st = snap.structure || {};
  // The VWAP that applies: the RTH VWAP from 09:30 to 16:00 ET, else the session's (18:00 ET), as the strategy filters use.
  const applies = (snap.vwap || {}).applies || null;
  const vwapRef = applies === 'rth' ? lv.vwapRth : lv.vwapSession;
  const t15 = (snap15 && snap15.trend) || {};
  // 1R without a setup: the reference stop, 0.5 x ATR(20), the stop the strategies are built on (a setup's own stop is its 1R).
  const oneR = (snap.referenceStop || {}).distance;
  const tf = `${minutes}m`;
  const step = minutes * 60000;
  const after = (iso, k = EQUAL_K) => new Date(Date.parse(iso) + k * step).toISOString();
  // A 1h swing counts as tested only by bars after its hour closed (the bars inside it made it).
  const swings1h = pivots(c60);
  const untested1h = untestedSwings(bars, [...swings1h.filter(x => x.type === 'high').slice(-4), ...swings1h.filter(x => x.type === 'low').slice(-4)]
    .map(x => ({ ...x, end: new Date(Date.parse(x.t) + 3600000).toISOString() })));
  // The 15m and 1h swings, and whether a 3m close has gone through each since its candle closed (per bar).
  const htf = (cs, mins, label) => swingLevels(cs, 2, 3).map(x => {
    const end = Date.parse(x.t) + mins * 60000;
    const b = bars.find(y => Date.parse(y.t) >= end && (x.type === 'high' ? y.c > x.price : y.c < x.price));
    // On a frame, a close of its own bars breaks it (the runner's briefing counts its own closes): named, as a different fact.
    return { name: `${label} swing ${x.type}`, type: x.type, price: x.price, side: side(x.price, price), brokenAt: b ? b.t : null, ...(own ? { brokenBy: `a ${tf} close` } : {}) };
  });
  // Per timeframe: the swings still holding, and the latest one a 3m close went through (with when).
  const holdAndLastBreak = list => {
    const broken = list.filter(x => x.brokenAt).sort((x, y) => Date.parse(y.brokenAt) - Date.parse(x.brokenAt))[0];
    return [...list.filter(x => !x.brokenAt), ...(broken ? [broken] : [])];
  };
  // On a frame (`own`, 15m up to 1h), only the timeframes at or above its own: its bars can't make a shorter one's swings.
  const htfLevels = [...(own && minutes > 15 ? [] : holdAndLastBreak(htf(c15, 15, '15m'))), ...holdAndLastBreak(htf(c60, 60, '1h'))];
  const ownSwing = own ? tf : '3m';
  // Equal highs (lows) still untaken: no bar since their last touch traded above (below) them.
  const pool = (list, type) => (list || []).map(x => {
    const level = type === 'high' ? Math.max(...x.prices) : Math.min(...x.prices);
    const times = x.at.map(Date.parse).sort((a, b) => a - b);
    const since = after(new Date(times[times.length - 1]).toISOString());
    const beyond = b => (type === 'high' ? b.h > level : b.l < level);
    // Taken: traded beyond after the last touch, or between the touches (outside the touches' own swing bars).
    const between = b => { const t = Date.parse(b.t); return t > times[0] + EQUAL_K * step && t < times[times.length - 1] - EQUAL_K * step; };
    const taken = bars.some(b => (Date.parse(b.t) > Date.parse(since) || between(b)) && beyond(b));
    return { name: type === 'high' ? 'equal highs' : 'equal lows', price: level, since, taken };
  });
  // The runner's base bars are the chain's entry frame (the entry rule holds the lane to it): never a level (the owner:
  // "We should never use entry timeframes as levels"; chain.js). Their swings, equal highs and lows and gaps stay out
  // of the levels, the room, the sweeps and the liquidity lists; their candles stay as candle facts. A frame's own
  // bars (15m and up) are no entry frame: its swings stand.
  const entryBars = !own;
  const eqHighs = entryBars ? [] : pool(liq.equalHighs, 'high');
  const eqLows = entryBars ? [] : pool(liq.equalLows, 'low');
  const rth = applies === 'rth';
  // The round numbers on the family's step (contracts.js), none for a root without one: the one just above and
  // the one just below price; price on one: that one ("at") and the next above and below.
  // Each is shown as every other level is (level(): on the contract's tick), so 30.125 on a 0.005 tick stays 30.125.
  const { at: roundOn, levels: roundLevels } = roundNumbers(price, roundStep);
  const roundAt = roundOn === null ? [] : [['round number', roundOn]];
  // The session levels (the day, IB, opening range, session range, VWAP, prior RTH, overnight, the profiles): computed
  // on the runner's bars only (exported as the briefing's `keyLevels`). A frame never computes them on its own bars (they
  // would differ: no 1h bar opens at 09:30): one fact has one value in every briefing. A lane's frame, whose setups
  // are traded, takes the runner's (`keyLevels`), so its room and its candidates' levels in the way are never
  // without them; an analyst's frame shows only its own levels and points to the runner's briefing for the rest.
  const ownSession = [
    ['day high', rth ? day.high : null], ['day low', rth ? day.low : null], ['IB high', day.ibHigh], ['IB low', day.ibLow],
    ['opening range high', (lv.openingRange || {}).high], ['opening range low', (lv.openingRange || {}).low],
    ['session high', ((snap.context || {}).session || {}).high], ['session low', ((snap.context || {}).session || {}).low],
    [`VWAP (${applies || 'session'})`, round2(vwapRef)],
    ['prior RTH high', (lv.priorRth || {}).high], ['prior RTH low', (lv.priorRth || {}).low], ['prior RTH close', (lv.priorRth || {}).close],
    ['overnight high', (lv.overnight || {}).high], ['overnight low', (lv.overnight || {}).low],
    // The profile's levels (row centers, off the tick) carry their shown price, on the tick.
    ['prior VAH', prior.vah, level(priorX.vah)], ['prior VAL', prior.val, level(priorX.val)], ['prior POC', prior.poc, level(priorX.poc)],
    ['session VAH', sess.vah, level(sessX.vah)], ['session VAL', sess.val, level(sessX.val)], ['session POC', sess.poc, level(sessX.poc)],
  ].filter(([, p]) => Number.isFinite(p));
  const sessionLevels = own ? keyLevels || [] : ownSession;
  // The VWAP that applies, for a frame from the runner's levels (its value, against this bar's price).
  const runnerVwap = own ? (sessionLevels.find(([n]) => /^VWAP /.test(n)) || [])[1] : null;
  const levels = [
    ...sessionLevels,
    ...(entryBars ? [] : [[`last ${ownSwing} swing high`, st.lastSwingHigh], [`last ${ownSwing} swing low`, st.lastSwingLow]]),
    ...htfLevels.filter(x => !x.brokenAt).map(x => [x.name, x.price]),
    ...untested1h.map(x => [`untested 1h swing ${x.type}`, x.price]),
    ...[...eqHighs, ...eqLows].filter(x => !x.taken).map(x => [x.name, x.price]),
    ...roundLevels.map(x => ['round number', x, level(x)]),
  ];
  const room = {
    ...nearest(price, oneR, levels, tick),
    ...(roundAt.length ? { at: roundAt.map(([name, p]) => ({ name, price: level(p), points: 0, R: 0 })) } : {}),
    // A configured step that was refused (round-numbers.js): none shown, and why.
    ...(roundError ? { roundNumbers: roundError } : {}),
  };
  // The key levels a completed candle is read against. A FIXED one (the prior day, overnight, opening range, IB, the
  // prior profile, the 15m and 1h swings still holding) counts when it was complete by the candle's open (its last bar
  // closed at or before it), at its value then: never a level the candle's own bars made, nor one formed later. Each is
  // read from the snapshot's own code (levelsAsOf) on the bar where it first holds that value without the candle's own
  // data: overnight, IB and swings on the last bar closed by the open (openIdx: they include their completing bar);
  // the opening range, the prior day and the prior profile on the candle's first bar (firstIdx: they appear on the bar
  // after they complete, from earlier bars only). A MOVING one (VWAP, the developing session profile) at the candle's
  // CLOSE (base bar idx: this bar's are the briefing's own, one value per level as above).
  const ownLevels = levels.filter(([name]) => CANDLE_LEVELS.test(name));
  const asOf = new Map();
  const named = k => { if (!asOf.has(k)) asOf.set(k, k >= 0 ? namedLevels(levelsAsOf(bars, k)) : []); return asOf.get(k); };
  // At a new session's first candle (18:00 ET, Sunday's open) the last session's overnight range and IB are stale: no
  // level (the opening range reads the candle's own first bar, so it is the new session's; the prior RTH day is the
  // day that just closed). The rules language does the same (candle-facts.js relationSeries, `session`).
  const sameSession = (a, b) => a >= 0 && b >= 0 && sessionKey(bars[a].t, GLOBEX_OPEN_MIN) === sessionKey(bars[b].t, GLOBEX_OPEN_MIN);
  const levelsAt = (idx, openIdx, firstIdx) => [
    ...(sameSession(openIdx, firstIdx) ? named(openIdx).filter(([name]) => AT_OPEN.test(name)) : []),
    ...named(firstIdx).filter(([name]) => !AT_OPEN.test(name) && !MOVING.test(name)),
    ...(idx === bars.length - 1 ? ownLevels : named(idx)).filter(([name]) => MOVING.test(name)),
    ...(openIdx >= 0 ? [15, 60].flatMap(m => holdingSwingsAt(bars, m, minutes, openIdx)) : []).map(x => [`${x.label} swing ${x.type} ${x.price}`, x.price]),
  ];
  // The fair value gaps' edges as of a base bar (a candle's open), once per bar: the candles' fvgRelations.
  const zones = new Map();
  const zonesOf = (k, until) => {
    const key = `${k}:${until}`;
    if (!zones.has(key)) zones.set(key, fvgEdgesAt({ bars, base: minutes, fine, at: k, until }));
    return zones.get(key);
  };
  // The key levels a box sits at: those that stood when it began (its first candle's open, `from`: levelsAt on the last
  // base bar closed by then, the rule a completed candle is read by) and still stand at the same value now (this bar's
  // `levels`, by name, within a tick), so never one the box made or moved, and one value per level in the briefing: a
  // moving level (VWAP, the developing profile) or a forming one (overnight, IB, opening range) that changed since is
  // none of them. A swing's name carries its price (holdingSwingsAt); it stands while this bar names that swing.
  const boxLevels = from => {
    const t = Date.parse(from);
    let k = bars.length - 1;
    while (k >= 0 && Date.parse(bars[k].t) + step > t) k -= 1;
    if (!(k >= 0 && k + 1 < bars.length)) return [];
    const nowByName = new Map();
    for (const [name, p] of levels) if (Number.isFinite(p)) nowByName.set(name, [...(nowByName.get(name) || []), p]);
    // Its value now when it still stands (within a tick of its value then), else null.
    const nowOf = (name, p) => {
      const swing = /^(.* swing (?:high|low)) -?\d+(?:\.\d+)?$/.exec(name);
      const q = (nowByName.get(swing ? swing[1] : name) || []).find(x => Math.abs(x - p) <= tick + 1e-9);
      return q === undefined ? null : q;
    };
    // At its value now, shown on the contract's tick as every other level (level()); the box's edges read the exact one.
    return levelsAt(k, k, k + 1).map(([name, p]) => [name, Number.isFinite(p) ? nowOf(name, p) : null]).filter(([, q]) => q !== null).map(([name, q]) => [name, q, level(q)]);
  };
  const news = newsState(blackouts, closedAt);
  // In a no-entry window, the window itself (its name, scope and end) is the reason a candidate is blocked.
  const noEntry = win.entries === 'none' ? win.text : false;
  const bar = snap.last;
  const atr14 = (snap.volatility || {}).atr14;
  const sessionRange = (snap.context || {}).session || null;
  // The rules language's causal levels (rth_open, the prior day, overnight), once: the CISD's sweep and the closes read them.
  const causal = causalLevels(bars);
  // This bar's close against the session's levels (level-closes.js), each placed with its owner below, only when it
  // happened; the summary's "This bar's close" line says them (not repeated in the detail: SUMMARY_ONLY).
  const closes = own ? {} : levelCloses(bars, bars.length - 1, { levels: causal });
  return {
    m3: {
      validUntil: new Date(closedAt.getTime() + step),
      data: {
        price, bar: { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v, rangeAtr: atr14 > 0 ? round2((bar.h - bar.l) / atr14) : null },
        // The session window, with its scope stated: whether the market is open and entries are allowed, and until when.
        et: etClock(closedAt), window: win.name, windowUntil: win.until.toISOString(), windowEntries: win.entries, marketOpen: win.marketOpen, windowText: win.text, windowRefusal: win.refusal,
        // R: every distance below is in points and R; 1R here is the reference stop (a setup's own stop is its 1R).
        // 1R names its timeframe: the reference stop on a 15m frame is the 15m ATR's, not the runner's.
        oneR: Number.isFinite(oneR) ? { points: round2(oneR), basis: `0.5 x ${tf} ATR(20) ${round2(2 * oneR)}, the ${tf} reference stop` } : null,
        news,
        regime: snap.regime ? { primary: snap.regime.primary, volatility: snap.regime.volatility, tags: snap.regime.tags, metrics: snap.regime.metrics } : null,
        trend: { ema9: round2(t.emaFast), ema20: round2(t.emaSlow), ema50: round2(t.ema50), ema200: round2(t.ema200), adx: t.adx, adxSlope: t.adxSlope, supertrend: t.supertrend ? { direction: t.supertrend.direction, line: round2(t.supertrend.line) } : null, keltner: t.keltner ? { upper: round2(t.keltner.upper), mid: round2(t.keltner.mid), lower: round2(t.keltner.lower) } : null },
        priceVsEma9: side(price, t.emaFast),
        atr14: round2(atr14),
        vwap: { applies, session: round2(lv.vwapSession), rth: round2(lv.vwapRth), side: side(price, vwapRef), distanceAtr: (snap.vwap || {}).distanceAtr,
          // Closes crossing each VWAP in the last 30 bars, labeled by the VWAP: the session one is the regime's sessionVwapCrosses.
          rthCrossesLast30: (snap.vwap || {}).rthCrossesLast30 ?? null, sessionCrossesLast30: (snap.vwap || {}).sessionCrossesLast30 ?? null,
          ...(closes.vwapCrossed ? { crossed: closes.vwapCrossed } : {}) },
        participation: snap.participation ? omit(snap.participation, ['note']) : null,
        // The counters the strategies' skip rules name (EMA crosses, ADX falling, Keltner squeeze and band-close streak,
        // SuperTrend flips, the last 5 bars' range in ATR).
        context: snap.context ? omit(snap.context, ['volVsAvg60', 'session']) : null,
        referenceStop: snap.referenceStop ? { distance: round2(snap.referenceStop.distance), long: round2(snap.referenceStop.long), short: round2(snap.referenceStop.short) } : null,
        swings: { high: st.lastSwingHigh, highAt: st.lastSwingHighAt, low: st.lastSwingLow, lowAt: st.lastSwingLowAt },
        // Liquidity on the trigger bars: recent swing points, equal highs and lows (with whether taken), fair value gaps open and partly filled.
        // The entry frame's swings stay for the stop beyond them (invalidation's 'stop swing low|high': structure, never a
        // level, target or room); its equal highs and lows and its gaps are levels, so none.
        liquidity: entryBars ? { swingHighs: liq.swingHighs, swingLows: liq.swingLows, equalHighs: [], equalLows: [], openFvgs: [], partlyFilledFvgs: [] }
          : { swingHighs: liq.swingHighs, swingLows: liq.swingLows, equalHighs: eqHighs.map(x => omit(x, ['since'])), equalLows: eqLows.map(x => omit(x, ['since'])), openFvgs: liq.openFvgs, partlyFilledFvgs: liq.partlyFilledFvgs || [] },
        // Structure events (structure-events.js): the latest break on the trigger bars, sweeps of key liquidity in the last
        // 10 bars (only levels that existed before the sweep), the 1h swings not traded back to, and the 15m and 1h swings
        // against price (a 3m close through one since its candle closed: brokenAt).
        lastBreak: lastBreaks(bars),
        sweeps: sweeps(bars, [
          // The session's key levels: the runner's bars only (a frame's sweeps are of its own levels).
          ...(own ? [] : [['prior RTH high', (lv.priorRth || {}).high, 'high', true], ['prior RTH low', (lv.priorRth || {}).low, 'low', true]]),
          // The overnight range is final at 09:30 ET: its sweeps count in RTH only.
          ...(rth && !own ? [['overnight high', (lv.overnight || {}).high, 'high', true], ['overnight low', (lv.overnight || {}).low, 'low', true]] : []),
          ...(entryBars ? [] : [[`last ${ownSwing} swing high`, st.lastSwingHigh, 'high', false, st.lastSwingHighAt ? after(st.lastSwingHighAt) : null],
            [`last ${ownSwing} swing low`, st.lastSwingLow, 'low', false, st.lastSwingLowAt ? after(st.lastSwingLowAt) : null]]),
          ...eqHighs.map(x => [x.name, x.price, 'high', false, x.since]), ...eqLows.map(x => [x.name, x.price, 'low', false, x.since]),
        ].map(([name, p, sideOf, key = false, since = null]) => ({ name, price: p, side: sideOf, key, since })), 10),
        htfLevels,
        untested1hSwings: untested1h,
        // The room to run: the three nearest levels above and below price, in points and R.
        nearestLiquidity: room,
        // Today so far and the developing levels: they move bar by bar.
        today: { open: day.open, gap: day.gap, openVs: day.openVs, openType: day.openType, openingRange: lv.openingRange || null, high: day.high, low: day.low, range: day.range, ibHigh: day.ibHigh, ibLow: day.ibLow, ibRange: day.ibRange, extUp: day.extUp, extDown: day.extDown, dayType: day.dayType, rangeVsAdr: day.adr ? round2(day.range / day.adr) : null,
          ...(closes.openingRangeCrossed ? { openingRangeCrossed: closes.openingRangeCrossed } : {}) },
        overnight: lv.overnight || null,
        sessionProfile: sess.poc ? { poc: level(sessX.poc), vah: level(sessX.vah), val: level(sessX.val), hvnAbove: level(sessX.hvnAbove), hvnBelow: level(sessX.hvnBelow), lvnAbove: level(sessX.lvnAbove), lvnBelow: level(sessX.lvnBelow) } : null,
        priorProfileNodes: prior.poc ? { hvnAbove: level(priorX.hvnAbove), hvnBelow: level(priorX.hvnBelow), lvnAbove: level(priorX.lvnAbove), lvnBelow: level(priorX.lvnBelow) } : null,
        // Where price is against the levels.
        location: {
          // From the levels to the cent, not the shown ticks: a shown VAH a tick under price can read inside.
          priorValue: where(price, prior.val, prior.vah), sessionValue: sess.poc ? where(price, sess.val, sess.vah) : null,
          initialBalance: where(price, day.ibLow, day.ibHigh), priorRthRange: lv.priorRth ? where(price, lv.priorRth.low, lv.priorRth.high) : null,
          priorRthClose: lv.priorRth ? side(price, lv.priorRth.close) : null,
          // The half of the session's range so far (from 18:00 ET) price is in (fib.js halfOf): premium, discount or equilibrium.
          sessionRangeHalf: sessionRange ? halfOf({ origin: sessionRange.low, extreme: sessionRange.high }, price) : null,
          ...(closes.closesBeyondValue ? { closesBeyondValue: closes.closesBeyondValue } : {}),
          ...(closes.backInsideValue ? { backInsideValue: closes.backInsideValue } : {}),
        },
        // The scan's candidates, each with its stop (its 1R), its exit, and the first level in its way in points and R.
        // null: the scan failed or the bar wasn't scanned, so what fired is unknown (not "nothing fired").
        candidates: scan ? scan.filter(r => r.candidate && r.direction).map(r => candidate(r, price, levels, { noEntry, news, lunch: /lunch/.test(win.name), alignment: read15.alignment, vwapSide: own ? side(price, runnerVwap) : side(price, vwapRef), tick })) : null,
        ...(scan ? {} : { scanError: scanError || 'the scan failed this bar' }),
        trendRule: read.lines[read.lines.length - 1],
        // The latest CISD per timeframe on completed candles, with its displacement leg's OTE zone (cisd.js, fib.js).
        cisd: cisdBlock(bars, level, causal),
        // The broker's own fields on the last 3 bars, as served (broker-fields.js): no meaning given here. In the JSON in
        // full; the summary's "Broker bar fields" line says them compactly (not repeated in the detail: SUMMARY_ONLY).
        brokerFields: brokerFieldsAt(bars, bars.length - 1),
        // Per timeframe, the last completed candle's facts and the levels it met; the next swing target each side.
        // Not on a frame's own bars: its candle facts are the runner's (buildFrameBriefing), one value per level.
        // fvgRelations: how each candle met the 5m, 15m and 1h gaps' edges as they stood at its open (fvg-frames.js).
        candles: own ? null : briefingCandles({ bars, base: minutes, fine, levelsAt, zonesAt: zonesOf, roundStep }),
        swingTargets: own ? null : briefingTargets({ bars, minutes, price, oneR, tick, frames: [15, 60, 240] }),
        // The last completed 1h and 4h candle's high, mid and low as targets, and the side the candle forming since has
        // taken, only when it has (candle-facts.js; the runner's, as above).
        rangeTargets: own ? null : briefingRangeTargets({ bars, base: minutes, price, oneR, tick }),
        // The unfilled fair value gaps on completed 5m, 15m and 1h candles, each with its last candle's retest (fvg-frames.js).
        fvgs: own ? null : fvgFrames({ bars, base: minutes, fine }),
        // The latest BOS or CHoCH and the last swings on completed 5m candles: base bars that divide 5m, else a 1m
        // lane's bars; without them unavailable, with why (m5-structure.js).
        structure5m: own ? null : structure5m({ bars, base: minutes, fine }),
        // Per timeframe, compression and its turn into expansion on completed candles, with the key levels its box sits
        // at as they stood when the box began (compression.js; boxLevels: the candles' levelsAt, never one the box made).
        compression: own ? null : compressionFrames({ bars, base: minutes, fine, price, levels: boxLevels }),
        // Whether the day's trend has declared itself each side's way (trend-declared.js): side-signed, in ATR(14), from
        // this bar's close, the RTH VWAP distance (the VWAP line's), EMA20, the RTH open and the overnight range; in RTH on the runner's bars only.
        declared: own || !rth ? null : declaredFacts({ price, atr: atr14, vwapAtr: (snap.vwap || {}).distanceAtr, ema20: t.emaSlow, open: day.open, overnight: day.overnight, regime: (snap.regime || {}).primary }),
      },
    },
    m15: {
      validUntil: nextClose(closedAt, 15),
      data: {
        frame: brief(f15, level),
        alignment: read15.alignment,
        lastBreak: atClose(lastBreaks(c15), 15),
        // The 15m candles' own indicators (completed candles only): EMA9 and EMA20, as on the trigger bars.
        indicators: snap15 ? {
          regime: snap15.regime && { primary: snap15.regime.primary, volatility: snap15.regime.volatility },
          ema9: round2(t15.emaFast), ema20: round2(t15.emaSlow), adx: t15.adx, adxSlope: t15.adxSlope,
          supertrend: t15.supertrend ? { direction: t15.supertrend.direction, line: round2(t15.supertrend.line) } : null,
          keltner: t15.keltner ? { upper: round2(t15.keltner.upper), mid: round2(t15.keltner.mid), lower: round2(t15.keltner.lower) } : null,
          atr14: round2((snap15.volatility || {}).atr14),
        } : null,
      },
    },
    h1: {
      validUntil: nextClose(closedAt, 60),
      data: { h1: brief(f60, level), h4: brief(frameOf(readH1, 240), level), lastBreak: atClose(lastBreaks(c60), 60) },
    },
    day: {
      // The prior RTH day changes at the RTH close (16:00 ET).
      validUntil: nextRthRoll(new Date(closedAt.getTime() - step), minutes),
      data: {
        priorRth: lv.priorRth || null,
        // The prior RTH day as a daily candle: its open, direction, close location, and close against the day before.
        priorRthCandle: priorDayCandle(bars),
        priorProfile: prior.poc ? { poc: level(priorX.poc), vah: level(priorX.vah), val: level(priorX.val), hvn: (priorX.hvn || []).map(x => level(x)), lvn: (priorX.lvn || []).map(x => level(x)) } : null,
      },
    },
    keyLevels: own ? null : ownSession,
  };
}

/**
 * A scan candidate with its 1R (its stop), its exit, its target, the levels ahead of it in points and its own R (the
 * first is the one in its way), the room it needs, and its context as facts: what the trend rule says for its side,
 * the multi-timeframe read for its side, confluence, the VWAP side, the window and the news. Context for the roles,
 * never a verdict: the strategy's STRATEGY.md and the skills (the trend rule, the multi-timeframe table, the
 * strategy's skip rules and min R:R, a policy verdict placed as given) decide. `blocked`: the gate refuses an entry now.
 */
function candidate(r, price, levels, { noEntry = false, news = null, lunch = false, alignment = {}, vwapSide = null, tick = 0.25 } = {}) {
  const R = r.stopDistance;
  const up = r.direction === 'long';
  // Its own three nearest levels in its direction, in its own R (its stop): the first is the one in its way.
  const ahead = merge(levels.filter(([, p]) => Number.isFinite(p) && (up ? p > price : p < price)).sort(([, a], [, b]) => (up ? a - b : b - a)), tick).slice(0, 3)
    .map(([name, p, shown]) => ({ name, price: shown ?? p, points: round2(Math.abs(p - price)), R: R > 0 ? round2(Math.abs(p - price) / R) : null }));
  const exit = r.exit || {};
  const inTheWay = R > 0 ? ahead[0] || null : null;
  // Its target: a level target's distance (the scan's targetDistance), else targetR x its stop.
  const targetPoints = Number.isFinite(r.targetDistance) ? r.targetDistance : Number.isFinite(exit.targetR) && R > 0 ? exit.targetR * R : null;
  const target = targetPoints !== null ? { level: sideTarget(exit.target, r.direction), points: round2(targetPoints), R: R > 0 ? round2(targetPoints / R) : null } : null;
  // The room it needs: to its trail activation, else its target, else its min R:R, else 2R.
  const needR = exit.trailActivateR ?? (target && target.R) ?? r.minRR ?? 2;
  const mtf = r.mtf || {};
  const allowed = up ? mtf.longAllowed : mtf.shortAllowed;
  const align = (alignment && alignment[up ? 'long' : 'short']) || null;
  const conf = r.confluence || { with: [], against: [] };
  // Never counter: a reversal strategy is held to the trend rule like any other; its fact says so when it is.
  // The scan's trend-rule summary names it as text: '4h up' (mtf.ruleSummary).
  const pm = /^(\S+) (up|down)$/.exec(String(mtf.prevailing || ''));
  const prev = pm ? { label: pm[1], trend: pm[2] } : null;
  const fading = prev && (up ? prev.trend === 'down' : prev.trend === 'up');
  const reversalFact = fading ? `a reversal strategy fading the prevailing ${prev.label} ${prev.trend} trend: the trend rule's read for it unknown`
    : prev ? `a reversal strategy, with the prevailing ${prev.label} ${prev.trend} trend` : 'a reversal strategy, no prevailing trend read';
  const facts = [
    allowed === false ? `against the trend rule for a ${r.direction}` : mtf.style === 'reversal' ? reversalFact : allowed === true ? `the trend rule allows a ${r.direction}` : 'the trend rule unknown',
    `multi-timeframe read for a ${r.direction}: ${align || 'unknown'}`,
    // The room as a fact, never a verdict: the first level ahead beside the R it aims for (the count weighs it).
    inTheWay ? `first level ahead: ${inTheWay.name} at ${inTheWay.R}R; it aims for ${needR}R`
      : R > 0 ? `no level ahead found; it aims for ${needR}R` : 'its stop is unknown, so no R',
    `confluence: ${(conf.with || []).length ? `with ${conf.with.join(', ')}` : 'none with it'}${(conf.against || []).length ? `; against ${conf.against.join(', ')}` : ''}`,
    vwapSide === 'at' ? 'price at the VWAP' : vwapSide ? `price ${vwapSide} the VWAP (${(up ? vwapSide === 'above' : vwapSide === 'below') ? 'its side' : 'the other side'})` : 'the VWAP unknown',
    ...(lunch ? ['lunch lull'] : []),
  ];
  const newsBlock = !news || news.inBlackout === false ? null : news.inBlackout === true ? 'news blackout' : 'news unknown (the blackouts file can\'t be read)';
  const blocked = noEntry ? (typeof noEntry === 'string' ? `no-entry window: ${noEntry}` : 'no-entry window') : newsBlock;
  // The broker's field values its fired rules read on this bar (the strategy's own document says what they mean).
  const values = sideValuesText(r.rules && r.rules[r.direction]);
  return {
    name: r.name, direction: r.direction, status: r.status, confluence: r.confluence || null,
    entryRef: r.entryRef, stopPoints: round2(R), minRR: r.minRR ?? null,
    exit: { trailActivateR: exit.trailActivateR ?? null, trailGivebackR: exit.trailGivebackR ?? null, targetR: exit.targetR ?? null, maxBars: exit.maxBars ?? null },
    target, inTheWay, ahead, needR,
    trendRule: candidateTrendRule(r),
    alignment: align, vwapSide, facts,
    ...(values ? { values } : {}),
    ...(blocked ? { blocked } : {}),
  };
}

/** The news blackouts at `at`: the one in force (with its end), else the next one today (with the minutes to it). */
function newsState(blackouts, at) {
  // An unreadable blackouts file: unknown (the gate refuses entries then), never "no blackout".
  if (blackouts && blackouts.error) return { inBlackout: null, error: `the blackouts file can't be read (${blackouts.error}): the order gate refuses entries` };
  // An entry without a valid start and end: the gate reads the whole file as unreadable (order-gate checkBlackouts).
  const bad = ((blackouts && blackouts.items) || []).find(x => !(x && Number.isFinite(Date.parse(x.start)) && Number.isFinite(Date.parse(x.end))));
  if (bad) return { inBlackout: null, error: 'the blackouts file can\'t be read (an entry without a valid start and end): the order gate refuses entries' };
  const items = ((blackouts && blackouts.items) || []).filter(x => Date.parse(x.end) > at.getTime()).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const now = items.find(x => Date.parse(x.start) <= at.getTime());
  if (now) return { inBlackout: true, reason: now.reason || null, until: now.end };
  const next = items[0];
  return next ? { inBlackout: false, next: { reason: next.reason || null, start: next.start, inMinutes: Math.round((Date.parse(next.start) - at.getTime()) / 60000) } } : { inBlackout: false, next: null };
}

/**
 * The multi-timeframe read as of the last `m`-minute candle close at or before `closedAt` (the h1 and m15 sections'
 * rule: their read stays what a fresh read at that close gives for its whole life); fewer than 3 bars by then: `read`
 * (the bar's own read; none given: computed).
 */
function readAsOfClose(bars, minutes, closedAt, m, read = null) {
  const boundary = nextClose(new Date(closedAt.getTime() - m * 60000), m).getTime();
  const upTo = bars.filter(b => Date.parse(b.t) + minutes * 60000 <= boundary);
  return upTo.length >= 3 ? mtfRead(upTo) : read || mtfRead(bars);
}

/**
 * The briefing's 4h and 1h trends for these closed bars, exactly as buildBriefing's h1 section reads them (the read as
 * of the last 1h close: readAsOfClose(60), its 60 and 240 frames): { '4h', '1h' }, each 'up' | 'down' | 'range' | null.
 */
function htfTrendsOf(raw, minutes) {
  const bars = normalizeBars(raw);
  if (!bars.length) return { '4h': null, '1h': null };
  // The trend rule's frames, highest first (config/analysis.json mtf.ruleFrames: the 4h, then the 1h).
  const [h4, h1] = RULE_FRAMES;
  const closedAt = new Date(Date.parse(bars[bars.length - 1].t) + minutes * 60000);
  const readH1 = readAsOfClose(bars, minutes, closedAt, h1);
  const t = f => (f && ['up', 'down', 'range'].includes(f.trend) ? f.trend : null);
  return { '4h': t(frameOf(readH1, h4)), '1h': t(frameOf(readH1, h1)) };
}

/**
 * The briefing for `symbol`'s closed bars on `minutes`-minute bars: each section from `prev` while it is
 * valid (same symbol and bar size, not expired), else recomputed with a new version.
 */
function buildBriefing({ symbol, contractId = null, bars: raw, minutes, fineBars = null, prev = null, scan = [], scanError = null, blackouts = null, clock = null, roundSteps = null, now = new Date(), own = false, keyLevels = null }) {
  const bars = normalizeBars(raw);
  if (bars.length < 3) throw new Error(`need closed bars, got ${bars.length}`);
  const last = bars[bars.length - 1];
  const closedAt = new Date(Date.parse(last.t) + minutes * 60000);
  // The contract's tick (contracts.js): the volume profile's levels are shown on it. The snapshot stays unrounded
  // (the room, R and every decision input read it); computeSections rounds only what it shows.
  const grid = tickOf(symbol);
  const snap = snapshot({ bars, exactLevels: true });
  const read = mtfRead(bars);
  // The m15 and h1 reads as of their own last candle close: the read's window slides with each bar, so a section
  // read at its close stays what a fresh read at that close gives for its whole life (the trend rule in m3 is the
  // read of this bar, as the gate's).
  const asOfClose = m => readAsOfClose(bars, minutes, closedAt, m, read);
  const read15 = asOfClose(15);
  const readH1 = asOfClose(60);
  // The 15m and 1h candles, completed only (the one forming isn't in them).
  const done = m => candles(bars, m).filter(c => c.complete).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const c15 = done(15);
  const c60 = done(60);
  const snap15 = c15.length >= 30 ? snapshot15(c15) : null;
  // Levels within a tick are one level: the contract's tick (contracts.js), 0.25 for a root it doesn't list.
  const tick = grid || 0.25;
  // Round-number steps: config (round-numbers.js) the caller loaded and passes; none passed, no round numbers.
  const root = String(symbol || '').split(':')[0];
  // 1m bars (a 1m lane's) build a timeframe the base bars can't (5m from 3m); only those closed by this bar's close.
  const fine = Array.isArray(fineBars) && fineBars.length ? normalizeBars(fineBars) : null;
  const fresh = computeSections({ bars, fine, c15, c60, snap, snap15, read, read15, readH1, scan, scanError, minutes, closedAt, blackouts, clock, tick, grid,
    roundStep: roundStepFor(root, roundSteps), roundError: roundStepError(root, roundSteps), own, keyLevels });
  // The base timeframe's timing against the side the entry rule allows (ltf-timing.js, BG), from these closed bars: the
  // runner's briefing only (a frame's is another timeframe's read).
  if (!own) {
    const m3 = fresh.m3.data;
    const h = fresh.h1.data || {};
    const comp = m3.compression && typeof m3.compression[tfLabel(minutes)] === 'object' ? m3.compression[tfLabel(minutes)] : null;
    const f15 = (fresh.m15 && fresh.m15.data && fresh.m15.data.frame) || {};
    m3.timing = timingOf({ trends: { '4h': (h.h4 || {}).trend, '1h': (h.h1 || {}).trend }, t15: f15.trend || null, declared: m3.declared || null, regime: (m3.regime || {}).primary, bars, minutes, breaks: breaksOf(bars), compression: comp });
  }
  // Same symbol, bar size and contract (a roll to the next month is new prices, never the old month's levels).
  const usable = prev && prev.symbol === symbol && prev.minutes === minutes && (prev.contractId || null) === contractId && Date.parse(prev.closedAt) < closedAt.getTime();
  const sections = {};
  for (const name of SECTIONS) {
    const old = usable ? prev.sections[name] : null;
    if (old && Date.parse(old.validUntil) > closedAt.getTime()) { sections[name] = old; continue; }
    const s = fresh[name];
    sections[name] = { version: `${name}@${closedAt.toISOString()}`, computedAt: closedAt.toISOString(), validUntil: s.validUntil.toISOString(), reason: old ? 'expired' : 'new', data: s.data };
  }
  // keyLevels: this bar's session levels ([name, price]), the ones a lane's frame takes for its room (not rendered: m3 has them).
  return { symbol, contractId, minutes, asOf: last.t, closedAt: closedAt.toISOString(), price: last.c, builtAt: now.toISOString(), sections, ...(own ? {} : { keyLevels: fresh.keyLevels }) };
}

/**
 * The round numbers on a step: { at, levels }. Off a multiple: the one just below and the one just above price;
 * on one: that one is `at` and the levels are the next below and above. Only positive prices (a step at or over
 * price has none below it); no step, none.
 */
function roundNumbers(price, step) {
  if (!(step > 0) || !Number.isFinite(price)) return { at: null, levels: [] };
  const k = Math.round(price / step);
  const on = Math.abs(price / step - k) < 1e-9;
  const levels = (on ? [k - 1, k + 1] : [Math.floor(price / step), Math.ceil(price / step)]).map(n => n * step).filter(x => x > 0);
  return { at: on ? k * step : null, levels };
}

/**
 * Levels within a tick of each other, as one with the names joined (sorted nearest first; the first price kept).
 * A level is [name, price, shown?]: `shown` is its price as displayed (on the tick), never used for a distance.
 */
function merge(sorted, tick = 0.25) {
  const out = [];
  for (const [name, p, shown] of sorted) {
    const same = out.find(([, q]) => Math.abs(q - p) <= tick + 1e-9);
    if (same) { if (!same[0].split(' / ').includes(name)) same[0] = `${same[0]} / ${name}`; } else out.push([name, p, shown]);
  }
  return out;
}

/** The three nearest named levels above and below price, each in points and R (`oneR`: 1R in points). */
function nearest(price, oneR, levels, tick = 0.25) {
  const pick = above => merge(levels.filter(([, p]) => Number.isFinite(p) && (above ? p > price : p < price))
    .sort(([, a], [, b]) => (above ? a - b : b - a)), tick).slice(0, 3);
  const one = ([name, p, shown]) => ({ name, price: shown ?? p, points: round2(Math.abs(p - price)), R: oneR > 0 ? round2(Math.abs(p - price) / oneR) : null });
  return { above: pick(true).map(one), below: pick(false).map(one) };
}

/** Price against a level: above or below (null without one). */
function side(p, level) {
  return Number.isFinite(level) && Number.isFinite(p) ? (p > level ? 'above' : p < level ? 'below' : 'at') : null;
}

/** Price against a low-high band: below, inside, or above (null without the band). */
function where(p, lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return p < lo ? 'below' : p > hi ? 'above' : 'inside';
}

/** The 15m candles' snapshot, or null when it can't be computed (too few candles for an indicator). */
function snapshot15(c15) {
  try {
    return snapshot({ bars: c15 });
  } catch (_err) {
    return null;
  }
}

/** Whether the briefing is this bar's: its m3 (the trigger bar) still holds at `now`. */
function current(b, now = new Date()) {
  return Boolean(b && b.sections && b.sections.m3 && Date.parse(b.sections.m3.validUntil) > now.getTime());
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const etDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: ET, month: '2-digit', day: '2-digit' }).format(at);
/** Every time as ET (HH:MM, with the date when it isn't the bar's ET day), as the skills and session windows read it. */
function etTimes(v, barDay) {
  if (typeof v === 'string' && ISO.test(v)) {
    const at = new Date(v);
    return etDate(at) === barDay ? etClock(at) : `${etDate(at)} ${etClock(at)}`;
  }
  if (Array.isArray(v)) return v.map(x => etTimes(x, barDay));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, etTimes(x, barDay)]));
  return v;
}
const fmt = v => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

const lvl = x => `${x.name} ${x.price} (${x.points} pts, ${x.R === null ? 'R unknown' : `${x.R}R`})`;

/** The decision in plain words, first: what a role needs at a glance (the sections below hold the detail). */
function summaryLines(b, et) {
  const m3 = (b.sections.m3 || {}).data || {};
  const m15 = (b.sections.m15 || {}).data || {};
  const al = m15.alignment || {};
  // A briefing on 1h bars shares no m15 part (it changes faster than its bars).
  const alignment = b.sections.m15 ? `- Alignment: long ${al.long || '?'}, short ${al.short || '?'}. Regime: ${(m3.regime || {}).primary || '?'}, ${(m3.regime || {}).volatility || '?'} volatility.`
    : `- Alignment: not in a ${b.minutes}m briefing (the 15m read changes faster than its bars). Regime: ${(m3.regime || {}).primary || '?'}, ${(m3.regime || {}).volatility || '?'} volatility.`;
  const rule = String(m3.trendRule || '').replace(/^Trend rule: /, '');
  const vw = m3.vwap || {};
  const news = m3.news || {};
  const room = m3.nearestLiquidity || { above: [], below: [] };
  // Every R and ATR names its timeframe: a frame's 1R is its own bars' reference stop, not the runner's.
  const tf = `${b.minutes}m`;
  // A frame (its m3 is its `bar`, without the session's facts): its room is its own levels; the session's are the runner's.
  const own = m3.sessionLevels !== undefined;
  const roomOf = `R = the ${tf} reference stop`;
  const out = [
    `Summary (${b.symbol} ${tf}, ${m3.et} ET):`,
    `- Session: ${m3.windowText || `${m3.window} until ${et(m3.windowUntil)} ET`}.`,
    `- Price ${m3.price}. 1R = ${m3.oneR ? `${m3.oneR.points} pts (${m3.oneR.basis})` : 'unknown'}; every distance below is in points and R.`,
    `- Trend rule: ${rule}`,
    // The side the entry rule (BG) allows, from its own check (bias-line.js): the runner's briefing only (a frame's has no
    // session facts, so no declared trend).
    ...(!own && biasLine(b) ? [`- ${biasLine(b)}.`] : []),
    alignment,
    own ? `- VWAP and the session's levels (today, overnight, opening range, IB, profile): each ${SESSION_ELSEWHERE}, one value in every briefing; ${typeof m3.setups === 'string' ? `the room below is this ${tf} bar's own levels` : `the room below and the setups' levels include them (the runner's values), with this ${tf} bar's own`}.`
      : `- VWAP (${vw.applies || '?'}): price ${vw.side || '?'}, ${Number.isFinite(vw.distanceAtr) ? Math.abs(vw.distanceAtr) : '?'} x ${tf} ATR(14) away. Closes crossing a VWAP in the last 30 bars: the RTH VWAP ${vw.rthCrossesLast30 ?? '?'}, the session VWAP ${vw.sessionCrossesLast30 ?? '?'} (the regime's count).`,
    `- News: ${news.error ? news.error : news.inBlackout ? `in a blackout (${news.reason || 'event'}) until ${et(news.until)}` : news.next ? `next ${news.next.reason || 'event'} at ${et(news.next.start)} (in ${news.next.inMinutes} min)` : 'no blackout ahead'}.`,
    `- Room above (${roomOf}): ${(room.above || []).map(lvl).join(', ') || 'none found'}.`,
    `- Room below (${roomOf}): ${(room.below || []).map(lvl).join(', ') || 'none found'}.`,
    ...(room.at && room.at.length ? [`- At price: ${room.at.map(x => `${x.name} ${x.price}`).join(', ')}.`] : []),
    ...(room.roundNumbers ? [`- Round numbers: none (${room.roundNumbers}).`] : []),
  ];
  const closes = closesLine(m3);
  if (closes) out.push(closes);
  const fields = brokerFieldsText(m3.brokerFields);
  if (fields) out.push(fields);
  out.push(...candleLines(m3, et, roomOf, b.closedAt));
  // The FVGs near price (within 2R) or retested by their timeframe's last candle (fvg-frames.js fvgLine).
  const fvg = fvgLine(m3.fvgs, et, { price: m3.price, near: m3.oneR ? 2 * m3.oneR.points : NaN });
  if (fvg) out.push(fvg);
  // The 5m structure only when its last break is recent (m5-structure.js structureLine).
  const s5 = structureLine(m3.structure5m, et);
  if (s5) out.push(s5);
  const cisd = cisdLine(m3.cisd, et);
  if (cisd) out.push(cisd);
  // Compression only when a timeframe is compressing or broke out of a box in its last candles (compression.js).
  const comp = compressionLine(m3.compression, et);
  if (comp) out.push(comp);
  // Whether the trend has declared itself each side's way, in RTH only (trend-declared.js declaredLine).
  const declared = declaredLine(m3.declared, tf);
  if (declared) out.push(declared);
  // The base timeframe's timing against the side the entry rule allows (ltf-timing.js timingLine).
  const timing = timingLine(m3.timing, et, tf);
  if (timing) out.push(timing);
  // The setup moment (learning/setup-moments.js): the reactions the model composes on, said as facts.
  // And the briefing's own setups on an allowed side (setupChecks: a compression break, a live CISD) on the same line;
  // the standard plan below stays the setup moment's.
  const SMo = require('../learning/setup-moments');
  const checkOpts = m3.bar ? { barClose: Date.parse(m3.bar.t) + b.minutes * 60000, et, entries: m3.windowEntries } : null;
  const check = checkOpts ? SMo.checkLine(m3.candles, checkOpts) : null;
  const shownCheck = checkOpts ? SMo.checkLine(m3.candles, { ...checkOpts, checks: SMo.setupChecks(m3) }) : null;
  if (shownCheck) out.push(shownCheck);
  // Its standard plan (learning/setup-library.js planLine, the census's composeAt and planOf): R:R as code's fact.
  const plan = check ? require('../learning/setup-library').planLine(b) : null;
  if (plan) out.push(plan);
  if (typeof m3.setups === 'string') out.push(`- Setups: ${m3.setups}.`);
  else if (m3.candidates === null) out.push(`- Setups: unknown (${m3.scanError || 'the scan failed'}): no rules entry this bar.`);
  // Only rules setups fire; a composed one is the model's to read, so none fired is never "no setup".
  else if (!m3.candidates || !m3.candidates.length) out.push('- Rules setups: none fired on this bar; a composed setup is yours to read and check (trade-lifecycle).');
  else {
    out.push('- Setups:');
    for (const c of m3.candidates) {
      out.push(`  - ${c.name} ${c.direction}: ${c.facts.join('; ')}${c.blocked ? ` (blocked now: ${c.blocked})` : ''}. Stop ${c.stopPoints} pts (its own 1R)${c.target ? `; target ${c.target.points} pts (${c.target.R}R)` : ''}; aims for ${c.needR}R; levels ahead in its R: ${(c.ahead || []).map(lvl).join(', ') || 'none found'}.${c.values ? ` Values: ${c.values}.` : ''}`);
    }
  }
  return out;
}

// Closes in a row: "the first close", "3 closes in a row", "20+ closes in a row" (the count stops at MAX_CLOSES).
const inARow = n => (n === 1 ? 'the first close' : `${n}${n >= MAX_CLOSES ? '+' : ''} closes in a row`);
/**
 * The summary's "This bar's close" line: what the close did against the session's levels (level-closes.js), only when
 * something happened (null: nothing), e.g. "- This bar's close: crossed above the RTH VWAP; 2 closes in a row above
 * prior value." A close on an edge is neither beyond nor inside.
 */
function closesLine(m3) {
  const vw = (m3.vwap || {}).crossed || {};
  const today = m3.today || {};
  const loc = m3.location || {};
  const word = d => (d === 'up' ? 'above' : 'below');
  const parts = [
    ...Object.entries(vw).map(([k, d]) => `crossed ${word(d)} the ${k === 'rth' ? 'RTH' : 'session'} VWAP`),
    ...(today.openingRangeCrossed ? [`crossed ${word(today.openingRangeCrossed)} the opening range ${today.openingRangeCrossed === 'up' ? 'high' : 'low'}`] : []),
    ...(loc.closesBeyondValue ? [`${inARow(loc.closesBeyondValue.closes)} ${loc.closesBeyondValue.side} prior value`] : []),
    ...(loc.backInsideValue ? [`${inARow(loc.backInsideValue.closes)} back inside prior value (the RTH open was ${loc.backInsideValue.opened} it)`] : []),
  ];
  return parts.length ? `- This bar's close: ${parts.join('; ')}.` : null;
}

/** The summary's CISD line: each timeframe's latest CISD and its OTE zone, the unavailable ones left out (null: none). */
function cisdLine(block, et) {
  if (!block || typeof block !== 'object') return null;
  const parts = Object.entries(block).filter(([, x]) => !(typeof x === 'string' && x.startsWith('unavailable'))).map(([tf, x]) => {
    if (typeof x === 'string') return `${tf} none`;
    const zone = x.ote ? `OTE ${x.ote.bottom}-${x.ote.top} (mid ${x.ote.mid}), ${x.status}${x.priceInOte ? ', price in it' : ''}`
      : x.displacement === 'weak' ? 'a weak displacement: no zone' : `zone ${x.status}`;
    return `${tf} ${x.dir} at ${x.level} (closed ${et(x.confirmedClose)}, ${x.displacement})${x.sweep ? ` after a sweep of the ${x.sweep.name} ${x.sweep.price}` : ', no key-level sweep'}, ${zone}${x.bounce ? `, this bar bounced ${x.bounce} out of it` : ''}`;
  });
  return parts.length ? `- CISD (completed candles; a read, not a signal): ${parts.join('; ')}.` : null;
}

const target = x => `${x.frame} ${x.price} (${x.points} pts, ${x.ticks} ticks, ${x.R === null ? 'R unknown' : `${x.R}R`})`;
/** The same swing on several timeframes once, its frames joined (15m/1h 27135.75). */
const targets = list => list.reduce((out, x) => {
  const same = out.find(y => y.price === x.price);
  if (same) same.frame = `${same.frame}/${x.frame}`; else out.push({ ...x });
  return out;
}, []).map(target).join(', ');

// The m3 fields the summary says in full (one line each), left out of the detail whole.
const CHAIN_FRAMES = (C => C.chainOf(C.SHIPPED))(require('./chain'));
const SUMMARY_FIELDS = ['swingTargets', 'rangeTargets', 'fvgs', 'structure5m', 'compression', 'declared', 'timing'];
// What the summary's "This bar's close" line says in full, left out of the detail (only present when it happened).
const SUMMARY_ONLY = { vwap: ['crossed'], today: ['openingRangeCrossed'], location: ['closesBeyondValue', 'backInsideValue'] };

/**
 * A section's data as the detail shows it: what the summary already says in full is left out (SUMMARY_FIELDS: the
 * swing and range targets, the timeframes' FVGs, the 5m structure; SUMMARY_ONLY; each candle's pattern, close
 * location, range, volume and levels; an unavailable timeframe or an event-driven one), and so is a candle's OHLCV when
 * it is the `bar` above (the base timeframe's own), so the text stays small; the JSON keeps it all.
 */
function detailEntries(data) {
  if ('brokerFields' in data) data = omit(data, ['brokerFields']);
  const bar = data.bar || {};
  const ohlcv = c => (c.t === bar.t && c.o === bar.o && c.h === bar.h && c.l === bar.l && c.c === bar.c ? {} : { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
  return Object.entries(data).filter(([k]) => !SUMMARY_FIELDS.includes(k)).map(([k, v]) => (k === 'candles' && v && typeof v === 'object'
    ? [k, Object.fromEntries(Object.entries(v).filter(([tf, c]) => !c.unavailable && !(tf in EVENT_FRAMES))
      .map(([tf, c]) => [tf, { t: c.t, ...ohlcv(c), body: c.body, upperWick: c.upperWick, lowerWick: c.lowerWick, ...(c.patterns ? { patterns: c.patterns } : {}) }]))]
    : [k, SUMMARY_ONLY[k] && v && typeof v === 'object' ? omit(v, SUMMARY_ONLY[k]) : v]));
}

/**
 * A candle beyond its previous candle's high or low (candle-facts.js prevSweep), as the summary says it: a sweep only
 * when it closed back inside; else where it closed. '' when it stayed inside.
 */
const sweepText = s => (!s ? '' : s.closedBack ? `; swept the ${s.of}, closed back inside`
  : `; traded beyond the ${s.of}, closed ${s.closedBeyond === 'high' ? 'above its high' : 'below its low'}`);

/** One level of a prior candle's range: its price, distance with its side, and R. */
const rangeLevel = (name, x) => `${name} ${x.price} (${x.side === 'at' ? 'at price' : `${x.points} ${x.side}`}, ${x.R === null ? 'R unknown' : `${x.R}R`})`;

/**
 * The summary's one line of prior-candle range targets: per frame (1h, 4h) the last completed candle's high, mid and
 * low, and, only when it happened, the side the candle forming since has taken ("low taken, closed back inside" or "low taken, closed below it"). An
 * unavailable frame is left out (the JSON says why); no line without any.
 */
function rangeLine(block, et, roomOf = 'R = the reference stop') {
  if (!block || typeof block !== 'object') return null;
  const parts = Object.entries(block).filter(([, x]) => x && !x.unavailable)
    .map(([tf, x]) => `${tf} (closed ${et(x.closedAt)}) ${rangeLevel('high', x.high)}, ${rangeLevel('mid', x.mid)}, ${rangeLevel('low', x.low)}${x.taken ? `, ${x.taken.side} taken, closed ${x.taken.closedBack ? 'back inside' : x.taken.side === 'low' ? 'below it' : 'above it'}` : ''}`);
  return parts.length ? `- Prior candle range (${roomOf}): ${parts.join('; ')}.` : null;
}

// Timeframes whose candle line is event-driven (minutes): in full only when the candle completed within that long of
// this bar's close; after that only its sweep closed back inside, if it made one; else the JSON alone holds it. Never in
// the detail.
const EVENT_FRAMES = { '4h': 60 };
/** An EVENT_FRAMES candle's line now: 'full', 'sweep' (its sweep only) or null (none); 'full' on other timeframes. */
const eventShown = (tf, c, closedAt) => (!(tf in EVENT_FRAMES) || !(Date.parse(closedAt) - Date.parse(c.closedAt) > EVENT_FRAMES[tf] * 60000) ? 'full'
  : c.sweep && c.sweep.closedBack ? 'sweep' : null);

const GAP_REL_RANK = { rejected: 0, broke: 1, touched: 2 };
const GAP_TF_RANK = { '1h': 0, '15m': 1, '5m': 2 };
/**
 * A candle line's fair value gap relation (candle-facts.js fvgRelations), only when it met a gap's edge: the single
 * strongest, rejected before broke before touched, the higher timeframe's gap first, in the read's word order with the
 * price after it ("; rejected 15m fvg high up (103)": the read `<line's tf> rejected 15m fvg high up`).
 */
function gapText(c) {
  const list = (Array.isArray(c.fvgRelations) ? c.fvgRelations : []).filter(r => r && GAP_REL_RANK[r.rel] !== undefined);
  if (!list.length) return '';
  const tfRank = r => { const k = GAP_TF_RANK[String(r.name).split(' ')[0]]; return k === undefined ? 9 : k; };
  const r = [...list].sort((x, y) => (GAP_REL_RANK[x.rel] - GAP_REL_RANK[y.rel]) || (tfRank(x) - tfRank(y)))[0];
  return `; ${r.rel} ${r.name}${r.dir ? ` ${r.dir}` : ''} (${r.price})`;
}

/** The summary's completed-candle lines: one per timeframe (EVENT_FRAMES only on an event), then the next swing targets. */
function candleLines(m3, et, roomOf = 'R = the reference stop', closedAt = null) {
  if (typeof m3.candles === 'string') return [`- Completed candles and swing targets: ${m3.candles}.`];
  if (!m3.candles) return [];
  const out = [];
  for (const [tf, c] of Object.entries(m3.candles)) {
    // A timeframe nothing here can build (5m with no 1m lane): left out of the summary (the JSON says why).
    if (c.unavailable) { if (!/no 1m bars configured/.test(c.unavailable) && !(tf in EVENT_FRAMES)) out.push(`- ${tf}: unavailable (${c.unavailable}).`); continue; }
    const shown = eventShown(tf, c, closedAt);
    if (!shown) continue;
    if (shown === 'sweep') { out.push(`- ${tf} (closed ${et(c.closedAt)})${sweepText(c.sweep)}.`); continue; }
    // The levels it met, strongest first as listed (candle-facts.js: at most MAX_LEVELS, the rest counted).
    const met = Object.entries(c.levels || {}).map(([name, r]) => (r.startsWith('rejected') ? `rejected ${name} (${r.replace('rejected: ', '')})` : `${r} ${name}`));
    if (c.moreLevels) met.push(`+${c.moreLevels} more`);
    // The entry reads' extras (the net move, the gap relation, the inside-bar stack): on the lines the entry reads from, not the
    // event-driven ones (4h), which keep their own byte budget.
    const extras = !(tf in EVENT_FRAMES);
    const shapeText = [`${c.pattern}${c.dir ? ` ${c.dir}` : ''}`, extras && c.insideStack && c.mother ? `${c.insideStack} in a row inside the ${et(c.mother.t)} candle ${c.mother.l}-${c.mother.h}` : null,
      c.closeLocation ? `close ${c.closeLocation} third` : null,
      c.rangeAtr !== null ? `range ${c.rangeAtr} ATR` : null, c.volRatio !== null ? `vol ${c.volRatio}x` : null,
      // On high volume, the net move (absorption's "little progress", composed-reads.js netAtrOf).
      extras && c.volRatio >= VOLUME_HIGH && netAtrOf(c) !== null ? `net ${netAtrOf(c)} ATR` : null,
      c.momentum === 'up' || c.momentum === 'down' ? `momentum ${c.momentum}` : null].filter(Boolean).join(', ');
    // The chain's roles (chain.js): the setup frame's candle is the setup candle, the entry frame's the entry (timing) one.
    const role = tf === CHAIN_FRAMES.setup ? 'setup candle, ' : tf === CHAIN_FRAMES.entry ? 'entry candle, timing, ' : '';
    out.push(`- ${tf} (${role}closed ${et(c.closedAt)}): ${shapeText}${sweepText(c.sweep)}${met.length ? `; ${met.join(', ')}` : ''}${extras ? gapText(c) : ''}.`);
  }
  const t = m3.swingTargets || { above: [], below: [] };
  out.push(`- Next swing above (${roomOf}): ${targets(t.above || []) || 'none found'}; below: ${targets(t.below || []) || 'none found'}.`);
  const range = rangeLine(m3.rangeTargets, et, roomOf);
  if (range) out.push(range);
  return out;
}

/** The briefing as text: the summary, then one block per section, with when it was computed and until when it holds. */
function renderBriefing(b, { now = new Date() } = {}) {
  const day = etDate(new Date(b.closedAt));
  const et = v => etTimes(v, day);
  const lines = [`Bar briefing ${b.symbol} ${b.minutes}m, bar ${et(b.asOf)} ET closed ${et(b.closedAt)} ET (${day}), price ${b.price}; times in ET, distances in points and R (computed once per section; reuse it, don't recompute):`];
  lines.push(...summaryLines(b, et), '', 'Detail by timeframe:');
  for (const name of SECTIONS) {
    const s = b.sections[name];
    if (!s) continue;
    const stale = Date.parse(s.validUntil) <= now.getTime() ? ' EXPIRED (the next briefing replaces it)' : '';
    lines.push(`[${name}] version ${s.version}, valid until ${et(s.validUntil)} ET${stale}`);
    for (const [k, v] of detailEntries(s.data)) lines.push(`  ${k}: ${fmt(et(v))}`);
  }
  return `${lines.join('\n')}\n`;
}

const briefingFile = (home, root) => path.join(home, 'briefing', `${familyRoot(root)}.json`);

function writeBriefing(home, b) {
  const file = briefingFile(home, b.symbol);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(b)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/** Remove the briefing (a bar whose briefing failed: an older one must not be read as this bar's). */
function removeBriefing(home, root) {
  try { fs.unlinkSync(briefingFile(home, root)); } catch (_err) { /* none */ }
}

function readBriefing(home, root) {
  try {
    return JSON.parse(fs.readFileSync(briefingFile(home, root), 'utf8'));
  } catch (_err) {
    return null;
  }
}

// The runner's parts a briefing on `minutes`-minute bars shares: those whose clock is no faster than its bars.
const SHARED_CLOCK = { m15: 15, h1: 60, day: 1440 };
const sharedParts = minutes => Object.keys(SHARED_CLOCK).filter(p => SHARED_CLOCK[p] >= minutes);

/**
 * The briefing on an analyst's own timeframe: `bars` are its closed `minutes`-minute bars (a lane's, or built from
 * the first lane's), `first` the runner's briefing (its parts are shared, see
 * sharedParts). `lane`: the bars are a lane's, so `scan` is that lane's scan and its candidates are this bar's;
 * else no strategy trades these bars and the setups are the runner's briefing's.
 */
function buildFrameBriefing({ symbol, contractId = null, bars, minutes, first, lane = false, scan = null, scanError = null, barsFile = null, blackouts = null, clock = null, roundSteps = null, now = new Date() }) {
  if (!first || !first.sections || !first.sections.m3) throw new Error(`no runner bar briefing to share with the ${minutes}m one`);
  if (first.symbol !== symbol || (first.contractId || null) !== contractId) throw new Error(`the runner's bar briefing is for ${first.symbol} ${first.contractId || ''}, not ${symbol} ${contractId || ''}`);
  // A lane's setups are traded: their room needs every key level, the session's from the runner's briefing (one value
  // each). A runner briefing without them (an older file) builds no lane briefing: never a room without them.
  if (lane && !Array.isArray(first.keyLevels)) throw new Error(`the runner's bar briefing has no session levels for the ${minutes}m lane's room`);
  const b = buildBriefing({ symbol, contractId, bars, minutes, scan: lane ? scan : null, scanError: lane ? scanError : null, blackouts, clock, roundSteps, now, own: true, keyLevels: lane ? first.keyLevels : null });
  // Its session levels must be the runner's as of this lane bar's close: the runner's bar holding then (closed at or
  // before it, its next not yet closed). An older runner briefing (a bar behind, or hours old) or a later one is refused.
  const laneClose = Date.parse(b.closedAt);
  if (lane && !(Date.parse(first.closedAt) <= laneClose && Date.parse(first.sections.m3.validUntil) > laneClose)) {
    throw new Error(`the runner's bar briefing (closed ${first.closedAt}) isn't the one holding at the ${minutes}m lane bar's close (${b.closedAt}): its session levels aren't this bar's`);
  }
  const base = b.sections.m3;
  // No session facts computed on these bars: they would differ from the runner's (no 1h bar opens at 09:30 ET, a VWAP
  // or a profile on coarser bars is another number), and one fact has one value in every briefing the model reads.
  // They are the runner's briefing's; a lane's room and candidates take its session levels, an analyst's frame has
  // only its own.
  // No trend rule: one read off these bars isn't the gate's, and the gate's, copied here, would be served as current
  // for this bar's whole life (and in a report cached on it). The gate's current rule is the runner's briefing's.
  const data = {
    ...omit(base.data, SESSION_FIELDS),
    sessionLevels: `not in a ${minutes}m briefing: the session's facts (today so far: open, gap, opening range, IB, high and low; the overnight range; the RTH and session VWAP and price's side of it; the session profile and the prior day's nodes; where price is against them) are computed on the runner's ${first.minutes}m bars only, one value each: in the runner's ${first.minutes}m bar briefing (bar_briefing without a timeframe); the prior RTH day and its profile are the [day] part below${lane ? `; the room and the setups' levels below include the runner's session levels (its values)` : ''}`,
    trendRule: `Trend rule: not in a ${minutes}m briefing (it would be up to a ${minutes}m bar old): the order gate's current rule is in the runner's ${first.minutes}m bar briefing and the cycle prompt`,
    // The CISD per timeframe reads the session's key levels (its sweep) and the zone moves bar by bar: one value each,
    // the runner's.
    cisd: `not in a ${minutes}m briefing: the CISD per timeframe (3m, 5m, 15m, 1h) is computed on the runner's ${first.minutes}m bars, one value each: in the runner's ${first.minutes}m bar briefing (bar_briefing without a timeframe)`,
  };
  // The completed-candle facts and swing targets read the session's levels (one value each, on the runner's bars): they
  // are the runner's briefing's, as the session's facts are; a frame points to them (its own bars' would be another
  // number, and a copy would be held as current for this bar's whole life).
  data.candles = `in the runner's ${first.minutes}m bar briefing (bar_briefing without a timeframe): each timeframe's last completed candle and the levels it met, the next swing targets and the prior 1h and 4h candle's range targets, one value per level`;
  delete data.swingTargets;
  delete data.rangeTargets;
  delete data.compression;
  delete data.timing;
  if (!lane) {
    delete data.candidates;
    delete data.scanError;
    data.setups = `not scanned on ${minutes}m bars (no lane trades them): this bar's setups are in the ${first.minutes}m bar briefing`;
  }
  return {
    symbol, contractId, minutes, runnerMinutes: first.minutes, asOf: b.asOf, closedAt: b.closedAt, price: b.price, builtAt: b.builtAt, barsFile,
    sections: { bar: { version: `bar${minutes}m@${b.closedAt}`, computedAt: b.closedAt, validUntil: frameUntil(new Date(b.closedAt), minutes).toISOString(), data } },
  };
}

/**
 * When a bar that closed at `closedAt` stops being the last one: the close of the next `minutes`-minute bar that opens
 * in market hours (clock.js inMarketHours, ET wall time, so across a DST change too). Inside a session that is
 * closedAt + minutes; the last bar before the daily break or the weekend holds until the first bar after the open.
 */
function frameUntil(closedAt, minutes) {
  const step = minutes * 60000;
  let open = closedAt.getTime();
  // At most a week of bars: a week always has market hours.
  for (let k = 0; k <= Math.ceil(10080 / minutes) && !inMarketHours(new Date(open)); k += 1) open += step;
  return new Date(open + step);
}

/**
 * The completed `minutes`-minute bars in `bars`, OHLCV only, each stamped with its own boundary's open (nextClose of
 * its first sub-bar, less its minutes), never its first sub-bar's time: a 1h bar whose 14:00 sub-bar is missing still
 * opens at 14:00 and closes at 15:00. Two anchors meet here: mtf.js candles group the sub-bars on the 18:00
 * America/New_York grid, and nextClose counts from the trading day's start (clock.js tradingDayStart, in its
 * own zone): the same instant all year, and a test pins that they agree.
 */
function wholeBars(bars, minutes) {
  return candles(normalizeBars(bars), minutes).filter(c => c.complete)
    .map(({ t, o, h, l, c, v }) => ({ t: new Date(nextClose(new Date(t), minutes).getTime() - minutes * 60000).toISOString(), o, h, l, c, v }));
}

/** Whether the briefing's bar is the one holding at `at` (closed by then, its next bar not yet). */
function frameHolds(f, at) {
  const s = f && f.sections && f.sections.bar;
  return Boolean(s && Date.parse(f.closedAt) <= at.getTime() && Date.parse(s.validUntil) > at.getTime());
}

/** The briefing on an analyst's timeframe as text: the summary, its `bar` part, then the runner's parts it shares. */
function renderFrameBriefing(f, first, { now = new Date() } = {}) {
  const day = etDate(new Date(f.closedAt));
  const et = v => etTimes(v, day);
  const shared = sharedParts(f.minutes).filter(p => first.sections[p]);
  const view = { symbol: f.symbol, minutes: f.minutes, sections: { m3: f.sections.bar, ...Object.fromEntries(shared.map(p => [p, first.sections[p]])) } };
  const lines = [`Bar briefing ${f.symbol} ${f.minutes}m (your own timeframe; the runner's bars are ${f.runnerMinutes}m), bar ${et(f.asOf)} ET closed ${et(f.closedAt)} ET (${day}), price ${f.price}; times in ET, distances in points and R (computed once per ${f.minutes}m bar; reuse it, don't recompute). Your report on it may be reused until its next ${f.minutes}m close, so it may be up to one ${f.minutes}m bar old.${f.barsFile ? ` Its ${f.minutes}m bars, oldest first: ${f.barsFile}.` : ''}`];
  lines.push(...summaryLines(view, et), '', 'Detail by timeframe:');
  const part = (label, s) => {
    const stale = Date.parse(s.validUntil) <= now.getTime() ? ' EXPIRED (the next briefing replaces it)' : '';
    lines.push(`[${label}] version ${s.version}, valid until ${et(s.validUntil)} ET${stale}`);
    for (const [k, v] of detailEntries(s.data)) lines.push(`  ${k}: ${fmt(et(v))}`);
  };
  part(`bar ${f.minutes}m`, f.sections.bar);
  for (const p of shared) part(p, first.sections[p]);
  return `${lines.join('\n')}\n`;
}

const frameBriefingFile = (home, root, minutes) => path.join(home, 'briefing', `${familyRoot(root)}-${minutes}m.json`);

function writeFrameBriefing(home, f) {
  const file = frameBriefingFile(home, f.symbol, f.minutes);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(f)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function readFrameBriefing(home, root, minutes) {
  try {
    return JSON.parse(fs.readFileSync(frameBriefingFile(home, root, minutes), 'utf8'));
  } catch (_err) {
    return null;
  }
}

function removeFrameBriefing(home, root, minutes) {
  try { fs.unlinkSync(frameBriefingFile(home, root, minutes)); } catch (_err) { /* none */ }
}

module.exports = { htfTrendsOf,
  SECTIONS, WINDOWS, nextClose, nextRthRoll, sessionWindow, newsState, buildBriefing, candidate, current, renderBriefing, briefingFile, writeBriefing, readBriefing, removeBriefing,
  roundNumbers, sharedParts, buildFrameBriefing, frameHolds, frameUntil, wholeBars, renderFrameBriefing, frameBriefingFile, writeFrameBriefing, readFrameBriefing, removeFrameBriefing,
  gapText,
};
