'use strict';

/**
 * The harness's "now" for trading decisions, in one place: the order gate (hook
 * and gateway), the scripts agents run, and the runner all take the time from
 * here.
 *
 *   FTH_REPLAY_NOW unset (or empty)  the wall clock (shifted only in the test
 *                                    suite: FTH_TEST_NOW with NODE_ENV=test, never
 *                                    in autonomous runs, never in the runner)
 *   FTH_REPLAY_NOW=<ISO 8601 UTC>    that time, but only for a replay broker:
 *     - the selected broker (broker/config.js: FTH_BROKER / brokers.json) says
 *       "replay": true, and doesn't look like a live one (it starts no live
 *       broker's server and reads none of a shipped live broker's variables);
 *     - in the gateway, which runs the server, the server itself also says so:
 *       get_server_config reports replay: true and a serverTime within 5 minutes
 *       of FTH_REPLAY_NOW (pinGatewayClock), decided once for the gateway's life.
 *
 * Otherwise the override is refused: the clock is the wall clock (a refused
 * override means a live broker, where wall time is right) with `refused` set.
 * The gate then refuses new entries ([replay-clock]) and judges every
 * risk-reducing action as usual; scripts exit with the error (harnessNow throws).
 * The override never relaxes a check; it only moves the time checks run at.
 * Reads only local state, except pinGatewayClock, which asks the gateway's server.
 *
 * resolveClock(env, { broker, testClock })  { replay, refused, at, now() }
 * harnessNow(env, opts)    a Date, or throws ReplayClockError when refused
 * recordNow(env, opts)     the same clock, never throws (bookkeeping, lookups)
 * replayAt(env, opts)      the replay clock's time (a Date) when one is in force, null live (FTH_REPLAY_NOW
 *                          unset: no broker config read); throws ReplayClockError when it is refused
 * pinGatewayClock(env, { broker, fromArgv, call })  the gateway's clock (a promise)
 * createGatewayClock(env, opts)  { ready(): Promise<clock>, now() } pinned once
 */

const fs = require('fs');
const path = require('path');
const { activeBroker, loadBrokers, DEFAULTS_FILE } = require('../broker/config');

const STARTED_AT = Date.now();
const SERVER_TIME_TOLERANCE_MS = 5 * 60000;
// A UTC instant: date, time to the minute or finer, and a Z.
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;
const REMEDY = 'Unset FTH_REPLAY_NOW to trade live, or select a real replay broker (FTH_BROKER).';

class ReplayClockError extends Error {}

/** The wall clock, or the test suite's shifted clock (FTH_TEST_NOW; never outside tests, in autonomous runs, or with testClock false). */
function wallNow(env, testClock = true) {
  const t = Date.parse(String(env.FTH_TEST_NOW || ''));
  if (!testClock || env.NODE_ENV !== 'test' || env.FTH_AUTONOMOUS === '1' || !Number.isFinite(t)) return new Date();
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
  return exact ? d : null;
}

const scriptOf = b => {
  const s = (b.command || []).find(a => /\.[cm]?js$/i.test(String(a)));
  return s ? path.resolve(String(s)) : null;
};

