'use strict';

/**
 * The replay server's days without source data (docs/BROKER-MCP-INTERFACE.md, get_server_config `dataGaps`: optional,
 * replay only; per root [{ day, bars, flow }]). On a day without bars (`bars: false`) the server still shows a front
 * contract and get_bars answers with the last bar it has (the evening before), so a run would wait the whole day for a
 * bar that never closes, run no cycle, and a continuous combine would count the dead day as a session. A day with bars
 * but no flow (`bars: true, flow: false`) is traded normally: its bars carry no flow, as any minute without flow
 * (the flow facts absent); it is only noted. Live always has data and never sends the field: this is replay only.
 *
 * The driver (replay/driver.js) reads the list once, at a run's fresh start, from a server started as the driver starts
 * it but on a scratch state folder (scratchServerConfig: the run's own broker state is never touched before its first
 * step), and skips those days: no decision time (replay/schedule.js NO_SOURCE_DATA), no session of a combine attempt
 * (its windows are its first maxSessions replayable days: combineForRun again on the points without them), and one log
 * line per day. The list is pinned in the run's manifest (`dataGaps`, named only when there are some), so a resume
 * skips the same days without asking again; a run started without the list (an older server, or before it existed)
 * keeps none. A server without the field (older) skips nothing: the run behaves as before.
 *
 * A day is skipped only when every symbol the run trades has no bars on it (a root the list doesn't name has its data),
 * only inside the run's window, and only on a day that would otherwise have had a session (holidays and weekends keep
 * their own reason).
 *
 *   gapsOf(config, run)            { present, malformed, days, flowOnly }: the run's skipped days (no bars) and its days
 *                                  with bars but no flow (traded), from a get_server_config answer
 *   scratchServerConfig(run, root, env)   the run's server's get_server_config, from a scratch state folder and harness
 *                                  home (the user's brokers copied in; nothing written to the user's home), or { error }
 *   readGaps(run, root, env)       the days, read from the server (throws when it can't be read)
 *   pinnedGaps(manifestFile)       null: no run started yet; else the days the run was started with ([] for none)
 *   applyGaps(run, days, { root, env })   sets run.dataGaps and re-derives a combine's attempt windows (throws, refused)
 *   gapsForRun(run, { manifestFile, read, root, env, log })   the whole step the driver runs before its decision times
 *   withServerGaps(run, { root, env, log })   applyGaps on the days read from the server (replay.js points: the plan;
 *                                  a server that can't be read is logged, nothing skipped)
 *   manifestPart(run)              { dataGaps } for the manifest, named only when there are some
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataGapsOk } = require('../broker/interface');
const { tradingDays, decisionPoints, NO_SOURCE_DATA } = require('./schedule');

/** A run symbol's contract root: a standard name (MNQ, or NQ:2026-03), its root before the month. */
const rootOf = symbol => String(symbol).split(':')[0].toUpperCase();

function gapsOf(config, run) {
  const raw = config && typeof config === 'object' ? config.dataGaps : undefined;
  if (raw === undefined) return { present: false, malformed: false, days: [], flowOnly: [] };
  if (!dataGapsOk(raw)) return { present: true, malformed: true, days: [], flowOnly: [] };
  const roots = [...new Set((run.cfg.symbols || []).map(rootOf))];
  const kind = (r, want) => new Set((raw[r] || []).filter(want).map(g => g.day));
  const noBars = roots.map(r => kind(r, g => g.bars === false));
  const noFlow = roots.map(r => kind(r, g => g.bars === true && g.flow === false));
  // The run's session days only: a holiday or weekend keeps its own reason, a day outside the window isn't the run's.
  const sessions = tradingDays(run.cfg, { start: run.start, end: run.end }).filter(d => !d.skipped).map(d => d.day);
  const days = roots.length ? sessions.filter(day => noBars.every(l => l.has(day))) : [];
  // Bars without flow: traded as any minute without flow is (the flow facts absent); noted, never skipped.
  const flowOnly = sessions.filter(day => !days.includes(day) && noFlow.some(l => l.has(day)));
  return { present: true, malformed: false, days, flowOnly };
}

