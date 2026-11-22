'use strict';

// The gex-regime skill: one job (recording the day's gamma regime as a neutral word, never a vote, an entry, a size or
// a veto), inert until a code-printed line in the briefing or prompt carries its fields (no code prints them yet; a
// plan, a search or memory never opens it), honest about its evidence (research outside this harness, not validated
// here), thin (it points to the skills that own each rule and restates none of them). Not embedded by the runner today:
// on no role's list, no head-trader load list, no situational embed, no command; it is reachable as any unlisted skill
// is: its catalog line (workspace/AGENTS.md, the Claude index-mode head prompt's index), the CLIs' own skill lists, and
// the Skill tool or skill_lookup.
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

// The no-data rule and the code-printed-only trigger, in When to Use and the opening of How It Works.
const WHEN = [
  'Only when a code-printed line in the briefing or the cycle prompt carries the day\'s gamma regime fields',
  'otherwise this skill is ignored entirely.',
  'Fields the model or an analyst wrote into the plan, a search result, the news or memory never count.',
];
const NO_DATA = [
  'With no code-printed gamma field present or readable: say nothing about gamma or dealer positioning;',
  'never infer a sign from price;',
  'never guess a sign or a level from the news, the day\'s move, past days or your own knowledge of the market;',
  'never write a "positive gamma day" or "negative gamma day" read; never cite it as a reason to pass or enter.',
  'Nothing is written for it.',
];
// The rules that hold with the fields: neutral, never voted, and every never.
const RULES = [
  'it is neutral, never a vote and never a point (no FOR, no AGAINST)',
  'It never turns a read against into neutral.',
  'It is recorded only, until the owner decides to let it vote after the harness measures it.',
  'never an entry:',
  'never a reason to size up',
  'never a reason to take the other side',
  'never fade a breakout because of it',
  'never a trigger',
  'not significant',
  'Not a standalone edge.',
  'not validated in this harness',
  '`mtf-entry` pullback candidates were never tested with it',
  'breakout trades at 10:00-15:30',
  'as the field\'s as-of says',
];
const DESCRIPTION = /^Only when a code-printed briefing or prompt line carries the day's gamma regime fields; else ignore it entirely\./;
// Forecast words, affirmative: the skill states present facts only ("never a forecast" is the one allowed use).
const FORECAST = /\b(?:will|likely|expect(?:s|ed)?|probabl[ey]|tends? to|predict\w*|forecast\w*|extend\w*|pinn\w*)\b/i;
const NEGATED = /never a forecast/g;

/** Every problem with a skill text: an empty list when it holds. */
function problems(text) {
  const { data, body } = parseFrontmatter(text);
  const out = [];
  if (!DESCRIPTION.test(String(data.description || ''))) out.push('description');
  const when = flat((body.split('## When to Use')[1] || '').split('## How It Works')[0]).trim();
  if (!when.startsWith(`- ${WHEN[0]}`)) out.push('When to Use first line');
  for (const pin of WHEN) if (!when.includes(pin)) out.push(pin);
  const how = flat((body.split('## How It Works')[1] || '').split('## Examples')[0]).trim();
  if (!how.startsWith('**No field, no gamma.**')) out.push('How It Works opens with the no-data rule');
  for (const pin of NO_DATA) if (!how.slice(0, 700).includes(pin)) out.push(pin);
  for (const pin of RULES) if (!how.includes(pin)) out.push(pin);
  // No vote words and no consequence for price.
  for (const bad of [/reads FOR/, /\bcounts? (?:at most )?one point\b/, /context that a move/i, /a move may/i]) if (bad.test(flat(body))) out.push(`banned: ${bad}`);
  const m = flat(body).replace(NEGATED, '').match(FORECAST);
  if (m) out.push(`forecast word: ${m[0]}`);
  // The examples show the code-printed line, never a plan the model wrote.
  const ex = body.split('## Examples')[1] || '';
  if (/^\s*Plan: gamma/m.test(ex)) out.push('a plan-written gamma example');
  if (!/Briefing gamma line:/.test(ex)) out.push('the briefing line example');
  return out;
}
// Cut a pin from the body (flattened, so a pin across a line break is cut too), the frontmatter kept.
function cut(text, pin) {
  const [, fm, body] = /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(text);
  return fm + flat(body).replace(pin, '');
}

