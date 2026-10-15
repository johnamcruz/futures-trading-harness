'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../../scripts/lib/config-files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-config-'));
const SPEC = { name: 'demo', validate: v => (Number.isInteger(v.n) ? [] : ['n: a whole number']), tightenOnly: { n: 'down', 'g.on': 'true', floor: 'up' } };

test('canonical hash: key order and whitespace are the same file; a changed value is another', () => {
  assert.strictEqual(C.hashOf({ a: 1, b: [1, { c: 2, d: 3 }] }), C.hashOf({ b: [1, { d: 3, c: 2 }], a: 1 }));
  assert.notStrictEqual(C.hashOf({ a: 1 }), C.hashOf({ a: 2 }));
  assert.notStrictEqual(C.hashOf([1, 2]), C.hashOf([2, 1]), 'list order is meaningful');
  assert.strictEqual(C.canonicalJson({ b: 1, a: 'x' }), '{"a":"x","b":1}');
});

test('loadConfigFile: a valid file loads frozen with its hash; missing, unreadable, non-JSON, non-object or refused files fail closed', () => {
  const dir = tmp();
  const f = path.join(dir, 'demo.json');
  fs.writeFileSync(f, '{ "n": 3,\n "g": { "on": true } }');
  const loaded = C.loadConfigFile(SPEC, { file: f });
  assert.strictEqual(loaded.value.n, 3);
  assert.ok(Object.isFrozen(loaded.value) && Object.isFrozen(loaded.value.g));
  assert.strictEqual(loaded.hash, C.hashOf({ g: { on: true }, n: 3 }));
  assert.deepStrictEqual(C.fingerprintOf(loaded), { name: 'demo', version: null, hash: loaded.hash });
  assert.throws(() => C.loadConfigFile(SPEC, { file: path.join(dir, 'none.json') }), /demo config .* refused: it can't be read \(ENOENT\)/);
  fs.writeFileSync(f, '{ "n": ');
  assert.throws(() => C.loadConfigFile(SPEC, { file: f }), /refused: not JSON/);
  fs.writeFileSync(f, '[1]');
  assert.throws(() => C.loadConfigFile(SPEC, { file: f }), /refused: not a JSON object/);
  fs.writeFileSync(f, '{ "n": 1.5 }');
  assert.throws(() => C.loadConfigFile(SPEC, { file: f }), /refused: n: a whole number/);
  const throwing = { name: 'demo', validate: () => { throw new Error('boom'); } };
  fs.writeFileSync(f, '{}');
  assert.throws(() => C.loadConfigFile(throwing, { file: f }), /refused: boom/);
  assert.throws(() => C.loadConfigFile({ name: 'demo', validate: () => 'no' }, { file: f }), /returned no list of errors/);
  assert.throws(() => C.loadConfigFile({ name: 'Bad Name', validate: () => [] }, { file: f }), /a config spec/);
  assert.throws(() => C.loadConfigFile({ name: 'demo', validate: () => [], tightenOnly: { x: 'sideways' } }, { file: f }), /tighten-only x is sideways/);
  // The default file is config/<name>.json in the repository.
  assert.throws(() => C.loadConfigFile({ name: 'no-such-area', validate: () => [] }), new RegExp(`${path.join(C.CONFIG_DIR, 'no-such-area.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('loosened: a tighten-only key past its pinned value, missing, not a number, or unpinned is refused', () => {
  const pins = { n: 3, 'g.on': true, floor: 10 };
  assert.deepStrictEqual(C.loosened(SPEC, pins, { n: 3, g: { on: true }, floor: 10 }), []);
  assert.deepStrictEqual(C.loosened(SPEC, pins, { n: 1, g: { on: true }, floor: 12 }), [], 'tighter is fine');
  assert.match(C.loosened(SPEC, pins, { n: 4, g: { on: true }, floor: 10 }).join(), /n is 4, above its pinned 3/);
  assert.match(C.loosened(SPEC, pins, { n: 3, g: { on: false }, floor: 10 }).join(), /g.on is false; it is a guard that stays true/);
  assert.match(C.loosened(SPEC, pins, { n: 3, g: { on: true }, floor: 9 }).join(), /floor is 9, under its pinned 10/);
  assert.match(C.loosened(SPEC, pins, { g: { on: true }, floor: 10 }).join(), /n is undefined, not a number/);
  assert.match(C.loosened(SPEC, { n: 3, 'g.on': true }, { n: 3, g: { on: true }, floor: 10 }).join(), /floor has no pinned value/);
  assert.match(C.loosened(SPEC, { ...pins, gone: 1 }, { n: 3, g: { on: true }, floor: 10 }).join(), /gone is pinned but no longer tighten-only/);
  assert.strictEqual(C.valueAt({ a: { b: 2 } }, 'a.b'), 2);
  assert.strictEqual(C.valueAt({ a: 1 }, 'a.b'), undefined);
});
