#!/usr/bin/env node
/**
 * The headless check: one real headless run per harness, started exactly as
 * the autonomous runner starts a cycle, with a probe that calls the harness
 * tools blackouts_list and strategies_list, delegates once to the harness role
 * risk-manager, and tries `node -e 1` through the shell. Prints what each step
 * reached. It places no orders and changes nothing.
 *
 *   node scripts/check-headless.js [--harness claude,codex,qwen,opencode] [--config autotrader.json] [--timeout 10]
 *
 * Default harnesses: the config's harness with --config (and its model, extra
 * args, workspace and bar directory), else all four (a harness that isn't
 * installed is reported so). The probe runs in paper mode. Qwen runs on the
 * workspace allowlist the runner writes at start: missing or different, the
 * Qwen probe stops and says so; --write-qwen-allowlist writes it (with no
 * runner trading: a running runner sees the change and turns trading off). Exit 0 when every probed
 * harness reached both tools and the role. --bin <file> runs a stand-in for
 * the harness CLI (tests). Each probe's raw transcript is kept at
 * FTH_HOME/logs/headless-<harness>-<time>.json, its path printed. The logic
 * lives in scripts/lib/headless-check.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { HARNESSES, configHarness, runProbe, passed, formatReport } = require('./lib/headless-check');

const ROOT = path.resolve(__dirname, '..');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv, { out = s => process.stdout.write(s), env = process.env } = {}) {
  const known = ['--harness', '--config', '--timeout', '--bin'];
  const writeAllowlist = argv.includes('--write-qwen-allowlist');
  argv = argv.filter(a => a !== '--write-qwen-allowlist');
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.includes(argv[i]) || argv[i + 1] === undefined) throw new Error(`usage: check-headless.js [--harness ${HARNESSES.join(',')}] [--config autotrader.json] [--timeout minutes] [--write-qwen-allowlist] (bad argument: ${argv[i]})`);
  }
  let harnesses = HARNESSES;
  // With a runner config: its harness, model, extra args, workspace and bar directory (in paper mode).
  const config = arg(argv, '--config') ? JSON.parse(fs.readFileSync(arg(argv, '--config'), 'utf8')) : {};
  if (arg(argv, '--config')) harnesses = [configHarness(config)];
  if (arg(argv, '--harness')) harnesses = arg(argv, '--harness').split(',').map(s => s.trim()).filter(Boolean);
  const bad = harnesses.filter(h => !HARNESSES.includes(h));
  if (bad.length) throw new Error(`--harness: ${bad.join(', ')} (known: ${HARNESSES.join(', ')})`);
  const minutes = arg(argv, '--timeout') === undefined ? 10 : Number(arg(argv, '--timeout'));
  if (!(minutes > 0)) throw new Error('--timeout: minutes, more than 0');
  let ok = true;
  for (const harness of harnesses) {
    out(`[check-headless] probing ${harness} (a real headless run; up to ${minutes} min)...\n`);
    const res = runProbe({ harness, root: ROOT, env, config, writeAllowlist, bin: arg(argv, '--bin') ? path.resolve(arg(argv, '--bin')) : null, timeoutMs: minutes * 60000 });
    out(`${formatReport(res).join('\n')}\n`);
    ok = passed(res) && ok;
  }
  return ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[check-headless] ${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { main };