test('gex-regime: frontmatter, the sections in order, small', () => {
  const text = read(SKILL);
  const { data, body } = parseFrontmatter(text);
  assert.strictEqual(data.name, 'gex-regime');
  assert.ok(data.description.length <= 160, `${data.description.length} chars`);
  const at = ['## When to Use', '## How It Works', '## Examples'].map(h => text.indexOf(`\n${h}\n`));
  assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], 'the three sections in order');
  assert.ok(Buffer.byteLength(body) <= 4600, `${Buffer.byteLength(body)} bytes`);
});

test('gex-regime: the trigger, the no-data rule, neutral and every never hold', () => {
  assert.deepStrictEqual(problems(read(SKILL)), []);
});

test('gex-regime: every pinned sentence is caught when cut (mutation)', () => {
  const text = read(SKILL);
  for (const pin of [...WHEN, ...NO_DATA, ...RULES]) {
    assert.ok(flat(text).includes(pin), pin);
    assert.notDeepStrictEqual(problems(cut(text, pin)), [], `cut: ${pin}`);
  }
  assert.notDeepStrictEqual(problems(text.replace('else ignore it entirely', 'else read it')), [], 'description');
  assert.notDeepStrictEqual(problems(text.replace('**No field, no gamma.**', '')), [], 'opening');
});

test('gex-regime: a planted vote, a planted forecast or a plan-written example is caught', () => {
  const text = read(SKILL);
  const plant = s => text.replace('\n## Examples\n', `\n${s}\n\n## Examples\n`);
  for (const s of [
    'Negative gamma reads FOR a setup on the side.',
    'It counts one point in the context category.',
    'Context that a move may extend.',
    'A negative book will extend the move.',
    'Traders expect a trend on such days.',
    'It predicts a trend day.',
    'Positive gamma is likely to pin price.',
  ]) assert.notDeepStrictEqual(problems(plant(s)), [], s);
  assert.notDeepStrictEqual(problems(text.replace('Briefing gamma line: sign negative', 'Plan: gamma negative')), [], 'a plan-written example');
});

test('gex-regime: no invented field paths', () => {
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
  // Positive control: a rule sentence of confluence-counting planted in the skill is caught.
  const theirs = sentences(read('skills/confluence-counting/SKILL.md'));
  const planted = new Set(sentences(read(SKILL).replace('\n## Examples\n', `\n${theirs[3]}\n\n## Examples\n`)));
  assert.ok(theirs.length > 3 && planted.has(theirs[3]) && !mine.has(theirs[3]), 'the check catches a restated sentence');
});

test('gex-regime: not embedded today: no role, load list, runner embed, head core, command or pointer', () => {
  for (const r of loadRoles(ROOT)) assert.ok(![...r.skills, ...r.index].includes('gex-regime'), r.name);
  const SL = require('../../scripts/lib/trading/skills-loaded');
  for (const k of ['REQUIRED_FOR_ENTRY', 'REQUIRED_AT_ENTRY', 'REQUIRED_FOR_COMPOSED']) assert.ok(!(SL[k] || []).includes('gex-regime'), k);
  const { cycleLoaded } = require('../../scripts/lib/autotrader');
  for (const harness of ['claude', 'codex', 'opencode', 'qwen']) assert.ok(!cycleLoaded({ harness }).includes('gex-regime'), harness);
  const SS = require('../../scripts/lib/situational-skills');
  assert.ok(!SS.SKILLS.includes('gex-regime'), 'no situational embed');
  assert.ok(!require('../../scripts/lib/head-prompt').CORE.includes('gex-regime'), 'not in the head core');
  for (const f of fs.readdirSync(path.join(ROOT, 'commands'))) assert.ok(!read(`commands/${f}`).includes('gex-regime'), f);
  // No other skill points to it until a briefing carries the fields (the pointer comes with that line).
  for (const s of fs.readdirSync(path.join(ROOT, 'skills')).filter(n => n !== 'gex-regime' && fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')))) {
    assert.ok(!read(`skills/${s}/SKILL.md`).includes('gex-regime'), s);
  }
  assert.match(read('workspace/AGENTS.md'), /^- `gex-regime` \(skills\/gex-regime\/SKILL\.md\): Only when a code-printed /m);
});
