#!/usr/bin/env node
/**
 * Strategy registry CLI (any harness can run it from a shell tool).
 *
 *   node scripts/strategies.js list [--json]
 *   node scripts/strategies.js show <name>
 *   node scripts/strategies.js validate
 *   node scripts/strategies.js scan <bars file|-> --symbol MNQ [--now ISO] [--record]
 *   node scripts/strategies.js recent <bars file> --symbol MNQ [--bars 5]   what fired on each of the last bars
 *
 * scan --record also records which rules strategies fired on the last closed
 * bar (only those on the bars' timeframe), for the order gate's trigger check
 * (trading/signal-state.js); refused in autonomous runs, where the runner
 * records every bar.
 */

'use strict';

const fs = require('fs');
const { readBarsArg } = require('./lib/backtest/data');
const path = require('path');
const { loadStrategies, scan, recentSignals } = require('./lib/trading/strategies');
const { buildSignals, writeSignals } = require('./lib/trading/signal-state');
const { timeframeMs } = require('./lib/trading/evaluator');
const { normalizeBars } = require('./lib/trading/indicators');
const { harnessHome } = require('./lib/paths');

const ROOT = path.resolve(__dirname, '..');

/** --name value or --name=value; every other flag is an error, so a typo can't be ignored silently. */
function options(args, valueFlags, boolFlags) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (valueFlags.includes(flag)) o[flag] = inline !== undefined ? inline : args[++i];
    else if (boolFlags.includes(flag) && inline === undefined) o[flag] = true;
    else if (!args[i].startsWith('--')) o._.push(args[i]);
    else throw new Error(`unknown argument: ${args[i]} (flags: ${[...valueFlags, ...boolFlags].join(' ')})`);
  }
  return o;
}

function run(argv, { env = process.env, out = s => process.stdout.write(s) } = {}) {
  const [cmd, ...args] = argv;
  const { strategies, problems } = loadStrategies(ROOT, env);

  if (cmd === 'list') {
    const rows = strategies.map(s => ({
      name: s.name, status: s.valid ? s.status : 'INVALID', instruments: s.instruments, timeframe: s.timeframe,
      signal: s.signal, sessions: s.sessions || [], description: s.description, file: s.file,
    }));
    if (options(args, [], ['--json'])['--json']) out(`${JSON.stringify(rows, null, 2)}\n`);
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
    const o = options(args, ['--symbol', '--now'], ['--record']);
    if (!o._[0]) throw new Error('scan needs a bars file (get_bars JSON, CSV, Parquet) or -');
    const bars = readBarsArg(o._[0]);
    const now = o['--now'] ? new Date(o['--now']) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error(`--now: not a time (${o['--now']})`);
    const results = scan(strategies, bars, { symbol: o['--symbol'], now });
    out(`${JSON.stringify(results, null, 2)}\n`);
    if (o['--record']) {
      if (env.FTH_AUTONOMOUS === '1') throw new Error('--record: the autonomous runner records every bar itself');
      if (!o['--symbol']) throw new Error('--record needs --symbol <ROOT>');
      const norm = normalizeBars(bars);
      const diffs = norm.slice(-50).map((b, i, a) => (i ? Date.parse(b.t) - Date.parse(a[i - 1].t) : Infinity)).filter(d => d > 0 && Number.isFinite(d));
      const stepMs = Math.min(...diffs);
      // Only strategies on the bars' own timeframe can have fired on them.
      const sameTf = results.filter(r => timeframeMs(r.timeframe) === stepMs);
      const file = writeSignals(harnessHome(env), buildSignals(sameTf, { symbol: o['--symbol'], bar: norm[norm.length - 1], stepMs, now, source: o._[0] }));
      process.stderr.write(`[strategies] recorded for the order gate: ${file}\n`);
    }
    return 0;
  }
  if (cmd === 'recent') {
    const o = options(args, ['--symbol', '--bars'], []);
    if (!o._[0]) throw new Error('recent needs a bars file');
    const count = o['--bars'] === undefined ? 5 : Number(o['--bars']);
    if (!(Number.isInteger(count) && count >= 1 && count <= 50)) throw new Error('--bars: 1 to 50');
    out(`${JSON.stringify(recentSignals(strategies, readBarsArg(o._[0]), { symbol: o['--symbol'], count }), null, 2)}\n`);
    return 0;
  }
  throw new Error('usage: strategies.js list [--json] | show <name> | validate | scan <bars file> --symbol <ROOT> [--now ISO] [--record] | recent <bars file> --symbol <ROOT> [--bars 5]');
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
