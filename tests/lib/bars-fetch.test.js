'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchBarsToFile, requestErrors, defaultOut } = require('../../scripts/lib/bars-fetch');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

function fakeClient(n = 50) {
  const calls = [];
  return {
    calls,
    async activeContract(symbol) { calls.push(['contract', symbol]); return { id: symbol, tickSize: 0.25, tickValue: 0.5 }; },
    async closedBars(id, opts) {
      calls.push(['bars', id, opts.minutes, opts.limit, opts.daily]);
      return Array.from({ length: n }, (_, k) => ({ t: new Date(Date.UTC(2026, 9, 7, 13) + k * 180000).toISOString(), o: 1, h: 2, l: 0, c: 1, v: 3 })).reverse();
    },
  };
}

test('fetchBarsToFile writes get_bars JSON oldest first, and says when the last bar closed', async () => {
  const out = path.join(tmpDir(), 'sub', 'MNQ-3m.json');
  const client = fakeClient();
  const r = await fetchBarsToFile({ client, symbol: 'MNQ', timeframe: 3, count: 50, out });
  assert.deepStrictEqual(client.calls[1], ['bars', 'MNQ', 3, 50, false]);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([j.contractId, j.barSize, j.count], ['MNQ', '3 minute', 50]);
  assert.ok(Date.parse(j.bars[0].t) < Date.parse(j.bars[49].t), 'oldest first');
  assert.strictEqual(r.closedAt, new Date(Date.parse(r.last) + 180000).toISOString());
  const daily = await fetchBarsToFile({ client: fakeClient(), symbol: 'MNQ', daily: true, count: 60, out: path.join(tmpDir(), 'd.json') });
  assert.strictEqual(JSON.parse(fs.readFileSync(daily.file, 'utf8')).barSize, '1 day');
  await assert.rejects(fetchBarsToFile({ client: fakeClient(2), symbol: 'MNQ', count: 50, out: path.join(tmpDir(), 'x.json') }), /only 2 closed bars/);
});

test('request checks and default paths', () => {
  assert.deepStrictEqual(requestErrors({ symbol: 'MNQ', timeframe: 3, count: 2000 }), []);
  assert.match(requestErrors({ symbol: 'mnq!', timeframe: 0, count: 1 }).join(), /--symbol.*--timeframe.*--count/);
  assert.strictEqual(defaultOut('MNQ', 3, false), '/tmp/fth/MNQ-3m.json');
  assert.strictEqual(defaultOut('MNQ', 3, true), '/tmp/fth/MNQ-1d.json');
});

test('scripts/bars.js refuses unknown flags and --record in autonomous runs', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bars.js'), ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: tmpDir(), ...env } });
  const bad = run(['--symbol', 'MNQ', '--bogus']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown argument: --bogus/);
  const auto = run(['--symbol', 'MNQ', '--record'], { FTH_AUTONOMOUS: '1' });
  assert.match(auto.stderr, /the autonomous runner records the read itself/);
});
