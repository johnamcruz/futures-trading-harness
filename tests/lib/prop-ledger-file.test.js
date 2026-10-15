'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readLedger, appendLook, withLedgerLock } = require('../../scripts/lib/prop/ledger-file');
const { parseLedger, formatLedger, checkLook } = require('../../scripts/lib/prop/looks');
const { checkWindow } = require('../../scripts/lib/prop/evaluator');
const { takeLook } = require('../../scripts/lib/replay/scorecard');
const { tmpDir } = require('../helpers');

const look = (candidate, from = '2026-11-02', to = '2026-11-03') => ({ candidate, purpose: 'judging', ranges: [{ from, to }], at: '2026-12-01T00:00:00.000Z' });

test('ledger format: JSON lines, and the earlier JSON list still reads with every look kept', () => {
  const a = look('a');
  const b = look('b');
  assert.strictEqual(formatLedger([a, b]), `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
  assert.deepStrictEqual(parseLedger(formatLedger([a, b])), [a, b]);
  assert.deepStrictEqual(parseLedger(JSON.stringify([a, b], null, 2)), [a, b], 'the list format (pretty-printed)');
  assert.throws(() => parseLedger('', 'f'), /f is empty: .*may be truncated/);
  assert.throws(() => parseLedger(' \n\t\n', 'f'), /f is empty/);
  assert.deepStrictEqual(parseLedger('[]'), [], 'an explicit empty list is a ledger with no looks');
  assert.throws(() => parseLedger(`${JSON.stringify(a)}\nnot json\n`, 'f'), /f:2: not a JSON look/);
  assert.throws(() => parseLedger('[1]', 'f'), /entry 1 is not a look/);
  assert.throws(() => parseLedger('[{"a":1}', 'f'), /not a JSON list of looks/);
  assert.throws(() => parseLedger('[[]]\n', 'f'), /entry 1 is not a look/);
  assert.throws(() => parseLedger('"x"', 'f'), /f:1: not a JSON look/);
});

test('ledger file: a list-format file is converted on append, nothing lost; a missing file needs create', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'ledger.json');
  assert.throws(() => readLedger(file), /no ledger at .*start a new one only on purpose/);
  assert.deepStrictEqual(readLedger(file, { create: true }), [], 'only a missing file is a new, empty ledger');
  // An existing empty or whitespace-only file may be a truncated ledger: refused, even with create.
  for (const text of ['', '\n  \n']) {
    fs.writeFileSync(file, text);
    assert.throws(() => readLedger(file), /is empty: .*may be truncated/);
    assert.throws(() => readLedger(file, { create: true }), /is empty/);
  }
  fs.writeFileSync(file, JSON.stringify([look('old1'), look('old2')], null, 2));
  appendLook(file, look('new'));
  assert.deepStrictEqual(readLedger(file).map(e => e.candidate), ['old1', 'old2', 'new']);
  // The appended look records the schedule it was written under (schedule.js fingerprint); the old ones are kept as they were.
  assert.strictEqual(fs.readFileSync(file, 'utf8'), formatLedger([look('old1'), look('old2'), { ...look('new'), schedule: require('../../scripts/lib/schedule').fingerprint() }]));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['ledger.json'], 'no temporary file left');
  // A hand-edited last line without its newline is ended before the next look.
  fs.writeFileSync(file, JSON.stringify(look('x')));
  appendLook(file, look('y'));
  assert.deepStrictEqual(readLedger(file).map(e => e.candidate), ['x', 'y']);
  assert.strictEqual(withLedgerLock(file, () => 5), 5);
});

test('one budget: the scorecard\'s looks and the evaluator\'s looks at the held-out quarters count together, in either format', () => {
  const root = tmpDir();
  const run = path.join(root, 'run');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ v: 1, runId: 'h1' }));
  fs.writeFileSync(path.join(run, '2026-11-02.jsonl'), '');
  const file = path.join(root, 'ledger.json');
  // An existing scorecard ledger in the earlier list format, with one held-out look.
  fs.writeFileSync(file, JSON.stringify([look('sc0')]));
  // The scorecard takes a second, the evaluator (prop/evaluate-run.js's path) a third.
  takeLook(run, { purpose: 'judging', candidate: 'sc1', ledgerFile: file }, new Date('2026-12-01T00:00:00Z'));
  const evalLook = () => withLedgerLock(file, () => checkWindow({
    from: '2026-11-02', to: '2026-11-03', look: { candidate: 'ev1', purpose: 'judging' }, ledger: readLedger(file), logLook: e => appendLook(file, e),
  }));
  assert.ok(evalLook().look, 'the third look is allowed');
  assert.deepStrictEqual(readLedger(file).map(e => e.candidate), ['sc0', 'sc1', 'ev1']);
  // The budget of three is spent across both writers: the fourth is refused by each.
  assert.throws(() => takeLook(run, { purpose: 'judging', candidate: 'sc2', ledgerFile: file }), /budget has used its 3 looks/);
  assert.throws(evalLook, /budget has used its 3 looks/);
  assert.strictEqual(checkLook(look('z'), readLedger(file)).ok, false);
  assert.strictEqual(readLedger(file).length, 3, 'refused looks are not recorded');
});
