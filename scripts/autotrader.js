#!/usr/bin/env node
/**
 * Autonomous runner: premarket and end of day on the clock, and a trade cycle
 * after every closed bar of the configured timeframe (1, 3, 5... minutes).
 * Bar closes are detected by polling get_bars (through the broker adapter) right after each
 * scheduled close; the closed bars are written to dataDir so the agents start
 * from fresh data. Each cycle is one headless harness invocation (Claude Code,
 * Codex, Qwen Code, or a custom CLI agent) covering every symbol whose bar
 * closed. One run at a time; a bar that closes while a cycle is still running
 * is skipped, never queued. The loop itself is scripts/lib/runner.js.
 *
 *   node scripts/autotrader.js --config autotrader.json            run the schedule
 *   node scripts/autotrader.js --config autotrader.json --once trade [--symbol MNQ]
 *   node scripts/autotrader.js --config autotrader.json --dry-run  print the next action
 *   node scripts/autotrader.js --status [--stale-minutes 10]        watchdog: exit 1 if the runner is silent or stopped
 *
 * With a replay broker's clock (FTH_REPLAY_NOW, trading/harness-now.js), --once
 * runs one pass of the live loop at the replayed time instead of a manual run
 * (scripts/replay.js drives it, one process per decision time).
 *
 * Alerts: every runner error, and the kill switch tripping, goes to
 * <FTH_HOME>/logs/alerts-<day>.jsonl and, when configured, to alertWebhook /
 * alertCommand (scripts/lib/alerts.js).
 *
 * Reads contracts, bars, positions, working orders, and the balance, and does
 * its housekeeping, through the broker adapter (scripts/lib/broker/adapter.js):
 * the broker MCP server named in the broker config, with that server's
 * settings in the environment. A live run refuses to start when the server
 * lacks an interface tool, has trading disabled, or doesn't allow the account.
 *
 * Safety: the kill switch file (<FTH_HOME>/STOP, default
 * ~/.futures-trading-harness/STOP) stops new
 * cycles (end of day still runs); after maxConsecutiveErrors failed runs the
 * runner creates the kill switch itself. Orders always pass the order gate and
 * the broker MCP server's guardrails.
 */

'use strict';

// Credentials and settings from a .env file (<FTH_HOME>/.env, or the repo's
// git-ignored .env); a variable already set in the environment wins. Logs key
// names only, to stderr.
require('./lib/env-file').loadEnvForCli('autotrader');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateConfig, prompts, buildCommand, childEnv, decide, runResult, dayKey, claudeOrderToolConflicts, resolveDataDir: dataDirFor, runnerArgv } = require('./lib/autotrader');
const { startPreflight } = require('./lib/harness-tools/preflight');
const { openRunnerBroker, wireRunner, replayUnattested, closedBarsOnly } = require('./lib/runner-wiring');
const { createPropHooks } = require('./lib/rl/live-runner');
const { loadStrategies } = require('./lib/trading/strategies');
const { appendJsonl } = require('./lib/trading/scan-log');
const { loadConfig } = require('./lib/trading/config');
const { harnessNow, resolveClock } = require('./lib/trading/harness-now');
const runnerNow = () => harnessNow(process.env, { testClock: false }); // never FTH_TEST_NOW: the runner trades live
const { readJson, writeJsonAtomic, runHarness, workspaceFingerprint, changedFiles, fileDigest } = require('./lib/harness-run');
const { qwenWorkspaceSettings } = require('./lib/install');
const { harnessHome } = require('./lib/paths');
const { createAlerter, writeHeartbeat, watchdogStatus } = require('./lib/alerts');
const { writeCycleLog } = require('./lib/cycle-log');
const { lockHolderAlive } = require('./lib/runner-lock');

const ROOT = path.resolve(__dirname, '..');
const HOME_DIR = harnessHome();
const STATE_FILE = path.join(HOME_DIR, 'autotrader-state.json');
const LOCK_FILE = path.join(HOME_DIR, 'autotrader.lock');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** One runner per machine: an exclusive lock file holding our pid and start time. */
function acquireLock() {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, mine, { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const raw = fs.readFileSync(LOCK_FILE, 'utf8');
      const lock = readJson(LOCK_FILE, { pid: Number(raw) });
      if (lockHolderAlive(lock)) throw new Error(`another autotrader is running (pid ${lock.pid}, ${LOCK_FILE})`, { cause: err });
      fs.unlinkSync(LOCK_FILE); // stale lock from a dead runner
    }
  }
  throw new Error(`could not acquire ${LOCK_FILE}`);
}

