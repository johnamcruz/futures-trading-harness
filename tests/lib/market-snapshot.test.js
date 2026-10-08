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
