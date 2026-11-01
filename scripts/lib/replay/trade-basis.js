'use strict';

/**
 * A round trip's R on the stop it actually held (the analysis after a run: the scorecard's trade R, trend capture's
 * ride and available R). The broker's round trip measures R from its bracket stop at the fill (`initialStop`, `risk`);
 * a composed entry filled away from its plan's limit has that stop moved to the plan's price by the runner right after
 * the fill ([protect]: the event log's `stop_moved` with why 'plan stop', runner.js guardFill), so the trade's real 1R
 * is the fill to that stop. 2021-06-24: filled 14374.25, bracket stop 14359.5 (14.75 points), moved to the plan's
 * 14361.75 (12.5 points): the broker's +0.864R is +1.02R on the stop it held.
 *
 *   planStops(events)                       the runner's moves to the plan's stop: [{ ms, to, fam }] (events: the run
 *                                            home's event log lines, logs/events-<day>.jsonl)
 *   readPlanStops(home)                     planStops of a run home's event logs ([] without any)
 *   heldStop(moves, { fam, fromMs, toMs })  the first such move of that market from the fill to the exit: its price, or null
 *   onHeldStop(rt, { stop, tick })          the broker's round trip `rt` on the stop it held: { r, maeR, mfeR, risk, reason,
 *                                            rBasis }. stop: heldStop's price (null: the bracket's, as sent). R, MAE and MFE
 *                                            are rescaled by the bracket's risk over the held one (the same P&L); risk is the
 *                                            held one in points; reason: the broker's, except its 'trail' for an exit at the
 *                                            held stop or worse (no stop moved toward profit: the trail never armed), 'stop'.
 *                                            rBasis: 'held stop' when the stop moved after the fill, else 'bracket stop'.
 */

const fs = require('fs');
const path = require('path');
const { famOf } = require('./exit-scorecard');

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round3 = x => (num(x) === null ? null : Math.round(x * 1000) / 1000);

function planStops(events) {
  return (Array.isArray(events) ? events : [])
    .filter(e => e && typeof e === 'object' && e.kind === 'stop_moved' && e.why === 'plan stop' && num(Number(e.to)) !== null && Number.isFinite(Date.parse(e.at)))
    .map(e => ({ ms: Date.parse(e.at), to: Number(e.to), fam: famOf(e.symbol || e.contractId) }))
    .sort((a, b) => a.ms - b.ms);
}

function readPlanStops(home) {
  const dir = path.join(home, 'logs');
  let names;
  try { names = fs.readdirSync(dir).filter(n => /^events-.*\.jsonl$/.test(n)).sort(); } catch (_err) { return []; }
  const lines = [];
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch (_err) { continue; }
    for (const l of text.split('\n').filter(Boolean)) { try { lines.push(JSON.parse(l)); } catch (_err) { /* a torn line */ } }
  }
  return planStops(lines);
}

function heldStop(moves, { fam, fromMs, toMs }) {
  if (!Number.isFinite(fromMs)) return null;
  const end = Number.isFinite(toMs) ? toMs : Infinity;
  const m = (Array.isArray(moves) ? moves : []).find(x => x.fam === famOf(fam) && x.ms >= fromMs && x.ms <= end);
  return m ? m.to : null;
}

function onHeldStop(rt, { stop = null, tick = null } = {}) {
  const r0 = rt && typeof rt === 'object' ? rt : {};
  const sign = r0.direction === 'short' ? -1 : 1;
  const entry = num(r0.averageEntryPrice) ?? num(r0.entryPrice);
  const exit = num(r0.averageExitPrice) ?? num(r0.exitPrice);
  const bracket = num(r0.risk);
  const held = num(stop) !== null && entry !== null ? sign * (entry - stop) : null;
  const moved = held !== null && held > 0 && bracket !== null && bracket > 0 && held !== bracket;
  const k = moved ? bracket / held : 1;
  const scale = x => (num(x) === null ? null : moved ? round3(x * k) : x);
  // The stop the trade held from the fill on: the plan's after the move, else the bracket's.
  const initial = moved ? stop : num(r0.initialStop);
  const atStop = r0.reason === 'trail' && exit !== null && initial !== null && sign * (exit - initial) < (num(tick) || Number.MIN_VALUE);
  return {
    r: scale(num(r0.r)), maeR: scale(num(r0.maeR)), mfeR: scale(num(r0.mfeR)), risk: moved ? held : bracket,
    reason: atStop ? 'stop' : r0.reason || null, rBasis: moved ? 'held stop' : 'bracket stop',
  };
}

module.exports = { planStops, readPlanStops, heldStop, onHeldStop };
