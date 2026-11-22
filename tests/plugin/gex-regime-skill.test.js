'use strict';

// The gex-regime skill: one job (reading the day's gamma regime as context, never an entry, a size or a veto), inert
// until the plan or the briefing carries its fields (no data path prints them yet: with no field the model says
// nothing about gamma), honest about its evidence (outside research, not validated here), thin (it points to the
// skills that own each rule and restates none of them), reached only by its AGENTS.md index line (skill_lookup): on no role's list, no head-trader load list, no runner embed, no command.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { loadRoles } = require('../../scripts/lib/role-skills');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = t => t.replace(/\s+/g, ' ');
const SKILL = 'skills/gex-regime/SKILL.md';
// The skills it relies on, each named by its folder: a rename breaks this test.
const RELIES_ON = ['day-context', 'confluence-counting', 'htf-to-ltf', 'mtf-entry', 'levels-and-reactions', 'candle-reading', 'position-sizing', 'trend-vs-range'];

// The no-data rule: what must hold for the skill to stay silent without a gamma field. Returns the missing pins.
const NO_DATA = [
  'With no gamma field present or readable: say nothing about gamma or dealer positioning;',
  'never infer a sign from price;',
  'never guess a sign or a level from the news, the day\'s move, past days or your own knowledge of the market;',
  'never write a "positive gamma day" or "negative gamma day" read; never count it; never cite it as a reason to pass or enter.',
  'Nothing is written for it.',
];
function noDataMissing(text) {
  const { data, body } = parseFrontmatter(text);
  const missing = [];
  if (!/^Only when the plan or briefing carries the day's gamma regime fields; else ignore it entirely\./.test(String(data.description || ''))) missing.push('description');
  const when = flat(body.split('## When to Use')[1] || '').trim();
  if (!when.startsWith('- Only when the premarket plan or the briefing carries the day\'s gamma regime fields')) missing.push('When to Use first line');
  if (!when.includes('otherwise this skill is ignored entirely.')) missing.push('ignored entirely');
  const how = flat((body.split('## How It Works')[1] || '').split('## Examples')[0]).trim();
  if (!how.startsWith('**No field, no gamma.**')) missing.push('How It Works opens with the no-data rule');
  for (const pin of NO_DATA) if (!how.slice(0, 700).includes(pin)) missing.push(pin);
  return missing;
}

test('gex-regime: frontmatter, the sections in order, small', () => {
  const text = read(SKILL);
  const { data, body } = parseFrontmatter(text);
  assert.strictEqual(data.name, 'gex-regime');
  assert.ok(data.description.length <= 160, `${data.description.length} chars`);
  const at = ['## When to Use', '## How It Works', '## Examples'].map(h => text.indexOf(`\n${h}\n`));
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], 'the three sections in order');
  assert.ok(Buffer.byteLength(body) <= 4200, `${Buffer.byteLength(body)} bytes`);
});

test('gex-regime: the no-data rule leads the description, When to Use and How It Works', () => {
  assert.deepStrictEqual(noDataMissing(read(SKILL)), []);
});

test('gex-regime: removing any no-data sentence fails the check (mutation)', () => {
  const text = read(SKILL);
  for (const pin of NO_DATA) {
    // Cut the pin from the text (flattened in its body only, so the frontmatter still parses): the check must notice.
    const [, fm, body] = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(text);
    assert.ok(flat(body).includes(pin), pin);
    assert.notDeepStrictEqual(noDataMissing(fm + flat(body).replace(pin, '')), [], `cut: ${pin}`);
  }
  assert.notDeepStrictEqual(noDataMissing(text.replace('else ignore it entirely', 'else read it')), [], 'description');
  assert.notDeepStrictEqual(noDataMissing(text.replace('**No field, no gamma.**', '')), [], 'opening');
  assert.notDeepStrictEqual(noDataMissing(text.replace('otherwise this skill is ignored entirely.', '')), [], 'When to Use');
});

