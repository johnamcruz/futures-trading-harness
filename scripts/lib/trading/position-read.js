'use strict';

/**
 * The Position line: the open trade's live numbers as one code-computed line, every cycle a position is open (the
 * trade-cycle, premarket and end-of-day prompts), so the model cites them instead of recomputing them. Facts only: no
 * instruction, no characterisation (manage-position teaches the reads). Pure.
 *
 * One R basis: the runner's held trade (runner.js trailPosition, state.trails: the entry and 1R the exit itself uses,
 * its best and worst closed-bar extremes with their prices, whether its target was reached, the code floor's class at
 * the last bar from the swing and lock its step read; exit-trail.js swingClassOf). It is used only when it is the
 * position's (its key), managed (not `skip`), and updated to the last closed bar (heldFor); otherwise the line is folded
 * from the bars by the runner's own bar rule (a bar that opened at most graceMs before the fill counts) with the
 * open trade's own risk (the journal's planned stop, else the working stop) and says so at its end.
 *
 *   positionKey(position)              the key the runner holds its trade under
 *   heldFor(held, { key, lastBarT })   { held } (asOf: no bar this pass, the held trade as of its last bar) | { why }
 *   positionRead(t, { held, why, asOf, bars, tick, graceMs })   the facts (plain fields, for the cycle record), or
 *                                       { unavailable }; never throws. t: open-trades.js's trade (entry and risk already
 *                                       the held trade's when held), with `stops` (every working stop price on its side)
 *   positionLine(read, { level, et })   the line; `Position: unavailable (<why>).` when it can't be stated
 */

const { snapStop } = require('./trail');
const { lockOf, tradeFold } = require('./exit-trail');
const { label } = require('./mtf');
const { zonedParts } = require('./clock');

const r2 = x => Math.round(x * 100) / 100;
const fin = Number.isFinite;

/** The key the runner holds a position's trade under (runner.js trailPosition): its id, else its open time and price. */
const positionKey = p => String(p.id ?? `${p.creationTimestamp}|${p.averagePrice}`);

function heldFor(held, { key, lastBarT } = {}) {
  if (!held || typeof held !== 'object') return { why: 'no held trade' };
  if (held.key !== key) return { why: 'the held trade is another position\'s' };
  if (held.skip) return { why: 'not managed by the runner (no exit plan it manages)' };
  // The runner's own close-out was sent (its trail or time stop): its record stops at that bar, the position may still
  // read open until the close fills.
  if (held.closing) return { why: 'the runner is closing this trade' };
  if (lastBarT === undefined) return { held, asOf: held.lastBarT || null };
  if (!held.lastBarT || Date.parse(held.lastBarT) !== Date.parse(lastBarT)) return { why: 'the held trade was not updated to the last closed bar' };
  return { held };
}

/** The mode of the exit plan: target_then_trail (afterTarget), trail (trailActivateR), else target. */
const modeOf = plan => (!plan ? null : plan.afterTarget ? 'target_then_trail' : fin(plan.trailActivateR) ? 'trail' : 'target');

