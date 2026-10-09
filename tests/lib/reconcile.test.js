'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { reconcile, toText } = require('../../scripts/lib/trading/reconcile');
const { tmpDir, writeJournal } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const bar = t => ({ t, c: 1 });
const scans = [
  { symbol: 'MNQ', bar: bar('2026-10-07T14:00:00.000Z'), results: [{ name: 'orb', candidate: true, direction: 'long' }, { name: 'bos', candidate: false, direction: 'short' }] },
  { symbol: 'MNQ', bar: bar('2026-10-07T15:00:00.000Z'), results: [{ name: 'ema_cross', candidate: true, direction: 'short' }] },
];
const placed = (ts, text, ok = true) => ({ ts, kind: 'order_placed', contractId: 'CON.F.US.MNQ.Z26', text, data: { result: { success: ok } } });
const journal = [
  placed('2026-10-07T14:04:30.000Z', 'setup:orb long, stop 21480'), // 90 s after the 14:03 close
  { ts: '2026-10-07T15:04:00.000Z', kind: 'note', text: 'ema_cross short passed: relative volume 0.8x (skip rule)' },
  placed('2026-10-07T16:00:00.000Z', 'setup:vwap_reclaim long, stop 21490'), // no scan signal
  placed('2026-10-07T16:10:00.000Z', '[exit] trail'),
  placed('2026-10-07T16:20:00.000Z', 'setup:orb long, stop 1', false),
];

test('reconcile: taken signals with latency, passed ones with the note that says why, and entries without a signal', () => {
  const r = reconcile(scans, journal, { timeframeMin: 3 });
  assert.deepStrictEqual([r.signals, r.taken, r.passed, r.takeRate], [2, 1, 1, 0.5]);
  assert.deepStrictEqual(r.latencySec, { median: 90, max: 90 });
  assert.strictEqual(r.passedSignals[0].name, 'ema_cross');
  assert.match(r.passedSignals[0].note, /relative volume 0.8x/);
  assert.deepStrictEqual(r.offScanEntries.map(e => e.setup), ['vwap_reclaim'], 'exits and failed orders are not entries');
  assert.deepStrictEqual(r.byStrategy, { orb: { signals: 1, taken: 1 }, ema_cross: { signals: 1, taken: 0 } });
  // An entry long after the signal is not taking it.
  const late = reconcile(scans, [placed('2026-10-07T14:30:00.000Z', 'setup:orb long, stop 1')], { timeframeMin: 3 });
  assert.deepStrictEqual([late.taken, late.offScanEntries.length], [0, 1]);
  assert.match(toText(r, '2026-10-07'), /2 signal\(s\) from the scan, 1 taken \(50%\), 1 passed; 1 entry without a scan signal/);
});

test('scripts/reconcile.js reads the day\'s decision log and journal', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'logs', 'scans-2026-10-07.jsonl'), scans.map(s => JSON.stringify(s)).join('\n') + '\n');
  const env = { ...process.env, FTH_HOME: home, PROJECTX_JOURNAL_PATH: writeJournal(home, journal) };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reconcile.js'), '--day', '2026-10-07'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 taken \(50%\)/);
  const none = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'reconcile.js'), '--day', '2026-10-06'], { encoding: 'utf8', env });
  assert.match(none.stderr, /no decision log for 2026-10-06/);
});
