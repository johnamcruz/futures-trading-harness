'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { snapshot } = require('../../scripts/lib/trading/market-snapshot');

// 3-min bars: a flat overnight, then an RTH opening range and an upside breakout.
function session() {
  const bars = [];
  let t = Date.UTC(2026, 9, 6, 22, 0); // 18:00 ET
  const push = (o, h, l, c, v = 100) => { bars.push({ t: new Date(t).toISOString(), o, h, l, c, v }); t += 180000; };
  while (t < Date.UTC(2026, 9, 7, 13, 30)) push(100, 100.5, 99.5, 100);
  for (let i = 0; i < 5; i += 1) push(100, 101, 99, 100); // OR 09:30-09:45 ET: 99..101
  for (let i = 0; i < 20; i += 1) push(100 + i * 0.1, 100.4 + i * 0.1, 99.8 + i * 0.1, 100.2 + i * 0.1);
  return bars;
}

test('snapshot reports trend, levels, and the reference stop', () => {
  const s = snapshot({ bars: session() });
  assert.strictEqual(s.levels.openingRange.high, 101);
  assert.strictEqual(s.levels.openingRange.low, 99);
  assert.deepStrictEqual(s.levels.overnight, { high: 100.5, low: 99.5 });
  assert.ok(s.levels.vwapRth > 99 && s.levels.vwapRth < 103);
  assert.ok(s.referenceStop.distance > 0);
  assert.strictEqual(s.signals, undefined, 'triggers come from the strategies\' rules, not the snapshot');
});

test('snapshot rejects too few bars', () => {
  assert.throws(() => snapshot([]), /at least 3 bars/);
});

test('CLI reads a file and validates parameters', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fth-')), 'bars.json');
  fs.writeFileSync(file, JSON.stringify({ bars: session() }));
  const cli = path.resolve(__dirname, '..', '..', 'scripts', 'market-snapshot.js');
  const ok = spawnSync(process.execPath, [cli, file, '--orbMinutes=30'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).params.orbMinutes, 30);
  const bad = spawnSync(process.execPath, [cli, file, '--nope=1'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /unknown parameter/);
});

test('snapshot: participation, VWAP crosses and distance, swings, equal highs, open FVGs; flags in either form', () => {
  const { snapshot } = require('../../scripts/lib/trading/market-snapshot');
  const t0 = Date.parse('2025-03-10T13:30:00Z'); // 09:30 ET
  // A bar before the open, so today's RTH VWAP is a whole session.
  const rows = [{ t: new Date(t0 - 180000).toISOString(), o: 100, h: 100.5, l: 99.5, c: 100, v: 50 }];
  for (let k = 0; k < 60; k += 1) {
    const c = 100 + (k % 10 < 5 ? k % 10 : 10 - (k % 10)); // a zigzag: swing highs at 105, equal
    rows.push({ t: new Date(t0 + k * 180000).toISOString(), o: c, h: c + 0.5, l: c - 0.5, c, v: k < 5 ? 100 : 50 });
  }
  // A bullish gap 3 bars from the end that nothing has filled.
  rows.push({ t: new Date(t0 + 60 * 180000).toISOString(), o: 101, h: 101.5, l: 100.5, c: 101, v: 200 });
  rows.push({ t: new Date(t0 + 61 * 180000).toISOString(), o: 103, h: 104, l: 102.5, c: 104, v: 200 });
  rows.push({ t: new Date(t0 + 62 * 180000).toISOString(), o: 104, h: 105, l: 103.5, c: 105, v: 200 });
  const s = snapshot(rows);
  assert.strictEqual(s.participation.relVolLastVsOpeningRange, 2, 'opening range bars averaged 100');
  assert.strictEqual(s.participation.relVolLast3VsPrior20, 4);
  assert.strictEqual(s.vwap.applies, 'rth');
  assert.ok(s.vwap.rthCrossesLast30 > 0);
  assert.ok(s.liquidity.swingHighs.length > 0 && s.liquidity.equalHighs.length > 0);
  assert.deepStrictEqual(s.liquidity.openFvgs.at(-1), { side: 'bullish', low: 101.5, high: 103.5, at: rows[62].t });
  const path = require('path');
  const { spawnSync } = require('child_process');
  const csv = path.resolve(__dirname, '..', 'fixtures', 'parity', 'NQ-3m.csv');
  const cli = args => spawnSync(process.execPath, [path.resolve(__dirname, '..', '..', 'scripts', 'market-snapshot.js'), csv, ...args], { encoding: 'utf8' });
  assert.strictEqual(JSON.parse(cli(['--orbMinutes', '30']).stdout).params.orbMinutes, 30);
  assert.strictEqual(JSON.parse(cli(['--orbMinutes=20']).stdout).params.orbMinutes, 20);
  assert.match(cli(['--bogus', '1']).stderr, /unknown parameter --bogus/);
  // The volume profile block, on the real bars: prior RTH day, session, rolling.
  const vpBlock = JSON.parse(cli([]).stdout).volumeProfile;
  for (const k of ['priorRth', 'session', 'rolling']) {
    const x = vpBlock[k];
    assert.ok(x && x.val < x.poc && x.poc < x.vah, `${k}: ${JSON.stringify(x)}`);
    assert.ok(['above value', 'inside value', 'below value'].includes(x.price));
  }
  assert.strictEqual(vpBlock.rolling.bars, 360);
  assert.match(vpBlock.note, /bar-based approximation/);
});

