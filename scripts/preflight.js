#!/usr/bin/env node
/**
 * Preflight: is everything ready for a live or replay session? Read-only: it
 * places no orders and writes no harness state (the contract translator keeps
 * its contract lookups, as on every server start). It starts the configured broker
 * server as the runner does (behind the contract translator) and checks the
 * runner config (eodAt, sessions, a live run's account and allow-list), the CLI
 * harness command, the broker interface, the account (it can trade, its
 * balance, the prop profile's size), prop attempts, the bar fields active
 * strategies read, the clock, market hours and the kill switch
 * (scripts/lib/preflight.js).
 *
 *   node scripts/preflight.js --config autotrader.json [--no-version] [--json]
 *
 * Exit 0 when every check passes (warnings allowed), 1 when one fails, 2 on a
 * usage error. Runbook: docs/LIVE-DRY-RUN.md.
 */

'use strict';

// The broker server's settings and credentials, as the runner reads them.
if (require.main === module) require('./lib/env-file').loadEnvForCli('preflight');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runPreflight, formatReport } = require('./lib/preflight');

const ROOT = path.resolve(__dirname, '..');

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** `<cmd> --version`: its first line, or why not. */
function version(cmd) {
  const res = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error || res.status !== 0) return { ok: false, text: res.error ? res.error.message : `exit ${res.status}` };
  return { ok: true, text: String(res.stdout || res.stderr).trim().split('\n')[0] || '(no output)' };
}

async function main(argv, { env = process.env, out = s => process.stdout.write(s), deps = {} } = {}) {
  require('./lib/tunables').assertUsable(); // a refused config file: no preflight passes (the CRITICAL error)
  const file = arg(argv, '--config');
  if (!file) {
    out('usage: preflight.js --config <autotrader.json> [--no-version] [--json]\n');
    return 2;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    out(`FAIL runner config: ${file}: ${err.message}\n`);
    return 1;
  }
  const report = await runPreflight({ raw, root: ROOT, env, deps: { version: argv.includes('--no-version') ? null : version, ...deps } });
  out(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
    process.stderr.write(`[preflight] ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main };
