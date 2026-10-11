'use strict';

/**
 * The harness's "now" for trading decisions, in one place: the order gate (hook
 * and gateway), the scripts agents run, and the runner all take the time from
 * harnessNow(env).
 *
 *   FTH_REPLAY_NOW unset (or empty)  the wall clock (shifted only in the test
 *                                    suite: FTH_TEST_NOW with NODE_ENV=test, never
 *                                    in autonomous runs)
 *   FTH_REPLAY_NOW=<ISO 8601 UTC>    that time, but only when the selected broker
 *                                    (broker/config.js: FTH_BROKER / brokers.json)
 *                                    declares itself a replay broker ("replay": true)
 *
 * Anything else throws ReplayClockError, so a replayed time is never used
 * against a live broker: an unparseable value, the override with a broker that
 * is not a replay broker, or a broker config that can't be read. The gate turns
 * that into a refusal of every gated order call (check-order.js), and scripts
 * exit with the error. The override never relaxes a check; it only moves the
 * time checks are evaluated at. Reads only local state (env, brokers.json).
 *
 * harnessNow(env)          a Date, or throws ReplayClockError
 * recordNow(env)           for bookkeeping that decides nothing by itself (the
 *                          gateway's ledger stamps, the translator's lookups): the
 *                          replay time when honored, else the wall clock; never
 *                          throws, so close_position still goes when the gate refuses
 */

const { activeBroker } = require('../broker/config');

const STARTED_AT = Date.now();
// A UTC instant: date, time to the minute or finer, and a Z.
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;

class ReplayClockError extends Error {}

/** The wall clock, or the test suite's shifted clock (FTH_TEST_NOW; never outside tests or in autonomous runs). */
function wallNow(env) {
  const t = Date.parse(String(env.FTH_TEST_NOW || ''));
  if (env.NODE_ENV !== 'test' || env.FTH_AUTONOMOUS === '1' || !Number.isFinite(t)) return new Date();
  return new Date(Date.now() + (t - STARTED_AT));
}

function parseReplayTime(raw) {
  const m = ISO_UTC.exec(raw);
  const ms = m ? Date.parse(raw) : NaN;
  // Date.parse rolls some impossible dates over (Feb 30); the parts must survive the round trip.
  const d = new Date(ms);
  const exact = Boolean(m) && Number.isFinite(ms) && d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2])
    && d.getUTCDate() === Number(m[3]) && d.getUTCHours() === Number(m[4]) && d.getUTCMinutes() === Number(m[5])
    && d.getUTCSeconds() === Number(m[6] || 0);
  if (!exact) throw new ReplayClockError(`FTH_REPLAY_NOW ${JSON.stringify(raw)} is not an ISO 8601 UTC time (e.g. 2026-03-02T15:30:00Z): refused`);
  return d;
}

/** { replay: false } when the override is unset; { replay: true, now } when honored; else throws ReplayClockError. */
function resolve(env) {
  const raw = env.FTH_REPLAY_NOW;
  if (raw === undefined || raw === null || raw === '') return { replay: false };
  const now = parseReplayTime(String(raw));
  let broker;
  try {
    broker = activeBroker(env);
  } catch (err) {
    throw new ReplayClockError(`FTH_REPLAY_NOW is set but the broker config can't be read (${err.message}): the replay clock is refused`);
  }
  if (broker.replay !== true) {
    throw new ReplayClockError(`FTH_REPLAY_NOW is set but the selected broker "${broker.name}" is not a replay broker ("replay": true in brokers.json): `
      + 'a replayed time is never used with a live broker. Unset FTH_REPLAY_NOW to trade live, or select the replay broker (FTH_BROKER).');
  }
  return { replay: true, now };
}

function harnessNow(env = process.env) {
  const r = resolve(env);
  return r.replay ? new Date(r.now.getTime()) : wallNow(env);
}

function recordNow(env = process.env) {
  try {
    return harnessNow(env);
  } catch (_err) {
    return wallNow(env);
  }
}

module.exports = { harnessNow, recordNow, ReplayClockError };
