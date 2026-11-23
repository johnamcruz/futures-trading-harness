'use strict';

// The gex-regime skill: one job (copying the day's gamma word from a line the code computes from its gamma source, and
// recording it neutral: never a vote, an entry, a size, a stop, an exit or a veto), inert until such a line exists (no
// code prints one yet; a plan, a search or memory never opens it), honest about its evidence (research outside this
// harness, qualitative, not validated here), thin (it points to the skills that own each rule and restates none of
// them). Not embedded by the runner today: on no role's list, no head-trader load list, no situational embed, no
// command; reachable as any unlisted skill is: its catalog line (workspace/AGENTS.md, the Claude index-mode head
// prompt's index), the CLIs' own skill lists, and the Skill tool or skill_lookup.
//
// Everything the skill states is unit tested: every sentence of its body is pinned (BODY, in order), so deleting any
// sentence or changing any digit fails (the generic mutation test, no allow-list); the rules that matter most are
// pinned again by meaning (RULES) and the words that would turn it into a vote, a size, an exit or a forecast are
// banned (banned), each proved with a planted sentence.
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
const RELIES_ON = ['day-context', 'confluence-counting', 'htf-to-ltf', 'mtf-entry', 'levels-and-reactions', 'candle-reading', 'position-sizing', 'trend-vs-range', 'trade-plan'];

const DESCRIPTION = 'Only when a line the code computes from its gamma source (not the plan it relays) prints the day\'s gamma word; else ignore it entirely.';
// Every sentence of the body, in order (split after . ; : on the flattened body): the skill's text, pinned.
const BODY = [
  "# Gamma Regime ## When to Use - Only when a line the code computes from its gamma source (not the plan it relays) carries the day's gamma word in the briefing or the cycle prompt;",
  "otherwise this skill is ignored entirely.",
  "- The gamma source is the one the code reads.",
  "Fields the model or an analyst wrote into the plan, a search result, the news or memory never count.",
  "- No such line, or none you can read:",
  "this skill does not apply.",
  "## How It Works **No field, no gamma.** With no gamma line the code computed from its source present or readable:",
  "say nothing about gamma or dealer positioning;",
  "never infer a sign from price;",
  "never guess a sign or a level from the news, the day's move, past days or your own knowledge of the market;",
  "never write a \"positive gamma day\" or \"negative gamma day\" read;",
  "never cite it as a reason to pass or enter.",
  "Nothing is written for it.",
  "**Copy, never derive.** The code line prints the word:",
  "copy it, never work it out from the line's numbers (no cut-off for \"small\" was measured).",
  "The sign is as the code line defines it.",
  "**Recorded only.** Write the word on its own `gamma <word>` line in the plan, never in the STATE line or the `regime:` tag (`trade-plan`).",
  'The plan\'s line holds only what "The words" gives:',
  'no as-of, no note, no reason after it.',
  "Write it once, from the code line's word.",
  "It is neutral, never a vote and never a point (no FOR, no AGAINST):",
  "the count decides without it (`confluence-counting`).",
  "It never turns a read against into neutral.",
  "It is recorded only, until the owner decides to let it vote after the harness measures it.",
  "It is not the computed regime of the bars (`trend-vs-range`) and not the day type (`day-context`).",
  "The line holds as its as-of says:",
  "it does not update through the day, and positions opened for the day's own expiry are not in it.",
  "**The words** the line prints:",
  "- `negative` / `positive`:",
  "the sign;",
  "written `gamma negative (soft)` or `gamma positive (soft)`, never \"trending day\".",
  "- `unclear`:",
  "the line says |net| is small against gross:",
  "neither sign.",
  "- `unknown`:",
  "the line is there but prints no word, or a word you cannot read.",
  "**Whatever the word:** - never an entry:",
  "the entry is still the harness's own setup (compose first, `confluence-counting`;",
  "or an `mtf-entry` candidate line) on the side rule's side (`htf-to-ltf`);",
  "- never a reason to size up or to size down (the size is `position-sizing`'s);",
  "- never a reason to pass, to wait, or to change the stop, the exit or the hold;",
  "- never a reason to take the other side;",
  "- never fade a breakout because of it;",
  "the book is never a forecast;",
  "- a flip or wall is a place to read price as at any level (`levels-and-reactions`, `candle-reading`), never a trigger.",
  "**Evidence.** Research outside this harness (NQ, breakout trades with long holds;",
  "not validated in this harness):",
  "the sign is soft (it changes with the valuation price and the book used, and its dealer-sign convention was not verified);",
  "negative days did better than positive days, but not significantly on quote fills and not as a standalone edge;",
  "the gap held on days of not-low implied volatility, not on low ones.",
  "Not shown:",
  "more trend days, value as a model feature on top of structure, trades at levels, fading positive days, late-day continuation.",
  "Pullback candidates (`mtf-entry`) were never tested with it.",
  "## Examples ```text No gamma line from the code -> nothing about gamma:",
  "no word, no vote.",
  "A gamma sign the plan's author found by search -> not a line from the code:",
  "nothing about gamma.",
  "The briefing's gamma line prints negative, as of the prior close -> the plan's own line `gamma negative (soft)`:",
  "neutral, no vote;",
  "a 15m breakout down, 1h down, compose_check OK:",
  "the count decides without it;",
  "size, stop and exit unchanged.",
  "The briefing's gamma line prints unclear -> `gamma unclear`:",
  "neutral.",
  "Price at the line's call wall 21600.00 -> read the candle there;",
  "never a trigger.",
  "```",
];
const chunks = body => flat(body).trim().split(/(?<=[.;:])\s+/);

