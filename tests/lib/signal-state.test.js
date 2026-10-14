'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSignals, writeSignals, readSignals, signalFile, checkTrigger, FUTURE_TOLERANCE_MIN, barMs, sameBar, recordTimeframe, lastRecordedBar } = require('../../scripts/lib/trading/signal-state');
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

test('writeSignals: the file is named from a contract root and minutes only, never a path', () => {
  const base = tmpDir();
  const home = path.join(base, 'a', 'home');
  const bar = { t: '2026-10-07T13:54:00.000Z' };
  for (const symbol of ['../../x', 'MNQ/../..', 'a b', '']) {
    assert.throws(() => writeSignals(home, buildSignals([], { symbol, bar, stepMs: 180000, now })), /the symbol must be a contract root/, symbol);
  }
  assert.throws(() => writeSignals(home, { ...buildSignals([], { symbol: 'MNQ', bar, stepMs: 180000, now }), timeframe: '../3m' }), /the timeframe must be minutes/);
  assert.throws(() => writeSignals(home, { ...buildSignals([], { symbol: 'MNQ', bar, stepMs: 180000, now }), timeframe: 'Infinitym' }), /the timeframe must be minutes/);
  assert.deepStrictEqual(fs.readdirSync(base, { recursive: true }), [], 'nothing written');
});

test('scripts/strategies.js scan --record refuses a symbol that is not a contract root', () => {
  const { spawnSync } = require('child_process');
  const base = tmpDir();
  const home = path.join(base, 'a', 'home');
  const csv = path.join(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'strategies.js'), 'scan', csv, '--symbol', '../../x', '--now', '2026-04-28T14:15:30Z', '--record'],
    { encoding: 'utf8', env: { PATH: process.env.PATH, FTH_HOME: home } });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /\[strategies\] --record needs --symbol <ROOT>: a contract root/);
  assert.deepStrictEqual(fs.readdirSync(base, { recursive: true }), [], 'nothing written');
});

