'use strict';

/**
 * The resting stop of an open position as the runner last confirmed it from the broker's own read (the working stop
 * order's id and price), kept in <home>/resting-stops.json so the order gate's hook can hold a modify_order of that
 * stop to tighten-only with local state only ([modify-stop]); the gateway still judges the broker's working order
 * (account-gate.js modify-protection), and stays the authority.
 *
 *   FILE                                         the file's name
 *   recordStop(home, { contractId, sign, stopOrderId, restingStop, at })   keep the newest record for that stop order
 *                                                (records of an earlier trading day than the new one's are dropped)
 *   readStop(home, orderId)                      that stop order's newest record, or null (none, or unreadable)
 *   modifyStopRefusal({ home, input, now })      the [modify-stop] message for a modify_order looser than the record, or
 *                                                null: equal (a no-op) and tighter pass, and with no record (none, or one
 *                                                of an earlier trading day than `now`: an order id a restarted server
 *                                                may reuse) the hook passes it to the gateway (a risk-reducing modify
 *                                                never fails on a read)
 */

const path = require('path');
const { readJson, writeJsonAtomic } = require('../harness-run');
const { tradingDayKey } = require('./clock');

const FILE = 'resting-stops.json';
const STOP_FIELDS = ['stopPrice', 'trailPrice'];

const listOf = home => { const l = readJson(path.join(home, FILE), []); return Array.isArray(l) ? l.filter(x => x && typeof x === 'object') : []; };

function recordStop(home, { contractId, sign, stopOrderId, restingStop, at }) {
  if (!(Number.isFinite(restingStop) && restingStop > 0) || ![1, -1].includes(sign) || stopOrderId === null || stopOrderId === undefined || !contractId || !Number.isFinite(Date.parse(at))) {
    throw new Error(`not a resting stop record (order ${stopOrderId}, stop ${restingStop}, sign ${sign})`);
  }
  const id = String(stopOrderId);
  const day = tradingDayKey(new Date(at));
  const kept = listOf(home).filter(x => String(x.stopOrderId) !== id && Number.isFinite(Date.parse(x.at)) && tradingDayKey(new Date(x.at)) === day);
  writeJsonAtomic(path.join(home, FILE), [...kept, { contractId, sign, stopOrderId: id, restingStop, at }]);
}

function readStop(home, orderId, now = null) {
  if (!home || orderId === undefined || orderId === null) return null;
  const hit = listOf(home).filter(x => String(x.stopOrderId) === String(orderId)).pop();
  if (!hit || !Number.isFinite(hit.restingStop) || ![1, -1].includes(hit.sign)) return null;
  if (now && (!Number.isFinite(Date.parse(hit.at)) || tradingDayKey(new Date(hit.at)) !== tradingDayKey(now))) return null;
  return hit;
}

function modifyStopRefusal({ home, input = {}, now = new Date() }) {
  const fields = STOP_FIELDS.filter(f => input[f] !== undefined && input[f] !== null);
  if (!fields.length) return null;
  const r = readStop(home, input.orderId, now);
  if (!r) return null;
  for (const f of fields) {
    const level = Number(input[f]);
    if (input[f] === '' || !Number.isFinite(level)) return `${f} ${JSON.stringify(input[f])} is not a price: stop ${input.orderId} rests at ${r.restingStop}; move it toward the market only, or close the position ([exit], close_position).`;
    if (r.sign * (level - r.restingStop) < 0) return `${f} ${level} is looser than the resting stop ${r.restingStop} of order ${input.orderId} (the runner's confirmed read): a stop moves toward the market only. Hold it, or close the position ([exit], close_position).`;
  }
  return null;
}

module.exports = { FILE, recordStop, readStop, modifyStopRefusal };
