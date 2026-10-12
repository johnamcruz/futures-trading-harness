'use strict';

/**
 * The strategy registry operations (scripts/strategies.js): list, show,
 * validate, scan, recent. Each is `(args, ctx) -> { text, stderr?, code? }`
 * (harness-tools/cli.js).
 *
 *   list     { json, compact }
 *   show     { name }
 *   validate {}                                  code 1 when any strategy is invalid
 *   scan     { file, symbol, now, record, view, name }   file: bars file or '-'; now: ISO (default: the harness clock)
 *   recent   { file, symbol, count, format }     count: 1 to 50 (default 5)
 *   plan     { file, symbol, strategy, side, accountId }   the order for a candidate (order-plan.js)
 *
 * The scripts print the full JSON. The harness tools ask for the compact forms
 * (compact.js) by default: scan view 'summary' (or 'one' with name: that
 * strategy's full result), recent format 'lines', list json on one line
 * (compact); registry.js maps the tools' detail / name / json to them.
 *
 * scan with record also records which rules strategies fired on the last
 * closed bar (only those on the bars' timeframe), for the order gate's trigger
 * check (trading/signal-state.js); ignored in autonomous runs, where the
 * runner records every bar (the scan is returned with a note saying so).
 */

const fs = require('fs');
const { readBarsArg } = require('../backtest/data');
const { loadStrategies, scan: scanStrategies, recentSignals } = require('../trading/strategies');
const { buildSignals, writeSignals } = require('../trading/signal-state');
const { timeframeMs } = require('../trading/evaluator');
const { normalizeBars } = require('../trading/indicators');
const { harnessHome } = require('../paths');
const { context, say, ignoredRecord, withText, options } = require('./cli');
const { liveRunner } = require('../runner-lock');
const { scanSummary, recentLines } = require('./compact');
const { liveSpecs } = require('../trading/broker-specs');
const { selectedSymbols } = require('../trading/contracts');
const { plan } = require('./order-plan');

const USAGE = 'usage: strategies.js list [--json] | show <name> | validate | scan <bars file> --symbol <ROOT> [--now ISO] [--record] | recent <bars file> --symbol <ROOT> [--bars 5] | plan <bars file> --symbol <ROOT> --strategy <name> --side long|short [--account-id <id>]';

const load = c => loadStrategies(c.root, c.env);

function list({ json = false, compact = false } = {}, ctx) {
  const rows = load(context(ctx)).strategies.map(s => ({
    name: s.name, status: s.valid ? s.status : 'INVALID', instruments: s.instruments, timeframe: s.timeframe,
    signal: s.signal, sessions: s.sessions || [], description: s.description, file: s.file,
  }));
  if (json) return { text: compact ? `${JSON.stringify(rows)}\n` : `${JSON.stringify(rows, null, 2)}\n` };
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

/** The scan as the caller asked: the full JSON (the script's), one strategy's full result, or the summary. */
function scanText(results, bars, { view = 'json', name, symbol, specOf }) {
  if (view === 'one') {
    const one = results.find(r => r.name === name);
    if (!one) throw new Error(`no scan result for "${name}" (scanned: ${results.map(r => r.name).join(', ') || 'none'})`);
    return `${JSON.stringify(one, null, 2)}\n`;
  }
  if (view === 'summary') {
    const norm = normalizeBars(bars);
    return scanSummary(results, { symbol: symbol ? String(symbol).toUpperCase() : '', bar: norm.length ? norm[norm.length - 1].t : null, specOf });
  }
  return `${JSON.stringify(results, null, 2)}\n`;
}

function scan({ file, symbol, now: at, record = false, view = 'json', name } = {}, ctx) {
  const c = context(ctx);
  const { strategies } = load(c);
  if (!file) throw new Error('scan needs a bars file (get_bars JSON, CSV, Parquet) or -');
  const bars = readBarsArg(file);
  // The harness clock (a replay broker's replayed time), refused when unusable even with --now.
  const clock = c.now();
  const now = at ? new Date(at) : clock;
  if (!Number.isFinite(now.getTime())) throw new Error(`--now: not a time (${at})`); // cli-only: the tool takes no time
  const results = scanStrategies(strategies, bars, { symbol, now, selected: selectedSymbols(c.env) });
  const text = scanText(results, bars, { view, name, symbol, specOf: liveSpecs(c.env) }); // the broker's tick specs
  if (!record) return { text };
  const ignored = ignoredRecord(c, 'strategies', 'the autonomous runner records every bar itself');
  if (ignored) return { text, stderr: ignored };
  return withText(text, () => {
    const record = say(c, '--record', 'record');
    const pid = liveRunner(c.env);
    if (pid) throw new Error(`${record}: an autonomous runner is running (pid ${pid}): it records the reads and signals of the symbols it trades, and record is refused while it runs`);
    if (!symbol) throw new Error(say(c, '--record needs --symbol <ROOT>', 'record needs symbol (a contract root)'));
    // The record's file is named after it: a contract root only (as mtf and bars take it).
    if (!/^[A-Z0-9]+$/.test(String(symbol).toUpperCase())) throw new Error(say(c, '--record needs --symbol <ROOT>: a contract root, e.g. MNQ', 'record needs symbol: a contract root, e.g. MNQ'));
    const norm = normalizeBars(bars);
    const diffs = norm.slice(-50).map((b, i, a) => (i ? Date.parse(b.t) - Date.parse(a[i - 1].t) : Infinity)).filter(d => d > 0 && Number.isFinite(d));
    const stepMs = Math.min(...diffs);
    // Only strategies on the bars' own timeframe can have fired on them.
    const sameTf = results.filter(r => timeframeMs(r.timeframe) === stepMs);
    const out = writeSignals(harnessHome(c.env), buildSignals(sameTf, { symbol, bar: norm[norm.length - 1], stepMs, now, source: file }));
    return { text, stderr: `[strategies] recorded for the order gate: ${out}\n` };
  });
}

function recent({ file, symbol, count: raw, format = 'json' } = {}, ctx) {
  const c = context(ctx);
  const { strategies } = load(c);
  if (!file) throw new Error('recent needs a bars file');
  const count = raw === undefined ? 5 : Number(raw);
  if (!(Number.isInteger(count) && count >= 1 && count <= 50)) throw new Error(say(c, '--bars: 1 to 50', 'count: 1 to 50'));
  const rows = recentSignals(strategies, readBarsArg(file), { symbol, count, selected: selectedSymbols(c.env) });
  return { text: format === 'lines' ? recentLines(rows, { symbol: symbol ? String(symbol).toUpperCase() : '' }) : `${JSON.stringify(rows, null, 2)}\n` };
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
  if (cmd === 'plan') {
    const o = options(rest, ['--symbol', '--strategy', '--side', '--account-id'], []);
    const id = o['--account-id'];
    return { op: 'plan', args: { file: o._[0], symbol: o['--symbol'], strategy: o['--strategy'], side: o['--side'], accountId: id === undefined ? undefined : Number(id) } };
  }
  throw new Error(USAGE);
}

const OPS = { list, show, validate, scan, recent, plan };

module.exports = { OPS, USAGE, list, show, validate, scan, recent, plan, parseArgv };
