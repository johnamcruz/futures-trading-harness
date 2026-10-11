'use strict';

// Repairing a harness tool call's arguments before they are checked (scripts/lib/harness-tools/repair.js):
// numbers and booleans sent as strings become what the schema declares, nothing else changes, and the
// repaired value is still validated (validate.js), so nothing out of range gets through.

const test = require('node:test');
const assert = require('node:assert');
const { repair } = require('../../scripts/lib/harness-tools/repair');
const { validate } = require('../../scripts/lib/harness-tools/validate');
const { BY_NAME } = require('../../scripts/lib/harness-tools/registry');

const BARS = BY_NAME.get('bars_fetch').inputSchema;
const MTF = BY_NAME.get('mtf_read').inputSchema;
const checked = (schema, v) => validate(schema, repair(schema, v));

const schema = {
  type: 'object', additionalProperties: false,
  properties: {
    n: { type: 'integer', minimum: 1, maximum: 10 },
    x: { type: 'number' },
    flag: { type: 'boolean' },
    name: { type: 'string' },
    code: { type: 'string', pattern: '^\\d+$' },
    either: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['daily'] }] },
    numOrText: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
    list: { type: 'array', items: { type: 'integer' } },
    words: { type: 'array', items: { type: 'string' } },
    nested: { type: 'object', properties: { k: { type: 'integer' }, s: { type: 'string' } } },
  },
};

test('repair: the real failing bars_fetch call (timeframe "3") now validates, as the number 3', () => {
  const given = { symbol: 'MNQ', timeframe: '3' };
  assert.match(validate(BARS, given).join(), /timeframe: minutes per bar, 1 to 60, or "daily" \(got "3"\)/, 'refused without the repair');
  const r = repair(BARS, given);
  assert.deepStrictEqual(r, { symbol: 'MNQ', timeframe: 3 });
  assert.deepStrictEqual(validate(BARS, r), []);
  assert.deepStrictEqual(given, { symbol: 'MNQ', timeframe: '3' }, 'the input is not mutated');
  assert.deepStrictEqual(checked(BARS, { symbol: 'MNQ', timeframe: 'daily' }), [], '"daily" still accepted');
  assert.strictEqual(repair(BARS, { symbol: 'MNQ', timeframe: 'daily' }).timeframe, 'daily');
  assert.deepStrictEqual(repair(BARS, { symbol: 'MNQ', timeframe: '15', count: '100', record: 'false' }), { symbol: 'MNQ', timeframe: 15, count: 100, record: false });
});

test('repair: a repaired value out of range is still refused', () => {
  assert.match(checked(BARS, { symbol: 'MNQ', timeframe: '90' }).join(), /timeframe: minutes per bar.*\(got 90\)/);
  assert.match(checked(BARS, { symbol: 'MNQ', timeframe: '0' }).join(), /timeframe:/);
  assert.match(checked(BARS, { symbol: 'MNQ', timeframe: '-3' }).join(), /timeframe:/);
  assert.match(checked(schema, { n: '11' }).join(), /n: at most 10/);
  assert.match(checked(MTF, { bars: '/x.json', timeframes: ['15', '5000'] }).join(), /timeframes\[1\]: at most 1440/);
});

test('repair: only exact number literals become numbers; integers only where an integer is taken', () => {
  const r = v => repair(schema, v);
  assert.deepStrictEqual(r({ n: '3', x: '-2', list: ['1'] }), { n: 3, x: -2, list: [1] });
  assert.deepStrictEqual(r({ x: '1.5' }), { x: 1.5 });
  assert.deepStrictEqual(r({ n: ' 4 ' }), { n: 4 }, 'surrounding spaces are ignored');
  assert.deepStrictEqual(r({ n: '\t4\t' }), { n: 4 }, 'and tabs');
  // Only spaces and tabs: line breaks and other whitespace leave the string as sent.
  for (const odd of ['\n3', '3\n', '\r3', '\uFEFF3', '\u00A03', '3\u2003']) {
    assert.strictEqual(r({ n: odd }).n, odd, JSON.stringify(odd));
    assert.match(checked(schema, { n: odd }).join(), /n: must be an integer/, JSON.stringify(odd));
  }
  assert.deepStrictEqual(r({ x: '-0.25' }), { x: -0.25 });
  // Not a plain JSON number literal, or not an integer where one is required: left as sent, then refused.
  for (const bad of ['1.5', '1.0', 'abc', '', ' ', '0x10', '1e3', '1E3', '+3', '03', '3.', '.5', '1_000', '1,000', 'Infinity', 'NaN', '3 4', '9007199254740993', '-', '٣']) {
    assert.deepStrictEqual(r({ n: bad }), { n: bad }, JSON.stringify(bad));
    assert.match(checked(schema, { n: bad }).join(), /n: must be an integer/, JSON.stringify(bad));
  }
  for (const bad of ['1e3', '0x10', 'abc', '.5', '1.', 'Infinity', '1.5.2']) assert.strictEqual(r({ x: bad }).x, bad, JSON.stringify(bad));
  assert.match(checked(BARS, { symbol: 'MNQ', timeframe: '1.5' }).join(), /timeframe: .*\(got "1\.5"\)/, '"1.5" for an integer is refused');
  assert.match(checked(BARS, { symbol: 'MNQ', timeframe: 'abc' }).join(), /timeframe: .*\(got "abc"\)/, '"abc" refused');
});

