'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseYaml, parseFrontmatter } = require('../../scripts/lib/frontmatter');

test('parses scalars, nested maps, inline and block lists, comments', () => {
  const doc = parseYaml([
    'name: orb  # trailing comment',
    'n: 18',
    'f: -1.5',
    'yes: true',
    'nothing:',
    'quoted: "a # not a comment"',
    "single: 'it''s'",
    'inline: [MNQ, "MES", 3]',
    'block:',
    '  - one',
    '  - two',
    'nested:',
    '  risk:',
    '    stop: atr:0.5',
    '    min_rr: 2',
    'maps:',
    '  - key: a',
    '    value: 1',
    '  - key: b',
  ].join('\n'));
  assert.deepStrictEqual(doc, {
    name: 'orb', n: 18, f: -1.5, yes: true, nothing: null, quoted: 'a # not a comment', single: "it's",
    inline: ['MNQ', 'MES', 3], block: ['one', 'two'], nested: { risk: { stop: 'atr:0.5', min_rr: 2 } },
    maps: [{ key: 'a', value: 1 }, { key: 'b' }],
  });
});

test('rejects unsupported or malformed YAML', () => {
  assert.throws(() => parseYaml('a: |\n  text'), /unsupported/);
  assert.throws(() => parseYaml('a: {b: 1}'), /inline maps/);
  assert.throws(() => parseYaml('a: 1\na: 2'), /duplicate key/);
  assert.throws(() => parseYaml('a:\n\t- x'), /tabs/);
  assert.throws(() => parseYaml('  a: 1'), /indented/);
  assert.throws(() => parseYaml('just text'), /expected "key: value"/);
  assert.throws(() => parseYaml('a: [1, 2'), /unterminated/);
});

test('parseFrontmatter splits data and body', () => {
  const { data, body } = parseFrontmatter('---\nname: x\n---\n# Title\n');
  assert.deepStrictEqual(data, { name: 'x' });
  assert.strictEqual(body, '# Title\n');
  assert.throws(() => parseFrontmatter('# no frontmatter'), /missing YAML frontmatter/);
  assert.deepStrictEqual(parseFrontmatter('---\r\nname: y\r\n---\r\n').data, { name: 'y' });
});

test('compact lists, a leading BOM, and reserved keys', () => {
  assert.deepStrictEqual(parseYaml('instruments:\n- MNQ\n- MES\nname: x'), { instruments: ['MNQ', 'MES'], name: 'x' });
  assert.deepStrictEqual(parseFrontmatter('﻿---\nname: z\n---\n').data, { name: 'z' });
  assert.throws(() => parseYaml('__proto__:\n  polluted: 1'), /line 1: "__proto__" is not allowed/);
  assert.throws(() => parseYaml('a: 1\nb: "open'), /line 2:/);
});
