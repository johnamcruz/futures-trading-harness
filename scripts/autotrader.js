#!/usr/bin/env node
/**
 * Autonomous runner: premarket and end of day on the clock, and a trade cycle
 * after every closed bar of the configured timeframe (1, 3, 5... minutes).
 * Bar closes are detected by polling ProjectX retrieveBars right after each
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
 * Alerts: every runner error, and the kill switch tripping, goes to
 * <FTH_HOME>/logs/alerts-<day>.jsonl and, when configured, to alertWebhook /
 * alertCommand (scripts/lib/alerts.js).
 *
 * Needs PROJECTX_USERNAME and PROJECTX_API_KEY (read-only use: contracts, bars,
 * positions, working orders) in its environment, like projectx-mcp.
 *
 * Safety: the kill switch file (<FTH_HOME>/STOP, default
 * ~/.futures-trading-harness/STOP) stops new
 * cycles (end of day still runs); after maxConsecutiveErrors failed runs the
 * runner creates the kill switch itself. Orders always pass the order gate and
 * the projectx-mcp guardrails.
 */

'use strict';

// Credentials and settings from a .env file (<FTH_HOME>/.env, or the repo's
// git-ignored .env); a variable already set in the environment wins. Logs key
// names only, to stderr.
require('./lib/env-file').loadEnvForCli('autotrader');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { dayContextSeries, describeDay } = require('./lib/trading/day-context');
const { readRecord, liveRecord, describeRecord, excursionNote } = require('./lib/trading/track-record');
const { validateConfig, prompts, buildCommand, childEnv, decide, cycleResult, dayKey, claudeOrderToolConflicts, resolveDataDir: dataDirFor, usesOrderFlow } = require('./lib/autotrader');
const { createRunner } = require('./lib/runner');
const { createClient } = require('./lib/projectx-rest');
const { createPropHooks } = require('./lib/rl/live-runner');
const { createRecorder } = require('./lib/orderflow-recorder');
const { loadStrategies, scan } = require('./lib/trading/strategies');
const { scanRecord, appendJsonl } = require('./lib/trading/scan-log');
const { loadConfig } = require('./lib/trading/config');
const { readJson, writeJsonAtomic, runHarness, entryOrders, workspaceFingerprint, changedFiles } = require('./lib/harness-run');
const { qwenWorkspaceSettings } = require('./lib/install');
const { harnessHome } = require('./lib/paths');
const { writeMtfRecord } = require('./lib/trading/mtf-state');
const { buildSignals, writeSignals } = require('./lib/trading/signal-state');
const { createAlerter, writeHeartbeat, watchdogStatus } = require('./lib/alerts');
const { writeCycleLog } = require('./lib/cycle-log');
const { digest, recentTrades } = require('./lib/trading/instincts');
const { resolveJournalPath, readJournal } = require('./lib/trading/journal');

const ROOT = path.resolve(__dirname, '..');
const HOME_DIR = harnessHome();
const STATE_FILE = path.join(HOME_DIR, 'autotrader-state.json');
const LOCK_FILE = path.join(HOME_DIR, 'autotrader.lock');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function processCommand(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch (_err) {
    return null; // no /proc (macOS) or no such process
  }
}