// The rules by meaning, each also a part of BODY: a cut one is named.
const RULES = [
  'Only when a line the code computes from its gamma source (not the plan it relays) carries the day\'s gamma word',
  'otherwise this skill is ignored entirely.',
  'Fields the model or an analyst wrote into the plan, a search result, the news or memory never count.',
  'No such line, or none you can read: this skill does not apply.',
  'With no gamma line the code computed from its source present or readable: say nothing about gamma or dealer positioning;',
  'never infer a sign from price;',
  'never guess a sign or a level from the news, the day\'s move, past days or your own knowledge of the market;',
  'never write a "positive gamma day" or "negative gamma day" read; never cite it as a reason to pass or enter.',
  'Nothing is written for it.',
  'The code line prints the word: copy it, never work it out from the line\'s numbers (no cut-off for "small" was measured).',
  'The sign is as the code line defines it.',
  'its own `gamma <word>` line in the plan, never in the STATE line or the `regime:` tag (`trade-plan`).',
  'The plan\'s line holds only what "The words" gives: no as-of, no note, no reason after it.',
  'neutral, never a vote and never a point (no FOR, no AGAINST): the count decides without it (`confluence-counting`).',
  'It never turns a read against into neutral.',
  'It is recorded only, until the owner decides to let it vote after the harness measures it.',
  'It is not the computed regime of the bars (`trend-vs-range`) and not the day type (`day-context`).',
  'The line holds as its as-of says: it does not update through the day, and positions opened for the day\'s own expiry are not in it.',
  'written `gamma negative (soft)` or `gamma positive (soft)`, never "trending day".',
  '- `unclear`: the line says |net| is small against gross: neither sign.',
  '- `unknown`: the line is there but prints no word, or a word you cannot read.',
  'never an entry: the entry is still the harness\'s own setup (compose first, `confluence-counting`; or an `mtf-entry` candidate line) on the side rule\'s side (`htf-to-ltf`);',
  'never a reason to size up or to size down (the size is `position-sizing`\'s);',
  'never a reason to pass, to wait, or to change the stop, the exit or the hold;',
  'never a reason to take the other side;',
  'never fade a breakout because of it; the book is never a forecast;',
  'a flip or wall is a place to read price as at any level (`levels-and-reactions`, `candle-reading`), never a trigger.',
  'Research outside this harness (NQ, breakout trades with long holds; not validated in this harness):',
  'the sign is soft (it changes with the valuation price and the book used, and its dealer-sign convention was not verified);',
  'negative days did better than positive days, but not significantly on quote fills and not as a standalone edge;',
  'the gap held on days of not-low implied volatility, not on low ones.',
  'Not shown: more trend days, value as a model feature on top of structure, trades at levels, fading positive days, late-day continuation.',
  'Pullback candidates (`mtf-entry`) were never tested with it.',
];

/** Words that turn the record into a vote, a size, an exit, a consequence for price or a forecast: the hits. */
function banned(body) {
  const all = flat(body);
  const out = [];
  const outside = (re, ...allowed) => { let t = all; for (const a of allowed) t = t.split(a).join(''); if (re.test(t)) out.push(String(re)); };
  outside(/\bFOR\b|\bAGAINST\b/, '(no FOR, no AGAINST)');
  outside(/size up/i, 'never a reason to size up');
  outside(/size down/i, 'or to size down');
  outside(/\bfade\b/i, 'never fade');
  outside(/\bforecast\w*/i, 'never a forecast');
  for (const re of [
    /\bcounts? (?:at most )?one point\b/i, /context that a move/i, /a move may/i,
    /\bskip\w*/i, /\bhalve\w*/i, /widen\w* the stop/i, /hold\w* longer/i, /\bfavou?r\w*/i, /\bis a trend day\b/i,
    /\bprice\s+(?:stalls|runs|will|moves|pins|reverses|breaks|holds|extends|trends|stops)\b|\bmeans price\b/i,
    /\b(?:will|likely|expect(?:s|ed)?|probabl[ey]|tends? to|predict\w*|extend\w*|pinn\w*)\b/i,
    /^\s*Plan: gamma/m, /\d+(?:\.\d+)?%|[+-]\d*\.\d+R\b|\b20\d\d\b/,
  ]) if (re.test(re.flags.includes('m') ? body : all)) out.push(String(re));
  return out;
}