/** Why a broker labelled replay looks like a live one, or null. */
function liveTwin(broker, env) {
  const { brokers } = loadBrokers(env);
  for (const name of Object.keys(brokers)) {
    if (name === broker.name || brokers[name].replay === true) continue;
    const other = activeBroker({ ...env, FTH_BROKER: name });
    if (broker.command && other.command && JSON.stringify(broker.command) === JSON.stringify(other.command)) return `it starts the same server as the live broker "${name}"`;
    if (scriptOf(broker) && scriptOf(broker) === scriptOf(other)) return `it starts the same server (${scriptOf(broker)}) as the live broker "${name}"`;
    if (broker.entryEnv && broker.entryEnv === other.entryEnv) return `it takes its server from ${broker.entryEnv}, as the live broker "${name}" does`;
  }
  const shipped = (JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8')).brokers) || {};
  const mine = [...(broker.env || []), broker.entryEnv, broker.journalEnv].filter(Boolean);
  for (const [name, b] of Object.entries(shipped)) {
    if (b.replay === true) continue;
    const theirs = new Set([...(Array.isArray(b.env) ? b.env : []), b.entryEnv, b.journalEnv].filter(Boolean));
    const shared = mine.filter(v => theirs.has(v));
    if (shared.length) return `it reads the live broker "${name}"'s variables (${shared.join(', ')})`;
  }
  return null;
}

function refusedClock(env, why, testClock = true) {
  return { replay: false, refused: `${why} ${REMEDY}`, at: null, now: () => wallNow(env, testClock) };
}

function resolveClock(env = process.env, { broker = null, testClock = true } = {}) {
  const raw = env.FTH_REPLAY_NOW;
  if (raw === undefined || raw === null || raw === '') return { replay: false, refused: null, at: null, now: () => wallNow(env, testClock) };
  const at = parseReplayTime(String(raw));
  if (!at) return refusedClock(env, `FTH_REPLAY_NOW ${JSON.stringify(String(raw))} is not an ISO 8601 UTC time (e.g. 2026-03-02T15:30:00Z): the replay clock is refused.`, testClock);
  let b = broker;
  let twin;
  try {
    b = b || activeBroker(env);
    twin = b.replay === true ? liveTwin(b, env) : null;
  } catch (err) {
    return refusedClock(env, `FTH_REPLAY_NOW is set but the broker config can't be read (${err.message}): the replay clock is refused.`, testClock);
  }
  if (b.replay !== true) {
    return refusedClock(env, `FTH_REPLAY_NOW is set but the selected broker "${b.name}" is not a replay broker ("replay": true in brokers.json): a replayed time is never used with a live broker.`, testClock);
  }
  if (twin) return refusedClock(env, `FTH_REPLAY_NOW is set but the replay broker "${b.name}" looks live: ${twin}. The replay clock is refused.`, testClock);
  return { replay: true, refused: null, at, now: () => new Date(at.getTime()) };
}

function harnessNow(env = process.env, opts = {}) {
  const c = resolveClock(env, opts);
  if (c.refused) throw new ReplayClockError(c.refused);
  return c.now();
}

function replayAt(env = process.env, opts = {}) {
  const raw = env.FTH_REPLAY_NOW;
  if (raw === undefined || raw === null || raw === '') return null;
  const c = resolveClock(env, opts);
  if (c.refused) throw new ReplayClockError(c.refused);
  return c.replay ? new Date(c.at.getTime()) : null;
}

function recordNow(env = process.env, opts = {}) {
  return resolveClock(env, opts).now();
}

/**
 * The gateway's clock. `broker`: the broker whose server it started (null when
 * the server came from its command line, `fromArgv`). `call(name, args)` asks
 * that server. The override is honored only if the server confirms it.
 */
async function pinGatewayClock(env, { broker = null, fromArgv = false, call, toleranceMs = SERVER_TIME_TOLERANCE_MS } = {}) {
  const raw = env.FTH_REPLAY_NOW;
  if (raw === undefined || raw === null || raw === '') return resolveClock(env);
  if (fromArgv || !broker) return refusedClock(env, 'FTH_REPLAY_NOW is set but the gateway runs a server given on its command line (-- <command>), not a configured replay broker: the replay clock is refused.');
  const c = resolveClock(env, { broker });
  if (!c.replay) return c;
  let cfg;
  try {
    const r = await call('get_server_config', {});
    if (!r || r.isError) throw new Error(String((r && r.content && r.content[0] && r.content[0].text) || 'no result').slice(0, 200));
    cfg = JSON.parse(r.content[0].text);
  } catch (err) {
    return refusedClock(env, `FTH_REPLAY_NOW is set but the server's get_server_config could not be read (${err.message}): the replay clock is refused.`);
  }
  if (!cfg || cfg.replay !== true) return refusedClock(env, `FTH_REPLAY_NOW is set but the server of broker "${broker.name}" does not report itself a replay server (get_server_config.replay): the replay clock is refused.`);
  const t = Date.parse(String(cfg.serverTime || ''));
  if (!Number.isFinite(t) || Math.abs(t - c.at.getTime()) > toleranceMs) {
    return refusedClock(env, `FTH_REPLAY_NOW ${c.at.toISOString()} is not within ${Math.round(toleranceMs / 60000)} min of the replay server's time (${cfg.serverTime}): the replay clock is refused.`);
  }
  return c;
}

/** Pinned on first use, for the gateway's lifetime; before that, now() is the wall clock. */
function createGatewayClock(env, opts) {
  let pinned = null;
  let pending = null;
  return {
    ready: () => pending || (pending = pinGatewayClock(env, opts).then(c => (pinned = c))),
    now: () => (pinned ? pinned.now() : wallNow(env)),
  };
}

module.exports = { harnessNow, recordNow, replayAt, resolveClock, pinGatewayClock, createGatewayClock, ReplayClockError, SERVER_TIME_TOLERANCE_MS };