test('repair: "true" and "false" become booleans where a boolean is taken; nothing else does', () => {
  assert.deepStrictEqual(repair(schema, { flag: 'true' }), { flag: true });
  assert.deepStrictEqual(repair(schema, { flag: 'false' }), { flag: false });
  assert.deepStrictEqual(repair(schema, { flag: ' true ' }), { flag: true }, 'surrounding spaces ignored, as for numbers');
  for (const bad of ['TRUE', 'True', 'yes', '1', '0', '', '\ntrue', 'tr ue']) {
    assert.strictEqual(repair(schema, { flag: bad }).flag, bad, JSON.stringify(bad));
    assert.match(checked(schema, { flag: bad }).join(), /flag: must be a boolean/);
  }
  assert.strictEqual(repair(schema, { n: 'true' }).n, 'true', 'no boolean where the schema takes an integer');
  assert.strictEqual(repair(schema, { flag: '1' }).flag, '1', 'no number where the schema takes a boolean');
});

test('repair: a string where the schema takes a string stays a string', () => {
  assert.deepStrictEqual(repair(schema, { name: '3', code: '42', words: ['15', 'true'], nested: { s: '7' } }), { name: '3', code: '42', words: ['15', 'true'], nested: { s: '7' } });
  assert.strictEqual(repair(schema, { numOrText: '3' }).numOrText, '3', 'a string form that takes it keeps it');
  assert.strictEqual(repair(BARS, { symbol: '3', timeframe: 3 }).symbol, '3');
  assert.strictEqual(repair(schema, { either: '5' }).either, 5, 'the string form takes only "daily", so "5" is the integer');
  // A string form that takes the value without its spaces keeps it a string (then refused by its pattern), not a number.
  const numeric = { anyOf: [{ type: 'integer' }, { type: 'string', pattern: '^\\d+$' }] };
  assert.strictEqual(repair(numeric, ' 3'), ' 3');
  assert.ok(validate(numeric, repair(numeric, ' 3')).length > 0);
  assert.strictEqual(repair(numeric, '3'), '3');
});

test('repair: array items and nested declared properties; unknown keys and other values untouched', () => {
  const r = repair(MTF, { bars: '/x.json', timeframes: ['15', '60', 240], json: 'true' });
  assert.deepStrictEqual(r, { bars: '/x.json', timeframes: [15, 60, 240], json: true });
  assert.deepStrictEqual(validate(MTF, r), []);
  assert.deepStrictEqual(repair(schema, { nested: { k: '2', s: '2' } }), { nested: { k: 2, s: '2' } });
  // An unknown key is kept as sent (and still refused by the validator), never coerced or dropped.
  const u = repair(schema, { n: '2', bogus: '3' });
  assert.deepStrictEqual(u, { n: 2, bogus: '3' });
  assert.match(validate(schema, u).join(), /"bogus": unknown argument/);
  const proto = repair(schema, JSON.parse('{"__proto__":{"n":"1"},"n":"2"}'));
  assert.strictEqual(Object.getPrototypeOf(proto), Object.prototype, 'a __proto__ key never becomes the prototype');
  assert.match(validate(schema, proto).join(), /"__proto__": unknown argument/);
  // Not objects, or of the wrong shape: as sent.
  for (const v of [null, 3, 'x', ['1'], undefined]) assert.deepStrictEqual(repair(schema, v), v);
  assert.deepStrictEqual(repair(schema, { list: '1', nested: ['1'] }), { list: '1', nested: ['1'] });
  // JSON in a string is not unwrapped.
  assert.deepStrictEqual(repair(schema, { list: '["1"]', nested: '{"k":1}' }), { list: '["1"]', nested: '{"k":1}' });
});

test('repair: deep values are not walked past the bound (the validator refuses them)', () => {
  // A schema whose items are itself: only the bound stops the walk (without it, the stack overflows).
  const self = { type: 'array', items: null };
  self.items = self;
  let deep = '3';
  for (let i = 0; i < 100000; i += 1) deep = [deep];
  assert.doesNotThrow(() => repair(self, deep));
  let shallow = '3';
  for (let i = 0; i < 3; i += 1) shallow = [shallow];
  assert.deepStrictEqual(repair({ type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } }, shallow), [[[3]]], 'within the bound it is walked');
  // anyOf that refers to itself: the forms are not collected past the bound either.
  const any = { anyOf: [{ type: 'integer' }] };
  any.anyOf.push(any);
  assert.strictEqual(repair({ type: 'object', properties: { a: { anyOf: [any] } } }, { a: '4' }).a, 4);
  assert.match(checked(BARS, { symbol: 'MNQ', timeframe: deep }).join(), /timeframe:/);
});