function releaseLock() {
  try {
    if (readJson(LOCK_FILE, {}).pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_err) {
    // already gone
  }
}

let activeChild = null;

function appendLog(now, text) {
  const dir = path.join(HOME_DIR, 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `autotrader-${dayKey(now)}.log`), text);
  } catch (err) {
    process.stderr.write(`[autotrader] could not write the log: ${err.message}\n`); // best effort: never stop the loop
  }
}

function runOnce(cfg, argv, timeoutMs) {
  const env = childEnv(cfg, ROOT);
  return runHarness(argv, { cwd: path.resolve(ROOT, cfg.workdir), env, timeoutMs, liveFile: env.FTH_CYCLE_TRANSCRIPT, onChild: c => { activeChild = c; } });
}

let workspaceBaseline = null;
// The files as they were when the guard last tripped: already reported, so
// they don't trip it again once the operator has looked and cleared the kill switch.
let workspaceAcknowledged = null;

/** Refuse to run (and switch trading off) if a run changed the workspace's instructions or settings. */
function guardWorkspace(cfg, killSwitchFile, when) {
  if (!workspaceBaseline) return true;
  const current = workspaceFingerprint(path.resolve(ROOT, cfg.workdir));
  const changed = changedFiles(workspaceBaseline, current);
  if (!changed.length) {
    // Back to the baseline: an acknowledgement covers only the change it was for.
    workspaceAcknowledged = null;
    return true;
  }
  if (workspaceAcknowledged && !changedFiles(workspaceAcknowledged, current).length) return true; // already reported
  const reason = `workspace files changed ${when}: ${changed.join(', ')}. Review the change (git diff workspace/; node scripts/sync-harness.js restores generated files), then remove this file to resume.`;
  process.stderr.write(`[autotrader] ${reason}\n`);
  try {
    // Appended, so a kill switch already on for another reason carries this
    // alarm too: clearing that reason must not resume on changed files.
    fs.appendFileSync(killSwitchFile, `${reason}\n`);
  } catch (_err) {
    return false; // not recorded anywhere the operator must clear: trip again next time
  }
  // The kill switch now carries the alarm. Restoring the files, or removing
  // the kill switch after looking at them, resumes trading; any further
  // change trips the guard again.
  workspaceAcknowledged = current;
  return false;
}

