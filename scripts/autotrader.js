#!/usr/bin/env node
/**
 * Autonomous runner: schedules premarket, trade cycles, and end of day, and
 * runs each as one headless harness invocation (Claude Code, Codex, Qwen Code,
 * or a custom CLI agent). One run at a time; never overlapping.
 *
 *   node scripts/autotrader.js --config autotrader.json            run the schedule
 *   node scripts/autotrader.js --config autotrader.json --once trade [--symbol MNQ]
 *   node scripts/autotrader.js --config autotrader.json --dry-run  print the next command
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
const { validateConfig, prompts, buildCommand, decide, recordRun, cycleResult, dayKey } = require('./lib/autotrader');
const { loadConfig } = require('./lib/trading/config');

const ROOT = path.resolve(__dirname, '..');
const HOME_DIR = path.join(os.homedir(), '.futures-trading-harness');
const STATE_FILE = path.join(HOME_DIR, 'autotrader-state.json');
const TICK_MS = 20000;

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
      env: { ...process.env, FTH_ROOT: ROOT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', c => { output += c; });
    child.stderr.on('data', c => { output += c; });
    const timer = setTimeout(() => {
      output += `\n[autotrader] timeout after ${timeoutMs / 60000} min; killing run\n`;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10000).unref();
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, output: `${output}\n[autotrader] could not start ${cmd}: ${err.message}\n` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output });
    });
  });
}

async function execute(cfg, action, symbols, opts) {
  const now = new Date();
  const p = prompts(cfg, now);
  const jobs = action === 'eod' ? [p.eod()] : symbols.map(sym => p[action](sym));
  let ok = true;
  for (const prompt of jobs) {
    const argv = buildCommand(cfg, prompt, ROOT);
    if (opts.dryRun) {
      process.stdout.write(`${JSON.stringify(argv)}\n`);
      continue;
    }
    process.stdout.write(`[autotrader] ${now.toISOString()} ${action}: ${argv[0]} ...\n`);
    const res = await runOnce(cfg, argv, cfg.cycleTimeoutMinutes * 60000);
    const result = cycleResult(res.output) || (res.ok ? 'CYCLE RESULT: (none reported)' : `CYCLE RESULT: error - exit ${res.code}`);
    appendLog(now, `\n===== ${now.toISOString()} ${action} ${cfg.harness}\n$ ${argv.map(a => JSON.stringify(a)).join(' ')}\n${res.output}\n`);
    process.stdout.write(`[autotrader] ${result}\n`);
    ok = ok && res.ok;
  }
  return ok;
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
  if (opts.dryRun) {
    const { action } = decide(cfg, state, new Date(), { killSwitch: fs.existsSync(killSwitchFile) });
    process.stdout.write(`next action now: ${action || 'none'}\n`);
    if (action) await execute(cfg, action, cfg.symbols, opts);
    return 0;
  }
  fs.mkdirSync(HOME_DIR, { recursive: true });
  let errors = 0;
  process.stdout.write(`[autotrader] ${cfg.harness} on ${cfg.symbols.join(',')}; kill switch: ${killSwitchFile}\n`);
  for (;;) {
    const now = new Date();
    const { action, state: s } = decide(cfg, state, now, { killSwitch: fs.existsSync(killSwitchFile) });
    state = s;
    if (action) {
      const ok = await execute(cfg, action, cfg.symbols, opts);
      // A failed end of day is retried on the next tick: flattening matters most.
      if (ok || action !== 'eod') state = recordRun(state, action, now);
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      errors = ok ? 0 : errors + 1;
      if (errors >= cfg.maxConsecutiveErrors && !fs.existsSync(killSwitchFile)) {
        fs.writeFileSync(killSwitchFile, `created by autotrader after ${errors} failed runs at ${now.toISOString()}\n`);
        process.stderr.write(`[autotrader] ${errors} failed runs in a row: kill switch created (${killSwitchFile}). Remove it to resume.\n`);
      }
    }
    await new Promise(r => setTimeout(r, TICK_MS));
  }
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  process.stderr.write(`[autotrader] ${err.message}\n`);
  process.exitCode = 1;
});
