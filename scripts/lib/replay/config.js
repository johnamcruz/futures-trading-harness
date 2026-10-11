'use strict';

/**
 * A replay run's configuration, its isolation, and the environment of every
 * process it starts. A replay is the live harness (the runner, the harness
 * CLI the runner config selects, the agents, skills, scripts, order gate and
 * broker interface) on replayed history: only the data, the clock and the
 * fills are simulated, by a replay broker (a brokers.json entry with
 * "replay": true whose server attests it, e.g. backtester-mcp).
 *
 * Config (JSON; mcp-configs/replay.example.json):
 *   runId          the run's name: [A-Za-z0-9][A-Za-z0-9._-]{0,63}
 *   workDir        where run homes live (absolute or ~/...); the run home is <workDir>/<runId>
 *   autotrader     the runner config (an object, or a path relative to this file)
 *   overrides      fields laid over it for the replay (e.g. account: the replay broker's account id)
 *   broker         the replay broker's name in brokers.json
 *   start, end     the window (ISO 8601 UTC); decision times in [start, end)
 *   everyNthBar    1 (every closed bar) or more
 *   premarket      run premarket at premarketAt (default true)
 *   endOfDay       the agents' end-of-day review (default true); end of day always flattens
 *   brokerEnv      the broker server's variables the driver sets (defaults: backtester-mcp's)
 *
 * Isolation: the run home is a fresh harness home (FTH_HOME) of its own, never
 * the default home, the caller's FTH_HOME, or inside the repository; it holds
 * the runner's state, records, logs, journal, the broker's state and clock,
 * a copy of brokers.json and of the workspace's operator files. Child
 * processes get no path override pointing elsewhere and every live broker's
 * variables (credentials, server entry, journal) replaced, so nothing they
 * start can reach a live broker or account.
 *
 *   resolveReplay(raw, { baseDir, env, home, root })   { ...settings, paths, cfg (the derived runner config) }
 *   isolationErrors(runHome, { env, home, root })      [message]
 *   replayEnv(base, run, { at, brokers })             the environment for a process at replayed time `at`
 *   brokerErrors(env, run)                           [message]: the broker isn't a usable replay broker
 *   configHash(run)                                  sha256 of what makes a run a run
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandHome, harnessHome } = require('../paths');
const { validateConfig, buildCommand } = require('../autotrader');
const { activeBroker, loadBrokers } = require('../broker/config');
const { resolveClock } = require('../trading/harness-now');
const { holidayDates } = require('./schedule');

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
// Backtester-mcp's variables (its README); another replay broker names its own.
const BROKER_ENV = { clockFile: 'BACKTESTER_CLOCK_FILE', stateDir: 'BACKTESTER_STATE_DIR', runId: 'BACKTESTER_RUN_ID', start: 'BACKTESTER_START', end: 'BACKTESTER_END' };
// Path overrides that would send a child's records, gate log, kill switch or settings outside the run home.
const STRIPPED = ['FTH_GATE_LOG', 'FTH_BLACKOUTS_FILE', 'FTH_KILL_SWITCH_FILE', 'FTH_BROKERS_FILE', 'FTH_ENV_FILE', 'FTH_TEST_NOW', 'FTH_DRY_RUN', 'FTH_ORDER_GATE_SKIP', 'FTH_PAPER'];
// A live broker's variable in a replay process: set (so no .env file fills it) and useless.
const DISABLED = 'disabled-by-fth-replay';
// Runner fields the driver owns: where the run's files go, and alerts (a replay pages no one).
const OWNED = ['dataDir', 'workdir', 'alertWebhook', 'alertCommand'];

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

function isolationErrors(runHome, { env = process.env, home = os.homedir(), root }) {
  const errors = [];
  const live = [path.join(home, '.futures-trading-harness'), harnessHome(env, home)];
  for (const h of new Set(live)) {
    if (inside(runHome, h) || inside(h, runHome)) errors.push(`the run home ${runHome} overlaps the live harness home ${h}: a replay runs in a home of its own`);
  }
  if (root && (inside(runHome, root) || inside(root, runHome))) errors.push(`the run home ${runHome} overlaps the repository ${root}: replay data never goes in the repo`);
  if (inside(home, runHome)) errors.push(`the run home ${runHome} contains your home directory`);
  return errors;
}

function readAutotrader(spec, baseDir) {
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) return { raw: spec, file: null };
  if (typeof spec !== 'string' || !spec) throw new Error('replay config: autotrader must be the runner config (an object) or its path');
  const file = path.resolve(baseDir, expandHome(spec));
  return { raw: JSON.parse(fs.readFileSync(file, 'utf8')), file };
}

function resolveReplay(raw, { baseDir = process.cwd(), env = process.env, home = os.homedir(), root }) {
  const errors = [];
  const r = raw && typeof raw === 'object' ? raw : {};
  if (!RUN_ID.test(String(r.runId || ''))) errors.push('runId: letters, digits, ".", "_", "-" (up to 64), starting with a letter or digit');
  if (!(typeof r.workDir === 'string' && /^(\/|~\/)/.test(r.workDir))) errors.push('workDir: an absolute path or ~/...');
  if (!(typeof r.broker === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(r.broker))) errors.push('broker: the replay broker\'s name in brokers.json');
  for (const k of ['start', 'end']) if (!ISO.test(String(r[k] || ''))) errors.push(`${k}: an ISO 8601 UTC time, e.g. 2024-03-04T00:00:00Z`);
  const start = new Date(r.start);
  const end = new Date(r.end);
  if (!errors.length && !(start < end)) errors.push('end: after start');
  const everyNth = r.everyNthBar === undefined ? 1 : r.everyNthBar;
  if (!(Number.isInteger(everyNth) && everyNth >= 1)) errors.push('everyNthBar: 1 or more');
  for (const k of ['premarket', 'endOfDay']) if (r[k] !== undefined && typeof r[k] !== 'boolean') errors.push(`${k}: true or false`);
  if (r.overrides !== undefined && !(r.overrides && typeof r.overrides === 'object' && !Array.isArray(r.overrides))) errors.push('overrides: an object');
  const overrides = r.overrides || {};
  for (const k of OWNED) if (k in overrides) errors.push(`overrides.${k}: set by the replay driver (the run's own files)`);
  const brokerEnv = { ...BROKER_ENV, ...(r.brokerEnv || {}) };
  for (const [k, v] of Object.entries(brokerEnv)) if (v !== null && !/^[A-Z_][A-Z0-9_]*$/.test(String(v))) errors.push(`brokerEnv.${k}: a variable name or null`);
  if (errors.length) throw new Error(`invalid replay config:\n- ${errors.join('\n- ')}`);

  const runHome = path.join(path.resolve(expandHome(r.workDir, home)), r.runId);
  const iso = isolationErrors(runHome, { env, home, root });
  if (iso.length) throw new Error(`replay refused:\n- ${iso.join('\n- ')}`);
  const runDir = path.join(runHome, 'replay', r.runId);
  const paths = {
    runHome, runDir, workspace: path.join(runHome, 'workspace'), bars: path.join(runHome, 'bars'),
    brokerDir: path.join(runDir, 'broker'), clockFile: path.join(runDir, 'clock.json'), journal: path.join(runDir, 'broker', 'journal.jsonl'),
    autotrader: path.join(runDir, 'autotrader.json'), manifest: path.join(runDir, 'manifest.json'), stepsLog: path.join(runDir, 'steps.log'),
  };
  const { raw: base, file: autotraderFile } = readAutotrader(r.autotrader, baseDir);
  const holidays = holidayDates(start, end);
  const derived = {
    ...base, ...overrides,
    dataDir: paths.bars, workdir: paths.workspace, alertWebhook: '', alertCommand: null,
    premarketAt: r.premarket === false ? '' : (overrides.premarketAt ?? base.premarketAt),
    eodReview: r.endOfDay !== false,
    closedDates: [...new Set([...(base.closedDates || []), ...(overrides.closedDates || []), ...holidays.closed])].sort(),
    earlyCloseDates: [...new Set([...(base.earlyCloseDates || []), ...(overrides.earlyCloseDates || []), ...holidays.early])].sort(),
  };
  const cfg = validateConfig(derived);
  return {
    runId: r.runId, broker: r.broker, start, end, everyNth, premarket: r.premarket !== false, endOfDay: r.endOfDay !== false,
    brokerEnv, paths, derived, cfg, autotraderFile, root,
  };
}

/** Every variable a live (non-replay) broker's server reads: its credentials, entry and journal. */
function liveBrokerVars(env) {
  const { brokers } = loadBrokers(env);
  const vars = new Set();
  for (const b of Object.values(brokers)) {
    if (b.replay === true) continue;
    for (const v of [...(Array.isArray(b.env) ? b.env : []), b.entryEnv, b.journalEnv]) if (v) vars.add(String(v));
  }
  return vars;
}