function readOf(t, { held = null, why = null, asOf = null, bars = [], tick = null, graceMs = 0 }) {
  if (!t || !(t.sign === 1 || t.sign === -1)) return { unavailable: 'no open trade' };
  if (!(t.risk > 0) || !fin(t.entry)) return { unavailable: 'no initial risk: no R to state' };
  const { sign, entry, risk } = t;
  const R = x => (fin(x) ? r2((sign * (x - entry)) / risk) : null);
  let f;
  if (held) {
    const plan = held.plan || null;
    f = {
      basis: 'held', peakR: Math.max(0, Number(held.peakR) || 0), troughR: Math.min(0, Number(held.troughR) || 0), bestPrice: fin(held.bestPrice) ? held.bestPrice : null,
      bestBarT: held.bestBarT || null, armed: Boolean(held.armed), target: fin(held.target) ? held.target : null, plan, lastClose: fin(held.lastClose) ? held.lastClose : null,
      lastBarT: held.lastBarT || null, swingClass: held.swingClass && typeof held.swingClass === 'object' ? held.swingClass : null,
    };
  } else {
    if (!Array.isArray(bars)) return { unavailable: 'no bars for this contract this cycle' };
    const opened = Date.parse(t.openedAt);
    const since = bars.filter(b => b && fin(Date.parse(b.t)) && [b.h, b.l, b.c].every(fin) && (!fin(opened) || Date.parse(b.t) >= opened - graceMs));
    if (!since.length) return { unavailable: 'no closed bar since the fill yet' };
    const x = tradeFold({ sign, entry, risk, stop: entry - sign * risk, target: null }, since, null, tick);
    f = { basis: 'fold', ...x, troughR: Math.min(0, x.troughR), armed: false, target: null, plan: null, swingClass: null };
  }
  if (f.lastClose === null) return { unavailable: 'no closed bar since the fill yet' };
  const mode = modeOf(f.plan);
  const stops = (Array.isArray(t.stops) ? t.stops : fin(t.stop) ? [t.stop] : []).filter(fin);
  const work = stops.length ? stops.reduce((a, b) => (sign * (b - a) < 0 ? b : a)) : null; // the loosest: the exposure
  const nowR = R(f.lastClose);
  const mfeR = r2(f.peakR);
  const give = mfeR > 0 ? r2(mfeR - nowR) : null;
  const lock = f.swingClass && fin(f.swingClass.lock) ? f.swingClass.lock
    : mode === 'target_then_trail' && f.target !== null ? (x => (x === null ? null : tick > 0 ? snapStop(x, sign, tick) : x))(lockOf({ sign, entry, risk, target: f.target, peakR: f.peakR }, f.plan)) : null;
  return {
    basis: f.basis, ...(why && f.basis === 'fold' ? { why } : {}), ...(asOf ? { asOf } : {}),
    contractId: t.contractId, side: t.side, sign, size: t.size, entry, risk, riskFrom: f.basis === 'held' ? 'runner' : t.riskFrom || null,
    averagePrice: fin(t.averagePrice) ? t.averagePrice : entry, tick,
    last: f.lastClose, lastBarT: f.lastBarT, nowR, mfeR, best: f.bestPrice, bestAt: f.bestBarT, maeR: r2(f.troughR),
    give, giveShare: give !== null ? Math.round((give / mfeR) * 100) : null,
    stops: stops.length, work, workR: R(work), atStopGive: work !== null ? r2(mfeR - R(work)) : null,
    mode, armed: f.armed, target: f.target, lock, lockR: R(lock), targetOrder: fin(t.target) ? t.target : null,
    trail: mode === 'trail' ? { activateR: f.plan.trailActivateR, givebackR: f.plan.trailGivebackR } : null,
    swingClass: mode === 'target_then_trail' ? f.swingClass : null,
    tf: f.plan && f.plan.afterTarget && f.plan.afterTarget.swingMinutes ? label(f.plan.afterTarget.swingMinutes) : null,
    trailR: f.plan && f.plan.afterTarget ? f.plan.afterTarget.trailR : null,
  };
}

function positionRead(t, opts = {}) {
  try {
    return readOf(t, opts || {});
  } catch (err) {
    return { unavailable: err.message };
  }
}