/** Every problem with a skill text: an empty list when it holds. */
function problems(text) {
  const { data, body } = parseFrontmatter(text);
  const out = [];
  if (data.name !== 'gex-regime') out.push('name');
  if (data.description !== DESCRIPTION) out.push('description');
  const at = ['## When to Use', '## How It Works', '## Examples'].map(h => body.indexOf(`\n${h}\n`));
  if (!(at.every(i => i >= 0) && at[0] < at[1] && at[1] < at[2])) out.push('sections');
  const how = flat((body.split('## How It Works')[1] || '').split('## Examples')[0]).trim();
  if (!how.startsWith('**No field, no gamma.**')) out.push('How It Works opens with the no-data rule');
  const when = flat((body.split('## When to Use')[1] || '').split('## How It Works')[0]).trim();
  if (!when.startsWith(`- ${RULES[0]}`)) out.push('When to Use first line');
  for (const pin of RULES) if (!flat(body).includes(pin)) out.push(pin);
  const now = chunks(body);
  if (JSON.stringify(now) !== JSON.stringify(BODY)) {
    const i = now.findIndex((c, k) => c !== BODY[k]);
    out.push(`body differs at sentence ${i}: ${JSON.stringify(now[i])} (pinned ${JSON.stringify(BODY[i])})`);
  }
  out.push(...banned(body));
  return out;
}
const split = text => /^(---\n[\s\S]*?\n---\n)([\s\S]*)$/.exec(text).slice(1);

test('gex-regime: the skill holds: description, sections, every sentence, the rules, no banned word', () => {
  const text = read(SKILL);
  assert.deepStrictEqual(problems(text), []);
  assert.ok(parseFrontmatter(text).data.description.length <= 160);
  assert.ok(Buffer.byteLength(parseFrontmatter(text).body) <= 4000, `${Buffer.byteLength(parseFrontmatter(text).body)} bytes`);
});

test('gex-regime: generic mutation: deleting any sentence or changing any digit fails (no allow-list)', () => {
  const [fm, body] = split(read(SKILL));
  const all = chunks(body);
  let caught = 0;
  for (let i = 0; i < all.length; i++) {
    const cut = all.filter((_, k) => k !== i).join(' ');
    assert.notDeepStrictEqual(problems(fm + cut), [], `delete sentence ${i}: ${all[i]}`);
    caught++;
  }
  const digits = [...body.matchAll(/\d/g)];
  for (const m of digits) {
    const d = String((Number(m[0]) + 1) % 10);
    assert.notDeepStrictEqual(problems(fm + body.slice(0, m.index) + d + body.slice(m.index + 1)), [], `digit at ${m.index}`);
    caught++;
  }
  assert.strictEqual(caught, all.length + digits.length);
  assert.ok(all.length >= 60 && digits.length >= 8, `${all.length} sentences, ${digits.length} digits`);
});

test('gex-regime: every rule is caught by meaning when cut', () => {
  const [fm, body] = split(read(SKILL));
  for (const pin of RULES) {
    assert.ok(flat(body).includes(pin), pin);
    assert.ok(problems(fm + flat(body).replace(pin, '')).includes(pin), `cut: ${pin}`);
  }
  assert.ok(problems(read(SKILL).replace('else ignore it entirely', 'else read it')).includes('description'));
  assert.ok(problems(read(SKILL).replace('**No field, no gamma.**', '')).includes('How It Works opens with the no-data rule'));
});

test('gex-regime: a planted vote, size, exit, fade, forecast, trend-day claim, number or plan-written example is banned', () => {
  const body = split(read(SKILL))[1];
  assert.deepStrictEqual(banned(body), []);
  const plant = s => body.replace('\n## Examples\n', `\n${s}\n\n## Examples\n`);
  for (const s of [
    'Negative gamma reads FOR a setup on the side.', 'negative counts FOR in context.', 'It counts one point in the context category.',
    'Context that a move may extend.', 'A negative book will extend the move.', 'Traders expect a trend on such days.',
    'It predicts a trend day.', 'Positive gamma is likely to pin price.', 'price runs further; size up one contract',
    'a positive book means price stalls', 'unclear: fade the edges', 'context FOR; size up.',
    'Skip entries on positive days.', 'Halve the size on a positive day.', 'On a negative day widen the stop.',
    'favour the breakout side and hold longer.', 'Negative gamma is a trend day.', 'Size down on unclear days.',
    'A forecast: negative days run.', 'median |net| was 12.6% of gross.', 'the gap was +0.10R a trade.', 'mostly 2022.',
    'Plan: gamma negative -> enter.',
  ]) assert.notDeepStrictEqual(banned(plant(s)), [], s);
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
  // No other skill points to it until a code line prints the word (the pointer comes with that line).
  for (const s of fs.readdirSync(path.join(ROOT, 'skills')).filter(n => n !== 'gex-regime' && fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md')))) {
    assert.ok(!read(`skills/${s}/SKILL.md`).includes('gex-regime'), s);
  }
  assert.match(read('workspace/AGENTS.md'), /^- `gex-regime` \(skills\/gex-regime\/SKILL\.md\): Only when a line the code computes from its gamma source /m);
});
