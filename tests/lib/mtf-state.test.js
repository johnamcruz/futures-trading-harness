'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildRecord, writeRecord, writeMtfRecord, readRecord, recordFile, checkTrend } = require('../../scripts/lib/trading/mtf-state');
const { normalizeBars } = require('../../scripts/lib/trading/indicators');
const { tmpDir, trendHome } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const NQ = path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv');
const et = (h, m = 0, day = 7) => Date.UTC(2026, 9, day, h + 4, m);

/** 3-minute bars falling in a wave, enough for a 4h downtrend. */
function falling(n = 6000) {
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const c = 20000 - 0.3 * k + 40 * Math.sin((2 * Math.PI * k) / 320);
    out.push({ t: new Date(et(9, 0, 1) + k * 180000).toISOString(), o: c, h: c + 1, l: c - 1, c, v: 10 });
  }
  return out;
}

test('buildRecord: the trend rule frames as of the last closed bar, and when that bar closed', () => {
  const bars = falling();
  const rec = buildRecord(bars, { symbol: 'mnq', source: 'x.json', now: new Date('2026-10-07T00:00:00Z') });
  assert.strictEqual(rec.symbol, 'MNQ');
  assert.strictEqual(rec.asOf, normalizeBars(bars).at(-1).t);
  assert.strictEqual(Date.parse(rec.closedAt) - Date.parse(rec.asOf), 180000, 'a 3-minute bar closes 3 minutes after it opens');
  assert.deepStrictEqual(rec.biases, { 15: -1, 60: -1, 240: -1 });
  assert.strictEqual(rec.rule.prevailing, '4h down');
  assert.match(rec.line, /trend strategies may not go long/);
});

test('writeRecord / readRecord: one file per index family, written atomically; MNQ and NQ share it', () => {
  const home = tmpDir();
  assert.strictEqual(readRecord(home, 'MNQ'), null);
  const rec = writeMtfRecord(home, 'NQ', falling());
  assert.strictEqual(recordFile(home, 'NQ'), path.join(home, 'mtf', 'MNQ.json'));
  assert.deepStrictEqual(readRecord(home, 'MNQ').biases, rec.biases);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'mtf')), ['MNQ.json'], 'no temp file left behind');
  fs.writeFileSync(recordFile(home, 'MES'), '{not json');
  assert.ok(readRecord(home, 'MES').error);
  writeRecord(home, { ...rec, symbol: 'MES' });
  assert.strictEqual(readRecord(home, 'MES').symbol, 'MES');
});

test('checkTrend: refuses a trend strategy against the prevailing trend, without a record, or on a stale one', () => {
  const now = new Date('2026-10-07T14:00:00Z');
  const fresh = '2026-10-07T13:57:00.000Z';
  const check = (home, extra = {}) => checkTrend(home, { root: 'MNQ', side: 'buy', strategy: 'orb', now, ...extra });
  const up = trendHome(tmpDir(), { closedAt: fresh });
  assert.strictEqual(check(up), null);
  assert.match(check(up, { side: 'sell' }), /setup:orb short is against the prevailing 4h up trend.*4h up, 1h up, 15m up/);
  assert.strictEqual(check(up, { side: 'sell', style: 'reversal' }), null, 'a reversal strategy may fade it');
  // The 4h is a range: the 1h decides.
  const h1 = trendHome(tmpDir(), { closedAt: fresh, biases: { 240: 0, 60: -1, 15: 1 } });
  assert.match(check(h1), /prevailing 1h down trend/);
  assert.strictEqual(check(h1, { side: 'sell' }), null);
  // Nothing trends: both sides open.
  assert.strictEqual(check(trendHome(tmpDir(), { closedAt: fresh, biases: { 240: 0, 60: 0, 15: 0 } }), { side: 'sell' }), null);
  // No 4h read yet: trend strategies wait.
  assert.match(check(trendHome(tmpDir(), { closedAt: fresh, biases: { 240: null, 60: 1, 15: 1 } })), /no 4h trend read yet/);
  // Fail closed: no record, unreadable, stale.
  assert.match(check(tmpDir()), /No multi-timeframe read for MNQ.*mtf\.js .* --record --symbol MNQ/);
  const broken = tmpDir();
  fs.mkdirSync(path.join(broken, 'mtf'));
  fs.writeFileSync(path.join(broken, 'mtf', 'MNQ.json'), 'nope');
  assert.match(check(broken), /unreadable/);
  const old = trendHome(tmpDir(), { closedAt: '2026-10-07T13:30:00.000Z' });
  assert.match(check(old), /30 min old \(limit 15, FTH_MTF_MAX_AGE_MIN\)/);
  assert.strictEqual(check(old, { maxAgeMin: 45 }), null);
  assert.match(check(trendHome(tmpDir(), { closedAt: '2026-10-07T15:00:00.000Z' })), /after now; it can't be trusted/);
  // A reversal strategy needs no record at all.
  assert.strictEqual(check(tmpDir(), { style: 'reversal' }), null);
});

test('scripts/mtf.js --record writes the record the gate reads, and refuses in autonomous runs', () => {
  const home = tmpDir();
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mtf.js'), NQ, ...args], { encoding: 'utf8', env: { ...process.env, FTH_HOME: home, FTH_AUTONOMOUS: '', ...env } });
  const ok = run(['--record', '--symbol', 'MNQ']);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /recorded for the order gate/);
  assert.match(ok.stdout, /^Trend rule: /m);
  assert.strictEqual(readRecord(home, 'MNQ').source, NQ);
  assert.strictEqual(run(['--record', '--symbol=NQ']).status, 0, 'the = form works too');
  const noSym = run(['--record']);
  assert.strictEqual(noSym.status, 1);
  assert.match(noSym.stderr, /needs --symbol/);
  const auto = run(['--record', '--symbol', 'MNQ'], { FTH_AUTONOMOUS: '1' });
  assert.strictEqual(auto.status, 1);
  assert.match(auto.stderr, /the autonomous runner records the read itself/);
});
