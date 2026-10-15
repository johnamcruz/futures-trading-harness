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
 *   prop           a prop account profile (e.g. topstep_100k): a fresh run starts its attempt at `start`, before the
 *                  first decision, so every trade of the window is inside it (default: none)
 *   practice       setup-focused practice (learning/setup-moments.js): { mode: 'setup-focus', setupTf, quietSample, seed };
 *                  cycles only at the selected bars, the clock advancing between them; a practice-train or
 *                  practice-validate learning run only (learning/run-gate.js), never test or final (default: none)
 *   setupLibrary   a history library index (scripts/setup-library.js index), pinned for the run at its start: the
 *                  experience_lookup's code-measured section (default: none)
 *   brokerEnv      the broker server's variables the driver sets (defaults: backtester-mcp's); with `prop`, its
 *                  maxDailyLoss is the account's daily_loss_limit
 *
 * Isolation: the run home is a fresh harness home (FTH_HOME) of its own, never
 * the default home, the caller's FTH_HOME, or inside the repository; it holds
 * the runner's state, records, logs, journal, the broker's state and clock,
 * a copy of brokers.json and of the workspace's operator files. Child
 * processes get every path override pinned inside the run home and every live broker's
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
const { activeBroker, loadBrokers, CREDENTIAL } = require('../broker/config');
const { resolveClock } = require('../trading/harness-now');
const { holidayDates } = require('./schedule');
const { treeDigest, HARNESS_DIRS, CODE_DIRS } = require('../session/record');
const { validatePractice } = require('../learning/setup-moments');

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
// Backtester-mcp's variables (its README); another replay broker names its own.
const BROKER_ENV = { clockFile: 'BACKTESTER_CLOCK_FILE', stateDir: 'BACKTESTER_STATE_DIR', runId: 'BACKTESTER_RUN_ID', start: 'BACKTESTER_START', end: 'BACKTESTER_END', maxDailyLoss: 'BACKTESTER_MAX_DAILY_LOSS' };
// Overrides that could send a child's records, gate log, kill switch or settings outside the run home,
// or change how it runs. Each is set explicitly (never just removed: a child's .env load fills a missing
// or empty variable from <FTH_HOME>/.env and the repo's .env).
const PINNED = {
  FTH_GATE_LOG: p => path.join(p.runHome, 'logs', 'gate-log.jsonl'),
  FTH_BLACKOUTS_FILE: p => path.join(p.runHome, 'blackouts', 'blackouts.json'),
  FTH_KILL_SWITCH_FILE: p => path.join(p.runHome, 'STOP'),
  FTH_BROKERS_FILE: p => path.join(p.runHome, 'brokers.json'),
  FTH_ENV_FILE: p => path.join(p.runHome, '.env'),
  // Where a step archives the bars it used (session/bars-archive.js): the run's record dir.
  FTH_REPLAY_RECORD_DIR: p => p.runDir,
  FTH_TEST_NOW: () => 'none', FTH_DRY_RUN: () => '0', FTH_ORDER_GATE_SKIP: () => 'none', FTH_PAPER: () => '0',
};
const STRIPPED = Object.keys(PINNED);
// The gate's settings (trading/config.js and the calendar, strategies and accounts it reads): part of a run.
const GATE_ENV = ['FTH_LOSS_COOLDOWN_MIN', 'FTH_MAX_CONSECUTIVE_LOSSES', 'FTH_MAX_CORRELATED_POSITIONS', 'FTH_MAX_DAILY_LOSSES', 'FTH_MAX_ENTRIES_PER_DAY',
  'FTH_MIN_CONFLUENCE', 'FTH_MTF_MAX_AGE_MIN', 'FTH_PLAN_MAX_AGE_MIN', 'FTH_SIGNAL_MAX_AGE_MIN', 'FTH_SIGNAL_MAX_AGE_BARS', 'FTH_ENTRY_HOURS', 'FTH_NO_ENTRY_WINDOWS',
  'FTH_CLOSED_DATES', 'FTH_EARLY_CLOSE_DATES', 'FTH_STRATEGIES_DIRS', 'FTH_ACCOUNTS_DIRS', 'FTH_DISABLED_HOOKS', 'FTH_HOOKS_ENABLED',
  'FTH_HOOK_PROFILE', 'FTH_LANE_TIMEOUT_MS', 'FTH_UNKNOWN_ORDER_GRACE_MS',
  // How the roles' prompts carry their skills (role-skills.js): an index run and a full run are different runs.
  'FTH_ROLE_SKILLS'];
// A live broker's variable in a replay process: set (so no .env file fills it) and useless.
const DISABLED = 'disabled-by-fth-replay';
// Runner fields the driver owns: where the run's files go, and alerts (a replay pages no one).
const OWNED = ['dataDir', 'workdir', 'alertWebhook', 'alertCommand'];