test('snapshot levels: a day or overnight session the data starts partway into gives no levels', () => {
  const { levels } = require('../../scripts/lib/trading/market-snapshot');
  const at = iso => ({ t: iso, o: 100, h: 101, l: 99, c: 100, v: 1 });
  // Data starting at 12:00 ET on Tuesday: Tuesday's RTH is partial, the overnight too.
  const bars = ['2026-10-06T16:00:00Z', '2026-10-06T19:00:00Z', '2026-10-06T22:30:00Z', '2026-10-07T12:00:00Z'].map(at);
  bars[1].h = 150;
  const l = levels(bars);
  assert.strictEqual(l.priorRth, null, 'Tuesday began at noon in the data: not a whole day');
  assert.deepStrictEqual(l.overnight, { high: 101, low: 99 }, 'the overnight session from 18:00 Tue is whole');
  const late = levels(['2026-10-06T23:00:00Z', '2026-10-07T12:00:00Z'].map(at));
  assert.strictEqual(late.overnight, null, 'data starting after 18:00 ET: the overnight is partial');
});

test('participation counts by trading day: the evening (from the 18:00 ET open) has no opening range; midday and the close use the day\'s own', () => {
  // Sunday 18:00 ET to 21:27 (volume 50), Monday's RTH (opening range volume 200, then 100), Monday 18:00 to 21:27 (100).
  const bars = [];
  const add = (from, to, v) => { for (let t = from; t < to; t += 180000) bars.push({ t: new Date(t).toISOString(), o: 100, h: 100.5, l: 99.5, c: 100, v }); };
  const et = (d, h, m) => Date.UTC(2026, 9, d, h + 4, m); // October: ET = UTC-4
  add(et(11, 18, 0), et(11, 21, 30), 50);
  add(et(12, 9, 30), et(12, 9, 45), 200);
  add(et(12, 9, 45), et(12, 16, 0), 100);
  add(et(12, 18, 0), et(12, 21, 30), 100);
  const evening = snapshot({ bars }).participation;
  assert.strictEqual(evening.relVolLastVsOpeningRange, null, 'Tuesday\'s trading day: its range hasn\'t opened');
  assert.strictEqual(evening.relVolLast3VsOpeningRange, null);
  // Same minute a day earlier (the same bar whether days split at 18:00 or midnight): 21:27 ET Monday vs Sunday, 100 / 50.
  assert.strictEqual(evening.relVolVsSameTimePriorDay, 2);
  const midday = snapshot({ bars: bars.filter(b => Date.parse(b.t) <= et(12, 10, 0)) }).participation;
  assert.strictEqual(midday.relVolLastVsOpeningRange, 0.5, 'Monday\'s own range (100 / 200)');
  const breakTime = snapshot({ bars: bars.filter(b => Date.parse(b.t) < et(12, 16, 0)) }).participation;
  assert.strictEqual(breakTime.relVolLastVsOpeningRange, 0.5, 'still Monday\'s range at the close');
});
