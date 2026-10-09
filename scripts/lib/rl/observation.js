'use strict';

/**
 * The policy's observation: one function for training (the challenge env and
 * the backtester) and live trading (the runner), so a live decision sees what
 * training saw. Every field is scaled to roughly [-1, 1].
 *
 * Context: { cs (combine state), account, book: { bars, feats }, i (bar
 * index), closeAt (Date), components (the policy strategy's strategies),
 * setup: { sign, stopTicks, size, riskUsd, mini, strategy } (at a setup) |
 * pos: { sign, entry, risk, size, tickValue, mini, strategy, peakR, troughR,
 * barsHeld } (in a trade) }.
 *
 * The fields are OBS_FIELDS, then one per strategy the policy strategy trades
 * (1 for the strategy whose setup or trade it is): observationFields().
 *
 * Market context (marketFeatures, computed once per series, causal: bar i uses
 * bars 0..i only): the multi-timeframe trend (the trend rule's 4h, 1h, 15m
 * biases), the distance to VWAP, and the last RECENT_BARS candles (body and
 * range in ATRs). Signed fields are multiplied by the side, so +1 always
 * means "with the setup or trade". Confluence: how many of the policy
 * strategy's strategies fire with (and against) the setup on this bar.
 */

const { sessionMinute } = require('../trading/clock');
const ind = require('../trading/indicators');
const { ruleSeries } = require('../trading/mtf');

const RECENT_BARS = 10;
const RTH_OPEN = 9 * 60 + 30;
const RTH_CLOSE = 16 * 60;
const GLOBEX_OPEN = 18 * 60;

const OBS_FIELDS = [
  'in_position', // 1 in a trade, 0 at a setup
  'side', // +1 long, -1 short (the setup's or the trade's)
  'cushion', // (balance - floor) / max_loss
  'progress', // profit / target, clamped to [-1, 1.5]
  'drawdown', // (highest end-of-day balance - balance) / max_loss
  'day_pnl', // today's realized P&L / max_loss
  'sessions_left', // sessions left / sessions
  'session_clock', // minutes since the 18:00 ET open / 1320 (the 16:00 ET close)
  'risk_of_cushion', // the setup's (or the trade's initial) dollar risk / cushion
  'soft_room', // room to the soft daily limit / max_loss
  'r_now', // the trade's R at this close / 5
  'r_peak', // best R reached / 5
  'r_trough', // worst R reached / 5
  'bars_held', // bars in the trade / 120
  'atr_ratio', // ATR(20) / ATR(100) - 1
  'adx', // ADX(14) / 50
  'mini', // 1 when the setup or trade is in minis, 0 in micros
  'mtf_4h', // the 4h trend x side: +1 with it, -1 against, 0 range or no read
  'mtf_1h',
  'mtf_15m',
  'confluence_with', // other strategies of the policy firing the same side on this bar / strategies
  'confluence_against', // ... firing the other side
  'vwap_dist', // (close - VWAP) / ATR(20) x side / 3 (RTH VWAP in RTH, else the session's)
  ...Array.from({ length: RECENT_BARS }, (_, k) => `bar${k + 1}_body`), // (close - open) / ATR(20) x side / 2; bar1 = the last closed bar
  ...Array.from({ length: RECENT_BARS }, (_, k) => `bar${k + 1}_range`), // (high - low) / ATR(20) / 3
];
const OBS_DIM = OBS_FIELDS.length;

/**
 * The market features the observation reads, for a whole series (each value at
 * bar i from bars 0..i): ATR(20), ATR(100), ADX(14), the trend rule's
 * frames, and the RTH and session VWAPs. The engine (training and backtests)
 * and the live runner both build them here.
 */
function marketFeatures(bars) {
  return {
    atr20: ind.atr(bars, 20),
    atr100: ind.atr(bars, 100),
    adx: ind.adx(bars, 14),
    mtf: ruleSeries(bars),
    vwapRth: ind.anchoredVwap(bars, RTH_OPEN, RTH_CLOSE),
    vwapSession: ind.anchoredVwap(bars, GLOBEX_OPEN),
  };
}

/** Every field for a policy strategy trading `components`, in order. */
const observationFields = components => [...OBS_FIELDS, ...components.map(c => `strategy:${c}`)];

const clamp = (x, lo, hi) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : 0);

