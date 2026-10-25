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
 *   setupLibrary   a history library index (scripts/setup-library.js index), pinned for the run at its start (default:
 *                  none). Pinned alone it is code's, never shown to the model
 *   libraryDisplay true shows the pinned library to the model: experience_lookup's code-measured section (counts, the
 *                  win rate and no-room only); needs setupLibrary; part of the setup (setupHash), so an arm with it
 *                  and one without are two setups, paired only as a library-display arm (learning/looks.js) (default: false)
 *   riskRecord     a risk record index file (learning/risk-record-index.js buildRiskIndex),
 *                  pinned for the run at its start (default: none). Pinned alone it is code's, never shown to the model
 *   riskRecordDisplay true shows the pinned risk record to the model: experience_lookup's "your risk record" section (counts
 *                  and outcomes of its own risk decisions by account state, practice-train days before the bar's session);
 *                  needs riskRecord; part of the setup (setupHash) only when on, so existing hashes are unchanged; an arm
 *                  dimension of its own (learning/looks.js `+risk:`), and a resume can't change it (default: false)
 *   comparisonArm  true declares the run one arm of a with/without comparison (two replays, the paired test): stage 2
 *                  shows the risk record only on one (replay/stage.js); a declaration only, in no hash (default: false)
 *   noWeb          true attests that a custom command (autotrader harness `custom`) reaches no web: its permissions
 *                  are its own, so a learning run's training preflight requires it (no-web-in-replay); a declaration
 *                  only, in no hash (default: false)
 *   latency        charge each cycle's real time on the replay clock, as live (replay/latency.js): the clock runs with
 *                  the wall clock during a step, so orders go, fill and expire at the bar plus the cycle's time (default:
 *                  on for a learning run, off for one declared not learning)
 *   curatedList    a curated lists document (scripts/curated-lists.js build) and its list: { file, list: 'mix' | <list> },
 *                  the run's market (symbol, bar and setup timeframes) the list's, every bar (no everyNthBar), no
 *                  prop attempt, each window holding a decision time; with `practice` only: the run steps the list's
 *                  windows and those days' premarket and end of day, and manages whatever is open after one bar by bar
 *                  until flat (any later day included); pinned at its start (learning/curated-lists.js) (default: none)
 *   stepWindows    the training loop's trend-set runs only (replay/step-windows.js; the preflight refuses it elsewhere):
 *                  { kind: 'trend-set', windows: [{ from, to }] } bar-close bounds (ISO, from exclusive); the run steps
 *                  those windows' trade times and those days' premarket and end of day, and manages what is open after
 *                  one bar by bar until flat (curatedPoints); nothing of them reaches the runner config or the prompt;
 *                  never with curatedList, practice, combine, accountStates or prop (default: none)
 *   accountStates  a stage-2 curated run's account states (prop/account-states.js, scripts/account-states.js draw):
 *                  { file }. Each window day starts from a drawn state (assignStates): the run seeds its attempt record
 *                  (prop-state seedAttempt) and the replay broker's balance (the balance schedule, brokerEnv
 *                  balanceSchedule) from it before the day's first step (replay/driver.js). Needs curatedList, never
 *                  prop; the document's account must still be the profile it was drawn on; part of both hashes
 *                  (default: none)
 *   combine        stage 2's continuous combine (replay/combine-run.js): { account, attempts: ['YYYY-MM-DD', ...],
 *                  maxSessions }. Each attempt a real combine from zero (a fresh record at the profile's starting balance,
 *                  set through the balance schedule) on consecutive trading days from its start, every decision time of
 *                  the run's sessions stepped, ended when it passes or blows (no step after) or after maxSessions sessions
 *                  (default: the profile's sessions; unfinished). Stage 2 only; never with accountStates, curatedList,
 *                  prop or practice; every bar (everyNthBar 1); the account the active policy strategy's; each attempt's
 *                  window inside the run's, inside one learning split window, never overlapping another; part of both
 *                  hashes (default: none)
 *   dayAttempts    the training loop's runs only (replay/day-attempts.js; set by its code, train/loop.js windowRun; the
 *                  training preflight refuses it elsewhere): { account }, the active policy strategy's account. Each
 *                  session day starts a fresh attempt at the profile's starting balance (the balance schedule) before its
 *                  first step, so every entry is sized as live sizes it in a running attempt and no day's trades reach
 *                  another day; never with prop, accountStates or combine; part of both hashes (default: none)
 *   brokerEnv      the broker server's variables the driver sets (defaults: backtester-mcp's); with `prop`,
 *                  `accountStates`, `combine` or `dayAttempts`, its maxDailyLoss is the account's daily_loss_limit
 *   stage          a training preset (replay/stage.js; docs/TRAINING.md): 1 learn to trade, 2 pass prop. It sets
 *                  defaults and requirements only: an explicit value contradicting it is refused, never overridden;
 *                  the training preflight (learning/preflight.js) checks the rest; part of both hashes (default: none).
 *                  An A/B of a skill change is two replays with the same stage, seed and list (practice and
 *                  curatedList), compared with the paired test (train/paired.js)
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
 *   runSettings(run, base)                           { gate, brokerEntry, brokerSettings }: the gate's settings and the
 *                                                    broker's entry and settings (no credential) the hash reads
 *   setupHash(run), setupBase(run)                   a run's setup (the arms of one evaluation share it); the same
 *                                                    without the library display (a library-display pair shares it)
 *   setupFixed(run)                                  the setup without its code digest (a resume keeps it)
 *   lookArm(run)                                     the arm its look names (learning/looks.js ARM)
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
const { latencySetting } = require('./latency');
const { WALL_START } = require('../trading/harness-now');
const { validateCuratedConfig, curatedForRun, emptyWindows } = require('../learning/curated-lists');
const { decisionPoints } = require('./schedule');
const { applyStage, stageRequirements } = require('./stage');
const { validateCombineConfig, combineForRun } = require('./combine-run');
const { adapterTag } = require('../learning/adapter');
const { validateStepWindows, stepWindowsForRun } = require('./step-windows');
const { validateDayAttempts } = require('./day-attempts');

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
// Backtester-mcp's variables (its README); another replay broker names its own.
// balanceSchedule: the replay-only balance schedule (a run with account states: the balance each practice day starts at).
const BROKER_ENV = { clockFile: 'BACKTESTER_CLOCK_FILE', stateDir: 'BACKTESTER_STATE_DIR', runId: 'BACKTESTER_RUN_ID', start: 'BACKTESTER_START', end: 'BACKTESTER_END', maxDailyLoss: 'BACKTESTER_MAX_DAILY_LOSS', balanceSchedule: 'BACKTESTER_BALANCE_SCHEDULE' };
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

