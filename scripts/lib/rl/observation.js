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
 */

const { sessionMinute } = require('../trading/clock');

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
];
const OBS_DIM = OBS_FIELDS.length;

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
    ...components.map(c => (c === which ? 1 : 0)),
  ];
  return v;
}

module.exports = { OBS_FIELDS, OBS_DIM, observationFields, buildObservation };
