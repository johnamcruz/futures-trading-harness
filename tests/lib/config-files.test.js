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

test('loosened: an exact key may not change at all (numbers, lists and objects, whole)', () => {
  const spec = { name: 'demo', validate: () => [], tightenOnly: { t: 'exact', w: 'exact' } };
  const pins = { t: 30000, w: ['a', { b: 1 }] };
  assert.deepStrictEqual(C.loosened(spec, pins, { t: 30000, w: ['a', { b: 1 }] }), []);
  assert.match(C.loosened(spec, pins, { t: 29999, w: ['a', { b: 1 }] }).join(), /t is 29999, not its pinned 30000; it is pinned exactly/);
  assert.match(C.loosened(spec, pins, { t: 30000, w: ['a', { b: 2 }] }).join(), /w is .* pinned exactly/);
  assert.match(C.loosened(spec, pins, { t: 30000 }).join(), /w is undefined/);
  assert.ok(C.DIRECTIONS.includes('exact'));
});

test('shapeErrors: every key present, none unknown, each leaf its type and range; lists and records checked item by item', () => {
  const { num, bool, str, list, record, custom } = C.shapes;
  const shape = { n: num({ min: 1, max: 5, int: true }), f: num(), b: bool(), s: str(['x', 'y']), l: list(num(), { min: 1, max: 2 }), r: record(bool()), o: { k: str() }, c: custom(v => (v === 'ok' ? null : 'ok')) };
  const good = { n: 3, f: -0.5, b: false, s: 'x', l: [1], r: { a: true }, o: { k: 'v' }, c: 'ok' };
  assert.deepStrictEqual(C.shapeErrors(shape, good), []);
  const errs = C.shapeErrors(shape, { n: 3.5, f: 'x', b: 1, s: 'z', l: [], r: { a: 1 }, o: { k: '', extra: 1 }, c: 'no', more: 1 });
  for (const re of [/n: a whole number/, /f: a number/, /b: true or false/, /s: one of x, y/, /l: a list of 1 to 2/, /r\.a: true or false/, /o\.k: a string/, /o\.extra: not a known key/, /c: ok/, /more: not a known key/]) assert.ok(errs.some(e => re.test(e)), `${re} in ${errs.join('; ')}`);
  assert.match(C.shapeErrors(shape, { ...good, n: 9 }).join(), /n: a whole number from 1 to 5, not 9/);
  assert.match(C.shapeErrors(shape, { ...good, l: [1, 'x'] }).join(), /l\[1\]: a number/);
  const { o: _o, ...noO } = good;
  assert.match(C.shapeErrors(shape, noO).join(), /o: missing \(expected an object with k\)/);
  const { n: _n, ...noN } = good;
  assert.match(C.shapeErrors(shape, noN).join(), /n: missing \(expected a whole number from 1 to 5\)/);
  assert.match(C.shapeErrors(shape, { ...good, more: 1 }).join(), /more: not a known key \(expected only n, f, b, s, l, r, o, c\)/);
  assert.match(C.shapeErrors({ p: num({ min: Number.MIN_VALUE }) }, {}).join(), /p: missing \(expected a number above 0\)/);
  assert.match(C.shapeErrors(shape, { ...good, o: 'x' }).join(), /o: an object with k/);
  assert.match(C.shapeErrors(shape, { ...good, f: Infinity }).join(), /f: a number/);
  assert.throws(() => C.shapeErrors(5, 1), /a shape is a leaf builder or an object of shapes/);
});

test('a refused file is a CRITICAL config error: the file, every problem at once (key path, what is wrong, what is expected)', () => {
  const dir = tmp();
  const f = path.join(dir, 'demo.json');
  const { num, str } = C.shapes;
  const spec = { name: 'demo', validate: v => C.shapeErrors({ a: num({ min: 1, max: 5, int: true }), b: { c: str(['x', 'y']) }, d: num() }, v) };
  fs.writeFileSync(f, JSON.stringify({ a: 'two', b: { c: 'z' }, e: 1 }));
  let err;
  try { C.loadConfigFile(spec, { file: f }); } catch (e) { err = e; }
  assert.ok(err instanceof C.CriticalConfigError);
  assert.strictEqual(err.code, 'FTH_CONFIG_CRITICAL');
  assert.match(err.message, /^CRITICAL config error: the demo config \(.*demo\.json\) is refused: /);
  for (const re of [/a: a whole number from 1 to 5, not "two"/, /b\.c: one of x, y, not "z"/, /d: missing \(expected a number\)/, /e: not a known key \(expected only a, b, d\)/]) assert.match(err.message, re);
  assert.deepStrictEqual(err.refusals.map(r => [r.name, r.file, r.problems.length]), [['demo', f, 4]]);
  // Several files as one error: each file once, every problem, and the note.
  const other = new C.CriticalConfigError([{ name: 'other', file: '/x/other.json', problems: ['k: missing (expected a string)'] }]);
  const both = C.CriticalConfigError.of([err, other, err], 'Exits still go.');
  assert.match(both.message, /^CRITICAL config error \(5 problems in 2 files\):\nthe demo config .*\nthe other config \(\/x\/other\.json\) is refused: k: missing \(expected a string\); .*\nExits still go\.$/);
  assert.strictEqual(both.refusals.length, 2);
});
