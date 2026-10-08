'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { addWindow, run } = require('../../scripts/blackouts');
const { tmpDir } = require('../helpers');

const NOW = new Date('2026-10-14T10:00:00Z');

test('addWindow appends, dedupes, prunes old windows, and validates', () => {
  const old = { start: '2026-10-12T12:00:00Z', end: '2026-10-12T12:30:00Z', reason: 'old' };
  const list = addWindow([old], { start: '2026-10-14T12:20:00Z', end: '2026-10-14T12:40:00Z', reason: 'CPI' }, NOW);
  assert.deepStrictEqual(list.map(b => b.reason), ['CPI']);
  assert.strictEqual(addWindow(list, { start: '2026-10-14T12:20:00Z', end: '2026-10-14T12:40:00Z' }, NOW).length, 1);
  assert.throws(() => addWindow([], { start: 'x', end: 'y' }, NOW), /ISO/);
  assert.throws(() => addWindow([], { start: '2026-10-14T01:00:00Z', end: '2026-10-14T20:00:00Z' }, NOW), /12 hours/);
  assert.throws(() => addWindow([], { start: '2026-10-13T01:00:00Z', end: '2026-10-13T02:00:00Z' }, NOW), /already ended/);
});

test('CLI add and list write the gate file atomically', () => {
  const dir = tmpDir();
  const env = { FTH_BLACKOUTS_FILE: path.join(dir, 'b', 'blackouts.json') };
  assert.strictEqual(run(['add', '--start', '2026-10-14T12:20:00Z', '--end', '2026-10-14T12:40:00Z', '--reason', 'CPI'], { env, now: NOW, out: () => {} }), 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(env.FTH_BLACKOUTS_FILE, 'utf8'))[0].reason, 'CPI');
  let out = '';
  run(['list'], { env, out: s => { out += s; } });
  assert.match(out, /CPI/);
  assert.throws(() => run(['remove'], { env }), /usage/);
});
