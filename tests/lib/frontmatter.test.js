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

test('an apostrophe inside an unquoted value is just a character', () => {
  assert.deepStrictEqual(parseYaml("a: [it's, MES]\nb: Don't fade # comment"), { a: ["it's", 'MES'], b: "Don't fade" });
  assert.throws(() => parseYaml("a: 'unterminated"), /unterminated/);
});

test('an unquoted value with ": " is refused, as YAML parsers (Claude Code, Qwen) refuse it; quoted is fine', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  assert.throws(() => parseFrontmatter('---\nname: x\ndescription: a policy strategy (signal: policy) trades\n---\nbody'), /unquoted value can't contain ": "/);
  assert.throws(() => parseFrontmatter('---\nname: x\ndescription: ends with a colon:\n---\nbody'), /unquoted value/);
  assert.strictEqual(parseFrontmatter('---\nname: x\ndescription: "a policy strategy (signal: policy) trades"\n---\nbody').data.description, 'a policy strategy (signal: policy) trades');
  assert.strictEqual(parseFrontmatter('---\nname: x\nsessions: [09:45-11:30@America/New_York]\n---\nbody').data.sessions[0], '09:45-11:30@America/New_York');
});

test('every frontmatter block in the repo parses (skills, agents, commands, rules, strategies, accounts, generated copies)', () => {
  const fs = require('fs');
  const path = require('path');
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const root = path.resolve(__dirname, '..', '..');
  let yaml = null;
  try { yaml = require('js-yaml'); } catch (_err) { /* the harness's own parser still checks */ }
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.md')) files.push(p);
    }
  };
  walk(root);
  const bad = [];
  let n = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    if (!m) continue;
    n += 1;
    try {
      parseFrontmatter(text);
      if (yaml) yaml.load(m[1]);
    } catch (err) {
      bad.push(`${path.relative(root, f)}: ${String(err.message).split('\n')[0]}`);
    }
  }
  assert.ok(n > 40, `found ${n} frontmatter blocks`);
  assert.deepStrictEqual(bad, []);
});