/** A lock holder is live only if the pid exists and (where /proc exists) is an autotrader. */
function lockHolderAlive(lock) {
  if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === process.pid) return false;
  try {
    process.kill(lock.pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  const cmd = processCommand(lock.pid);
  return cmd === null || cmd.includes('autotrader');
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
  return runHarness(argv, { cwd: path.resolve(ROOT, cfg.workdir), env: childEnv(cfg, ROOT), timeoutMs, onChild: c => { activeChild = c; } });
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

async function runCycle(cfg, action, prompt, opts, { timeoutMs = cfg.cycleTimeoutMinutes * 60000 } = {}) {
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
  const result = cycleResult(res.output) || (res.ok ? 'CYCLE RESULT: (none reported)' : `CYCLE RESULT: error - ${res.timedOut ? 'timed out' : `exit ${res.code}`}`);
  // What the model saw and did: the prompt, every tool call, skills loaded, orders sent (logs/cycles/).
  const { summary, file: cycleFile } = writeCycleLog(HOME_DIR, { at: now, action, harness: cfg.harness, prompt, argv, output: res.output, result, ok: res.ok, timedOut: res.timedOut, durationMs: Date.now() - now.getTime() });
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
    return { day: dayKey(new Date()), premarketDone: true, eodDone: false, cycles: cfg.maxCyclesPerDay, lastCycleAt: null };
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

function resolveDataDir(cfg) {
  return dataDirFor(cfg);
}

/** Claude settings that would silently refuse order tools in an unattended run. */
function checkClaudeSettings(cfg) {
  if (cfg.harness !== 'claude') return;
  const files = [path.join(os.homedir(), '.claude', 'settings.json'), path.join(ROOT, cfg.workdir, '.claude', 'settings.json'), path.join(ROOT, cfg.workdir, '.claude', 'settings.local.json')];
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
  const file = path.join(ROOT, cfg.workdir, '.qwen', 'settings.json');
  const content = `${JSON.stringify(qwenWorkspaceSettings(ROOT, os.homedir(), { dataDir, stateDir: harnessHome() }), null, 2)}\n`;
  if (readJson(file, null) !== null && fs.readFileSync(file, 'utf8') === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  process.stdout.write(`[autotrader] wrote the Qwen autonomous allowlist to ${file}\n`);
}

async function main(argv) {
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
  const dataDir = resolveDataDir(cfg);
  const opts = { dryRun: argv.includes('--dry-run') };
  const killSwitchFile = loadConfig(process.env).killSwitchFile;
  checkStrategies(cfg);
  checkClaudeSettings(cfg);
  writeQwenSettings(cfg, dataDir, opts);
  // Codex may write the blackouts directory from its sandbox, but can't create it.
  fs.mkdirSync(path.dirname(loadConfig(process.env).blackoutsFile), { recursive: true });
  workspaceBaseline = workspaceFingerprint(path.resolve(ROOT, cfg.workdir));

  const once = arg(argv, '--once');
  if (once) {
    if (!['premarket', 'trade', 'eod'].includes(once)) throw new Error('--once must be premarket, trade, or eod');
    const symbols = arg(argv, '--symbol') ? [arg(argv, '--symbol')] : cfg.symbols;
    if (once !== 'eod' && fs.existsSync(killSwitchFile)) throw new Error(`kill switch is on (${killSwitchFile})`);
    const p = prompts(cfg, new Date(), ROOT);
    const jobs = once === 'eod' ? [p.eod()] : once === 'trade' ? [p.trade(symbols.map(symbol => ({ symbol })))] : symbols.map(s => p.premarket(s));
    let ok = true;
    for (const prompt of jobs) ok = (await runCycle(cfg, once, prompt, opts)).ok && ok;
    return ok ? 0 : 1;
  }

  if (opts.dryRun) {
    const { action } = decide(cfg, loadState(cfg), new Date(), { killSwitch: fs.existsSync(killSwitchFile) });
    process.stdout.write(`next action now: ${action || 'none'}${action === 'trade' || action === 'manage' ? ' (on the next closed bar)' : ''}\n`);
    return 0;
  }

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

  // Every runner line goes to the terminal and to the day's log file (with its level), so a session can be traced afterwards.
  const alert = createAlerter({ home: HOME_DIR, webhook: cfg.alertWebhook, command: cfg.alertCommand, label: `autotrader ${cfg.symbols.join(',')}` });
  const log = (msg, level) => {
    const now = new Date();
    const line = `[autotrader] ${now.toISOString()} ${level === 'error' ? 'ERROR' : 'INFO'} ${msg}\n`;
    (level === 'error' ? process.stderr : process.stdout).write(line);
    appendLog(now, line);
    // Every error is an alert (throttled); a human hears about trouble while it matters.
    if (level === 'error') alert(msg);
  };
  const client = createClient();
  const wantFlow = cfg.orderFlow === true || (cfg.orderFlow === 'auto' && usesOrderFlow(loadStrategies(ROOT, process.env).strategies, cfg.timeframe));
  const flow = wantFlow && !opts.dryRun ? createRecorder({ home: HOME_DIR, getToken: client.getToken, log }) : null;
  if (wantFlow && !flow) log('order flow: off in a dry run');
  const strategiesNow = () => loadStrategies(ROOT, process.env).strategies;
  const prop = createPropHooks({ root: ROOT, env: process.env, home: HOME_DIR, client, accountId: cfg.account, strategies: strategiesNow, paper: cfg.paper, log });
  if (prop.accounts().length) log(`prop challenge: ${prop.accounts().map(a => a.name).join(', ')} (balance snapshot each bar; policies screen setups)`);
  const runner = createRunner({
    cfg,
    prop: prop.accounts().length ? prop : null,
    root: ROOT,
    client,
    flow,
    clock: { now: () => new Date() },
    runCycle: (action, prompt, limits) => runCycle(cfg, action, prompt, opts, limits),
    isKillSwitchOn: () => fs.existsSync(killSwitchFile),
    createKillSwitch: reason => fs.writeFileSync(killSwitchFile, `${reason}\n`),
    loadState: () => loadState(cfg),
    saveState: s => writeJsonAtomic(STATE_FILE, s),
    writeBars: (sym, bars) => {
      const file = path.join(dataDir, `${sym.symbol}-${cfg.timeframe}m.json`);
      writeJsonAtomic(file, { contractId: sym.contractId, barSize: `${cfg.timeframe} minute`, count: bars.length, bars });
      return file;
    },
    recordMtf: (sym, bars) => writeMtfRecord(HOME_DIR, sym.symbol, bars).line,
    // A strategy's track record (trading/track-record.js): its recorded backtest and the journal's reviews.
    trackRecord: (name, { regime, at, entries }) => describeRecord({
      backtest: readRecord(HOME_DIR, name), live: liveRecord(entries || readJournal(resolveJournalPath(process.env)), name, regime), regime, at,
      file: (loadStrategies(ROOT, process.env).strategies.find(s => s.name === name) || {}).file || null,
    }),
    // The day so far (trading/day-context.js), one line for the prompt; levels on the contract's tick.
    dayContext: (sym, bars) => {
      const tick = sym.tickSize > 0 ? sym.tickSize : 0.25;
      return describeDay(dayContextSeries(bars).day.at(-1), { symbol: sym.symbol, round: x => Number((Math.round(x / tick) * tick).toFixed(6)) });
    },
    lessons: ({ setups } = {}) => digest(readJournal(resolveJournalPath(process.env)), 5, { setups }),
    recentTrades: () => recentTrades(readJournal(resolveJournalPath(process.env)), 10),
    journalEntries: () => readJournal(resolveJournalPath(process.env)),
    tradeHistory: t => excursionNote(readRecord(HOME_DIR, t.setup), t),
    recordSignals: (item, results) => writeSignals(HOME_DIR, buildSignals(results, { symbol: item.symbol, bar: item.bar, stepMs: cfg.timeframe * 60000 })),
    scanFor: (symbol, bars) => {
      // Only strategies that trade this bar's timeframe can be judged from these bars.
      const { strategies } = loadStrategies(ROOT, process.env);
      const sameTf = strategies.filter(s => s.timeframe === `${cfg.timeframe}m`);
      return scan(sameTf, { bars }, { symbol, now: new Date() });
    },
    log,
    // The decision log: every scanned bar, every strategy's verdict and why (logs/scans-<day>.jsonl).
    scanLog: rec => appendJsonl(path.join(HOME_DIR, 'logs', `scans-${dayKey(new Date(rec.at))}.jsonl`), scanRecord(rec)),
    // The event log: cycles, account reads, positions managed, stops moved, closes, flattens, errors (logs/events-<day>.jsonl).
    event: ev => appendJsonl(path.join(HOME_DIR, 'logs', `events-${dayKey(new Date(ev.at))}.jsonl`), ev),
    entryOrders: () => entryOrders(HOME_DIR),
    strategyNamed: name => loadStrategies(ROOT, process.env).strategies.find(s => s.name === name && s.valid) || null,
  });
  const event = ev => appendJsonl(path.join(HOME_DIR, 'logs', `events-${dayKey(new Date(ev.at))}.jsonl`), ev);
  event({ at: new Date().toISOString(), kind: 'start', pid: process.pid, dryRun: Boolean(opts.dryRun), config: cfg, dataDir, killSwitchFile });
  process.on('exit', code => event({ at: new Date().toISOString(), kind: 'stop', pid: process.pid, code }));
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
