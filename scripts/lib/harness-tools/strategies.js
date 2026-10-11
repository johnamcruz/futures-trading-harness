'use strict';

/**
 * The strategy registry operations (scripts/strategies.js): list, show,
 * validate, scan, recent. Each is `(args, ctx) -> { text, stderr?, code? }`
 * (harness-tools/cli.js).
 *
 *   list     { json }
 *   show     { name }
 *   validate {}                                  code 1 when any strategy is invalid
 *   scan     { file, symbol, now, record }       file: bars file or '-'; now: ISO (default: the harness clock)
 *   recent   { file, symbol, count }             count: 1 to 50 (default 5)
 *
 * scan with record also records which rules strategies fired on the last
 * closed bar (only those on the bars' timeframe), for the order gate's trigger
 * check (trading/signal-state.js); refused in autonomous runs, where the
 * runner records every bar.
 */

const fs = require('fs');
const { readBarsArg } = require('../backtest/data');
const { loadStrategies, scan: scanStrategies, recentSignals } = require('../trading/strategies');
const { buildSignals, writeSignals } = require('../trading/signal-state');
const { timeframeMs } = require('../trading/evaluator');
const { normalizeBars } = require('../trading/indicators');
const { harnessHome } = require('../paths');
const { context, withText, options } = require('./cli');

const USAGE = 'usage: strategies.js list [--json] | show <name> | validate | scan <bars file> --symbol <ROOT> [--now ISO] [--record] | recent <bars file> --symbol <ROOT> [--bars 5]';

const load = c => loadStrategies(c.root, c.env);

function list({ json = false } = {}, ctx) {
  const rows = load(context(ctx)).strategies.map(s => ({
    name: s.name, status: s.valid ? s.status : 'INVALID', instruments: s.instruments, timeframe: s.timeframe,
    signal: s.signal, sessions: s.sessions || [], description: s.description, file: s.file,
  }));
  if (json) return { text: `${JSON.stringify(rows, null, 2)}\n` };
  return { text: rows.map(r => `${r.name.padEnd(14)} ${String(r.status).padEnd(9)} ${String(r.signal).padEnd(11)} ${(r.instruments || []).join(',')}  ${r.description || ''}\n`).join('') };
}

function show({ name } = {}, ctx) {
  const { strategies } = load(context(ctx));
  const s = strategies.find(x => x.name === name);
  if (!s) throw new Error(`unknown strategy "${name}" (known: ${strategies.map(x => x.name).join(', ')})`);
  return { text: fs.readFileSync(s.file, 'utf8') };
}

function validate(_args, ctx) {
  const { strategies, problems } = load(context(ctx));
  let bad = problems.length;
  let text = problems.map(p => `WARN ${p.dir}: ${p.error}\n`).join('');
  for (const s of strategies) {
    if (s.valid) text += `ok   ${s.name}\n`;
    else { bad += 1; text += `FAIL ${s.name} (${s.file})\n${s.errors.map(e => `     - ${e}`).join('\n')}\n`; }
  }
  return { text, code: bad === 0 ? 0 : 1 };
}

function scan({ file, symbol, now: at, record = false } = {}, ctx) {
  const c = context(ctx);
  const { strategies } = load(c);
  if (!file) throw new Error('scan needs a bars file (get_bars JSON, CSV, Parquet) or -');
  const bars = readBarsArg(file);
  // The harness clock (a replay broker's replayed time), refused when unusable even with --now.
  const clock = c.now();
  const now = at ? new Date(at) : clock;
  if (!Number.isFinite(now.getTime())) throw new Error(`--now: not a time (${at})`);
  const results = scanStrategies(strategies, bars, { symbol, now });
  const text = `${JSON.stringify(results, null, 2)}\n`;
  if (!record) return { text };
  return withText(text, () => {
    if (c.env.FTH_AUTONOMOUS === '1') throw new Error('--record: the autonomous runner records every bar itself');
    if (!symbol) throw new Error('--record needs --symbol <ROOT>');
    const norm = normalizeBars(bars);
    const diffs = norm.slice(-50).map((b, i, a) => (i ? Date.parse(b.t) - Date.parse(a[i - 1].t) : Infinity)).filter(d => d > 0 && Number.isFinite(d));
    const stepMs = Math.min(...diffs);
    // Only strategies on the bars' own timeframe can have fired on them.
    const sameTf = results.filter(r => timeframeMs(r.timeframe) === stepMs);
    const out = writeSignals(harnessHome(c.env), buildSignals(sameTf, { symbol, bar: norm[norm.length - 1], stepMs, now, source: file }));
    return { text, stderr: `[strategies] recorded for the order gate: ${out}\n` };
  });
}

function recent({ file, symbol, count: raw } = {}, ctx) {
  const c = context(ctx);
  const { strategies } = load(c);
  if (!file) throw new Error('recent needs a bars file');
  const count = raw === undefined ? 5 : Number(raw);
  if (!(Number.isInteger(count) && count >= 1 && count <= 50)) throw new Error('--bars: 1 to 50');
  return { text: `${JSON.stringify(recentSignals(strategies, readBarsArg(file), { symbol, count }), null, 2)}\n` };
}

/** argv (after the script name) to { op, args }; throws the usage on anything else. */
function parseArgv([cmd, ...rest]) {
  if (cmd === 'list') return { op: 'list', args: { json: Boolean(options(rest, [], ['--json'])['--json']) } };
  if (cmd === 'show') return { op: 'show', args: { name: rest[0] } };
  if (cmd === 'validate') return { op: 'validate', args: {} };
  if (cmd === 'scan') {
    const o = options(rest, ['--symbol', '--now'], ['--record']);
    return { op: 'scan', args: { file: o._[0], symbol: o['--symbol'], now: o['--now'], record: Boolean(o['--record']) } };
  }
  if (cmd === 'recent') {
    const o = options(rest, ['--symbol', '--bars'], []);
    return { op: 'recent', args: { file: o._[0], symbol: o['--symbol'], count: o['--bars'] } };
  }
  throw new Error(USAGE);
}

const OPS = { list, show, validate, scan, recent };

module.exports = { OPS, USAGE, list, show, validate, scan, recent, parseArgv };