async function runCycle(cfg, action, prompt, opts, { timeoutMs = cfg.cycleTimeoutMinutes * 60000, context = null } = {}) {
  const now = new Date();
  const argv = buildCommand(cfg, prompt, ROOT);
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify(argv)}\n`);
    return { ok: true, timedOut: false };
  }
  const killSwitchFile = loadConfig(process.env).killSwitchFile;
  if (!guardWorkspace(cfg, killSwitchFile, 'between runs') && action !== 'eod') return { ok: false, timedOut: false };
  process.stdout.write(`[autotrader] ${now.toISOString()} ${action}: ${argv[0]} ...\n`);
  const res = await runOnce(cfg, argv, timeoutMs);
  const result = runResult(res);
  // What the model saw and did: the prompt, every tool call, skills loaded, orders sent (logs/cycles/).
  const { summary, file: cycleFile } = writeCycleLog(HOME_DIR, { at: now, action, harness: cfg.harness, prompt, context, argv, output: res.output, result, ok: res.ok, timedOut: res.timedOut, durationMs: Date.now() - now.getTime() });
  process.stdout.write(`[autotrader] cycle log ${cycleFile}: skills ${summary.skills.join(', ') || 'none seen'}; ${Object.entries(summary.tools).map(([k, n]) => `${k} x${n}`).join(', ') || 'no tool calls seen'}\n`);
  if (summary.missingSkills.length) process.stderr.write(`[autotrader] an entry was sent without loading ${summary.missingSkills.join(', ')}\n`);
  appendLog(now, `\n===== ${now.toISOString()} ${action} ${cfg.harness}\n$ ${argv.map(a => JSON.stringify(a)).join(' ')}\n${res.output}\n`);
  process.stdout.write(`[autotrader] ${result}\n`);
  const intact = guardWorkspace(cfg, killSwitchFile, `during a ${action} run`);
  // End of day did its job if the run succeeded; the guard's verdict is in the kill switch.
  return { ok: res.ok && (intact || action === 'eod'), timedOut: res.timedOut, result, code: res.code ?? null };
}

function loadState(cfg) {
  const state = readJson(STATE_FILE, null);
  if (state === null && fs.existsSync(STATE_FILE)) {
    // Unreadable state: don't guess. Manage-only cycles today; end of day still runs.
    process.stderr.write(`[autotrader] ${STATE_FILE} is unreadable; only manage-only cycles until tomorrow\n`);
    return { day: dayKey(runnerNow()), premarketDone: true, eodDone: false, cycles: cfg.maxCyclesPerDay, lastCycleAt: null };
  }
  return state;
}

function checkStrategies(cfg) {
  if (cfg.trigger !== 'signal') return;
  const { strategies } = loadStrategies(ROOT, process.env);
  const tf = `${cfg.timeframe}m`;
  const usable = strategies.filter(s => s.valid && s.status !== 'disabled' && s.timeframe === tf && s.signal !== 'manual');
  if (usable.length === 0) {
    throw new Error(`trigger "signal" with timeframe ${cfg.timeframe}: no active mechanical strategy uses ${tf}, so only open positions would ever start a cycle. Use trigger "bar" or a matching timeframe.`);
  }
}

/** Claude settings that would silently refuse order tools in an unattended run. */
function checkClaudeSettings(cfg) {
  if (cfg.harness !== 'claude') return;
  const files = [path.join(os.homedir(), '.claude', 'settings.json'), path.resolve(ROOT, cfg.workdir, '.claude', 'settings.json'), path.resolve(ROOT, cfg.workdir, '.claude', 'settings.local.json')];
  const hits = claudeOrderToolConflicts(files.map(f => readJson(f, null)).filter(Boolean));
  if (hits.length) {
    throw new Error(`Claude settings would block order tools in unattended runs (${hits.join('; ')}). Remove these ask/deny rules for autonomous use; the order gate and the runner's allowlist still apply.`);
  }
}

/**
 * Qwen runs headless in default approval mode, so its allowlist in
 * workspace/.qwen/settings.json must match this config (bar directory, state
 * directory). The runner writes it at start rather than trusting a stale copy.
 */