/** A run whose manifest exists and doesn't say it charges latency (started before the setting, or pinned). */
function startedPinned(manifestFile) {
  try { return JSON.parse(fs.readFileSync(manifestFile, 'utf8')).latency !== true; } catch (_err) { return false; }
}

function resolveReplay(raw, { baseDir = process.cwd(), env = process.env, home = os.homedir(), root }) {
  // A stage preset's defaults under the config's own values; a value contradicting it is refused (replay/stage.js).
  const staged = applyStage(raw);
  const errors = [...staged.errors];
  const r = staged.raw;
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
  if (r.libraryDisplay !== undefined && typeof r.libraryDisplay !== 'boolean') errors.push('libraryDisplay: true or false');
  else if (r.libraryDisplay === true && r.setupLibrary === undefined) errors.push('libraryDisplay: shows the pinned history library; name it (setupLibrary)');
  if (r.riskRecord !== undefined && !(typeof r.riskRecord === 'string' && r.riskRecord.trim())) errors.push('riskRecord: a risk record index file (learning/risk-record-index.js)');
  if (r.riskRecordDisplay !== undefined && typeof r.riskRecordDisplay !== 'boolean') errors.push('riskRecordDisplay: true or false');
  else if (r.riskRecordDisplay === true && r.riskRecord === undefined) errors.push('riskRecordDisplay: shows the pinned risk record; name it (riskRecord)');
  if (r.comparisonArm !== undefined && typeof r.comparisonArm !== 'boolean') errors.push('comparisonArm: true or false');
  if (r.noWeb !== undefined && typeof r.noWeb !== 'boolean') errors.push('noWeb: true or false');
  let propAccount = null;
  if (r.prop !== undefined && !(typeof r.prop === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(r.prop))) errors.push('prop: an account profile name, e.g. topstep_100k');
  else if (r.prop !== undefined && root) {
    // Checked here, before any run state is written (a typo found later would change the config of a started run).
    try { propAccount = require('../trading/accounts').accountNamed(root, r.prop, env); } catch (err) { errors.push(`prop: ${err.message}`); }
  }
  const practice = validatePractice(r.practice);
  errors.push(...practice.errors);
  const latency = latencySetting(r.latency, r.learning !== false);
  if (latency.error) errors.push(latency.error);
  // A run started before the setting (its manifest doesn't say latency: true) keeps its pinned clock when the config
  // doesn't name one, so it resumes under the hash it was started with.
  const curatedCfg = validateCuratedConfig(r.curatedList);
  errors.push(...curatedCfg.errors);
  if (curatedCfg.curated && !practice.practice) errors.push('curatedList: runs through setup-focused practice; set practice too');
  if (curatedCfg.curated && everyNth !== 1) errors.push('curatedList: every bar of its windows runs (everyNthBar 1)');
  if (curatedCfg.curated && r.prop !== undefined) errors.push('curatedList: not with prop (a combine attempt is judged over whole days; curated runs are scored apart)');
  const statesCfg = r.accountStates;
  if (statesCfg !== undefined) {
    if (!(statesCfg && typeof statesCfg === 'object' && !Array.isArray(statesCfg) && typeof statesCfg.file === 'string' && statesCfg.file.trim())) errors.push('accountStates: { "file": "<account states>" } (scripts/account-states.js draw)');
    else if (Object.keys(statesCfg).some(k => k !== 'file')) errors.push(`accountStates.${Object.keys(statesCfg).find(k => k !== 'file')}: unknown (file)`);
    if (!curatedCfg.curated) errors.push('accountStates: each curated window day starts from a drawn state; set curatedList too');
    if (r.prop !== undefined) errors.push('accountStates: not with prop (the run\'s attempt is seeded from the drawn states)');
  }
  // The training loop's stepped windows (replay/step-windows.js): a whole-session run's bars, only these stretches stepped.
  const stepCfg = validateStepWindows(r.stepWindows);
  errors.push(...stepCfg.errors);
  if (stepCfg.stepWindows) {
    for (const k of ['curatedList', 'practice', 'combine', 'accountStates', 'prop']) if (r[k] !== undefined) errors.push(`stepWindows: not with ${k} (the windows are stepped as a whole-session run steps its bars, nothing else chosen)`);
    if (everyNth !== 1) errors.push('stepWindows: every bar of its windows runs (everyNthBar 1)');
    // Only the loop's trend-set role runs them, which the training preflight checks; a run declared not learning skips it.
    if (r.learning === false) errors.push('stepWindows: a learning run only (the training loop\'s trend-set role, checked by the training preflight, which a run declared not learning skips)');
  }
  // Stage 2's continuous combine: one stage-2 mode or the other (drawn states on curated days), never both.
  const combineCfg = validateCombineConfig(r.combine);
  errors.push(...combineCfg.errors);
  let combineAccount = null;
  if (r.combine !== undefined) {
    const req = staged.stage ? stageRequirements(staged.stage) : null;
    if (!(req && req.combine === 'allowed')) errors.push('combine: stage 2\'s continuous combine (stage: 2); refused in stage 1 and without a stage');
    if (statesCfg !== undefined) errors.push('combine: not with accountStates (drawn states practise curated days; the continuous combine trades whole attempts from zero): one stage-2 mode per replay config');
    if (curatedCfg.curated) errors.push('combine: not with curatedList (every decision time of an attempt\'s days is stepped)');
    if (r.prop !== undefined) errors.push('combine: not with prop (combine.account is the attempts\' account)');
    if (practice.practice) errors.push('combine: not with practice (no setup-focus skipping: every decision time is stepped)');
    if (everyNth !== 1) errors.push('combine: every bar of an attempt\'s days runs (everyNthBar 1)');
    if (combineCfg.combine && !root) errors.push('combine: needs the harness root to load its account and the policy strategy (resolveReplay { root })');
    if (combineCfg.combine && root) {
      try { combineAccount = require('../trading/accounts').accountNamed(root, combineCfg.combine.account, env); } catch (err) { errors.push(`combine.account: ${err.message}`); }
      // The runner snapshots and closes the days of the account its policy strategy trades: the attempts must be it.
      let policy = null;
      try { policy = policyAccount(root, env); } catch (err) { errors.push(`combine.account: ${String(err.message).split('\n').pop().replace(/^- /, '')}`); }
      if (combineAccount && !(policy && policy.name === combineAccount.name)) errors.push(`combine.account: ${combineAccount.name} is not the account the active policy strategy trades (${policy ? policy.name : 'none'}): the runner keeps the attempt record of that account only`);
    }
  }
  // The training loop's day attempts (replay/day-attempts.js): a fresh attempt each session day, on the policy's account.
  const dayCfg = validateDayAttempts(r.dayAttempts);
  errors.push(...dayCfg.errors);
  let dayAccount = null;
  if (r.dayAttempts !== undefined) {
    for (const k of ['prop', 'accountStates', 'combine']) if (r[k] !== undefined) errors.push(`dayAttempts: not with ${k} (each day's attempt starts fresh; ${k} keeps an attempt of its own)`);
    if (dayCfg.dayAttempts && !root) errors.push('dayAttempts: needs the harness root to load its account and the policy strategy (resolveReplay { root })');
    if (dayCfg.dayAttempts && root) {
      try { dayAccount = require('../trading/accounts').accountNamed(root, dayCfg.dayAttempts.account, env); } catch (err) { errors.push(`dayAttempts.account: ${err.message}`); }
      // The runner snapshots and closes the days of the account its policy strategy trades: the attempts must be it.
      let policy = null;
      try { policy = policyAccount(root, env); } catch (err) { errors.push(`dayAttempts.account: ${String(err.message).split('\n').pop().replace(/^- /, '')}`); }
      if (dayAccount && !(policy && policy.name === dayAccount.name)) errors.push(`dayAttempts.account: ${dayAccount.name} is not the account the active policy strategy trades (${policy ? policy.name : 'none'}): the runner keeps the attempt record of that account only`);
    }
  }
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
    // A run with account states (or a combine, or day attempts): the balance each day (attempt) starts at (read by the replay broker), and what each day was given.
    balanceSchedule: path.join(runDir, 'broker', 'balance-schedule.json'), statesLog: path.join(runDir, 'account-states.jsonl'),
  };
  const pinnedResume = r.latency === undefined && startedPinned(paths.manifest);
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
  // The curated list: its windows inside the run's, its use the run's window (a validation list never on practice-train),
  // its market the run's, and every window holding a decision time of the run's sessions.
  let curated = null;
  if (curatedCfg.curated) {
    try {
      curated = curatedForRun({ ...curatedCfg.curated, file: path.resolve(baseDir, expandHome(curatedCfg.curated.file, home)), start, end, symbols: cfg.symbols, timeframe: cfg.timeframe, setupTf: practice.practice.setupTf });
      const missed = emptyWindows(decisionPoints(cfg, { start, end }), curated, (cfg.barDelaySeconds || 0) * 1000);
      if (missed.length) throw new Error(`curatedList: ${missed.length} window(s) hold no decision time of the run's sessions, the first ${new Date(missed[0].from).toISOString()}`);
    } catch (err) {
      throw new Error(`invalid replay config:\n- ${err.message}`, { cause: err });
    }
  }
  // The stepped windows: inside the run, each holding a decision time of the run's sessions (as a curated list's).
  let stepWindows = null;
  if (stepCfg.stepWindows) {
    try {
      stepWindows = stepWindowsForRun(stepCfg.stepWindows, { start, end });
      const missed = emptyWindows(decisionPoints(cfg, { start, end }), stepWindows, (cfg.barDelaySeconds || 0) * 1000);
      if (missed.length) throw new Error(`stepWindows: ${missed.length} window(s) hold no decision time of the run's sessions, the first ${new Date(missed[0].from).toISOString()}`);
    } catch (err) {
      throw new Error(`invalid replay config:\n- ${err.message}`, { cause: err });
    }
  }
  // The continuous combine: each attempt's window on the run's trading days, inside the run and one split window.
  let combineRun = null;
  if (combineCfg.combine && combineAccount) {
    try {
      combineRun = combineForRun(combineCfg.combine, { points: decisionPoints(cfg, { start, end }), account: combineAccount, rolesBetween: require('../learning/splits').rolesBetween });
    } catch (err) {
      throw new Error(`invalid replay config:\n- ${err.message}`, { cause: err });
    }
  }
  // The account states: the document (its hash checked), its account still the profile it was drawn on, its draws
  // assigned to the curated window days.
  let accountStates = null;
  let statesAccount = null;
  if (statesCfg !== undefined) {
    try {
      const S = require('../prop/account-states');
      const file = path.resolve(baseDir, expandHome(statesCfg.file, home));
      const doc = S.readDocument(file);
      statesAccount = require('../trading/accounts').accountNamed(root, doc.account, env);
      if (S.accountDigest(statesAccount) !== doc.accountDigest) throw new Error(`accountStates: ${doc.account}'s rules changed since the states were drawn: draw them again`);
      accountStates = { file, hash: doc.hash, account: doc.account, assignment: S.assignStates(doc, curated.windows) };
    } catch (err) {
      throw new Error(`invalid replay config:\n- ${err.message}`, { cause: err });
    }
  }
  // The account whose limits the replay broker runs with: the run's own (prop, account states), else the policy
  // strategy's (the account a learning run trades for), else none.
  const limitsAccount = propAccount || statesAccount || combineAccount || dayAccount || policyAccount(root, env);
  const ownAccount = propAccount || statesAccount || combineAccount || dayAccount;
  return {
    runId: r.runId, broker: r.broker, start, end, everyNth, premarket: r.premarket !== false, endOfDay: r.endOfDay !== false,
    // A learning run unless declared otherwise (learning/run-gate.js): it lies in one window of the learning split.
    learning: r.learning !== false,
    // The experience index the run pins at its start (learning/experience-index.js pinIndex), or null.
    experienceIndex: r.experienceIndex ? path.resolve(baseDir, expandHome(r.experienceIndex, home)) : null,
    // The history library index the run pins at its start (learning/setup-library.js pinLibrary), or null.
    setupLibrary: r.setupLibrary ? path.resolve(baseDir, expandHome(r.setupLibrary, home)) : null,
    // Whether the model is shown that library (experience_lookup); off unless the config says true.
    libraryDisplay: r.libraryDisplay === true,
    // The risk record index the run pins at its start (learning/risk-record-index.js pinRiskRecord), or null, and whether it is shown.
    riskRecord: r.riskRecord ? path.resolve(baseDir, expandHome(r.riskRecord, home)) : null,
    riskRecordDisplay: r.riskRecordDisplay === true,
    // Whether the run is declared one arm of a with/without comparison (replay/stage.js); in no hash.
    comparisonArm: r.comparisonArm === true,
    // A custom command's attestation that it reaches no web (the training preflight's no-web-in-replay); in no hash.
    noWeb: r.noWeb === true,
    prop: r.prop || null,
    // The training stage preset (replay/stage.js), or null.
    stage: staged.stage,
    // Setup-focused practice (learning/setup-moments.js), or null: every bar runs, as live.
    practice: practice.practice,
    // The cycle's real time charged on the replay clock (replay/latency.js): on unless said otherwise for a learning run.
    latency: pinnedResume ? false : latency.value,
    // A resume of a run started before the setting (pinned, the config naming none): the preflight passes it, noted.
    latencyPinnedResume: pinnedResume,
    // The curated list the run replays (learning/curated-lists.js curatedForRun), or null: every window bar, as practice runs.
    curated,
    // The training loop's stepped windows (replay/step-windows.js), or null: every decision time of the run's sessions.
    stepWindows,
    // A combine replay's broker stops the day at the account's own daily loss limit, as the firm does (not the
    // server's default): the agents size from the room it reports. 0 (none) turns the server's limit off.
    propDailyLoss: ownAccount ? Number(ownAccount.daily_loss_limit) || 0 : null,
    // The account's limits the replay broker is run with (trading/accounts.js accountLimits), passed through the env names
    // of the broker's brokers.json `limits` (replayEnv), or null: a run with no account.
    limits: limitsAccount ? require('../trading/accounts').accountLimits(limitsAccount, cfg.symbols) : null,
    // The account states the run's window days start from (prop/account-states.js), or null.
    accountStates,
    // Stage 2's continuous combine (replay/combine-run.js combineForRun): its account, maxSessions and attempts' windows, or null.
    combine: combineRun,
    // The training loop's day attempts (replay/day-attempts.js): { account }, or null.
    dayAttempts: dayCfg.dayAttempts && dayAccount ? { account: dayAccount.name } : null,
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

/**
 * The account the active policy strategy trades (its `account`), or null: none, or one that doesn't load. More than one
 * active policy naming different accounts is refused (load order must never decide which account's limits the broker gets).
 */
function policyAccount(root, env) {
  if (!root) return null;
  let names;
  try {
    names = [...new Set(require('../trading/strategies').loadStrategies(root, env).strategies.filter(s => s.signal === 'policy' && s.status === 'active' && s.account).map(s => s.account))];
  } catch (_err) {
    return null;
  }
  if (names.length > 1) throw new Error(`invalid replay config:\n- more than one active policy strategy names an account (${names.sort().join(', ')}): the replay broker's limits come from one; pass the run's account (prop) or keep one policy active`);
  try {
    return names.length ? require('../trading/accounts').accountNamed(root, names[0], env) : null;
  } catch (_err) {
    return null;
  }
}

/** The env variables (name -> value) that carry the account's limits to `broker`, a replay broker only; {} for a live one. */
function limitsEnv(run, broker) {
  const out = {};
  if (!(broker && broker.replay === true && run.limits && broker.limits)) return out;
  for (const key of ['dailyLoss', 'maxOrderSize', 'maxPositionSize']) {
    if (broker.limits[key] && run.limits[key] !== null && run.limits[key] !== undefined) out[broker.limits[key]] = String(run.limits[key]);
  }
  return out;
}

/**
 * Only the replay broker server's own variables, as replayEnv gives them (its clock, state, run, window, journal and the
 * account's limits), over `base`, with its run files in `paths` ({ clockFile, brokerDir, journal }): to start the server
 * outside a run, as the preflight does on a scratch folder. Nothing else of the run's environment is touched.
 */
function serverEnv(base, run, paths) {
  const env = { ...base, FTH_BROKER: run.broker };
  const broker = activeBroker(env);
  if (broker.replay !== true) return env;
  const set = (key, value) => { if (key) env[key] = value; };
  set(run.brokerEnv.clockFile, paths.clockFile);
  set(run.brokerEnv.stateDir, paths.brokerDir);
  set(run.brokerEnv.runId, run.runId);
  set(run.brokerEnv.start, run.start.toISOString());
  set(run.brokerEnv.end, run.end.toISOString());
  if (run.propDailyLoss !== null && run.propDailyLoss !== undefined) set(run.brokerEnv.maxDailyLoss, String(run.propDailyLoss));
  for (const [name, value] of Object.entries(limitsEnv(run, broker))) set(name, value);
  set(broker.journalEnv, paths.journal);
  return env;
}

function replayEnv(base, run, { at }) {
  const env = { ...base };
  for (const [k, value] of Object.entries(PINNED)) env[k] = value(run.paths);
  env.FTH_HOME = run.paths.runHome;
  const live = liveBrokerVars(env);
  for (const v of live) env[v] = DISABLED;
  env.FTH_BROKER = run.broker;
  env.FTH_REPLAY_NOW = at.toISOString();
  // Never inherited: only the driver's charged step sets it (a stale one would run a pinned run's clock).
  delete env[WALL_START];
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
  // The account's limits, for a replay broker only (a live broker keeps its own): each into the variable its brokers.json
  // entry names (`limits`); a limit the account states none for (a size) is not set.
  for (const [name, value] of Object.entries(limitsEnv(run, broker))) set(name, value);
  // The balance schedule is the driver's alone: set for a run with account states, never inherited by any other run.
  if (run.accountStates || run.combine || run.dayAttempts) set(run.brokerEnv.balanceSchedule, run.paths.balanceSchedule);
  else if (run.brokerEnv.balanceSchedule) delete env[run.brokerEnv.balanceSchedule];
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
/**
 * The gate's settings and the replay broker's entry and settings (never a credential) a run runs under: part of its
 * config hash, and of its setup record (train/ab-compare.js: the same market and data).
 */
function runSettings(run, base = process.env) {
  const env = replayEnv(base, run, { at: run.start });
  const gate = Object.fromEntries(GATE_ENV.filter(k => base[k] !== undefined && base[k] !== '').map(k => [k, base[k]]));
  // The role-skills mode as the runner reads it (unset or blank is index, the default): one mode, one hash.
  if (gate.FTH_ROLE_SKILLS !== undefined && ['', 'index'].includes(String(gate.FTH_ROLE_SKILLS).trim())) delete gate.FTH_ROLE_SKILLS;
  else if (gate.FTH_ROLE_SKILLS !== undefined) gate.FTH_ROLE_SKILLS = String(gate.FTH_ROLE_SKILLS).trim();
  const b = activeBroker(env);
  // The variables the driver sets are the run's own; maxDailyLoss is only when it sets it (a combine replay):
  // otherwise the user's value is a broker setting of the run, so a change makes it another run.
  const setsLimit = run.propDailyLoss !== null && run.propDailyLoss !== undefined;
  const own = new Set(Object.entries(run.brokerEnv).filter(([k]) => k !== 'maxDailyLoss' || setsLimit).map(([, v]) => v).concat(b.journalEnv, run.limits && b.limits ? Object.values(b.limits) : []));
  // Its settings (a credential never: a run's identity isn't its keys), the fingerprint allowlist among them (R35:
  // every allowlisted name is one of `env`).
  const names = [...new Set(b.env || [])].filter(k => !own.has(k) && !CREDENTIAL.test(k));
  const brokerSettings = Object.fromEntries(names.sort().map(k => [k, env[k] ?? null]));
  // The node binary that starts an entry is no part of the run (a Node upgrade isn't a new run). The entry's `limits`
  // mapping stays in it: an edit of the variables the account's limits go into is another run.
  const brokerEntry = { ...b, journalPath: undefined, fingerprintEnv: undefined, command: (b.command || []).map(a => (a === process.execPath ? 'node' : a)) };
  return { gate, brokerEntry, brokerSettings };
}

function configHash(run, base = process.env) {
  const { gate, brokerEntry, brokerSettings } = runSettings(run, base);
  const body = {
    cfg: run.cfg, broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), everyNth: run.everyNth,
    premarket: run.premarket, endOfDay: run.endOfDay, prop: run.prop || null, command: harnessCommand(run, base), gate,
    // Named only when charged, so a run with a pinned clock keeps the hash it had before the setting existed.
    ...(run.latency ? { latency: true } : {}),
    // The training stage, named only when set, so a run without one keeps the hash it had.
    ...(run.stage ? { stage: run.stage } : {}),
    // The node binary that starts an entry is no part of the run (a Node upgrade isn't a new run).
    // Its allowlist is in brokerSettings, by value (so a run's hash is the one it had before the list existed).
    brokerEntry, brokerSettings,
    harness: run.root ? treeDigest(run.root, HARNESS_DIRS) : null,
    // The curated list a run replays (its decision times are the list's): named only when there is one.
    ...(run.curated ? { curated: { fingerprint: run.curated.fingerprint, list: run.curated.list } } : {}),
    // The stepped windows (its decision times are the windows'): named only when there are some.
    ...stepPart(run),
    // The account states its days start from (the draw and its assignment): named only when there are some.
    ...statesPart(run),
    ...combinePart(run),
    ...dayPart(run),
    ...adapterPart(run),
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** A run's stepped windows in its hashes: their kind and hash (named only when set, so every other run keeps its hash). */
const stepPart = run => (run.stepWindows ? { stepWindows: { kind: run.stepWindows.kind, hash: run.stepWindows.hash } } : {});
/** A run's account states in its hashes: the document's hash (seed, weights, buckets, draws) and the days' assignment. */
const statesPart = run => (run.accountStates ? { accountStates: { hash: run.accountStates.hash, assignment: run.accountStates.assignment.hash } } : {});
/** A run's continuous combine in its hashes: its account, attempt length and attempts' starts (named only when set). */
const combinePart = run => (run.combine ? { combine: { account: run.combine.account, maxSessions: run.combine.maxSessions, attempts: run.combine.attempts.map(a => a.start) } } : {});
/** A run's day attempts in its hashes: their account (named only when set, so every other run keeps its hash). */
const dayPart = run => (run.dayAttempts ? { dayAttempts: { account: run.dayAttempts.account } } : {});
/**
 * The fine-tuning adapter the runner config declares (learning/adapter.js adapterTag: its manifest's digest), named only
 * when one is, so a base run keeps its hash: a retrained adapter at the same path is another run and another setup.
 */
const adapterPart = run => { const tag = adapterTag(run.cfg); return tag ? { adapter: tag } : {}; };

/** The harness command a cycle runs (the prompt elided), as the runner builds it in the run's environment. */
/**
 * A run's setup, from its config alone (no environment, nothing seeded): the runner config, broker, window, the
 * decision times' settings, the harness's documents and code, its history library and whether the model is shown it.
 * Not its runId, learning flag or experience index: the arms of one evaluation (learning/looks.js) share it and differ
 * in their index only (a library-display pair shares setupBase instead).
 */
function setupHash(run, { code = true } = {}) {
  const body = {
    // The runner config without the run's own folders (its runId is in their paths).
    cfg: { ...run.cfg, dataDir: null, workdir: null }, broker: run.broker, start: run.start.toISOString(), end: run.end.toISOString(), everyNth: run.everyNth,
    premarket: run.premarket, endOfDay: run.endOfDay, prop: run.prop || null,
    // The arms of one evaluation charge the latency alike (named only when charged, as configHash).
    ...(run.latency ? { latency: true } : {}),
    ...(run.stage ? { stage: run.stage } : {}),
    harness: run.root ? treeDigest(run.root, HARNESS_DIRS) : null, code: run.root && code ? treeDigest(run.root, CODE_DIRS) : null,
    // The history library the run pins (learning/setup-library.js), by its own hash: the arms of one evaluation share
    // it, so they differ in their experience index only. Named only when there is one, so a setup without a library keeps
    // the hash it had (its looks in the ledger stay its own).
    ...(run.setupLibrary ? { library: require('../learning/setup-library').readLibrary(run.setupLibrary).hash } : {}),
    // Whether the model is shown it: named only when on, so a run without the display keeps the hash it had.
    ...(run.setupLibrary && run.libraryDisplay === true ? { libraryDisplay: true } : {}),
    // The risk record shown to the model, by its hash (named only when shown, so every other setup keeps its hash).
    ...(run.riskRecord && run.riskRecordDisplay === true ? { riskRecordDisplay: require('../learning/risk-record-index').readRiskIndex(run.riskRecord).hash } : {}),
    // The curated list the run replays, by its fingerprint (named only when there is one, as the library).
    ...(run.curated ? { curated: { fingerprint: run.curated.fingerprint, list: run.curated.list } } : {}),
    ...stepPart(run),
    // The account states its days start from: named only when there are some.
    ...statesPart(run),
    ...combinePart(run),
    ...dayPart(run),
    ...adapterPart(run),
  };
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** The setup without its code (setupHash's code digest): what a resumed look keeps (learning/looks.js), a code fix aside. */
const setupFixed = run => setupHash(run, { code: false });

/** The setup without the library display: the two arms of a library-display pair (learning/looks.js) share it. */
const setupBase = run => setupHash({ ...run, libraryDisplay: false, riskRecordDisplay: false });

/** The arm a run's look names: its experience index's (experience-index.js armOf), `+library:<hash>` when it shows the library, then `+risk:<hash>` when it shows the risk record. */
function lookArm(run) {
  let arm = require('../learning/experience-index').armOf(run.experienceIndex);
  if (run.setupLibrary && run.libraryDisplay === true) arm += `+library:${require('../learning/setup-library').readLibrary(run.setupLibrary).hash.slice(0, 16)}`;
  if (run.riskRecord && run.riskRecordDisplay === true) arm += `+risk:${require('../learning/risk-record-index').readRiskIndex(run.riskRecord).hash.slice(0, 16)}`;
  return arm;
}

function harnessCommand(run, base = process.env) {
  return buildCommand(run.cfg, '<prompt>', run.root || '', replayEnv(base, run, { at: run.start }));
}

module.exports = { resolveReplay, policyAccount, isolationErrors, replayEnv, limitsEnv, serverEnv, brokerErrors, configHash, runSettings, setupHash, setupFixed, setupBase, lookArm, harnessCommand, liveBrokerVars, DISABLED, BROKER_ENV, STRIPPED, GATE_ENV, PINNED };