const sR = x => `${x > 0 ? '+' : x < 0 ? '-' : '+'}${Math.abs(x)}R`;
const hhmm = iso => { const ms = Date.parse(iso); if (!fin(ms)) return '?'; const p = zonedParts(new Date(ms), 'America/New_York'); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

/** The code floor's class at the last bar (exit-trail.js swingClassOf), in words. */
function classText(c, p, level) {
  if (!c || typeof c !== 'object') return null;
  const tf = p.tf || 'swing';
  const restsOrTrails = c.binds === 'trail' ? `the stop trails ${p.trailR}R behind the best (${level(c.trailStop)})` : 'the stop rests at the lock';
  if (c.cls === 'A') return Number.isFinite(c.earlyLock) ? `before the target: the early lock holds the stop at ${level(c.earlyLock)}` : 'before the target: the initial stop holds';
  if (c.cls === 'B') return `the stop trails the ${tf} swing ${level(c.swing)} (stop ${level(c.swingStop)})`;
  if (c.cls === 'C') return `last confirmed ${tf} swing ${level(c.swing)} is behind the lock: the stop rests at the lock`;
  if (c.cls === 'D' && c.trailBy !== 'structure') return restsOrTrails;
  if (c.cls === 'D' && c.wrongSide) return `last ${tf} swing ${level(c.swing)} is on the wrong side of the price: ${restsOrTrails}`;
  if (c.cls === 'D') return `no ${tf} swing in the bars: ${restsOrTrails}`;
  return null;
}

function lineOf(p, { level = x => String(r2(x)), et = hhmm } = {}) {
  if (!p || p.unavailable) return `Position: unavailable (${p ? p.unavailable : 'not computed'}).`;
  const avg = p.tick > 0 && Math.abs(p.averagePrice - p.entry) >= p.tick - 1e-9 ? ` (average price now ${level(p.averagePrice)}; R from the runner's entry ${level(p.entry)})` : '';
  const head = `Position (code facts): ${p.contractId} ${p.side} ${p.size} @ ${level(p.entry)}, 1R ${r2(p.risk)} pts${avg}`;
  const now = `now ${sR(p.nowR)} at ${level(p.last)}${p.asOf ? ` (the ${et(p.asOf)} ET bar's close)` : ''}`;
  const mfe = p.mfeR > 0 ? `MFE ${sR(p.mfeR)} at ${p.best === null ? '? (not recorded)' : `${level(p.best)} (${et(p.bestAt)} ET bar)`}` : 'MFE 0R (no closed bar beyond the entry yet)';
  const mae = p.maeR < 0 ? `MAE ${sR(p.maeR)}` : `MAE 0R (never ${p.sign > 0 ? 'below' : 'above'} the entry on a closed bar)`;
  const give = p.give !== null ? `giveback ${p.give}R (${p.giveShare}% of MFE)` : 'giveback: none';
  const at = x => `${level(p.work)} (${sR(p.workR)}; a fill there is ${x}R off the best)`;
  const stop = p.work === null ? 'NO working stop' : p.stops > 1 ? `${p.stops} stop orders, the loosest ${at(p.atStopGive)}` : `working stop ${at(p.atStopGive)}`;
  const R = x => r2((p.sign * (x - p.entry)) / p.risk);
  const noTarget = p.mode === 'target_then_trail' && p.target === null;
  const exit = noTarget ? 'no target (the stop holds until its own exit)'
    : p.mode === 'target_then_trail' ? `target ${p.armed ? `reached (lock ${p.lockR === null ? '?' : sR(p.lockR)})` : 'not reached'}`
    : p.mode === 'trail' ? `trail ${p.trail.givebackR}R behind the best from ${sR(p.trail.activateR)}`
      : p.targetOrder !== null ? `target order ${level(p.targetOrder)} (${sR(R(p.targetOrder))})` : 'no target order';
  const cls = p.mode === 'target_then_trail' && !noTarget ? classText(p.swingClass, p, level) : null;
  const tail = p.basis === 'fold' ? ` (not runner-managed: ${p.why || 'no held trade'}; risk from ${p.riskFrom === 'working' ? 'the working stop' : 'the journal stop'})` : '';
  return `${head}; ${now}; ${mfe}; ${mae}; ${give}; ${stop}; ${exit}${cls ? `; code floor: ${cls}` : ''}${tail}.`;
}

function positionLine(read, opts = {}) {
  try {
    return lineOf(read, opts);
  } catch (err) {
    return `Position: unavailable (${err.message}).`;
  }
}

module.exports = { positionKey, heldFor, positionRead, positionLine };