function buildObservation({ cs, account, book, i, closeAt, components = [], setup = null, pos = null }) {
  const maxLoss = cs ? cs.maxLoss : (account && account.max_loss) || 1;
  const balance = cs ? cs.balance : 0;
  const cushion = cs ? balance - cs.floor : maxLoss;
  const bar = book.bars[i];
  const f = book.feats || {};
  const atr20 = f.atr20 ? f.atr20[i] : NaN;
  const atr100 = f.atr100 ? f.atr100[i] : NaN;
  const adx = f.adx ? f.adx[i] : NaN;
  const inPos = Boolean(pos);
  const side = inPos ? pos.sign : setup ? setup.sign : 0;
  const tickValue = inPos && pos.tickValue ? pos.tickValue : book.tickValue;
  const riskUsd = inPos ? pos.risk * (tickValue / book.tickSize) * pos.size : setup ? setup.riskUsd : 0;
  const which = inPos ? pos.strategy : setup ? setup.strategy : null;
  const rNow = inPos ? (pos.sign * (bar.c - pos.entry)) / pos.risk : 0;
  const dir = side || 1; // flat with no setup: raw values
  const trend = m => (f.mtf && Number.isFinite(f.mtf[m][i]) ? f.mtf[m][i] * dir : 0);
  const vwap = f.vwapRth && Number.isFinite(f.vwapRth[i]) ? f.vwapRth[i] : f.vwapSession && Number.isFinite(f.vwapSession[i]) ? f.vwapSession[i] : NaN;
  const conf = (!inPos && setup && setup.confluence) || { with: 0, against: 0 };
  const n = Math.max(1, components.length);
  const recent = k => book.bars[i - k];
  const body = k => (recent(k) && atr20 > 0 ? clamp(((recent(k).c - recent(k).o) / atr20) * dir / 2, -1.5, 1.5) : 0);
  const range = k => (recent(k) && atr20 > 0 ? clamp((recent(k).h - recent(k).l) / atr20 / 3, 0, 2) : 0);
  const v = [
    inPos ? 1 : 0,
    side,
    clamp(cushion / maxLoss, 0, 3),
    cs ? clamp((balance - cs.start) / cs.target, -1, 1.5) : 0,
    cs ? clamp((cs.eodHigh - balance) / maxLoss, -1, 2) : 0,
    cs ? clamp(cs.dayPnl / maxLoss, -1, 1) : 0,
    cs ? clamp((cs.sessions - cs.days.length) / cs.sessions, 0, 1) : 1,
    clamp(sessionMinute(closeAt) / 1320, 0, 1.1),
    clamp(riskUsd / Math.max(1, cushion), 0, 2),
    cs && cs.dailySoft > 0 ? clamp((cs.dailySoft + cs.dayPnl) / maxLoss, -1, 1) : 1,
    clamp(rNow / 5, -1, 3),
    inPos ? clamp(pos.peakR / 5, 0, 3) : 0,
    inPos ? clamp((pos.troughR || 0) / 5, -1, 0) : 0,
    inPos ? clamp(pos.barsHeld / 120, 0, 3) : 0,
    clamp(atr20 / atr100 - 1, -1, 2),
    clamp(adx / 50, 0, 2),
    (inPos ? pos.mini : setup && setup.mini) ? 1 : 0,
    trend(240),
    trend(60),
    trend(15),
    clamp(conf.with / n, 0, 1),
    clamp(conf.against / n, 0, 1),
    Number.isFinite(vwap) && atr20 > 0 ? clamp(((bar.c - vwap) / atr20) * dir / 3, -1.5, 1.5) : 0,
    ...Array.from({ length: RECENT_BARS }, (_, k) => body(k)),
    ...Array.from({ length: RECENT_BARS }, (_, k) => range(k)),
    ...components.map(c => (c === which ? 1 : 0)),
  ];
  return v;
}

/**
 * Confluence on bar i for a setup on `sign`: how many OTHER strategies (by
 * name, from `results`: [{ name, candidate, direction }]) fire with it and
 * against it.
 */
function confluence(results, setupName, sign) {
  const want = sign > 0 ? 'long' : 'short';
  const others = (results || []).filter(r => r && r.name !== setupName && r.candidate && r.direction);
  return { with: others.filter(r => r.direction === want).length, against: others.filter(r => r.direction !== want).length };
}

module.exports = { OBS_FIELDS, OBS_DIM, RECENT_BARS, observationFields, buildObservation, marketFeatures, confluence };
