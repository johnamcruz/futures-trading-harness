'use strict';

/**
 * End to end: a broker MCP server that adds its own fields to its bars (the tests' fake server, its
 * FAKE_BARS setting standing in for a real server's order-flow setting) -> the broker adapter and the
 * contract translator (scripts/bars.js) -> the bars file -> the strategy scan (scripts/strategies.js),
 * where ofi_absorption reads the broker's flow fields with field(). The same prices without the fields
 * give no signal.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FAKE_BROKERS, tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const FAKE_SERVER = path.join(ROOT, 'tests', 'fixtures', 'broker-mcp-server.js');
const T0 = Date.UTC(2026, 9, 7, 14, 0);
const M = 60000;

/** 1-minute bars: 200 quiet, then 5 of heavy selling that holds the price, the last turning up; flow fields when `withFlow`. */
function absorbed(withFlow) {
  const out = [];
  let c = 20000;
  for (let k = 0; k < 205; k += 1) {
    const burst = k >= 200;
    const o = c;
    c = burst ? c : c + (k % 2 ? 0.25 : -0.25);
    if (k === 204) c += 0.5;
    const one = burst ? (k === 204 ? 0.4 : -0.5) : 0;
    const bar = { t: new Date(T0 + k * M).toISOString(), o, h: Math.max(o, c) + 0.5, l: Math.min(o, c) - 0.5, c, v: burst ? 400 : 100 };
    if (withFlow) bar.flow = { ofiTrade: one, complete: true, windows: { 5: { ofiTrade: burst ? -0.4 : 0, delta: 0 } } };
    out.push(bar);
  }
  return out;
}

function scanThroughBroker(withFlow) {
  const home = tmpDir();
  const served = path.join(home, 'served.json');
  fs.writeFileSync(served, JSON.stringify(absorbed(withFlow)));
  const env = { PATH: process.env.PATH, HOME: home, FTH_HOME: home, FTH_BROKERS_FILE: FAKE_BROKERS, FAKE_BROKER_ENTRY: FAKE_SERVER, FAKE_BARS: served };
  const fetched = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), '--symbol', 'MNQ', '--timeframe', '1', '--count', '205'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(fetched.status, 0, fetched.stderr);
  const file = path.join(home, 'bars-scratch', 'MNQ-1m.json');
  const bars = JSON.parse(fs.readFileSync(file, 'utf8')).bars;
  const scan = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'strategies.js'), 'scan', file, '--symbol', 'MNQ'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(scan.status, 0, scan.stderr);
  const row = JSON.parse(scan.stdout).find(r => r.name === 'ofi_absorption');
  return { bars, row };
}

test('a broker\'s own bar fields reach the bars file untouched and fire the strategy that reads them', () => {
  const { bars, row } = scanThroughBroker(true);
  assert.strictEqual(bars.length, 205);
  assert.deepStrictEqual(bars.at(-1).flow, absorbed(true).at(-1).flow, 'the broker\'s fields, as it served them');
  assert.ok(row, 'ofi_absorption is scanned');
  assert.strictEqual(row.direction, 'long', JSON.stringify(row));
});

test('the same prices without the broker\'s fields give no signal', () => {
  const { bars, row } = scanThroughBroker(false);
  assert.ok(!('flow' in bars.at(-1)));
  assert.ok(row && !row.direction, JSON.stringify(row));
});
