'use strict';

// The recognition test's frozen definitions and case list (scripts/lib/learning/recognition/config.js): config/
// recognition.json and config/recognition-cases.json, the list refused unless its bytes hash to the frozen sha256.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const RC = require('../../scripts/lib/learning/recognition/config');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFS = path.join(ROOT, 'config', 'recognition.json');
const CASES = path.join(ROOT, 'config', 'recognition-cases.json');
const sha = text => crypto.createHash('sha256').update(text).digest('hex');

test('the committed list: 5 trend legs and 5 chop days, frozen by sha256, margins 5 and 10, pace by the census span', () => {
  const r = RC.load();
  assert.strictEqual(r.casesSha256, sha(fs.readFileSync(CASES)));
  assert.strictEqual(r.casesSha256, 'b0278dd07ee8937964f5e2a1b6b1fd6aa21a2aead850886da39597d7d43a2959');
  assert.strictEqual(r.cases.length, 10);
  assert.strictEqual(r.cases.filter(c => c.kind === 'trend').length, 5);
  assert.strictEqual(r.cases.filter(c => c.kind === 'chop').length, 5);
  assert.ok(r.cases.every(c => c.margin === (c.kind === 'trend' ? 5 : 10)));
  assert.deepStrictEqual(r.cases.filter(c => c.pace === 'sharp').map(c => c.day), ['2021-09-01', '2022-05-23']);
  assert.strictEqual(r.fingerprint.version, '1');
  assert.ok(r.cases.every(c => typeof c.id === 'string' && c.id.startsWith(c.day)));
});

/** A copy of the definitions and the list in a temp dir, the list edited by `edit` (its sha re-pinned unless keepSha). */
function copy(edit, { keepSha = false, defsEdit = d => d } = {}) {
  const dir = tmpDir();
  const body = edit(fs.readFileSync(CASES, 'utf8'));
  fs.writeFileSync(path.join(dir, 'recognition-cases.json'), body);
  const defs = JSON.parse(fs.readFileSync(DEFS, 'utf8'));
  if (!keepSha) defs.casesSha256 = sha(body);
  fs.writeFileSync(path.join(dir, 'recognition.json'), JSON.stringify(defsEdit(defs)));
  return path.join(dir, 'recognition.json');
}

test('a changed byte in the list is refused (sha mismatch): the list is frozen before any run', () => {
  const f = copy(t => t.replace('"margin": 5', '"margin": 5 '), { keepSha: true });
  assert.throws(() => RC.load({ file: f }), /CRITICAL config error.*sha256/);
});

test('every case is checked against the frozen definitions: margin by kind, pace by span, sides, times', () => {
  assert.throws(() => RC.load({ file: copy(t => t.replace('"margin": 5', '"margin": 6')) }), /margin 6, not the trend margin 5/);
  assert.throws(() => RC.load({ file: copy(t => t.replace('"pace": "slow"', '"pace": "sharp"')) }), /pace sharp/);
  assert.throws(() => RC.load({ file: copy(t => t.replace('"side": "long"', '"side": "up"')) }), /side/);
  assert.throws(() => RC.load({ file: copy(t => t.replace('"start": "2021-06-11T13:30:00.000Z"', '"start": "soon"')) }), /start/);
  assert.throws(() => RC.load({ file: copy(t => t.replace('"kind": "chop"', '"kind": "range"')) }), /kind/);
  assert.throws(() => RC.load({ file: copy(t => t, { defsEdit: d => ({ ...d, margins: { trend: 5 } }) }) }), /margins/);
  assert.throws(() => RC.load({ file: copy(t => t, { defsEdit: d => ({ ...d, extra: 1 }) }) }), /extra/);
});

test('another list is taken only with its own sha256 stated', () => {
  const f = copy(t => t);
  const other = path.join(path.dirname(f), 'recognition-cases.json');
  assert.throws(() => RC.load({ casesFile: other }), /sha256/);
  assert.throws(() => RC.load({ casesFile: other, casesSha: 'ab'.repeat(32) }), /sha256/);
  assert.strictEqual(RC.load({ casesFile: other, casesSha: sha(fs.readFileSync(other)) }).cases.length, 10);
});

test('startCloseOf: rel 0 is the first candle whose close is the setup start + one bar (trend: the census start; chop: the window open)', () => {
  const { cases, definitions } = RC.load();
  const trend = cases.find(c => c.day === '2022-03-07');
  assert.strictEqual(new Date(RC.startCloseOf(trend, 3, definitions)).toISOString(), '2022-03-07T16:21:00.000Z');
  const summer = cases.find(c => c.day === '2021-08-03');
  assert.strictEqual(new Date(RC.startCloseOf(summer, 3, definitions)).toISOString(), '2021-08-03T13:33:00.000Z');
  const winter = cases.find(c => c.day === '2021-12-01');
  assert.strictEqual(new Date(RC.startCloseOf(winter, 3, definitions)).toISOString(), '2021-12-01T14:33:00.000Z');
  assert.strictEqual(RC.endCloseOf(trend, 3), Date.parse('2022-03-07T16:42:00.000Z'));
  assert.strictEqual(RC.endCloseOf(summer, 3), null);
});