/** The path as the filesystem resolves it: symlinks of its nearest existing ancestor followed, case folded where names fold. */
function realish(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  let real = head;
  try { real = fs.realpathSync.native(head); } catch (_err) { /* unreadable: as given */ }
  const out = path.join(real, ...tail);
  return process.platform === 'darwin' || process.platform === 'win32' ? out.toLowerCase() : out;
}

const inside = (child, parent) => {
  const rel = path.relative(realish(parent), realish(child));
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
  for (const k of ['premarket', 'endOfDay', 'learning']) if (r[k] !== undefined && typeof r[k] !== 'boolean') errors.push(`${k}: true or false`);
  if (r.experienceIndex !== undefined && !(typeof r.experienceIndex === 'string' && r.experienceIndex.trim())) errors.push('experienceIndex: an experience index file (scripts/experience-index.js build)');
  if (r.setupLibrary !== undefined && !(typeof r.setupLibrary === 'string' && r.setupLibrary.trim())) errors.push('setupLibrary: a history library index file (scripts/setup-library.js index)');
  let propAccount = null;
  if (r.prop !== undefined && !(typeof r.prop === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.prop))) errors.push('prop: an account profile name, e.g. topstep_100k');
  else if (r.prop !== undefined && root) {
    // Checked here, before any run state is written (a typo found later would change the config of a started run).
    try { propAccount = require('../trading/accounts').accountNamed(root, r.prop, env); } catch (err) { errors.push(`prop: ${err.message}`); }
  }
  const practice = validatePractice(r.practice);
  errors.push(...practice.errors);
  if (r.overrides !== undefined && !(r.overrides && typeof r.overrides === 'object' && !Array.isArray(r.overrides))) errors.push('overrides: an object');
  const overrides = r.overrides || {};
  for (const k of OWNED) if (k in overrides) errors.push(`overrides.${k}: set by the replay driver (the run's own files)`);
  const brokerEnv = { ...BROKER_ENV, ...(r.brokerEnv || {}) };
  for (const [k, v] of Object.entries(brokerEnv)) {
    if (v !== null && (!/^[A-Z_][A-Z0-9_]*$/.test(String(v)) || /^(FTH_|NODE_|PATH$|HOME$)/.test(String(v)))) errors.push(`brokerEnv.${k}: the replay server's own variable name (not FTH_*, NODE_*, PATH or HOME), or null`);
  }
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
  if (base.practice !== undefined || overrides.practice !== undefined) throw new Error('invalid replay config:\n- practice: set in the replay config (its own field), never in the runner config or overrides');
  const holidays = holidayDates(start, end);
  const derived = {
    ...base, ...overrides,
    dataDir: paths.bars, workdir: paths.workspace, alertWebhook: '', alertCommand: null,
    premarketAt: r.premarket === false ? '' : (overrides.premarketAt ?? base.premarketAt),
    eodReview: r.endOfDay !== false,
    closedDates: [...new Set([...(base.closedDates || []), ...(overrides.closedDates || []), ...holidays.closed])].sort(),
    earlyCloseDates: [...new Set([...(base.earlyCloseDates || []), ...(overrides.earlyCloseDates || []), ...holidays.early])].sort(),
    ...(practice.practice ? { practice: practice.practice } : {}),
  };
  const cfg = validateConfig(derived);
  return {
    runId: r.runId, broker: r.broker, start, end, everyNth, premarket: r.premarket !== false, endOfDay: r.endOfDay !== false,
    // A learning run unless declared otherwise (learning/run-gate.js): it lies in one window of the learning split.
    learning: r.learning !== false,
    // The experience index the run pins at its start (learning/experience-index.js pinIndex), or null.
    experienceIndex: r.experienceIndex ? path.resolve(baseDir, expandHome(r.experienceIndex, home)) : null,
    // The history library index the run pins at its start (learning/setup-library.js pinLibrary), or null.
    setupLibrary: r.setupLibrary ? path.resolve(baseDir, expandHome(r.setupLibrary, home)) : null,
    prop: r.prop || null,
    // Setup-focused practice (learning/setup-moments.js), or null: every bar runs, as live.
    practice: practice.practice,
    // A combine replay's broker stops the day at the account's own daily loss limit, as the firm does (not the
    // server's default): the agents size from the room it reports. 0 (none) turns the server's limit off.
    propDailyLoss: propAccount ? Number(propAccount.daily_loss_limit) || 0 : null,
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
  for (const [k, value] of Object.entries(PINNED)) env[k] = value(run.paths);
  env.FTH_HOME = run.paths.runHome;
  const live = liveBrokerVars(env);
  for (const v of live) env[v] = DISABLED;
  env.FTH_BROKER = run.broker;
  env.FTH_REPLAY_NOW = at.toISOString();
  const broker = activeBroker(env);
  const set = (key, value) => {
    if (!key) return;
    if (live.has(key)) throw new Error(`replay refused: ${key} is a live broker's variable; a replay never sets it`);
    env[key] = value;
  };
  set(run.brokerEnv.clockFile, run.paths.clockFile);
  set(run.brokerEnv.stateDir, run.paths.brokerDir);
  set(run.brokerEnv.runId, run.runId);
  set(run.brokerEnv.start, run.start.toISOString());
  set(run.brokerEnv.end, run.end.toISOString());
  if (run.propDailyLoss !== null && run.propDailyLoss !== undefined) set(run.brokerEnv.maxDailyLoss, String(run.propDailyLoss));
  if (broker.replay === true) set(broker.journalEnv, run.paths.journal); // a live broker is refused by brokerErrors
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

/**
 * What makes a run a run: the derived runner config, the window and decision
 * points, the harness command (harness and model), the gate's settings, the
 * replay broker's entry and settings, and the strategies, accounts,
 * skills, agents and rules the cycles read. Nothing about where it was started from.
 */
function configHash(run, base = process.env) {
  const env = replayEnv(base, run, { at: run.start });
  const gate = Object.fromEntries(GATE_ENV.filter(k => base[k] !== undefined && base[k] !== '').map(k => [k, base[k]]));
  // The role-skills mode as the runner reads it (unset or blank is index, the default): one mode, one hash.
  if (gate.FTH_ROLE_SKILLS !== undefined && ['', 'index'].includes(String(gate.FTH_ROLE_SKILLS).trim())) delete gate.FTH_ROLE_SKILLS;
  else if (gate.FTH_ROLE_SKILLS !== undefined) gate.FTH_ROLE_SKILLS = String(gate.FTH_ROLE_SKILLS).trim();
  const b = activeBroker(env);
  // The variables the driver sets are the run's own; maxDailyLoss is only when it sets it (a combine replay):
  // otherwise the user's value is a broker setting of the run, so a change makes it another run.
  const setsLimit = run.propDailyLoss !== null && run.propDailyLoss !== undefined;
  const own = new Set(Object.entries(run.brokerEnv).filter(([k]) => k !== 'maxDailyLoss' || setsLimit).map(([, v]) => v).concat(b.journalEnv));
  // Its settings (a credential never: a run's identity isn't its keys), the fingerprint allowlist among them (R35:
  // every allowlisted name is one of `env`).
  const names = [...new Set(b.env || [])].filter(k => !own.has(k) && !CREDENTIAL.test(k));
  const brokerSettings = Object.fromEntries(names.sort().map(k => [k, env[k] ?? null]));
  const body = {
    cfg: run.cfg, broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), everyNth: run.everyNth,
    premarket: run.premarket, endOfDay: run.endOfDay, prop: run.prop || null, command: harnessCommand(run, base), gate,
    // The node binary that starts an entry is no part of the run (a Node upgrade isn't a new run).
    // Its allowlist is in brokerSettings, by value (so a run's hash is the one it had before the list existed).
    brokerEntry: { ...b, journalPath: undefined, fingerprintEnv: undefined, command: (b.command || []).map(a => (a === process.execPath ? 'node' : a)) }, brokerSettings,
    harness: run.root ? treeDigest(run.root, HARNESS_DIRS) : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** The harness command a cycle runs (the prompt elided), as the runner builds it in the run's environment. */
/**
 * A run's setup, from its config alone (no environment, nothing seeded): the runner config, broker, window, the
 * decision times' settings and the harness's documents and code. Not its runId, learning flag or experience index:
 * the arms of one evaluation (learning/looks.js) share it and differ in their index only.
 */
function setupHash(run) {
  const body = {
    // The runner config without the run's own folders (its runId is in their paths).
    cfg: { ...run.cfg, dataDir: null, workdir: null }, broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), everyNth: run.everyNth,
    premarket: run.premarket, endOfDay: run.endOfDay, prop: run.prop || null,
    harness: run.root ? treeDigest(run.root, HARNESS_DIRS) : null, code: run.root ? treeDigest(run.root, CODE_DIRS) : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function harnessCommand(run, base = process.env) {
  return buildCommand(run.cfg, '<prompt>', run.root || '', replayEnv(base, run, { at: run.start }));
}

module.exports = { resolveReplay, isolationErrors, replayEnv, brokerErrors, configHash, setupHash, harnessCommand, liveBrokerVars, DISABLED, BROKER_ENV, STRIPPED, GATE_ENV, PINNED };
