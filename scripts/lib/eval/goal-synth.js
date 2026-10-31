'use strict';

/**
 * The goal regression's synthetic days (mock data; docs/TRAINING.md, "The goal regression"): only what real days can't
 * give cleanly, seeded MNQ 3m bars built in memory at run time, never a data file:
 *
 *   fakeout   the move scenario that must end at -1R: a drift the block's way (so the 4h and 1h trend it), then in the
 *             cash session a run of impulse bars that way (momentum candles: the cited setup fires) and a reversal
 *             through the stop
 *   listed-vwap  a flat cash-session box at the VWAP, then an expansion (no cited fire: the volume keeps falling): the first
 *             listed setup is the VWAP break, which compose_check does not verify (an open finding: no trade)
 *   limit-fill the box away from the VWAP's level, a 15m level break listed: the composed limit entry at the confirming
 *             3m close fills, its bracket, the trail, the exit (a limit at the last close is marketable at once: one
 *             expires only when the price leaves before the order goes, the order-latency self-test's case)
 *   quiet     the drift alone (no momentum candle, no listed setup): a day whose right answer is no trade
 *   floor     D13's stop floor binding (compose must refuse, never widen): the cash session's approach to just under
 *             the overnight high (floor-ticks: straight; floor-atr: a deep V, a large ATR(20)), a 15m candle breaking it by
 *             a few ticks (the listed reaction, its low the stop read), a 3m bar closing at its top (the confirming close),
 *             then flat: the stop a few ticks under max(stop_floor_ticks, stop_floor_atr x ATR(20)), the tick term binding
 *             on floor-ticks, the ATR term on floor-atr (floorBar)
 *   bleed     the blow path: a block of consecutive fakeout sessions whose reversal opens with a gap through the stop
 *             (a loss of a few R every day). The shipped sizing (a share of the cushion) never risks the floor; a broken
 *             size or cap turns it into a blow (tier 1's stress group, its mutation check)
 *
 * Every other day is a real one (the committed slice). Prices on MNQ's tick, OHLC consistent, volume on every bar. The
 * draws, the shapes and the layout are config/training.json goalRegression.synth.
 *
 *   synthFixture()           { blocks: [{ half 'S' (the bleed block) or 'M' (a move scenario), sessions, labels, bars }],
 *                            hash }: goal-fixture.js's block shape
 *   dayBars({ day, type, dir, rand, cfg, tick, startTicks })   { bars, endTicks }: one trading day's Globex bars
 *   normal(rand)             a standard normal draw
 */

const crypto = require('crypto');
const stats = require('../prop/stats');
const GF = require('./goal-fixture');
const { zonedTimeToUtc, minutesOfDay, RTH_OPEN_MIN, RTH_CLOSE_MIN, GLOBEX_OPEN_MIN, MARKET_TZ, tradingDayKey } = require('../trading/clock');
const { HISTORY_HOURS } = require('../trading/mtf');
const { tickOf } = require('../trading/contracts');

const CFG = () => require('../tunables').training().goalRegression.synth;
const msOf = minutes => minutes * 60000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * msOf(24 * 60)).toISOString().slice(0, 10);
const weekday = d => new Date(`${d}T00:00:00Z`).getUTCDay();
const isWeekday = d => ![0, 6].includes(weekday(d)); // not Sunday or Saturday (Date#getUTCDay)
const ymd = d => d.split('-').map(Number);
const at = (d, minute) => { const [year, month, day] = ymd(d); return zonedTimeToUtc({ year, month, day, hour: Math.floor(minute / 60), minute: minute % 60 }, MARKET_TZ).getTime(); };

