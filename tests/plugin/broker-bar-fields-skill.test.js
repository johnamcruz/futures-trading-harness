'use strict';

// The broker-bar-fields skill: one job (reading the broker's own bar fields as confirmation, never a setup), generic
// (it gives no field a meaning: that is the broker's), the summary line it names is the briefing's, it is reached by
// its AGENTS.md index line, and listed only on the volume analyst's index (looked up, never embedded in index mode).
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
    'The harness states no meaning and neither does this skill.',
    'Never guess a meaning from a name, and never work one out from OHLCV.',
    '`Broker bar fields as the broker describes them`',
    'a context read, never an edge',
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

test('broker-bar-fields: the line it names when the broker gives words is the briefing\'s described line', () => {
  const f = { paths: ['x.a'], bars: [{ t: '1', fields: { x: { a: 5 } } }], shown: [{ path: 'x.a', per: 'v', meaning: 'the broker\'s words', values: [0.25] }] };
  const line = brokerFieldsText(f);
  assert.ok(line.startsWith('- Broker bar fields as the broker describes them ') && line.includes('(the broker\'s words)'), line);
  assert.ok(read(SKILL).includes('`Broker bar fields as\nthe broker describes them`'), 'the skill names the described line');
});

test('broker-bar-fields: reached by its AGENTS.md index line; on the volume analyst\'s index only (looked up when the briefing line has fields), never embedded in another role', () => {
  assert.match(read('workspace/AGENTS.md'), /^- `broker-bar-fields` \(skills\/broker-bar-fields\/SKILL\.md\): Use when /m);
  for (const r of loadRoles(ROOT)) {
    assert.ok(!r.skills.includes('broker-bar-fields'), `${r.name}: never in the embedded list`);
    assert.strictEqual(r.index.includes('broker-bar-fields'), r.name === 'volume-liquidity-analyst', r.name);
  }
});

test('the flow teaching states what was measured and keeps absorption with the setup (the review: not "none measured")', () => {
  const evidence = flat(read(SKILL));
  assert.ok(evidence.includes('as a mechanical confirmer it was not shown to work (26 months); a model reading a stated meaning is untested'), 'broker-bar-fields: what was measured');
  assert.doesNotMatch(evidence, /none measured/);
  const ab = flat(read('skills/absorption/SKILL.md'));
  assert.ok(ab.includes('as a mechanical confirmer flow was not shown to work; a model reading a stated meaning is untested'), 'absorption: what was measured');
  // The day type and balance are day-context's words, and the day type is a read, not a measured filter.
  assert.ok(ab.includes('The day so far first (`day-context`: a read of the morning, not a predictor of the rest)'));
  assert.doesNotMatch(ab, /none measured/);
  assert.ok(ab.includes('**Evidence**: as a mechanical confirmer, not shown to work.'));
  assert.ok(ab.includes("in the day's balance (`day-context`) → no flow read"));
  assert.match(flat(read('skills/day-context/SKILL.md')), /is balance \(the edges are its levels/);
  // Absorption alone is never the entry: with the setup.
  assert.ok(flat(read('skills/cisd/SKILL.md')).includes('`absorption` there counts, with the setup'));
  assert.ok(flat(read('skills/fib-retracement/SKILL.md')).includes('or, with the setup, absorption (`absorption`)'));
  // A described delta is one weak confirmation at a level.
  // One phrase for the vote everywhere: one participation vote, never decisive.
  const VOTE = 'one participation vote, never decisive';
  assert.ok(flat(read('skills/confluence-counting/SKILL.md')).includes(`a described delta at a level: ${VOTE} (\`broker-bar-fields\`)`));
  assert.ok(ab.includes(`${VOTE} (\`confluence-counting\`)`), 'absorption');
  assert.ok(evidence.includes(`It is ${VOTE} (\`confluence-counting\`, with volume)`), 'broker-bar-fields');
  assert.doesNotMatch(`${ab} ${evidence} ${flat(read('skills/confluence-counting/SKILL.md'))}`, /weak confirmation/);
  // No skill still says the flow strategies set a bar size.
  for (const f of ['skills/market-snapshot/SKILL.md', 'skills/timeframe-sources/SKILL.md']) assert.doesNotMatch(flat(read(f)), /for the flow strategies/, f);
});
