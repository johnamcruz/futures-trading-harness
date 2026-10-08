'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSignals, writeSignals, readSignals, signalFile, checkTrigger } = require('../../scripts/lib/trading/signal-state');
const { tmpDir, trendHome } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const now = new Date('2026-10-07T14:00:00Z');

test('buildSignals keeps the rules candidates with a side; writes one file per index family', () => {
  const rec = buildSignals([
    { name: 'orb', signal: 'rules', candidate: true, direction: 'long', stopDistance: 5.25 },
    { name: 'bos', signal: 'rules', candidate: false, direction: 'short' },
    { name: 'note', signal: 'manual', candidate: true },
  ], { symbol: 'nq', bar: { t: '2026-10-07T13:54:00.000Z' }, stepMs: 180000, now });
  assert.deepStrictEqual(rec.candidates, [{ name: 'orb', direction: 'long', stopDistance: 5.25 }]);
  assert.strictEqual(rec.closedAt, '2026-10-07T13:57:00.000Z');
  const home = tmpDir();
  writeSignals(home, rec);
  assert.strictEqual(signalFile(home, 'NQ', '3m'), path.join(home, 'signals', 'MNQ-3m.json'));
  assert.deepStrictEqual(readSignals(home, 'MNQ', '3m').candidates, rec.candidates);
  assert.strictEqual(readSignals(home, 'MNQ', '1m'), null, 'another timeframe has its own record');
});

test('checkTrigger: only the strategy that fired, on its side, on a recent bar; fails closed', () => {
  const home = trendHome(tmpDir(), { fired: [{ name: 'orb', direction: 'long' }] });
  const check = extra => checkTrigger(home, { root: 'MNQ', side: 'buy', strategy: 'orb', now, ...extra });
  assert.strictEqual(check(), null);
  assert.match(check({ side: 'sell' }), /setup:orb short did not fire on the last closed MNQ bar .*fired: orb long/);
  assert.match(check({ strategy: 'cisd_ote' }), /setup:cisd_ote long did not fire.*a different setup tag doesn't make it one/);
  assert.match(check({ now: new Date('2026-10-07T14:20:00Z') }), /closed 23 min ago \(limit 10, FTH_SIGNAL_MAX_AGE_MIN\): the setup has expired/);
  assert.match(check({ now: new Date('2026-10-07T13:30:00Z') }), /after now/);
  assert.match(checkTrigger(tmpDir(), { root: 'MNQ', side: 'buy', strategy: 'orb', now }), /No 3m signal record for MNQ.*strategies\.js scan .* --record/);
  const broken = tmpDir();
  fs.mkdirSync(path.join(broken, 'signals'));
  fs.writeFileSync(path.join(broken, 'signals', 'MNQ-3m.json'), '{');
  assert.match(checkTrigger(broken, { root: 'MNQ', side: 'buy', strategy: 'orb', now }), /unreadable/);
});

test('strategies.js scan --record writes the signal record; strict flags; refused in autonomous runs', () => {
  const home = tmpDir();
  const csv = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'strategies.js'), 'scan', csv, ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: home, FTH_AUTONOMOUS: '', ...env } });
  const ok = run(['--symbol=MNQ', '--now', '2026-04-28T04:15:30Z', '--record']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  const rec = readSignals(home, 'MNQ', '3m');
  assert.strictEqual(rec.closedAt, '2026-04-28T04:15:00.000Z');
  assert.ok(Array.isArray(rec.candidates));
  assert.match(run(['--symbol', 'MNQ', '--bogus']).stderr, /unknown argument: --bogus/);
  assert.match(run(['--symbol', 'MNQ', '--now', 'nope']).stderr, /--now: not a time/);
  assert.match(run(['--record']).stderr, /--record needs --symbol/);
  assert.match(run(['--symbol', 'MNQ', '--record'], { FTH_AUTONOMOUS: '1' }).stderr, /the autonomous runner records every bar itself/);
});
