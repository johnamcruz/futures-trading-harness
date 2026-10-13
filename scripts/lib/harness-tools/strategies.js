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
 * scan judges only the strategies on the bars' timeframe (as the runner does);
 * name on a strategy of another timeframe is refused, not scanned.
 * scan with record also records which rules strategies fired on the last
 * closed bar, for the order gate's trigger
 * check (trading/signal-state.js); ignored in autonomous runs, where the
 * runner records every bar (the scan is returned with a note saying so).
 */

const fs = require('fs');
const { readBarsArg } = require('../backtest/data');
const { loadStrategies, scan: scanStrategies, recentSignals, barsStepMs, onTimeframe, barsTimeframe } = require('../trading/strategies');
const { buildSignals, writeSignals } = require('../trading/signal-state');
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
  // Read once: in a cycle whose bar briefing is current, the summary scan is what the briefing's m3 candidates hold.
  if (view === 'summary' && !record && !at && require('./briefing').briefedThisCycle(c.env, symbol)) {
    return { text: `This bar's briefing is current (bar_briefing {"symbol": "${symbol}"}): its m3 candidates are this scan (each with its stop, exit and facts), and the trend rule and alignment are in it too. Read it there, once per role (trade-session: read once); strategies_show gives a strategy's rules, and strategies_scan with name one strategy's full result.\n` };
  }
  const bars = readBarsArg(file);
  // The harness clock (a replay broker's replayed time), refused when unusable even with --now.
  const clock = c.now();
  const now = at ? new Date(at) : clock;
  if (!Number.isFinite(now.getTime())) throw new Error(`--now: not a time (${at})`); // cli-only: the tool takes no time
  // Only the strategies on the bars' own timeframe can be judged from them (as the runner scans).
  const stepMs = barsStepMs(bars);
  const tf = barsTimeframe(stepMs);
  const tfText = tf || (stepMs > 0 ? `${stepMs / 1000}s` : 'of no known spacing');
  const asked = name ? strategies.find(s => s.name === name) : null;
  if (asked && asked.timeframe !== tf) {
    throw new Error(`${name} trades ${asked.timeframe} bars, and these bars are ${tfText}: not scanned (scan it on ${asked.timeframe} bars)`);
  }
  const results = scanStrategies(onTimeframe(strategies, tf), bars, { symbol, now, selected: selectedSymbols(c.env) });
  // No strategy on these bars' timeframe: say so, not "no candidates" (which reads as no setup).
  const usable = strategies.filter(s => s.valid && s.status !== 'disabled');
  const none = onTimeframe(usable, tf).length ? '' : `no strategy trades ${tfText} bars; strategies here trade ${[...new Set(usable.map(s => s.timeframe))].sort().join(', ') || 'none'}: nothing was scanned\n`;
  const text = none && view === 'summary' ? none : scanText(results, bars, { view, name, symbol, specOf: liveSpecs(c.env) }); // the broker's tick specs
  const note = none && view !== 'summary' ? `[strategies] ${none}` : '';
  if (!record) return note ? { text, stderr: note } : { text };
  const ignored = ignoredRecord(c, 'strategies', 'the autonomous runner records every bar itself');
  if (ignored) return { text, stderr: note + ignored };
  return withText(text, () => {
    const record = say(c, '--record', 'record');
    const pid = liveRunner(c.env);
    if (pid) throw new Error(`${record}: an autonomous runner is running (pid ${pid}): it records the reads and signals of the symbols it trades, and record is refused while it runs`);
    if (!symbol) throw new Error(say(c, '--record needs --symbol <ROOT>', 'record needs symbol (a contract root)'));
    // The record's file is named after it: a contract root only (as mtf and bars take it).
    if (!/^[A-Z0-9]+$/.test(String(symbol).toUpperCase())) throw new Error(say(c, '--record needs --symbol <ROOT>: a contract root, e.g. MNQ', 'record needs symbol: a contract root, e.g. MNQ'));
    const norm = normalizeBars(bars);
    // The rules strategies' results (a policy strategy's result fires nothing): all on the bars' timeframe.
    const sameTf = onTimeframe(results, tf);
    const out = writeSignals(harnessHome(c.env), buildSignals(sameTf, { symbol, bar: norm[norm.length - 1], stepMs, now, source: file }));
    return { text, stderr: `${note}[strategies] recorded for the order gate: ${out}\n` };
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