test('gex-regime: with the fields, a read never a veto, one point at most, evidence labelled', () => {
  const f = flat(read(SKILL));
  for (const pin of [
    'None, or none you can read: this skill does not apply.',
    'One field missing beside the others is `unknown`, which counts for nothing.',
    'a read, never a veto: the count decides (`confluence-counting`).',
    'One read inside the `context` vote, beside the category\'s other reads, never a point of its own',
    'never an entry, never a reason to size up',
    '`unclear`',
    'never "trending day"',
    'not validated in this harness',
    'do not update through the day',
  ]) assert.ok(f.includes(pin), pin);
  // No invented field paths: the regime's fields are described generically until a briefing line prints them.
  assert.doesNotMatch(read(SKILL), /`(?:m3|m15|day)\.[A-Za-z]/);
});

test('gex-regime: points to each skill it relies on, by a name that exists', () => {
  const text = read(SKILL);
  for (const s of RELIES_ON) {
    assert.ok(text.includes(`\`${s}\``), `names \`${s}\``);
    assert.ok(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), `skills/${s} exists`);
  }
});

test('gex-regime: restates none of the owning skills\' rule sentences', () => {
  const sentences = t => flat(parseFrontmatter(t).body.replace(/^#.*$/gm, '')).split(/(?<=[.:;])\s+/).map(s => s.trim()).filter(s => s.split(' ').length >= 6);
  const mine = new Set(sentences(read(SKILL)));
  for (const s of RELIES_ON) {
    const dup = sentences(read(`skills/${s}/SKILL.md`)).filter(x => mine.has(x));
    assert.deepStrictEqual(dup, [], `restates ${s}`);
  }
  // Positive control: a rule sentence of confluence-counting appended to the skill is caught.
  const theirs = sentences(read('skills/confluence-counting/SKILL.md'));
  const planted = new Set(sentences(read(SKILL).replace('\n## Examples\n', `\n${theirs[3]}\n\n## Examples\n`)));
  assert.ok(theirs.length > 3 && planted.has(theirs[3]) && !mine.has(theirs[3]), 'the check catches a restated sentence');
});

test('gex-regime: nothing loads it today: no role, load list, runner embed, head core or command', () => {
  for (const r of loadRoles(ROOT)) assert.ok(![...r.skills, ...r.index].includes('gex-regime'), r.name);
  const SL = require('../../scripts/lib/trading/skills-loaded');
  for (const k of ['REQUIRED_FOR_ENTRY', 'REQUIRED_AT_ENTRY', 'REQUIRED_FOR_COMPOSED']) assert.ok(!(SL[k] || []).includes('gex-regime'), k);
  const { cycleLoaded } = require('../../scripts/lib/autotrader');
  for (const harness of ['claude', 'codex', 'opencode', 'qwen']) assert.ok(!cycleLoaded({ harness }).includes('gex-regime'), harness);
  const SS = require('../../scripts/lib/situational-skills');
  assert.ok(!SS.SKILLS.includes('gex-regime'), 'no situational embed');
  assert.ok(!require('../../scripts/lib/head-prompt').CORE.includes('gex-regime'), 'not in the head core');
  for (const f of fs.readdirSync(path.join(ROOT, 'commands'))) assert.ok(!read(`commands/${f}`).includes('gex-regime'), f);
  assert.match(read('workspace/AGENTS.md'), /^- `gex-regime` \(skills\/gex-regime\/SKILL\.md\): Only when /m);
});

test('gex-regime: no every-cycle skill points to it until a briefing carries the fields (today\'s prompts unchanged)', () => {
  // The pointer (day-context's, conditional on the fields) comes with the briefing line that prints them.
  for (const s of fs.readdirSync(path.join(ROOT, 'skills')).filter(n => n !== 'gex-regime' && fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')))) {
    assert.ok(!read(`skills/${s}/SKILL.md`).includes('gex-regime'), s);
  }
});
