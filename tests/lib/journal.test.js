'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJournal, resolveJournalPath, reviewResult, contractRoot, entriesSince, DEFAULT_JOURNAL_PATH } = require('../../scripts/lib/trading/journal');
const { tmpDir, writeJournal } = require('../helpers');

test('missing journal reads as empty', () => {
  assert.deepStrictEqual(readJournal(path.join(tmpDir(), 'nope.jsonl')), []);
});

test('skips malformed lines and entries without a kind', () => {
  const file = path.join(tmpDir(), 'j.jsonl');
  fs.writeFileSync(file, '{"ts":"2026-01-01T00:00:00Z","kind":"plan","text":"a"}\nnot json\n{"ts":"x"}\n\n');
  const entries = readJournal(file);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].kind, 'plan');
});

test('tails large journals and drops the partial first line', () => {
  const dir = tmpDir();
  const entries = Array.from({ length: 200 }, (_, i) => ({ ts: '2026-01-01T00:00:00Z', kind: 'note', text: `n${i}` }));
  const file = writeJournal(dir, entries);
  const tail = readJournal(file, { maxBytes: 500 });
  assert.ok(tail.length > 0 && tail.length < 200);
  assert.strictEqual(tail[tail.length - 1].text, 'n199');
});

test('unreadable journal throws so the gate can fail closed', () => {
  const dir = tmpDir();
  assert.throws(() => readJournal(dir)); // a directory, not a file
});

test('resolveJournalPath honours PROJECTX_JOURNAL_PATH and ~', () => {
  assert.strictEqual(resolveJournalPath({}), DEFAULT_JOURNAL_PATH);
  assert.strictEqual(resolveJournalPath({ PROJECTX_JOURNAL_PATH: '~/j.jsonl' }), path.join(os.homedir(), 'j.jsonl'));
  assert.strictEqual(resolveJournalPath({ PROJECTX_JOURNAL_PATH: '/x/j.jsonl' }), '/x/j.jsonl');
});

test('reviewResult reads result tags only from reviews', () => {
  assert.strictEqual(reviewResult({ kind: 'review', tags: ['result:loss'] }), 'loss');
  assert.strictEqual(reviewResult({ kind: 'review', tags: ['Result:Win'] }), 'win');
  assert.strictEqual(reviewResult({ kind: 'review', tags: ['result:nofill'] }), null);
  assert.strictEqual(reviewResult({ kind: 'lesson', tags: ['result:loss'] }), null);
});

test('contractRoot and entriesSince', () => {
  assert.strictEqual(contractRoot('CON.F.US.MNQ.Z25'), 'MNQ');
  assert.strictEqual(contractRoot('mes'), 'MES');
  const e = [{ ts: '2026-01-01T00:00:00Z' }, { ts: '2026-01-02T00:00:00Z' }, { ts: 'bad' }];
  assert.strictEqual(entriesSince(e, new Date('2026-01-01T12:00:00Z')).length, 1);
});
