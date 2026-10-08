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

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateConfig, prompts, buildCommand, childEnv, decide, cycleResult, dayKey, claudeOrderToolConflicts, resolveDataDir: dataDirFor } = require('./lib/autotrader');
const { createRunner } = require('./lib/runner');
const { createClient } = require('./lib/projectx-rest');
const { loadStrategies, scan } = require('./lib/trading/strategies');
const { loadConfig } = require('./lib/trading/config');
const { readJson, writeJsonAtomic, runHarness } = require('./lib/harness-run');
const { harnessHome } = require('./lib/paths');

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
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `autotrader-${dayKey(now)}.log`), text);
}

function runOnce(cfg, argv, timeoutMs) {
  return runHarness(argv, { cwd: path.resolve(ROOT, cfg.workdir), env: childEnv(cfg, ROOT), timeoutMs, onChild: c => { activeChild = c; } });
}

async function runCycle(cfg, action, prompt, opts) {
  const now = new Date();
  const argv = buildCommand(cfg, prompt, ROOT);
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify(argv)}\n`);
    return { ok: true, timedOut: false };
  }
  process.stdout.write(`[autotrader] ${now.toISOString()} ${action}: ${argv[0]} ...\n`);
  const res = await runOnce(cfg, argv, cfg.cycleTimeoutMinutes * 60000);
  const result = cycleResult(res.output) || (res.ok ? 'CYCLE RESULT: (none reported)' : `CYCLE RESULT: error - ${res.timedOut ? 'timed out' : `exit ${res.code}`}`);
  appendLog(now, `\n===== ${now.toISOString()} ${action} ${cfg.harness}\n$ ${argv.map(a => JSON.stringify(a)).join(' ')}\n${res.output}\n`);
  process.stdout.write(`[autotrader] ${result}\n`);
  return { ok: res.ok, timedOut: res.timedOut };
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

async function main(argv) {
  const configPath = arg(argv, '--config');
  if (!configPath) throw new Error('usage: autotrader.js --config <file.json> [--once premarket|trade|eod] [--symbol X] [--dry-run]');
  const cfg = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const dataDir = resolveDataDir(cfg);
  const opts = { dryRun: argv.includes('--dry-run') };
  const killSwitchFile = loadConfig(process.env).killSwitchFile;
  checkStrategies(cfg);
  checkClaudeSettings(cfg);

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

  const log = (msg, level) => (level === 'error' ? process.stderr : process.stdout).write(`[autotrader] ${new Date().toISOString()} ${msg}\n`);
  const runner = createRunner({
    cfg,
    root: ROOT,
    client: createClient(),
    clock: { now: () => new Date() },
    runCycle: (action, prompt) => runCycle(cfg, action, prompt, opts),
    isKillSwitchOn: () => fs.existsSync(killSwitchFile),
    createKillSwitch: reason => fs.writeFileSync(killSwitchFile, `${reason}\n`),
    loadState: () => loadState(cfg),
    saveState: s => writeJsonAtomic(STATE_FILE, s),
    writeBars: (sym, bars) => {
      const file = path.join(dataDir, `${sym.symbol}-${cfg.timeframe}m.json`);
      writeJsonAtomic(file, { contractId: sym.contractId, barSize: `${cfg.timeframe} minute`, count: bars.length, bars });
      return file;
    },
    scanFor: (symbol, bars) => {
      // Only strategies that trade this bar's timeframe can be judged from these bars.
      const { strategies } = loadStrategies(ROOT, process.env);
      const sameTf = strategies.filter(s => s.timeframe === `${cfg.timeframe}m`);
      return scan(sameTf, { bars }, { symbol, now: new Date() });
    },
    log,
  });
  log(`${cfg.harness} on ${cfg.symbols.join(',')} every closed ${cfg.timeframe}m bar (trigger ${cfg.trigger}, cycle ${cfg.cycle}, timeout ${cfg.cycleTimeoutMinutes} min); bars in ${dataDir}; kill switch ${killSwitchFile}`);
  for (;;) {
    const ms = await runner.step();
    if (ms > 0) await new Promise(r => setTimeout(r, ms));
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[autotrader] ${err.message}\n`);
  process.exitCode = 1;
});
