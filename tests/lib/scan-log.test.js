'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { summarizeResult, scanRecord, appendJsonl } = require('../../scripts/lib/trading/scan-log');
const { tmpDir } = require('../helpers');

const result = (extra = {}) => ({
  name: 'crt_1h', status: 'paper', inSession: true, inRegime: true, signal: 'rules', direction: null, candidate: false, filtersFailed: [],
  rules: { long: [{ rule: 'crt_dir(60) > 0', ok: false }], short: [{ rule: 'crt_dir(60) < 0', ok: false }] },
  stopDistance: null, detail: { 'crt(60)': { reason: 'no_shift', why: 'the close has not broken the extreme of the crtShiftBars bars before it' } }, ...extra,
});

test('summarizeResult keeps what decided the verdict: failed rules, filters, session, regime, stop, target, detectors', () => {
  assert.deepStrictEqual(summarizeResult(result()), {
    name: 'crt_1h', candidate: false,
    failed: { long: ['crt_dir(60) > 0'], short: ['crt_dir(60) < 0'] },
    detail: { 'crt(60)': { reason: 'no_shift', why: 'the close has not broken the extreme of the crtShiftBars bars before it' } },
  });
  const fired = summarizeResult(result({
    direction: 'long', candidate: true, inSession: false, stopDistance: 16.25, targetDistance: 53.5,
    rules: { long: [{ rule: 'crt_dir(60) > 0', ok: true }], short: [{ rule: 'atr(20) > 1', ok: false, missing: true }] }, filtersFailed: ['VWAP distance 2.1 ATR > 1.5'],
  }));
  assert.strictEqual(fired.direction, 'long');
  assert.strictEqual(fired.inSession, false);
  assert.deepStrictEqual(fired.failed, { short: ['atr(20) > 1 (no value yet)'] });
  assert.deepStrictEqual(fired.filtersFailed, ['VWAP distance 2.1 ATR > 1.5']);
  assert.deepStrictEqual([fired.stopDistance, fired.targetDistance], [16.25, 53.5]);
  // A policy strategy's verdict is kept too.
  const v = summarizeResult({ name: 'prop', candidate: false, verdict: { action: 'skip', maxSize: 0, contract: null, reason: 'the size budget is below one contract', at: 'x' } });
  assert.deepStrictEqual(v.verdict, { action: 'skip', maxSize: 0, contract: null, reason: 'the size budget is below one contract' });
});

test('scanRecord: one line per scanned bar with the runner\'s decision and the candidates', () => {
  const rec = scanRecord({
    at: new Date('2026-10-07T15:21:05Z'), symbol: 'MNQ', contractId: 'MNQ', bar: { t: '2026-10-07T15:18:00Z', c: 21486.5, h: 1 },
    results: [result({ candidate: true, direction: 'long' }), { name: 'orb', candidate: false }], decision: { run: true, reason: 'signal: crt_1h long' },
  });
  assert.strictEqual(rec.at, '2026-10-07T15:21:05.000Z');
  assert.deepStrictEqual(rec.bar, { t: '2026-10-07T15:18:00Z', c: 21486.5 });
  assert.deepStrictEqual(rec.decision, { run: true, reason: 'signal: crt_1h long' });
  assert.deepStrictEqual(rec.candidates, ['crt_1h']);
  assert.strictEqual(rec.results.length, 2);
});

test('appendJsonl appends a line and never throws', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'logs', 'scans-2026-10-07.jsonl');
  assert.strictEqual(appendJsonl(file, { a: 1 }), true);
  assert.strictEqual(appendJsonl(file, { b: 2 }), true);
  assert.deepStrictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse), [{ a: 1 }, { b: 2 }]);
  fs.writeFileSync(path.join(dir, 'blocker'), '');
  assert.strictEqual(appendJsonl(path.join(dir, 'blocker', 'x.jsonl'), { c: 3 }), false, 'a path it cannot write is reported, not thrown');
});
