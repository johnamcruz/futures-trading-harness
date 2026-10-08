#!/usr/bin/env node
/**
 * Autonomous runner: premarket and end of day on the clock, and a trade cycle
 * after every closed bar of the configured timeframe (1, 3, 5... minutes).
 * Bar closes are detected by polling ProjectX retrieveBars right after each
 * scheduled close; the closed bars are written to dataDir so the agents start
 * from fresh data. Each cycle is one headless harness invocation (Claude Code,
 * Codex, Qwen Code, or a custom CLI agent). One run at a time; a bar that
 * closes while a cycle is still running is skipped, never queued.
 *
 *   node scripts/autotrader.js --config autotrader.json            run the schedule
 *   node scripts/autotrader.js --config autotrader.json --once trade [--symbol MNQ]
 *   node scripts/autotrader.js --config autotrader.json --dry-run  print the next command
 *
 * Needs PROJECTX_USERNAME and PROJECTX_API_KEY (read-only use: bars, contracts,
 * positions) in its environment, like projectx-mcp.
 *
 * Safety: the kill switch file (~/.futures-trading-harness/STOP) stops new
 * cycles (end of day still runs); after maxConsecutiveErrors failed runs the
 * runner creates the kill switch itself. Orders always pass the order gate and
 * the projectx-mcp guardrails.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { validateConfig, prompts, buildCommand, childEnv, decide, recordRun, cycleResult, dayKey, signalDecision } = require('./lib/autotrader');
const { barStep, sleepMs } = require('./lib/bar-clock');
const { createClient } = require('./lib/projectx-rest');
const { loadStrategies, scan } = require('./lib/trading/strategies');
const { loadConfig } = require('./lib/trading/config');

const ROOT = path.resolve(__dirname, '..');
const HOME_DIR = path.join(os.homedir(), '.futures-trading-harness');
const STATE_FILE = path.join(HOME_DIR, 'autotrader-state.json');
const LOCK_FILE = path.join(HOME_DIR, 'autotrader.lock');
const IDLE_MS = 5000;

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_err) {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** One runner per machine: an exclusive lock file holding our pid. */
function acquireLock() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) throw new Error(`another autotrader is running (pid ${pid}, ${LOCK_FILE})`, { cause: err });
      fs.unlinkSync(LOCK_FILE); // stale lock from a dead runner
    }
  }
  throw new Error(`could not acquire ${LOCK_FILE}`);
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE);
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
  return new Promise(resolve => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd, args, {
      cwd: path.resolve(ROOT, cfg.workdir),
      env: childEnv(cfg, ROOT),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a timeout kills the harness and everything it started
    });
    activeChild = child;
    const killGroup = sig => {
      try {
        process.kill(-child.pid, sig);
      } catch (_err) {
        child.kill(sig);
      }
    };
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    const timer = setTimeout(() => {
      output += `\n[autotrader] timeout after ${timeoutMs / 60000} min; killing run\n`;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10000).unref();
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      activeChild = null;
      resolve({ ok: false, output: `${output}\n[autotrader] could not start ${cmd}: ${err.message}\n` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      activeChild = null;
      resolve({ ok: code === 0, code, output });
    });
  });
}