test('checkTrigger: only the strategy that fired, on its side, on a recent bar; fails closed', () => {
  const home = trendHome(tmpDir(), { fired: [{ name: 'orb', direction: 'long' }] });
  const check = extra => checkTrigger(home, { root: 'MNQ', side: 'buy', strategy: 'orb', timeframe: '3m', now, ...extra });
  assert.strictEqual(check(), null);
  // No timeframe given: the 3m record is read, at the strictest age (1 minute a bar: 3 min).
  assert.match(check({ timeframe: undefined, now: new Date('2026-10-07T14:01:00Z') }), /closed 4 min ago \(limit 3 min: 3 1-minute \(no readable timeframe\) bars/);
  assert.match(check({ side: 'sell' }), /setup:orb short did not fire on the last closed MNQ bar .*fired: orb long/);
  assert.match(check({ strategy: 'cisd_ote' }), /setup:cisd_ote long did not fire.*a different setup tag doesn't make it one/);
  assert.match(check({ now: new Date('2026-10-07T14:20:00Z') }), /closed 23 min ago \(limit 9 min: 3 3m bars, FTH_SIGNAL_MAX_AGE_BARS\): the setup has expired/);
  assert.match(check({ now: new Date('2026-10-07T13:30:00Z') }), /after now/);
  // A record up to FUTURE_TOLERANCE_MIN (1) after now is a broker clock a little ahead: trusted (order_plan shares it).
  assert.strictEqual(FUTURE_TOLERANCE_MIN, 1);
  assert.strictEqual(check({ now: new Date('2026-10-07T13:56:30Z') }), null, '30 s ahead');
  assert.strictEqual(check({ now: new Date('2026-10-07T13:56:00Z') }), null, 'exactly the minute ahead');
  assert.match(check({ now: new Date('2026-10-07T13:55:59Z') }), /after now/, 'just over a minute ahead');
  assert.match(checkTrigger(tmpDir(), { root: 'MNQ', side: 'buy', strategy: 'orb', now }), /No 3m signal record for MNQ.*bars_fetch \{"symbol": "MNQ", "timeframe": 3\}.*strategies_scan \{"bars": "<that file>", "symbol": "MNQ", "record": true\}/);
  const broken = tmpDir();
  fs.mkdirSync(path.join(broken, 'signals'));
  fs.writeFileSync(path.join(broken, 'signals', 'MNQ-3m.json'), '{');
  assert.match(checkTrigger(broken, { root: 'MNQ', side: 'buy', strategy: 'orb', now }), /unreadable/);
});

test('strategies.js scan --record writes the signal record; strict flags; ignored (with a note) in autonomous runs', () => {
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
  // Autonomous: the scan prints, record is ignored with a note (exit 0), and no record is written.
  const autoHome = tmpDir();
  const auto = run(['--symbol', 'MNQ', '--record'], { FTH_AUTONOMOUS: '1', FTH_SYMBOLS: 'MNQ', FTH_HOME: autoHome });
  assert.strictEqual(auto.status, 0, auto.stderr);
  assert.match(auto.stdout, /^\[/);
  assert.strictEqual(auto.stderr, '[strategies] note: --record ignored - the autonomous runner records every bar itself\n');
  assert.ok(!fs.existsSync(path.join(autoHome, 'signals')), 'nothing recorded');
});

test('checkTrigger: a trend strategy is refused on a conflicting bar; FTH_MIN_CONFLUENCE asks for agreement', () => {
  const home = trendHome(tmpDir(), { fired: [{ name: 'orb', direction: 'long', confluence: { with: [], against: ['cisd_ote'] } }, { name: 'cisd_ote', direction: 'short', confluence: { with: [], against: ['orb'] } }] });
  const check = extra => checkTrigger(home, { root: 'MNQ', side: 'buy', strategy: 'orb', now, ...extra });
  assert.match(check(), /conflicts with cisd_ote firing the other side on the same bar: stand aside/);
  assert.strictEqual(checkTrigger(home, { root: 'MNQ', side: 'sell', strategy: 'cisd_ote', style: 'reversal', now }), null, 'a reversal may fade it');
  const alone = trendHome(tmpDir(), { fired: [{ name: 'orb', direction: 'long', confluence: { with: [], against: [] } }] });
  assert.match(checkTrigger(alone, { root: 'MNQ', side: 'buy', strategy: 'orb', now, minConfluence: 2 }), /fired alone \(1 of the 2 agreeing strategies/);
  assert.strictEqual(checkTrigger(alone, { root: 'MNQ', side: 'buy', strategy: 'orb', now }), null);
});

test('sameBar: bar times are compared as instants, whatever their text; an unreadable one is no bar', () => {
  assert.strictEqual(sameBar('2026-10-07T13:57:00Z', '2026-10-07T13:57:00.000Z'), true);
  assert.strictEqual(sameBar('2026-10-07T13:57:00Z', '2026-10-07T09:57:00-04:00'), true, 'the same instant in another offset');
  assert.strictEqual(sameBar('2026-10-07T13:57:00Z', '2026-10-07T13:54:00Z'), false);
  for (const bad of [undefined, null, '', '  ', 'not a time', 1791380220000, {}]) {
    assert.strictEqual(sameBar(bad, bad), false, `${JSON.stringify(bad)} names no bar`);
    assert.ok(Number.isNaN(barMs(bad)));
  }
});

test('recordTimeframe: a strategy timeframe as the record names it (minutes)', () => {
  assert.strictEqual(recordTimeframe('3m'), '3m');
  assert.strictEqual(recordTimeframe('1h'), '60m', 'the runner names a 1h record by its minutes');
  for (const bad of [undefined, '', '0m', '3 m', '1d', '../x']) assert.strictEqual(recordTimeframe(bad), null, bad);
});

test('lastRecordedBar: the last recorded bar of the family and timeframe; fails closed on a missing or unreadable record', () => {
  const home = tmpDir();
  assert.match(lastRecordedBar(home, 'MNQ', '3m').error, /no 3m signal record for MNQ, so the bar the setup is on is unknown/);
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:54:00.000Z' }, stepMs: 180000, now }));
  assert.deepStrictEqual(lastRecordedBar(home, 'NQ', '3m'), { bar: '2026-10-07T13:54:00.000Z', timeframe: '3m' }, 'the mini reads the family record');
  assert.match(lastRecordedBar(home, 'MNQ', '1m').error, /no 1m signal record/);
  assert.match(lastRecordedBar(home, 'MNQ', 'weekly').error, /timeframe \(weekly\) names no signal record/);
  writeSignals(home, buildSignals([], { symbol: 'MNQ', bar: { t: '2026-10-07T13:00:00.000Z' }, stepMs: 3600000, now }));
  assert.strictEqual(lastRecordedBar(home, 'MNQ', '1h').bar, '2026-10-07T13:00:00.000Z');
  fs.writeFileSync(signalFile(home, 'MNQ', '3m'), JSON.stringify({ symbol: 'MNQ', timeframe: '3m', asOf: 'garbage', candidates: [] }));
  assert.match(lastRecordedBar(home, 'MNQ', '3m').error, /unreadable \(no bar time\)/);
  fs.writeFileSync(signalFile(home, 'MNQ', '3m'), '{ half a file');
  assert.match(lastRecordedBar(home, 'MNQ', '3m').error, /unreadable/);
});

test('signal record setups: every fired candidate the bar briefing lists, with the trend rule the briefing gives it (index mode reads a lane\'s setups from here)', () => {
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const ROOT = path.resolve(__dirname, '..', '..');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
  const pick = l => l.map(c => ({ name: c.name, direction: c.direction, trendRule: c.trendRule }));
  // Synthetic results: each trend rule, an unknown one, a fired setup that isn't a rules strategy, one not fired.
  const synthetic = [
    { name: 'rev', candidate: true, direction: 'long', signal: 'rules', stopDistance: 10, mtf: { style: 'reversal' } },
    { name: 'with', candidate: true, direction: 'short', signal: 'rules', stopDistance: 10, mtf: { style: 'trend', shortAllowed: true } },
    { name: 'against', candidate: true, direction: 'long', signal: 'rules', stopDistance: 10, mtf: { style: 'trend', longAllowed: false } },
    { name: 'unknown', candidate: true, direction: 'long', signal: 'rules', stopDistance: 10 },
    { name: 'manual', candidate: true, direction: 'long', signal: 'manual', stopDistance: 10, mtf: { style: 'trend', longAllowed: true } },
    { name: 'quiet', candidate: false, direction: null, signal: 'rules' },
  ];
  const rec = buildSignals(synthetic, { symbol: 'NQ', bar: { t: bars.at(-1).t }, stepMs: 180000 });
  assert.deepStrictEqual(rec.setups.map(s => s.trendRule), ['reversal', 'allows', 'against', null, 'allows']);
  assert.deepStrictEqual(rec.candidates.map(c => c.name), ['rev', 'with', 'against', 'unknown'], 'the gate\'s trigger record keeps rules strategies only');
  const briefed = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, scan: synthetic });
  assert.deepStrictEqual(pick(rec.setups), pick(briefed.sections.m3.data.candidates));
});
