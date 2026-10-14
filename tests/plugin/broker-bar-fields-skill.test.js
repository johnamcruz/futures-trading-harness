'use strict';

// The broker-bar-fields skill: one job (reading the broker's own bar fields as confirmation, never a setup), generic
// (it gives no field a meaning: that is the broker's), the summary line it names is the briefing's, it is reached by
// its AGENTS.md index line (no existing skill is edited) and never embedded in a role.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { loadRoles } = require('../../scripts/lib/role-skills');
const { brokerFieldsText } = require('../../scripts/lib/trading/broker-fields');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = t => t.replace(/\s+/g, ' ');
const SKILL = 'skills/broker-bar-fields/SKILL.md';

test('broker-bar-fields: the sections in order, small, a read never a veto, confirmation only, no meaning of its own', () => {
  const text = read(SKILL);
  const { data, body } = parseFrontmatter(text);
  assert.strictEqual(data.name, 'broker-bar-fields');
  assert.match(data.description, /^Use when /);
  const at = ['## When to Use', '## How It Works', '## Examples'].map(h => text.indexOf(`\n${h}\n`));
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2]);
  assert.ok(Buffer.byteLength(body) <= 3400, `${Buffer.byteLength(body)} bytes`);
  const f = flat(text);
  for (const pin of [
    'A read, never a veto and never a setup',
    'the harness passes them through untouched and gives them no meaning',
    'come from the broker\'s own documentation of its server. The harness states none, and neither does this skill.',
    'Never guess one from its name, and never work one out from OHLCV.',
    'It never makes a setup, never moves a stop and never sizes a trade.',
    '`Broker bar fields` line',
  ]) assert.ok(f.includes(pin), pin);
  // No field path or field meaning of any broker: only the generic line.
  assert.doesNotMatch(text, /`(?!m3\.)[a-z]+\.[A-Za-z0-9.]+`/);
  // The examples are reads, never strategies.
  assert.doesNotMatch(text.slice(text.indexOf('## Examples')), /fired|strategy|setup:/);
});

test('broker-bar-fields: the line it names is the briefing\'s summary line', () => {
  const line = brokerFieldsText({ paths: ['x.a'], bars: [{ t: '1', fields: { x: { a: 1 } } }, { t: '2', fields: null }, { t: '3', fields: { x: { a: 2 } } }] });
  assert.strictEqual(line, '- Broker bar fields (last 3 bars, oldest first): x.a 1/null/2.');
  assert.ok(line.includes('Broker bar fields') && read(SKILL).includes('`Broker bar fields` line'));
});

test('broker-bar-fields: reached by its AGENTS.md index line, never embedded or indexed in a role', () => {
  assert.match(read('workspace/AGENTS.md'), /^- `broker-bar-fields` \(skills\/broker-bar-fields\/SKILL\.md\): Use when /m);
  for (const r of loadRoles(ROOT)) assert.ok(![...r.skills, ...r.index].includes('broker-bar-fields'), r.name);
});