function writeQwenSettings(cfg, dataDir, opts) {
  if (cfg.harness !== 'qwen' || opts.dryRun) return;
  const file = path.resolve(ROOT, cfg.workdir, '.qwen', 'settings.json');
  const content = `${JSON.stringify(qwenWorkspaceSettings(ROOT, os.homedir(), { dataDir, stateDir: harnessHome() }), null, 2)}\n`;
  // The same allowlist but for the $version stamp Qwen Code writes on start (fileDigest): left as it is.
  if (readJson(file, null) !== null && fileDigest('.qwen/settings.json', fs.readFileSync(file)) === fileDigest('.qwen/settings.json', content)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  process.stdout.write(`[autotrader] wrote the Qwen autonomous allowlist to ${file}\n`);
}

/** The runner's lock, released on exit; a signal also stops the running harness. */
function holdLock() {
  acquireLock();
  const stop = sig => {
    if (activeChild) {
      try {
        process.kill(-activeChild.pid, sig);
      } catch (_err) {
        // already exited
      }
    }
    releaseLock();
    process.exit(130);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('exit', releaseLock);
}

// Every runner line goes to the terminal and to the day's log file (with its level), so a session can be traced afterwards.
const runnerLog = alert => (msg, level) => {
  const now = new Date();
  const line = `[autotrader] ${now.toISOString()} ${level === 'error' ? 'ERROR' : 'INFO'} ${msg}\n`;
  (level === 'error' ? process.stderr : process.stdout).write(line);
  appendLog(now, line);
  // Every error is an alert (throttled); a human hears about trouble while it matters.
  if (level === 'error') alert(msg);
};
const writeEvent = ev => appendJsonl(path.join(HOME_DIR, 'logs', `events-${dayKey(new Date(ev.at))}.jsonl`), ev);

function buildRunner(cfg, dataDir, opts, client, log, event) {
  const prop = createPropHooks({ root: ROOT, env: process.env, home: HOME_DIR, client, accountId: cfg.account, strategies: () => loadStrategies(ROOT, process.env).strategies, paper: cfg.paper, log });
  if (prop.accounts().length) log(`prop challenge: ${prop.accounts().map(a => a.name).join(', ')} (balance snapshot each bar; policies screen setups)`);
  return wireRunner({
    cfg, root: ROOT, home: HOME_DIR, env: process.env, client, prop: prop.accounts().length ? prop : null, dataDir, now: runnerNow, log, event,
    runCycle: (action, prompt, limits) => runCycle(cfg, action, prompt, opts, limits),
    loadState: () => loadState(cfg), saveState: s => writeJsonAtomic(STATE_FILE, s), killSwitchFile: loadConfig(process.env).killSwitchFile,
  });
}

/**
 * Replay (a replay broker's clock): one pass of the live loop at the replayed
 * time, with this home's runner state, so the cycle is built as a live one
 * (bars, records, scan, verdicts, account, prompt). What ran goes to stdout as
 * one "REPLAY STEP {json}" line for the replay driver.
 */
async function replayStep(cfg, dataDir, opts, asked) {
  holdLock();
  const errors = [];
  const log = runnerLog(msg => errors.push(String(msg).slice(0, 300)));
  let client;
  try {
    client = await openRunnerBroker({ cfg, root: ROOT, env: process.env });
    const why = replayUnattested(await client.serverConfig(), runnerNow());
    if (why) throw new Error(why);
  } catch (err) {
    if (client) client.close();
    log(`broker: can't start (${err.message})`, 'error');
    return 1;
  }
  const events = [];
  try {
    const runner = buildRunner(cfg, dataDir, opts, closedBarsOnly(client, runnerNow), log, ev => { events.push(ev); writeEvent(ev); });
    await runner.step();
    const ran = events.filter(e => e.kind === 'cycle_end').map(e => ({ action: e.action, ok: e.ok, timedOut: e.timedOut, result: e.result, symbols: e.symbols || null }));
    const kinds = [...new Set(events.map(e => e.kind))];
    const bars = runner.symbols.map(s => ({ symbol: s.symbol, lastBarT: (s.clock && s.clock.lastBarT) || null }));
    process.stdout.write(`REPLAY STEP ${JSON.stringify({ asked, at: runnerNow().toISOString(), ran, events: kinds, errors, bars, state: runner.state })}\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function main(rawArgv) {
  const argv = runnerArgv(rawArgv); // only the runner's own flags: a typo never starts the live loop
  if (argv.includes('--status')) {
    // The watchdog: for cron / launchd / a monitor. Exit 1 pages someone.
    const stale = arg(argv, '--stale-minutes') !== undefined ? Number(arg(argv, '--stale-minutes')) : 10;
    const st = watchdogStatus(HOME_DIR, { staleMinutes: stale, killSwitchFile: loadConfig(process.env).killSwitchFile });
    process.stdout.write(st.ok
      ? `runner ok: last pass ${st.ageMinutes} min ago (pid ${st.heartbeat.pid})\n`
      : `runner NOT ok:\n${st.problems.map(p => `- ${p}`).join('\n')}\n`);
    return st.ok ? 0 : 1;
  }
  const configPath = arg(argv, '--config');
  if (!configPath) throw new Error('usage: autotrader.js --config <file.json> [--once premarket|trade|eod] [--symbol X] [--dry-run]');
  const cfg = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const dataDir = dataDirFor(cfg);
  // The harness clock (trading/harness-now.js): FTH_REPLAY_NOW without a replay broker, or unparseable, stops the run here.
  if (arg(argv, '--once') !== 'eod') runnerNow(); // a refused replay clock stops all but end of day (run at the wall clock)
  const opts = { dryRun: argv.includes('--dry-run') };
  const killSwitchFile = loadConfig(process.env).killSwitchFile;
  checkStrategies(cfg);
  checkClaudeSettings(cfg);
  writeQwenSettings(cfg, dataDir, opts);
  // The harness tools server the cycles use answers with the registry's tools; else no trading (harness-tools/preflight.js).
  const preflight = once => startPreflight({ root: ROOT, env: childEnv(cfg, ROOT), once, killSwitchFile });
  // A replay step is a pass of the live loop: like it, a failure turns trading off and end of day still runs.
  if (!opts.dryRun && arg(argv, '--once')) await preflight(resolveClock(process.env, { testClock: false }).replay ? null : arg(argv, '--once'));
  // Codex may write the blackouts directory from its sandbox, but can't create it.
  fs.mkdirSync(path.dirname(loadConfig(process.env).blackoutsFile), { recursive: true });
  workspaceBaseline = workspaceFingerprint(path.resolve(ROOT, cfg.workdir));

  const once = arg(argv, '--once');
  if (once) {
    // A replay broker's clock: the live loop's pass at that time (its schedule decides what runs), not a manual run.
    if (!opts.dryRun && resolveClock(process.env, { testClock: false }).replay) return replayStep(cfg, dataDir, opts, once);
    const symbols = arg(argv, '--symbol') ? [arg(argv, '--symbol')] : cfg.symbols;
    if (once !== 'eod' && fs.existsSync(killSwitchFile)) throw new Error(`kill switch is on (${killSwitchFile})`);
    const p = prompts(cfg, once === 'eod' ? require('./lib/trading/harness-now').recordNow(process.env, { testClock: false }) : runnerNow(), ROOT);
    // A manual trade run reads nothing for the prompt: it says so instead of claiming an empty journal.
    const manual = { journalRead: false, unavailable: ['a manual run (--once): no bars, account, journal, news, premarket plan, or strategy scan were read; read them yourself'] };
    const jobs = once === 'eod' ? [p.eod()] : once === 'trade' ? [p.trade(symbols.map(symbol => ({ symbol })), manual)] : symbols.map(s => p.premarket(s));
    let ok = true;
    // A manual run has no bars or account read: its cycle log says so.
    for (const prompt of jobs) ok = (await runCycle(cfg, once, prompt, opts, { context: { action: once, manual: true, symbols } })).ok && ok;
    return ok ? 0 : 1;
  }

  if (opts.dryRun) {
    const { action } = decide(cfg, loadState(cfg), runnerNow(), { killSwitch: fs.existsSync(killSwitchFile) });
    process.stdout.write(`next action now: ${action || 'none'}${action === 'trade' || action === 'manage' ? ' (on the next closed bar)' : ''}\n`);
    return 0;
  }

  if (process.env.FTH_REPLAY_NOW) throw new Error('FTH_REPLAY_NOW is set: the runner loop never runs on a replayed clock. Replay drives one cycle per process (--once or --dry-run, a fresh run per cycle with the time set by the replay driver).');
  holdLock();
  await preflight(null); // the live loop: only once it holds the lock (a second start must not switch off the first)
  const log = runnerLog(createAlerter({ home: HOME_DIR, webhook: cfg.alertWebhook, command: cfg.alertCommand, label: `autotrader ${cfg.symbols.join(',')}` }));
  // Bars, positions, orders, balance, and housekeeping through the broker adapter (the configured broker MCP server).
  let client;
  try {
    client = await openRunnerBroker({ cfg, root: ROOT, env: process.env });
  } catch (err) {
    log(`broker: can't start (${err.message})`, 'error');
    return 1;
  }
  process.on('exit', () => client.close());
  const runner = buildRunner(cfg, dataDir, opts, client, log, writeEvent);
  writeEvent({ at: new Date().toISOString(), kind: 'start', pid: process.pid, dryRun: Boolean(opts.dryRun), config: cfg, dataDir, killSwitchFile });
  process.on('exit', code => writeEvent({ at: new Date().toISOString(), kind: 'stop', pid: process.pid, code }));
  log(`${cfg.harness} on ${cfg.symbols.join(',')} every closed ${cfg.timeframe}m bar (trigger ${cfg.trigger}, cycle ${cfg.cycle}, timeout ${cfg.cycleTimeoutMinutes} min); bars in ${dataDir}; kill switch ${killSwitchFile}`);
  const beat = () => writeHeartbeat(HOME_DIR, { symbols: cfg.symbols, timeframe: cfg.timeframe, killSwitch: fs.existsSync(killSwitchFile) });
  for (;;) {
    const ms = await runner.step();
    beat();
    // Long waits (the daily break, the weekend) in one-minute pieces, so the heartbeat stays fresh.
    for (let left = ms; left > 0; left -= 60000) {
      await new Promise(r => setTimeout(r, Math.min(left, 60000)));
      beat();
    }
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[autotrader] ${err.message}\n`);
  process.exitCode = 1;
});
