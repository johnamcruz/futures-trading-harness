'use strict';

// The harness tools' schema checker (scripts/lib/harness-tools/validate.js): the subset the
// registry's schemas use, enforced; anything it can't enforce throws instead of passing.

const test = require('node:test');
const assert = require('node:assert');
const { validate } = require('../../scripts/lib/harness-tools/validate');

const schema = {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string', pattern: '^[a-z]+$', minLength: 2, maxLength: 5 },
    n: { type: 'integer', minimum: 1, maximum: 10 },
    x: { type: 'number' },
    flag: { type: 'boolean' },
    tf: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 2 },
    mode: { type: 'string', enum: ['a', 'b'] },
    either: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['daily'] }], description: 'minutes or "daily"' },
    nested: { type: 'object', properties: { k: { type: 'number' } }, additionalProperties: false },
  },
};

test('validate: a fitting value has no errors', () => {
  assert.deepStrictEqual(validate(schema, { name: 'abc', n: 3, x: 1.5, flag: true, tf: [1, 2], mode: 'a', either: 'daily', nested: { k: 1 } }), []);
  assert.deepStrictEqual(validate(schema, { name: 'ab', either: 5 }), []);
});

test('validate: each rule refuses what breaks it', () => {
  const errs = v => validate(schema, v).join('; ');
  assert.match(errs({}), /name: required/);
  assert.match(errs({ name: 'abc', bogus: 1 }), /"bogus": unknown argument \(known: name, n, x/);
  assert.match(validate(schema, JSON.parse('{"name":"abc","__proto__":{"n":1}}')).join(), /"__proto__": unknown argument/);
  assert.match(validate(schema, JSON.parse('{"name":"abc","constructor":1}')).join(), /"constructor": unknown argument/);
  assert.match(errs({ name: 'ABC' }), /name: must match/);
  assert.match(errs({ name: 'a' }), /at least 2 characters/);
  assert.match(errs({ name: 'abcdef' }), /at most 5 characters/);
  assert.match(errs({ name: 'abc', n: 1.5 }), /n: must be an integer/);
  assert.match(errs({ name: 'abc', n: '3' }), /n: must be an integer \(got string\)/);
  assert.match(errs({ name: 'abc', n: 0 }), /n: at least 1/);
  assert.match(errs({ name: 'abc', n: 11 }), /n: at most 10/);
  assert.match(errs({ name: 'abc', x: '1' }), /x: must be a number/);
  assert.match(errs({ name: 'abc', flag: 'true' }), /flag: must be a boolean/);
  assert.match(errs({ name: 'abc', tf: [] }), /tf: at least 1 items/);
  assert.match(errs({ name: 'abc', tf: [1, 2, 3] }), /tf: at most 2 items/);
  assert.match(errs({ name: 'abc', tf: [0] }), /tf\[0\]: at least 1/);
  assert.match(errs({ name: 'abc', tf: 'x' }), /tf: must be an array/);
  assert.match(errs({ name: 'abc', mode: 'c' }), /mode: must be one of "a", "b"/);
  assert.match(errs({ name: 'abc', either: 'weekly' }), /either: minutes or "daily"/);
  assert.match(errs({ name: 'abc', nested: { j: 1 } }), /"nested.j": unknown argument/);
  assert.match(errs({ name: 'abc', nested: [] }), /nested: must be an object \(got array\)/);
  assert.match(validate(schema, null).join(), /arguments: must be an object \(got null\)/);
  assert.match(validate(schema, []).join(), /must be an object \(got array\)/);
  assert.match(validate({ type: 'object', properties: {}, additionalProperties: false }, { a: 1 }).join(), /this tool takes none/);
});

test('validate: a long value is clipped in the message, and an unsupported keyword throws', () => {
  const msg = validate(schema, { name: 'x'.repeat(5000) }).join();
  assert.ok(msg.length < 300, msg);
  assert.throws(() => validate({ type: 'string', format: 'date-time' }, 'x'), /unsupported schema keyword format/);
  assert.throws(() => validate({ type: 'null' }, null), /unsupported type null/);
});
