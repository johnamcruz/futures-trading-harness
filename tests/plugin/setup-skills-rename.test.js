'use strict';

// The two multi-timeframe setups (mtf-rejection, mtf-breakout) became generic setups on any timeframe (rejection,
// breakout): the same substance, with a timeframe table and the multi-timeframe form as the best practice instead of
// the definition. This test proves nothing was lost or doubled: every sentence (and every table cell and code line) of
// the two skills as they were (tests/fixtures/skill-split/mtf-*.before.txt, frozen) appears in the new skills exactly
// as many times as it did before, byte-for-byte after whitespace is normalised. The only exceptions are listed below,
// each with its reason (most are the MTF-specific wording made generic); an exception that no longer differs fails
// too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The fixtures are the skills exactly as main had them before the rename (skills/mtf-*/SKILL.md at e0ce5ff4): pinned,
// so a sentence can't be dropped from a fixture and from its new home together.
const BEFORE = {
  'tests/fixtures/skill-split/mtf-rejection.before.txt': '41af448cb8454e89c345e1297d97f1f50662f672059cdbd671fc5678a51dd455',
  'tests/fixtures/skill-split/mtf-breakout.before.txt': '0ce9b5db0de7eb83f5ed836cc52c33126b23c8f376b3c01bb5338a359949fdb2',
};
const HOMES = ['rejection', 'breakout'];
const OLD_NAMES = ['mtf-rejection', 'mtf-breakout'];

/**
 * A skill's units: its body (no frontmatter) in blocks (a heading, a list item, a table row, a paragraph, a code
 * line), whitespace normalised, list and heading markers dropped; table rows split into cells; prose into sentences.
 */
