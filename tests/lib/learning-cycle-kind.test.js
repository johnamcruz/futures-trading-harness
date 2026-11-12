'use strict';

// The cycle's kind and a run's replay dirs (scripts/lib/learning/cycle-kind.js): one home for the rules the read audit
// and the recognition test both read a run by. Synthetic records and folders only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const C = require('../../scripts/lib/learning/cycle-kind');

test('outcomeWord: the CYCLE RESULT word, markdown marks aside; none is empty', () => {
  assert.strictEqual(C.outcomeWord('CYCLE RESULT: managed the long'), 'managed');
  assert.strictEqual(C.outcomeWord('CYCLE RESULT: **Managed**'), 'managed');
  assert.strictEqual(C.outcomeWord('managed'), '');
  assert.strictEqual(C.outcomeWord(null), '');
});

test('kindOf: the decision record\'s when joined, else a managed result in the trade, an allowed buy or sell an entry, else a pass', () => {
  assert.deepStrictEqual(C.kindOf({ decision: { inTrade: true } }), { kind: 'in-trade', side: null });
  assert.deepStrictEqual(C.kindOf({ decision: { decision: 'in-trade' } }), { kind: 'in-trade', side: null });
  assert.deepStrictEqual(C.kindOf({ decision: { actual: { action: 'short' } }, result: 'CYCLE RESULT: managed' }), { kind: 'entry', side: 'short' }, 'the record decides');
  assert.deepStrictEqual(C.kindOf({ decision: { actual: { action: 'none' } } }), { kind: 'pass', side: null });
  assert.deepStrictEqual(C.kindOf({ decision: null, result: 'CYCLE RESULT: managed', orders: [{ gate: 'allowed', side: 'buy' }] }), { kind: 'in-trade', side: null });
  assert.deepStrictEqual(C.kindOf({ orders: [{ gate: 'allowed', side: 'buy' }] }), { kind: 'entry', side: 'long' });
  assert.deepStrictEqual(C.kindOf({ orders: [{ gate: 'allowed', side: 'sell' }] }), { kind: 'entry', side: 'short' });
  for (const o of [[{ gate: 'refused', side: 'buy' }], [{ side: 'buy' }], [{ gate: 'allowed', side: 'flat' }], null, 'x']) assert.deepStrictEqual(C.kindOf({ orders: o }), { kind: 'pass', side: null }, JSON.stringify(o));
});

test('replayDirs: a replay run dir itself, a run home\'s replay runs, or every run home\'s in a runs folder', () => {
  const home = tmpDir();
  const run = path.join(home, 'replay', 'r1');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'manifest.json'), '{}');
  fs.mkdirSync(path.join(home, 'replay', 'not-a-run'));
  assert.deepStrictEqual(C.replayDirs(run), [run]);
  assert.deepStrictEqual(C.replayDirs(home), [run]);
  const runs = tmpDir();
  const inner = path.join(runs, 'h1', 'replay', 'r1');
  fs.mkdirSync(inner, { recursive: true });
  fs.writeFileSync(path.join(inner, 'manifest.json'), '{}');
  assert.deepStrictEqual(C.replayDirs(runs), [inner]);
  assert.deepStrictEqual(C.replayDirs(tmpDir()), []);
  assert.deepStrictEqual(C.replayDirs(path.join(home, 'none')), []);
});

test('one home: the read audit and the recognition test use these very functions', () => {
  const RA = require('../../scripts/lib/learning/read-audit');
  const R = require('../../scripts/lib/learning/recognition/run');
  assert.strictEqual(RA.kindOf, C.kindOf);
  assert.strictEqual(RA.replayDirs, C.replayDirs);
  assert.strictEqual(R.kindOf, C.kindOf);
  assert.strictEqual(R.replayDirs, C.replayDirs);
});