function normal(rand) {
  const u = Math.max(rand(), Number.MIN_VALUE);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** One bar in ticks from its open: the move, a small wick on the side it moved, a larger one behind, its volume. */
function bar(o, { move, sigma, wick, volume, rand }) {
  const c = Math.round(o + move);
  const ahead = Math.round(Math.abs(normal(rand)) * sigma * wick.with);
  const behind = Math.round(Math.abs(normal(rand)) * sigma * wick.against);
  const up = c >= o;
  return { o, h: Math.max(o, c) + (up ? ahead : behind), l: Math.min(o, c) - (up ? behind : ahead), c, v: Math.max(1, Math.round(volume)) };
}

/**
 * A floor day's cash-session bar k (ticks): { o, h, l, c } from its shape F (config synth.floor with its variant), the
 * level (the overnight high) and the price at the open (from). The approach (approachBars, whole 15m candles): down
 * depthTicks and back up to belowTicks under the level (a V: its bars make ATR(20); no bar closes at its top again until
 * the reaction candle is the last one closed, so the approach's own breaks never confirm); the reaction candle
 * (reactionBars, one 15m candle): up through the level to crossTicks over it, each bar with a wick wickTicks over its
 * close; the confirming close confirmTicks over it (its low the reaction's close); then flat to the session's end.
 */
function floorBar(k, px, { F, level, from }) {
  const approachEnd = F.quietBars + F.approachBars;
  const reactionEnd = approachEnd + F.reactionBars;
  const line = (a, b, i, n) => Math.round(a + ((b - a) * (i + 1)) / n);
  const flat = { o: px, h: px, l: px, c: px };
  if (k < F.quietBars) return flat;
  if (k < approachEnd) {
    const i = k - F.quietBars;
    const down = Math.floor(F.approachBars / 2);
    const c = i < down ? line(from, from - F.depthTicks, i, down) : line(from - F.depthTicks, level - F.belowTicks, i - down, F.approachBars - down);
    return { o: px, h: Math.max(px, c), l: Math.min(px, c), c };
  }
  if (k < reactionEnd) { const c = line(level - F.belowTicks, level + F.crossTicks, k - approachEnd, F.reactionBars); return { o: px, h: Math.max(px, c) + F.wickTicks, l: Math.min(px, c), c }; }
  if (k === reactionEnd) { const c = px + F.confirmTicks; return { o: px, h: c, l: px, c }; }
  return flat;
}

function dayBars({ day, type, dir, rand, cfg, tick, startTicks, shape = null }) {
  const open = at(addDays(day, -1), GLOBEX_OPEN_MIN); // the evening before (a Monday's: Sunday's)
  const step = msOf(cfg.minutes);
  const T = cfg.fakeout;
  const bars = [];
  let px = startTicks;
  // A floor day's overnight high (ticks) and the price at the cash open (its approach starts there).
  let onHigh = -Infinity;
  let openTicks = null;
  for (let t = open; tradingDayKey(new Date(t)) === day && minutesOfDay(new Date(t), MARKET_TZ) !== cfg.breakMin; t += step) {
    const m = minutesOfDay(new Date(t), MARKET_TZ);
    const rth = m >= RTH_OPEN_MIN && m < RTH_CLOSE_MIN;
    const sigma = rth ? cfg.sigma.rth : cfg.sigma.overnight;
    // The drift its way, but on a composed-limit scenario's own day (its levels hold until the designed break).
    const drift = ['compress', 'runaway', 'quiet', 'floor'].includes(type) ? 0 : dir * cfg.macroDrift;
    let move = drift + normal(rand) * sigma * cfg.noise;
    const k = rth ? Math.round((m - RTH_OPEN_MIN) / cfg.minutes) : 0;
    // The session's volume falls bar by bar (no ordinary bar is above its average: only the scenario's bars have momentum).
    let volume = rth ? cfg.volume.rth * (1 - cfg.volume.decay * k) : cfg.volume.overnight;
    const r = rth ? k - T.startBar : -1;
    // The blow path's reversal opens with a gap through the stop (a loss past 1R the stop can't hold).
    if (type === 'bleed' && r === T.impulseBars) px -= dir * cfg.bleed.gapTicks;
    if ((type === 'fakeout' || type === 'bleed') && r >= 0 && r < T.impulseBars + T.reversalBars) {
      // The impulse its way (the setup), then the reversal through the stop.
      move = (r < T.impulseBars ? dir * T.impulseDrift : -dir * T.reversalDrift) * sigma + normal(rand) * sigma * cfg.noise;
      volume *= T.volume;
    }
    let wick = cfg.wick;
    // The quiet day: no drift, and a flat cash session (it meets no level, nothing fires: no trade is the answer).
    if (type === 'quiet' && rth) { move = 0; wick = { with: 0, against: 0 }; }
    if ((type === 'compress' || type === 'runaway') && rth) {
      // A 15m box (quiet bars, no momentum), its expansion its way (a 15m compression break the briefing lists, no single
      // 3m momentum candle: the volume keeps falling), a 3m bar that dips and closes at its top (the entry's confirming
      // close, the limit at it); then compress: the next bar trades back to the limit (it fills) and the trend runs;
      // runaway: every next bar opens past the last close and never trades back (the limit expires unfilled).
      const C = cfg.compress;
      const e0 = C.boxBars;
      const e1 = e0 + C.expandBars;
      if (k < e0) { move = 0; wick = { with: 0, against: 0 }; } // the box: flat, so it meets no level until the break
      else if (k < e1) { move = dir * sigma * C.expandDrift + normal(rand) * sigma * C.quietNoise; wick = C.wick; }
      else if (k === e1) { move = dir * sigma * C.confirmDrift; wick = { with: 0, against: C.confirmDip }; }
      else if (type === 'runaway' && k <= e1 + C.runBars) { px += dir * C.gapTicks; move = dir * sigma * C.expandDrift; wick = { with: C.wick.with, against: 0 }; }
      else if (type === 'compress' && k <= e1 + C.runBars) { move = dir * sigma * C.trendDrift + normal(rand) * sigma * C.quietNoise; wick = C.wick; }
      else move = normal(rand) * sigma * C.quietNoise;
    }
    if (type === 'floor' && rth && openTicks === null) openTicks = px;
    const shaped = type === 'floor' && rth ? floorBar(k, px, { F: shape, level: onHigh, from: openTicks }) : null;
    const b = shaped ? { ...shaped, v: Math.max(1, Math.round(volume)) } : bar(px, { move, sigma, wick, volume, rand });
    if (!rth && openTicks === null) onHigh = Math.max(onHigh, b.h); // the overnight session: every bar before the cash open
    bars.push({ t: new Date(t).toISOString(), o: b.o * tick, h: b.h * tick, l: b.l * tick, c: b.c * tick, v: b.v });
    px = b.c;
  }
  return { bars, endTicks: px };
}

/** A block's bars: the warm-up weekdays (the drift alone), then its sessions, each of `type`. */
function blockBars({ sessions, type, dir, rand, cfg, tick, shape = null }) {
  const warm = [];
  for (let d = sessions[0]; warm.length < Math.ceil(HISTORY_HOURS / 24) + 1;) { d = addDays(d, -1); if (isWeekday(d)) warm.unshift(d); }
  let px = Math.round(cfg.startPrice / tick);
  const out = [];
  for (const x of [...warm.map(day => ({ day, type: 'drift' })), ...sessions.map(day => ({ day, type }))]) {
    const r = dayBars({ day: x.day, type: x.type, dir, rand, cfg, tick, startTicks: px, shape });
    out.push(...r.bars);
    px = r.endTicks;
  }
  return GF.blockBars(out, sessions, { historyHours: HISTORY_HOURS, minutes: cfg.minutes });
}

/** `n` consecutive weekdays from `from` the runner trades (its clock's sessions and holidays). */
function sessionsFrom(from, n, cfg) {
  const clock = require('../learning/setup-library').runnerClock({ from, to: addDays(from, n * 2 + cfg.minutes) });
  const out = [];
  for (let d = from; out.length < n; d = addDays(d, 1)) if (isWeekday(d) && clock.inSession(at(d, RTH_OPEN_MIN + cfg.minutes))) out.push(d);
  return out;
}

function synthFixture() {
  const cfg = CFG();
  const tick = tickOf(cfg.symbol);
  const rand = stats.streamFor(cfg.seed, 'goal:synth');
  const block = (half, name, type, sessions, dir, why, shape = null) => ({
    half, scenario: name, sessions, trend: [], labels: Object.fromEntries(sessions.map(d => [d, { kind: 'non-trend', why }])),
    bars: GF.encodeBars(blockBars({ sessions, type, dir, rand, cfg, tick, shape }), tick, cfg.minutes),
  });
  const floor = variant => { const { ticksDay: _t, atrDay: _a, ticks: _k, atr: _r, ...F } = cfg.floor; return { ...F, ...cfg.floor[variant] }; };
  const blocks = [
    block('M', 'fakeout', 'fakeout', sessionsFrom(cfg.fakeout.day, 1, cfg), 1, 'synthetic fakeout: the impulse fires the setup, the reversal takes the stop: -1R at most'),
    block('M', 'quiet', 'quiet', sessionsFrom(cfg.quiet.day, 1, cfg), 1, 'synthetic quiet day: the drift alone, no momentum, no listed setup: the right answer is no trade'),
    block('M', 'listed-vwap', 'compress', sessionsFrom(cfg.compress.vwapDay, 1, cfg), 1, 'synthetic: a flat box at the VWAP, then the break: the first listed setup is the VWAP break, which compose_check does not verify (its quoted level keeps its brackets): no trade (an open finding)'),
    block('M', 'limit-fill', 'runaway', sessionsFrom(cfg.compress.limitDay, 1, cfg), 1, 'synthetic composed limit: a 15m level break listed (no cited fire), compose OK on the confirming close, the limit fills, its bracket, the trail, the exit'),
    block('S', 'bleed', 'bleed', sessionsFrom(cfg.bleed.from, cfg.bleed.sessions, cfg), -1, 'synthetic blow path: a loss at the stop every session'),
    // After the blow path (each block draws from the one seeded stream in turn: the earlier ones keep their bars).
    block('M', 'floor-ticks', 'floor', sessionsFrom(cfg.floor.ticksDay, 1, cfg), 1, 'synthetic stop floor (its ticks): the listed break\'s stop under stop_floor_ticks, the ATR term below it: compose refuses, never widens: no trade', floor('ticks')),
    block('M', 'floor-atr', 'floor', sessionsFrom(cfg.floor.atrDay, 1, cfg), 1, 'synthetic stop floor (its ATR term): the listed break\'s stop past stop_floor_ticks, under stop_floor_atr x ATR(20): compose refuses, never widens: no trade', floor('atr')),
  ];
  const doc = { v: 1, kind: 'goal-synth', symbol: cfg.symbol, minutes: cfg.minutes, seed: cfg.seed, blocks };
  return { ...doc, hash: crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex') };
}

module.exports = { synthFixture, dayBars, sessionsFrom, normal };