function units(md) {
  const body = md.replace(/^---\n[^]*?\n---\n/, '');
  const blocks = [];
  let cur = null;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; cur = null; continue; }
    if (fence) { if (line.trim()) blocks.push(line); cur = null; continue; }
    if (!line.trim()) { cur = null; continue; }
    if (cur === null || /^(#{1,6} |- |\d+\. |\|)/.test(line)) { cur = [line]; blocks.push(cur); } else cur.push(line);
  }
  const out = [];
  for (const b of blocks) {
    const text = (Array.isArray(b) ? b.join(' ') : b).replace(/\s+/g, ' ').trim();
    if (!Array.isArray(b)) { out.push(text); continue; } // a code line, whole
    if (text.startsWith('|')) {
      for (const cell of text.replace(/^\|\s*|\s*\|$/g, '').split(/\s+\|\s+/)) if (!/^[-|: ]+$/.test(cell)) out.push(cell);
      continue;
    }
    const prose = text.replace(/^#{1,6} /, '').replace(/^(?:- |\d+\. )/, '');
    for (const s of prose.split(/(?<=[.!?])\s+(?=[A-Z`*[("])/)) if (s) out.push(s);
  }
  return out;
}

const count = list => list.reduce((m, u) => m.set(u, (m.get(u) || 0) + 1), new Map());

// The skill format's own section headings: every skill has them (CLAUDE.md, skill format).
const STRUCTURE = ['When to Use', 'How It Works', 'Examples'];

// Deliberate differences, each with its reason. `now`: the new text, in exactly one home.
const GENERIC = 'the setup is defined on any completed candle; the 15m or 60m form is now the best practice (the timeframe table and **Strongest**)';
const ALLOWED = [
  // The titles: the skills are named for the setup, not for one timeframe pairing.
  { old: 'MTF Rejection', now: 'Rejection', reason: 'renamed: the setup on any timeframe' },
  { old: 'MTF Breakout', now: 'Breakout', reason: 'renamed: the setup on any timeframe' },
  // When to Use: a completed candle on any timeframe, not "a higher timeframe".
  { old: 'A strategy fired at a key level, and the plan asks whether a higher timeframe rejected that level.',
    now: 'A strategy fired at a key level, and the plan asks whether a completed candle rejected that level, on any timeframe (trader-process step 4).',
    reason: GENERIC },
  { old: 'A strategy fired at a key level, and the plan asks whether a higher timeframe accepted price beyond it.',
    now: 'A strategy fired at a key level, and the plan asks whether a completed candle accepted price beyond it, on any timeframe (trader-process step 4).',
    reason: GENERIC },
  // Step 4, the definition: any completed candle, not a 15m or 60m one.
  { old: '**4 Setup**: a completed 15m or 60m candle rejects the level: it trades through and closes back inside, with a long wick and the close in the opposite third, or an engulfing at the level (`candle-reading`).',
    now: '**4 Setup**: a completed candle rejects the level: it trades through and closes back inside, with a long wick and the close in the opposite third, or an engulfing at the level (`candle-reading`).',
    reason: GENERIC },
  { old: '**4 Setup**: a completed 15m or 60m candle closes beyond the level with acceptance: a strong close in the extreme third, the body beyond the level, not just a wick (`breakout-vs-fakeout`, `candle-reading`).',
    now: '**4 Setup**: a completed candle closes beyond the level with acceptance: a strong close in the extreme third, the body beyond the level, not just a wick (`breakout-vs-fakeout`, `candle-reading`).',
    reason: GENERIC },
  { old: 'A close beyond a level that is also a BOS on that timeframe (`m15.lastBreak.last`, `h1.lastBreak.last`) is accepted structure (`bos-vs-choch`).',
    now: 'A close beyond a level that is also a BOS on that timeframe (`m3.lastBreak.last`, `m15.lastBreak.last`, `h1.lastBreak.last`) is accepted structure (`bos-vs-choch`).',
    reason: 'any timeframe: the 3m break too' },
  // Step 6: the 3m or 5m confirmation is the form after a 15m or 60m setup, not the only entry.
  { old: '**6 Entry**: after the HTF rejection, a completed 3m or 5m candle confirms the same way: a displacement candle, or a break of the small pullback structure (`m3.lastBreak.last`).',
    now: '**6 Entry**: after a 15m or 60m rejection, a completed 3m or 5m candle confirms the same way: a displacement candle, or a break of the small pullback structure (`m3.lastBreak.last`).',
    reason: GENERIC },
  { old: '**6 Entry**: a completed 3m or 5m candle confirms: a retest of the broken level that holds, with a rejection candle there (preferred), or a continuation displacement.',
    now: '**6 Entry**: a completed candle confirms (after a 15m or 60m break, a 3m or 5m): a retest of the broken level that holds (a pullback: `pullback-vs-reversal`), with a rejection candle there (preferred), or a continuation displacement.',
    reason: `${GENERIC}; the retest is a pullback, pointed to its read` },
  // Step 3: the level list is levels-and-reactions' (pointed to, not restated); the two levels it lacks stay named.
  { old: '**3 Location**: price at a key level (`levels-and-reactions`: POC, VAH/VAL, CRT high/low, prior-day and overnight high/low, VWAP, IB/OR, swing, previous candle high/low: `mtf_read` `json`, not the briefing).',
    now: '**3 Location**: price at a key level (`levels-and-reactions`; the previous candle\'s high/low, a CRT range: `mtf_read` `json`, not the briefing).',
    reason: 'the levels are levels-and-reactions\' list; the previous candle and the CRT range are not in it (candle-reading)' },
  { old: '**3 Location**: a key level in the way (`levels-and-reactions`: prior-day or overnight high/low, IB/OR, value-area edge, CRT range edge, swing, previous candle high/low: `mtf_read` `json`, not the briefing).',
    now: '**3 Location**: a key level in the way (`levels-and-reactions`; the previous candle\'s high/low, a CRT range: `mtf_read` `json`, not the briefing).',
    reason: 'the levels are levels-and-reactions\' list; the previous candle and the CRT range are not in it (candle-reading)' },
  // The pairing names the renamed skills.
  { old: '**Paired with `mtf-breakout`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
    now: '**Paired with `breakout`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
    reason: 'the renamed skill' },
  { old: '**Paired with `mtf-rejection`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
    now: '**Paired with `rejection`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
    reason: 'the renamed skill' },
  // The skip examples, on another timeframe: the examples show at least two (basics-skills.test.js).
  { old: 'Skip: at the overnight high 21614.75: the 15m candle still forming (no read yet); orb long fired.',
    now: ['Skip: at the swing high 21588.25 (3m, a minor level), 60m and 15m up: on the 5m close a shooting star',
      '(H 21590.75, C 21585.50). crt_1h short fired. Priority order (step 2, a fade only at an HTF level): skip.'],
    reason: 'a 5m rejection at a minor level; a forming candle is never judged: candle-reading\'s pinned sentence and its skip example' },
  { old: 'candidate.inTheWay the overnight high at 0.2R. Priority order (step 3, room): skip.', reason: 'the second line of the replaced skip example' },
  { old: 'Skip: at the IB high 21560.00: on the 15m close only a wick beyond, close 21556.25 (no acceptance);',
    now: 'Skip: at the IB high 21560.00: on the 5m close only a wick beyond, close 21556.25 (no acceptance);',
    reason: 'the same skip on a 5m candle: the examples show at least two timeframes' },
];

/** What differs between the old skills and the new homes, beyond the allowed exceptions: [] when nothing does. */
function differences(beforeTexts, homeTexts) {
  const before = count(beforeTexts.flatMap(units));
  const after = count(homeTexts.flatMap(units));
  const allowed = new Map(ALLOWED.map(a => [a.old, a]));
  const bad = [];
  for (const [u, n] of before) {
    if (STRUCTURE.includes(u)) continue;
    const a = allowed.get(u);
    const want = a ? (a.copies || 0) : n;
    if ((after.get(u) || 0) !== want) bad.push(`${JSON.stringify(u)}: ${n} before, ${after.get(u) || 0} after${a ? ` (allowed: ${want})` : ''}`);
  }
  for (const a of ALLOWED) {
    if (!before.has(a.old)) bad.push(`allow-list entry not in the old skills: ${a.old}`);
    for (const now of [a.now || []].flat()) if (after.get(now) !== 1) bad.push(`changed sentence in ${after.get(now) || 0} homes, not 1: ${now}`);
  }
  for (const h of STRUCTURE) if (after.get(h) !== homeTexts.length) bad.push(`"${h}" heading: ${after.get(h) || 0}, not one per skill`);
  return bad;
}

const beforeTexts = () => Object.keys(BEFORE).map(read);
const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('setup rename: every unit of the two old skills is in exactly one new home, byte-for-byte (whitespace normalised)', () => {
  for (const [file, want] of Object.entries(BEFORE)) {
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
    assert.strictEqual(sha, want, `${file}: the fixture is the old skill, unchanged`);
  }
  assert.deepStrictEqual(differences(beforeTexts(), homeTexts()), []);
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('setup rename: the comparison catches a lost, a doubled or an edited sentence, and a stale exception', () => {
  const old = beforeTexts();
  assert.ok(old.flatMap(units).length > 60, `the units are fine-grained (${old.flatMap(units).length})`);
  const homes = homeTexts();
  const KEPT = 'It is never a reason to enter without a fired strategy.';
  const EVIDENCE = '**Evidence**: not measured as a setup yet; candle patterns alone have weak evidence in general.';
  assert.ok(homes[0].replace(/\s+/g, ' ').includes(EVIDENCE));
  const with0 = text => [text, homes[1]];
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(differences(old, with0(homes[0].replace(/\*\*Evidence\*\*: not measured/, 'Not measured'))), []);
  // Doubled: the same sentence once more.
  assert.notDeepStrictEqual(differences(old, with0(`${homes[0]}\n${KEPT}\n`)), []);
  // Edited: one word changed.
  assert.notDeepStrictEqual(differences(old, with0(homes[0].replace('Size: the priority order and the rulebook.', 'Size: the rulebook.'))), []);
  // A changed sentence reverted to its old text (the exception no longer needed) also fails: the list only shrinks.
  assert.notDeepStrictEqual(differences(old, with0(homes[0].replace('**Paired with `breakout`**', '**Paired with `mtf-breakout`**'))), []);
});

test('setup rename: the old names are gone from every skill, agent, command, rule, hook table and doc', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md'))).map(d => `skills/${d}/SKILL.md`),
    ...fs.readdirSync(path.join(ROOT, 'agents')).map(f => `agents/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'commands')).map(f => `commands/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'rules', 'trading')).map(f => `rules/trading/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => `docs/${f}`),
    'scripts/lib/trading/skills-loaded.js', 'README.md',
  ];
  for (const f of files) for (const n of OLD_NAMES) assert.ok(!read(f).includes(n), `${f}: ${n}`);
  for (const n of OLD_NAMES) assert.ok(!fs.existsSync(path.join(ROOT, 'skills', n)), `skills/${n} is gone`);
  // The situational triggers name the new skills (index mode).
  const { SITUATIONAL } = require('../../scripts/lib/trading/skills-loaded');
  assert.ok(SITUATIONAL.some(e => e.skill === 'rejection' && e.when === 'candidate.trendRule=reversal'));
  assert.ok(SITUATIONAL.some(e => e.skill === 'breakout' && e.when === 'candidate.trendRule=allows'));
});
