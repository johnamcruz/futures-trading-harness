'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { instincts, digest, reviewR, confidenceFor } = require('../../scripts/lib/trading/instincts');
const { tmpDir, writeJournal } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
let t = Date.parse('2026-09-01T14:00:00Z');
const review = (result, tags, text = '') => ({ ts: new Date((t += 3600000)).toISOString(), kind: 'review', text, tags: [`result:${result}`, ...tags] });

test('instincts: setup records by regime, recurring mistakes, and lessons, with confidence from evidence', () => {
  const journal = [
    ...Array.from({ length: 6 }, (_, k) => review(k < 4 ? 'win' : 'loss', ['setup:orb', 'regime:trend-up', `r:${k < 4 ? 2 : -1}`])),
    ...Array.from({ length: 4 }, () => review('loss', ['setup:keltner', 'regime:range', 'mistake:chased-entry'], 'entered 3 bars late, R = -1.2')),
    review('win', ['setup:orb', 'regime:range', 'paper', 'r:5']),
    { ts: new Date((t += 3600000)).toISOString(), kind: 'lesson', text: 'Keltner in range: 0W/4L over 4 trades. Skip.', tags: ['setup:keltner'] },
  ];
  const list = instincts(journal);
  const orb = list.find(x => x.key === 'setup:orb regime:trend-up');
  assert.match(orb.text, /orb in trend-up: 6 trades, win 67%, E \+1R -> favour/);
  assert.strictEqual(orb.confidence, 0.55);
  const kel = list.find(x => x.key === 'setup:keltner regime:range');
  assert.match(kel.text, /4 trades, win 0%, E -1\.2R -> avoid/);
  const mistake = list.find(x => x.kind === 'mistake');
  assert.match(mistake.text, /mistake:chased-entry in 4 of the last 10 reviewed trades; last: entered 3 bars late/);
  assert.ok(list.some(x => x.kind === 'lesson' && x.evidence === 4));
  assert.ok(!list.some(x => /orb in range/.test(x.text)), 'paper reviews are not evidence');
  for (let k = 1; k < list.length; k += 1) assert.ok(list[k - 1].confidence >= list[k].confidence, 'strongest first');
  assert.strictEqual(digest(journal, 2).length, 2);
  assert.match(digest(journal, 1)[0], /^\(0\.\d\) /);
  assert.deepStrictEqual([reviewR({ tags: ['r:-1.11'] }), reviewR({ text: 'R = 2.5' }), reviewR({ text: 'none' })], [-1.11, 2.5, null]);
  assert.deepStrictEqual([confidenceFor(1), confidenceFor(30)], [0.3, 0.9]);
});

test('scripts/lessons.js prints the instincts from the journal', () => {
  const dir = tmpDir();
  const journal = Array.from({ length: 3 }, () => review('loss', ['setup:bos', 'regime:range', 'r:-1']));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lessons.js')], { encoding: 'utf8', env: { ...process.env, PROJECTX_JOURNAL_PATH: writeJournal(dir, journal) } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[setup\] bos in range: 3 trades, win 0%, E -1R -> avoid/);
  const empty = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'lessons.js')], { encoding: 'utf8', env: { ...process.env, PROJECTX_JOURNAL_PATH: writeJournal(tmpDir(), []) } });
  assert.match(empty.stdout, /No instincts yet/);
});

test('the trade prompt carries the top instincts as notes, not rules', () => {
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const p = prompts(validateConfig({ harness: 'qwen', eodAt: '15:50@America/New_York' }), new Date(), '/r')
    .trade([{ symbol: 'MNQ' }], { lessons: ['(0.6) orb in trend-up: 7 trades -> favour'] });
  assert.match(p, /Instincts from your reviewed trades \(confidence; notes from your own past, not rules\): \(0\.6\) orb in trend-up: 7 trades -> favour\./);
});