function replayEnv(base, run, { at }) {
  const env = { ...base };
  for (const k of STRIPPED) delete env[k];
  env.FTH_HOME = run.paths.runHome;
  for (const v of liveBrokerVars(env)) env[v] = DISABLED;
  env.FTH_BROKER = run.broker;
  env.FTH_REPLAY_NOW = at.toISOString();
  const set = (key, value) => { if (key) env[key] = value; };
  set(run.brokerEnv.clockFile, run.paths.clockFile);
  set(run.brokerEnv.stateDir, run.paths.brokerDir);
  set(run.brokerEnv.runId, run.runId);
  set(run.brokerEnv.start, run.start.toISOString());
  set(run.brokerEnv.end, run.end.toISOString());
  const broker = activeBroker(env);
  set(broker.journalEnv, run.paths.journal);
  return env;
}

function brokerErrors(env, run) {
  let b;
  try {
    b = activeBroker(env);
  } catch (err) {
    return [err.message];
  }
  const errors = [];
  if (b.name !== run.broker) errors.push(`the selected broker is "${b.name}", not "${run.broker}"`);
  if (b.replay !== true) errors.push(`broker "${b.name}" is not a replay broker ("replay": true in brokers.json): a replay never runs on a live broker`);
  if (!b.journalEnv) errors.push(`broker "${b.name}" has no journalEnv: the replay can't give the run a journal of its own`);
  if (!b.command) errors.push(`broker "${b.name}" has no server configured (entry, entryEnv or command)`);
  if (errors.length) return errors;
  const clock = resolveClock(env, { testClock: false });
  if (!clock.replay) errors.push(clock.refused);
  if (path.resolve(b.journalPath) !== path.resolve(run.paths.journal)) errors.push(`broker "${b.name}"'s journal resolves to ${b.journalPath}, not the run's ${run.paths.journal}`);
  return errors;
}

/** What makes a run a run: the derived runner config, the window, the decision points, the broker, and the harness command. */
function configHash(run, base = process.env) {
  // The gate's settings come from FTH_* variables: a changed one is a changed run.
  const gate = Object.fromEntries(Object.entries(base).filter(([k]) => k.startsWith('FTH_') && !STRIPPED.includes(k) && !['FTH_HOME', 'FTH_REPLAY_NOW', 'FTH_BROKER'].includes(k)).sort());
  const body = {
    cfg: run.cfg, broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), everyNth: run.everyNth,
    premarket: run.premarket, endOfDay: run.endOfDay, command: harnessCommand(run, base), gate,
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** The harness command a cycle runs (the prompt elided), as the runner builds it in the run's environment. */
function harnessCommand(run, base = process.env) {
  return buildCommand(run.cfg, '<prompt>', run.root || '', replayEnv(base, run, { at: run.start }));
}

module.exports = { resolveReplay, isolationErrors, replayEnv, brokerErrors, configHash, harnessCommand, liveBrokerVars, DISABLED, BROKER_ENV, STRIPPED };
