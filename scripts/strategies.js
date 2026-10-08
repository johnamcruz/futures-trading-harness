#!/usr/bin/env node
/**
 * Strategy registry CLI (any harness can run it from a shell tool).
 *
 *   node scripts/strategies.js list [--json]
 *   node scripts/strategies.js show <name>
 *   node scripts/strategies.js validate
 *   node scripts/strategies.js scan <bars.json|-> --symbol MNQ [--now ISO]
 */

'use strict';

require('./lib/sim-clock').installSimClock(process.env);

const fs = require('fs');
const path = require('path');
const { loadStrategies, scan } = require('./lib/trading/strategies');

const ROOT = path.resolve(__dirname, '..');

function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function run(argv, { env = process.env, out = s => process.stdout.write(s) } = {}) {
  const [cmd, ...args] = argv;
  const { strategies, problems } = loadStrategies(ROOT, env);

  if (cmd === 'list') {
    const rows = strategies.map(s => ({
      name: s.name, status: s.valid ? s.status : 'INVALID', instruments: s.instruments, timeframe: s.timeframe,
      signal: s.signal, sessions: s.sessions || [], description: s.description, file: s.file,
    }));
    if (args.includes('--json')) out(`${JSON.stringify(rows, null, 2)}\n`);
    else for (const r of rows) out(`${r.name.padEnd(14)} ${String(r.status).padEnd(9)} ${String(r.signal).padEnd(11)} ${(r.instruments || []).join(',')}  ${r.description || ''}\n`);
    return 0;
  }
  if (cmd === 'show') {
    const s = strategies.find(x => x.name === args[0]);
    if (!s) throw new Error(`unknown strategy "${args[0]}" (known: ${strategies.map(x => x.name).join(', ')})`);
    out(fs.readFileSync(s.file, 'utf8'));
    return 0;
  }
  if (cmd === 'validate') {
    let bad = problems.length;
    for (const p of problems) out(`WARN ${p.dir}: ${p.error}\n`);
    for (const s of strategies) {
      if (s.valid) out(`ok   ${s.name}\n`);
      else { bad += 1; out(`FAIL ${s.name} (${s.file})\n${s.errors.map(e => `     - ${e}`).join('\n')}\n`); }
    }
    return bad === 0 ? 0 : 1;
  }
  if (cmd === 'scan') {
    if (!args[0]) throw new Error('scan needs a bars file (get_bars JSON) or -');
    const bars = JSON.parse(fs.readFileSync(args[0] === '-' ? 0 : args[0], 'utf8'));
    const nowArg = option(args, '--now');
    const results = scan(strategies, bars, { symbol: option(args, '--symbol'), now: nowArg ? new Date(nowArg) : new Date() });
    out(`${JSON.stringify(results, null, 2)}\n`);
    return 0;
  }
  throw new Error('usage: strategies.js list [--json] | show <name> | validate | scan <bars.json> --symbol <ROOT> [--now ISO]');
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[strategies] ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run };