async function runJob(cfg, action, prompt, opts) {
  const now = new Date();
  const argv = buildCommand(cfg, prompt, ROOT);
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify(argv)}\n`);
    return true;
  }
  process.stdout.write(`[autotrader] ${now.toISOString()} ${action}: ${argv[0]} ...\n`);
  const res = await runOnce(cfg, argv, cfg.cycleTimeoutMinutes * 60000);
  const result = cycleResult(res.output) || (res.ok ? 'CYCLE RESULT: (none reported)' : `CYCLE RESULT: error - exit ${res.code}`);
  appendLog(now, `\n===== ${now.toISOString()} ${action} ${cfg.harness}\n$ ${argv.map(a => JSON.stringify(a)).join(' ')}\n${res.output}\n`);
  process.stdout.write(`[autotrader] ${result}\n`);
  return res.ok;
}

async function execute(cfg, action, symbols, opts) {
  const p = prompts(cfg, new Date(), ROOT);
  const jobs = action === 'eod' ? [p.eod()] : symbols.map(sym => p[action](sym));
  let ok = true;
  for (const prompt of jobs) ok = (await runJob(cfg, action, prompt, opts)) && ok;
  return ok;
}

function writeBars(cfg, sym, bars) {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const file = path.join(cfg.dataDir, `${sym.symbol}-${cfg.timeframe}m.json`);
  writeJsonAtomic(file, { contractId: sym.contractId, barSize: `${cfg.timeframe} minute`, count: bars.length, bars });
  return file;
}

/** Should this closed bar start a cycle? Always in trigger "bar"; on a signal or open position in "signal". */
async function wantsCycle(cfg, sym, bars, client) {
  if (cfg.trigger === 'bar') return { run: true, reason: 'bar closed' };
  // Only strategies that trade this bar's timeframe can be judged from these bars.
  const { strategies } = loadStrategies(ROOT, process.env);
  const sameTf = strategies.filter(s => s.timeframe === `${cfg.timeframe}m`);
  const results = scan(sameTf, { bars }, { symbol: sym.symbol, now: new Date() });
  const net = await client.netPosition(cfg.account, sym.contractId);
  return signalDecision(results, net);
}

async function main(argv) {
  const configPath = arg(argv, '--config');
  if (!configPath) throw new Error('usage: autotrader.js --config <file.json> [--once premarket|trade|eod] [--symbol X] [--dry-run]');
  const cfg = validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const opts = { dryRun: argv.includes('--dry-run') };
  const killSwitchFile = loadConfig(process.env).killSwitchFile;

  const once = arg(argv, '--once');
  if (once) {
    if (!['premarket', 'trade', 'eod'].includes(once)) throw new Error('--once must be premarket, trade, or eod');
    const symbols = arg(argv, '--symbol') ? [arg(argv, '--symbol')] : cfg.symbols;
    if (once !== 'eod' && fs.existsSync(killSwitchFile)) throw new Error(`kill switch is on (${killSwitchFile})`);
    return (await execute(cfg, once, symbols, opts)) ? 0 : 1;
  }

  let state = readJson(STATE_FILE, null);
  if (state === null && fs.existsSync(STATE_FILE)) {
    // Unreadable state: don't guess. No new trade cycles today; end of day still runs.
    process.stderr.write(`[autotrader] ${STATE_FILE} is unreadable; trade cycles are off until tomorrow, end of day still runs\n`);
    state = { day: dayKey(new Date()), premarketDone: true, eodDone: false, cycles: cfg.maxCyclesPerDay, lastCycleAt: null };
  }
  if (opts.dryRun) {
    const { action } = decide(cfg, state, new Date(), { killSwitch: fs.existsSync(killSwitchFile) });
    process.stdout.write(`next action now: ${action || 'none'}\n`);
    if (action) await execute(cfg, action, cfg.symbols, opts);
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
  let errors = 0;
  const recordResult = (ok, now) => {
    errors = ok ? 0 : errors + 1;
    if (errors >= cfg.maxConsecutiveErrors && !fs.existsSync(killSwitchFile)) {
      fs.writeFileSync(killSwitchFile, `created by autotrader after ${errors} failed runs at ${now.toISOString()}\n`);
      process.stderr.write(`[autotrader] ${errors} failed runs in a row: kill switch created (${killSwitchFile}). Remove it to resume.\n`);
    }
  };
  const client = createClient();
  const barOpts = {
    minutes: cfg.timeframe,
    delayMs: cfg.barDelaySeconds * 1000,
    timeoutMs: cfg.barTimeoutSeconds * 1000,
    pollMs: cfg.barPollSeconds * 1000,
  };
  const syms = cfg.symbols.map(symbol => ({ symbol, contractId: null, clock: null, lastPollAt: 0 }));
  process.stdout.write(`[autotrader] ${cfg.harness} on ${cfg.symbols.join(',')} every closed ${cfg.timeframe}m bar (trigger: ${cfg.trigger}); kill switch: ${killSwitchFile}\n`);

  for (;;) {
    const now = new Date();
    const { action, state: s } = decide(cfg, state, now, { killSwitch: fs.existsSync(killSwitchFile) });
    state = s;
    if (action === 'premarket' || action === 'eod') {
      const ok = await execute(cfg, action, cfg.symbols, opts);
      // A failed end of day is retried on the next pass: flattening matters most.
      if (ok || action !== 'eod') state = recordRun(state, action, now);
      writeJsonAtomic(STATE_FILE, state);
      recordResult(ok, now);
      continue;
    }
    if (action !== 'trade') {
      await new Promise(r => setTimeout(r, IDLE_MS));
      continue;
    }

    for (let i = 0; i < syms.length; i += 1) {
      const sym = syms[i];
      try {
        if (!sym.contractId) {
          if (Date.now() - sym.lastPollAt < 10000) continue; // back off after a failed lookup
          const c = await client.activeContract(sym.symbol);
          syms[i] = { ...sym, contractId: c.id };
          process.stdout.write(`[autotrader] ${sym.symbol} -> ${c.id}\n`);
          continue; // next pass resyncs its bar schedule
        }
        const step = await barStep(sym, new Date(), barOpts, () => client.closedBars(sym.contractId, { minutes: cfg.timeframe, limit: cfg.bars }));
        syms[i] = step.sym;
        if (step.event === 'stale') {
          const agoS = Math.round((Date.now() - Date.parse(step.bar.t)) / 1000 - cfg.timeframe * 60);
          process.stdout.write(`[autotrader] ${sym.symbol} bar ${step.bar.t} skipped: closed ${agoS}s ago, too late to act on\n`);
        }
        if (step.event !== 'bar') continue;

        const file = writeBars(cfg, sym, step.bars);
        const want = await wantsCycle(cfg, syms[i], step.bars, client);
        if (!want.run) {
          process.stdout.write(`[autotrader] ${sym.symbol} bar ${step.bar.t}: no cycle (${want.reason})\n`);
          continue;
        }
        const cycleNow = new Date();
        const prompt = prompts(cfg, cycleNow, ROOT).trade(sym.symbol, { ...step.bar, file, contractId: sym.contractId });
        const ok = await runJob(cfg, 'trade', prompt, opts);
        state = recordRun(state, 'trade', cycleNow);
        writeJsonAtomic(STATE_FILE, state);
        recordResult(ok, cycleNow);
      } catch (err) {
        process.stderr.write(`[autotrader] ${sym.symbol}: ${err.message}\n`);
        syms[i] = { ...syms[i], lastPollAt: Date.now() };
      }
    }
    await new Promise(r => setTimeout(r, sleepMs(syms.map(x => x.clock), new Date(), { delayMs: barOpts.delayMs })));
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[autotrader] ${err.message}\n`);
  process.exitCode = 1;
});
