'use strict';

/**
 * End to end: a broker MCP server (the tests' fake) serving 3-minute bars that carry a nested field of its
 * own -> `backtest.js fetch --timeframe 3` (the broker adapter's history and the contract translator) ->
 * a JSON lines file -> `backtest.js` on it, where a strategy reads the field with field() and trades on the
 * bars that carry it. The field survives fetch, load and evaluation; the report gives its coverage (the
 * share of the bars carrying it) and warns where it is null. The same prices without the field don't trade.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readBarsArg } = require('../../scripts/lib/backtest/data');
const { FAKE_BROKERS, tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_SERVER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const CSV = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
const PRICES = readBarsArg(CSV).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
const NULL_TAIL = 100; // the last bars: past the broker's data for the field (null)

/** A probe strategy of the user's: long whenever the broker's nested field says so. */
const PROBE = `---
name: field_probe
description: Test probe - goes long on a 3-minute bar whose broker field ext.deep.signal is 1 or more.
version: 1
status: paper
instruments: [MNQ]
timeframe: 3m
sessions: ["09:45-15:30@America/New_York"]
mtf: reversal
signal: rules
rules:
  long:
    - field("ext.deep.signal") >= 1
risk:
  stop: atr:1
  min_rr: 1
exit:
  target_r: 1
  max_bars: 3
source: test probe
---

# Strategy: field probe

## When to Use

Tests only.

## How It Works

Long on the broker's field.

## Examples

A bar with ext.deep.signal 1: long.
`;

/** Is bar k a signal bar: 10:30 ET (14:30 UTC in April). */
const marked = b => b.t.endsWith('T14:30:00.000Z');

function served(withField) {
  return PRICES.map((b, k) => {
    if (!withField) return b;
    const value = k >= PRICES.length - NULL_TAIL ? null : marked(b) ? 1 : 0;
    return { ...b, ext: { deep: { signal: value, note: 'kept' } }, flow: { windows: { 3: { ofiTrade: value === null ? null : 0 } } } };
  });
}

function run(withField) {
  const home = tmpDir();
  const file = path.join(home, 'served.json');
  fs.writeFileSync(file, JSON.stringify(served(withField)));
  const stratDir = path.join(home, 'strategies', 'field_probe');
  fs.mkdirSync(stratDir, { recursive: true });
  fs.writeFileSync(path.join(stratDir, 'STRATEGY.md'), PROBE);
  const args = path.join(home, 'args.jsonl');
  const env = {
    PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: FAKE_SERVER,
    FAKE_BARS: file, FAKE_BARS_FROM_START: '1', FAKE_ARGS: args, FTH_STRATEGIES_DIRS: path.join(home, 'strategies'),
  };
  const node = argv => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'backtest.js'), ...argv], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const out = path.join(home, 'MNQ-3m.jsonl');
  const fetched = node(['fetch', '--contract', 'MNQ', '--from', PRICES[0].t, '--to', PRICES.at(-1).t, '--timeframe', '3', '--out', out]);
  assert.strictEqual(fetched.status, 0, fetched.stderr);
  const calls = fs.readFileSync(args, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(c => c.name === 'get_bars');
  const bars = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const backtest = (strategy, dir) => {
    const r = node(['--data', out, '--symbol', 'MNQ', '--timeframe', '3', '--strategy', strategy, '--no-gate', '--out', path.join(home, dir)]);
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    return { log: r.stdout, report: JSON.parse(fs.readFileSync(path.join(home, dir, 'report.json'), 'utf8')), md: fs.readFileSync(path.join(home, dir, 'report.md'), 'utf8') };
  };
  return { fetched, calls, bars, probe: backtest('field_probe', 'probe'), va: backtest('value_area', 'va') };
}

test('fetch --timeframe 3 -> JSON lines -> backtest: the broker\'s nested field survives, field() fires on it, coverage is reported', () => {
  const r = run(true);
  assert.match(r.fetched.stdout, new RegExp(`wrote ${PRICES.length} 3 minute bars for MNQ to .*MNQ-3m\\.jsonl \\(with the broker's own fields: ext, flow\\)`));
  // get_bars at 3 minutes (never 1-minute bars built up), within the span asked.
  assert.ok(r.calls.length >= 1 && r.calls.every(c => c.args.unit === 'minute' && c.args.unitNumber === 3), JSON.stringify(r.calls));
  // Fetched: every bar, the broker's nested fields as it served them (the translator in front changes nothing).
  assert.deepStrictEqual(r.bars, served(true));
  // Evaluated: the probe trades on the bars the field marks, and only there.
  const trades = r.probe.report.trades;
  const signals = new Set(served(true).filter((b, k) => marked(b) && k < PRICES.length - NULL_TAIL).map(b => Date.parse(b.t)));
  assert.ok(trades.length >= 1, r.probe.log);
  for (const t of trades) assert.ok(signals.has(Date.parse(t.entryTime) - 180000), `entry ${t.entryTime} closes a signal bar`);
  // Coverage: the probe's field on all but the null tail, in the log, report.json and report.md, with a warning.
  const n = PRICES.length;
  const want = { bars: n, carried: n - NULL_TAIL, share: Math.floor(((n - NULL_TAIL) / n) * 10000) / 10000 };
  assert.deepStrictEqual(r.probe.report.fieldCoverage, [{ strategy: 'field_probe', path: 'ext.deep.signal', coverage: { MNQ: want }, symbols: ['MNQ'] }]);
  assert.deepStrictEqual(r.probe.report.missingFields, r.probe.report.fieldCoverage);
  const share = `${Math.floor(((n - NULL_TAIL) / n) * 1000) / 10}%`;
  assert.ok(r.probe.log.includes(`field coverage: field_probe field("ext.deep.signal") on MNQ: ${share} of ${n} bars`), r.probe.log);
  assert.ok(r.probe.log.includes(`warning: field_probe reads field("ext.deep.signal"), which only ${share} of the MNQ bars (${n - NULL_TAIL} of ${n}) in this data carry`), r.probe.log);
  assert.ok(r.probe.md.includes(`| field_probe | \`ext.deep.signal\` | MNQ | ${share} | ${n - NULL_TAIL} / ${n} |`), r.probe.md);
  // value_area (3m) reads the broker's flow from the same fetched bars: its coverage is counted the same way.
  const va = r.va.report.fieldCoverage;
  assert.ok(va.length === 1 && va[0].strategy === 'value_area' && va[0].coverage.MNQ.carried === n - NULL_TAIL, JSON.stringify(va));
});

test('the same prices without the broker\'s field: fetched as plain bars, no trade, and 0% coverage said', () => {
  const r = run(false);
  assert.ok(r.bars.every(b => !('ext' in b)));
  assert.strictEqual(r.probe.report.trades.length, 0);
  assert.strictEqual(r.probe.report.missingFields[0].coverage.MNQ.carried, 0);
  assert.match(r.probe.log, /field_probe reads field\("ext\.deep\.signal"\), which no MNQ bar in this data carries/);
});