function scratchServerConfig(run, root, env) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-server-config-'));
  try {
    fs.mkdirSync(path.join(scratch, 'broker'));
    const paths = { clockFile: path.join(scratch, 'clock.json'), brokerDir: path.join(scratch, 'broker'), journal: path.join(scratch, 'broker', 'journal.jsonl') };
    fs.writeFileSync(paths.clockFile, JSON.stringify({ now: run.start.toISOString() })); // the driver's clock file (replay/driver.js writeClock)
    // A harness home of its own, holding the brokers as the user configured them (as seedRunHome copies them): whatever
    // the call writes there (the contract translator's cache) goes with the scratch folder, never into the user's home.
    const { broker, brokers } = require('../broker/config').loadBrokers(env);
    const brokersFile = path.join(scratch, 'brokers.json');
    fs.writeFileSync(brokersFile, JSON.stringify({ broker, brokers }));
    const driven = require('./config').serverEnv({ ...env, FTH_HOME: scratch, FTH_BROKERS_FILE: brokersFile }, run, paths);
    return require('../learning/broker-limits').readBrokerConfig(root, driven);
  } catch (err) {
    return { error: String((err && err.message) || err).split('\n')[0] };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function readGaps(run, root, env) {
  const config = scratchServerConfig(run, root, env);
  if (!config || config.error) throw new Error(`replay refused: the replay server's configuration could not be read for its days without source data (${config ? config.error : 'no answer'})`);
  const g = gapsOf(config, run);
  if (g.malformed) throw new Error('replay refused: the replay server\'s get_server_config.dataGaps is malformed (want { <root>: [{ "day": "YYYY-MM-DD", "bars": true|false, "flow": true|false }] })');
  return g.days;
}

function pinnedGaps(manifestFile) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (_err) {
    return null;
  }
  return Array.isArray(m && m.dataGaps) ? [...m.dataGaps] : [];
}

function applyGaps(run, days, { root, env = process.env } = {}) {
  run.dataGaps = [...days];
  if (!days.length || !run.combine) return run;
  // The combine's windows again, on the replayable days only: an attempt's maxSessions count no dead day.
  const { combineForRun } = require('./combine-run');
  const c = run.combine;
  const spec = { account: c.account, attempts: c.attempts.map(a => a.start), maxSessions: c.maxSessions };
  try {
    const account = require('../trading/accounts').accountNamed(root || run.root, c.account, env);
    run.combine = combineForRun(spec, { points: decisionPoints(run.cfg, { start: run.start, end: run.end, dataGaps: days }), account, rolesBetween: require('../learning/splits').rolesBetween });
  } catch (err) {
    throw new Error(`replay refused: with the replay server's days without source data skipped (${days.join(', ')}), the combine's attempts no longer fit:\n- ${err.message}`, { cause: err });
  }
  return run;
}

async function gapsForRun(run, { manifestFile, read = null, root, env = process.env, log = () => {} }) {
  if (!Array.isArray(run.dataGaps)) {
    const pinned = pinnedGaps(manifestFile);
    const days = pinned !== null ? pinned : read ? await read() : [];
    applyGaps(run, days, { root, env });
  }
  for (const day of run.dataGaps) log(`${day}: ${NO_SOURCE_DATA}`);
  return run.dataGaps;
}

function withServerGaps(run, { root, env = process.env, log = () => {} }) {
  let days = [];
  try {
    days = readGaps(run, root, env);
  } catch (err) {
    log(`${String(err.message).replace(/^replay refused: /, '')}: no day skipped in this plan (a run refuses it)`);
  }
  return applyGaps(run, days, { root, env });
}

const manifestPart = run => (Array.isArray(run.dataGaps) && run.dataGaps.length ? { dataGaps: [...run.dataGaps] } : {});

module.exports = { gapsOf, scratchServerConfig, readGaps, pinnedGaps, applyGaps, gapsForRun, withServerGaps, manifestPart, rootOf };
