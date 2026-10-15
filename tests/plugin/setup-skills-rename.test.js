'use strict';

// The two multi-timeframe setups (mtf-rejection, mtf-breakout) became generic setups on any timeframe (rejection,
// breakout): the same substance, with a timeframe table and the multi-timeframe form as the best practice instead of
// the definition. This test proves nothing was lost, doubled or moved: every sentence (and every table cell and code
// line) of each old skill as it was (tests/fixtures/skill-split/mtf-*.before.txt, frozen) appears in ITS new skill
// (mtf-rejection -> rejection, mtf-breakout -> breakout) exactly as many times as it did before, byte-for-byte after
// whitespace is normalised. The only exceptions are listed below, each with its reason (most are the MTF-specific
// wording made generic); an exception that no longer differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Each new skill, from its old one. The fixtures are the skills exactly as main had them before the rename
// (skills/mtf-*/SKILL.md at ef7c9544, with #126's m3.candles and m3.swingTargets): pinned, so a sentence can't be dropped from a fixture and its new home together.
const PAIRS = {
  rejection: { old: 'mtf-rejection', file: 'tests/fixtures/skill-split/mtf-rejection.before.txt', sha256: 'accf3ae2eba3a09caa15a5930a6ef00b121099ceaacdbab3c7dc456f40c54ca9' },
  breakout: { old: 'mtf-breakout', file: 'tests/fixtures/skill-split/mtf-breakout.before.txt', sha256: '2ed49a9bb2d1a0ec0ebea619d163b27124d294b50df70af8923a8b6b49ef600f' },
};
const HOMES = Object.keys(PAIRS);
const OLD_NAMES = HOMES.map(h => PAIRS[h].old);

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


// Deliberate differences, by new skill, each with its reason. `now`: the new text, exactly once in that skill.
const GENERIC = 'the setup is defined on any completed candle; the 15m or 60m form is now the best practice (the timeframe table and **Strongest**)';
const LEVELS = 'the levels are levels-and-reactions\' list, pointed to; the previous candle and the CRT range are not in it (candle-reading)';
const TARGET = 'Aim for the next swing (`m3.swingTargets`); the room to the next level (`candidate.inTheWay`, `candidate.ahead`) is step 3\'s; the target and exit stay the strategy\'s.';
const SIZE = 'Size: the priority order and the rulebook.';
const SIZE_REASON = 'the read sentence already says the priority order decides size and the rulebook is untouched; the room and target sentence took its place';
const TARGET_REASON = 'the next swing target (`m3.swingTargets`, #126) is in the room and target sentence, once';
const ALLOWED = {
  rejection: [
    { old: 'MTF Rejection', now: 'Rejection', reason: 'renamed: the setup on any timeframe' },
    { old: 'A strategy fired at a key level, and the plan asks whether a higher timeframe rejected that level.',
      now: 'A strategy fired at a key level, and the plan asks whether a completed candle rejected that level, on any timeframe (trader-process step 4).',
      reason: GENERIC },
    { old: '**3 Location**: price at a key level (`levels-and-reactions`: POC, VAH/VAL, CRT high/low, prior-day and overnight high/low, VWAP, IB/OR, swing, previous candle high/low; `m3.candles` has them).',
      now: '**3 Location**: price at a key level (`levels-and-reactions`; the previous candle\'s high/low, a CRT range; `m3.candles` has them).',
      reason: LEVELS },
    { old: '**4 Setup**: a completed 15m or 60m candle rejects the level: it trades through and closes back inside, with a long wick and the close in the opposite third, or an engulfing at the level (`candle-reading`; the 15m and 1h entries of `m3.candles`: `rejected`).',
      now: '**4 Setup**: a completed candle rejects the level: it trades through and closes back inside, with a long wick and the close in the opposite third, or an engulfing at the level (`candle-reading`; each timeframe\'s entry of `m3.candles`: `rejected`).',
      reason: GENERIC },
    { old: '**6 Entry**: after the HTF rejection, a completed 3m or 5m candle confirms the same way: a displacement candle, or a break of the small pullback structure (`m3.lastBreak.last`).',
      now: '**6 Entry**: after a 15m or 60m rejection, a completed 3m or 5m candle confirms the same way: a displacement candle, or a break of the small pullback structure (`m3.lastBreak.last`).',
      reason: GENERIC },
    { old: SIZE, now: TARGET, reason: SIZE_REASON },
    { old: 'Target: the next swing, `m3.swingTargets`.', reason: TARGET_REASON },
    { old: '**Paired with `mtf-breakout`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
      now: '**Paired with `breakout`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
      reason: 'the renamed skill' },
    { old: 'Skip: at the overnight high 21614.75: the 15m candle still forming (no read yet); orb long fired.',
      now: ['Skip: at the swing high 21588.25 (3m, a minor level), 60m and 15m up: on the 3m close a shooting star',
        '(H 21590.75, C 21585.50). ofi_absorption short fired. Priority order (step 2, a fade only at an HTF level): skip.'],
      reason: 'a 3m rejection at a minor level faded by a reversal strategy (priority order step 2); a forming candle is never judged: candle-reading\'s pinned sentence and its skip example' },
    { old: 'candidate.inTheWay the overnight high at 0.2R. Priority order (step 3, room): skip.', reason: 'the second line of the replaced skip example' },
  ],
  breakout: [
    { old: 'MTF Breakout', now: 'Breakout', reason: 'renamed: the setup on any timeframe' },
    { old: 'A strategy fired at a key level, and the plan asks whether a higher timeframe accepted price beyond it.',
      now: 'A strategy fired at a key level, and the plan asks whether a completed candle accepted price beyond it, on any timeframe (trader-process step 4).',
      reason: GENERIC },
    { old: '**3 Location**: a key level in the way (`levels-and-reactions`: prior-day or overnight high/low, IB/OR, value-area edge, CRT range edge, swing, previous candle high/low; `m3.candles` has them).',
      now: '**3 Location**: a key level in the way (`levels-and-reactions`; the previous candle\'s high/low, a CRT range; `m3.candles` has them).',
      reason: LEVELS },
    { old: '**4 Setup**: a completed 15m or 60m candle closes beyond the level with acceptance: a strong close in the extreme third, the body beyond the level, not just a wick (`breakout-vs-fakeout`, `candle-reading`).',
      now: '**4 Setup**: a completed candle closes beyond the level with acceptance: a strong close in the extreme third, the body beyond the level, not just a wick (`breakout-vs-fakeout`, `candle-reading`).',
      reason: GENERIC },
    { old: '**5 Confluence**: expanding range and volume (`momentum-and-volume`: `m3.bar.rangeAtr`, `m3.participation.relVolLast3VsPrior20`), no absorption against it (`absorption`); counted by `confluence-counting`.',
      now: '**5 Confluence**: expanding range and volume (`momentum-and-volume`), no absorption against it (`absorption`); counted by `confluence-counting`.',
      reason: 'the fields are momentum-and-volume\'s, pointed to, not restated (room for the timeframe table)' },
    { old: '**6 Entry**: a completed 3m or 5m candle confirms: a retest of the broken level that holds, with a rejection candle there (preferred), or a continuation displacement.',
      now: '**6 Entry**: a completed candle confirms: a retest of the broken level that holds (a pullback: `pullback-vs-reversal`), with a rejection candle there (preferred), or a continuation displacement.',
      reason: `${GENERIC}; the retest is a pullback, pointed to its read` },
    { old: SIZE, now: TARGET, reason: SIZE_REASON },
    { old: 'Target: `m3.swingTargets`.', reason: TARGET_REASON },
    { old: '**Paired with `mtf-rejection`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
      now: '**Paired with `rejection`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
      reason: 'the renamed skill' },
    { old: 'Skip: at the IB high 21560.00: on the 15m close only a wick beyond, close 21556.25 (no acceptance);',
      now: 'Skip: at the IB high 21560.00: on the 3m close only a wick beyond, close 21556.25 (no acceptance);',
      reason: 'the same skip on a 3m candle (in the briefing): the examples show at least two timeframes' },
  ],
};

// Edits made to the new skills since the rename (skill-split-late.js), each with its reason: the coverage test holds
// each skill to its edited text, and an edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = {
  rejection: [
    { from: "Completed candles only, on 3m, 5m, 15m and 60m (`candle-reading`).",
      to: "Completed candles only, on 3m, 5m, 15m, 1h and 4h (`candle-reading`).",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "**1 HTF**: the 60m and 15m bias (`h1.h1.trend`, `m15.frame.trend`) and `trend-vs-range`.",
      to: "**1 HTF**: the 1h and 15m bias (`h1.h1.trend`, `m15.frame.trend`) and `trend-vs-range`.",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "**4 Setup**: a completed candle rejects the level: it trades through and closes back inside, with a long wick and the close in the opposite third, or an engulfing at the level (`candle-reading`; each timeframe's entry of `m3.candles`: `rejected`).",
      to: ["**4 Setup**: a completed candle rejects the level: the briefing's relation `rejected` (traded through it, closed back; read `<tf> rejected <level> up|down`).","A long wick, the close in the opposite third or an engulfing grade its strength (`candle-reading`); a candle's sweep of its previous candle is one too (`breakout-vs-fakeout`)."],
      reason: "a rejection is the briefing's relation (traded through, closed back); the wick, the close third and an engulfing grade it; a candle's sweep is one (the skill audit, fix/skills-concept-owners)" },
    { from: "**6 Entry**: after a 15m or 60m rejection, a completed 3m or 5m candle confirms the same way: a displacement candle, or a break of the small pullback structure (`m3.lastBreak.last`).",
      to: "**6 Entry**: after a 15m or 1h rejection, a completed 3m or 5m candle confirms the same way: a displacement candle, or a break of the small pullback structure (`m3.lastBreak.last`).",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "Take: at the RTH VWAP 21520.50, 60m and 15m up: on the 15m close a wick to 21517.25, close 21523.00",
      to: "Take: at the RTH VWAP 21520.50, 1h and 15m up: on the 15m close a wick to 21517.25, close 21523.00",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "Skip: at the swing high 21588.25 (3m, a minor level), 60m and 15m up: on the 3m close a shooting star",
      to: "Skip: at the swing high 21588.25 (3m, a minor level), 1h and 15m up: on the 3m close a shooting star",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "Loser: at the prior RTH low 21402.00: on the 60m close a rejection (L 21396.75, C 21405.50), on the",
      to: "Loser: at the prior RTH low 21402.00: on the 1h close a rejection (L 21396.75, C 21405.50), on the",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
  ],
  breakout: [
    { from: "Completed candles only, on 3m, 5m, 15m and 60m (`candle-reading`).",
      to: "Completed candles only, on 3m, 5m, 15m, 1h and 4h (`candle-reading`).",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "**1 HTF**: the 60m and 15m bias (`h1.h1.trend`, `m15.frame.trend`) agrees with the break, or the range is mature (`trend-vs-range`).",
      to: "**1 HTF**: the 1h and 15m bias (`h1.h1.trend`, `m15.frame.trend`) agrees with the break, or the range is mature (`trend-vs-range`).",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "**4 Setup**: a completed candle closes beyond the level with acceptance: a strong close in the extreme third, the body beyond the level, not just a wick (`breakout-vs-fakeout`, `candle-reading`).",
      to: "**4 Setup**: a completed candle closes beyond the level with acceptance (the briefing's `broke`: `<tf> broke <level> up|down`): a strong close in the extreme third, the body beyond the level, not just a wick (`breakout-vs-fakeout`, `candle-reading`).",
      reason: "the briefing's relation and its read form (the skill audit, fix/skills-concept-owners)" },
    { from: "Take: at the prior RTH high 21615.00, 60m and 15m up: on the 15m close a body beyond, close 21624.75",
      to: "Take: at the prior RTH high 21615.00, 1h and 15m up: on the 15m close a body beyond, close 21624.75",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
    { from: "Loser: at the overnight high 21614.75: on the 60m close a body beyond, close 21629.50; on the 3m close a",
      to: "Loser: at the overnight high 21614.75: on the 1h close a body beyond, close 21629.50; on the 3m close a",
      reason: "\"60m\" is written \"1h\" (the briefing's and the reads' name), and the 4h candle is in the stack (fix/skills-concept-owners)" },
  ],
};
const LATE_STALE = [];
for (const h of Object.keys(LATE)) {
  const r = withLate(ALLOWED[h], LATE[h], units(read(PAIRS[h].file)));
  ALLOWED[h] = r.allowed;
  LATE_STALE.push(...r.stale.map(l => `${h}: ${l.from}`));
}

/** What differs between an old skill and its new home, beyond that home's allowed exceptions: [] when nothing does. */
function differences(beforeText, homeText, home) {
  const before = count(units(beforeText));
  const after = count(units(homeText));
  const list = ALLOWED[home] || [];
  const allowed = new Map(list.map(a => [a.old, a]));
  const bad = [];
  for (const [u, n] of before) {
    if (STRUCTURE.includes(u)) continue;
    const a = allowed.get(u);
    const want = a ? (a.copies || 0) : n;
    if ((after.get(u) || 0) !== want) bad.push(`${home}: ${JSON.stringify(u)}: ${n} before, ${after.get(u) || 0} after${a ? ` (allowed: ${want})` : ''}`);
  }
  for (const a of list) {
    if (!before.has(a.old)) bad.push(`${home}: allow-list entry not in the old skill: ${a.old}`);
    for (const now of [a.now || []].flat()) if (after.get(now) !== 1) bad.push(`${home}: changed sentence ${after.get(now) || 0} times, not once: ${now}`);
  }
  for (const h of STRUCTURE) if (after.get(h) !== 1) bad.push(`${home}: "${h}" heading ${after.get(h) || 0} times, not once`);
  return bad;
}

const homeText = h => read(`skills/${h}/SKILL.md`);
const allDifferences = (texts = {}) => HOMES.flatMap(h => differences(read(PAIRS[h].file), texts[h] === undefined ? homeText(h) : texts[h], h));

test('setup rename: every unit of each old skill is in its new skill, as often as before, byte-for-byte (whitespace normalised)', () => {
  for (const h of HOMES) {
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, PAIRS[h].file))).digest('hex');
    assert.strictEqual(sha, PAIRS[h].sha256, `${PAIRS[h].file}: the fixture is the old skill, unchanged`);
  }
  assert.deepStrictEqual(allDifferences(), []);
  assert.deepStrictEqual(LATE_STALE, [], 'every late edit matches a unit');
  for (const a of HOMES.flatMap(h => ALLOWED[h])) assert.ok(a.reason, a.old);
});

test('setup rename: the comparison catches a lost, a doubled, an edited or a moved sentence, and a stale exception', () => {
  const n = HOMES.flatMap(h => units(read(PAIRS[h].file))).length;
  assert.ok(n > 60, `the units are fine-grained (${n})`);
  const rej = homeText('rejection');
  const brk = homeText('breakout');
  const KEPT = 'It is never a reason to enter without a fired strategy.';
  const EVIDENCE = '**Evidence**: not measured as a setup yet; candle patterns alone have weak evidence in general.';
  assert.ok(rej.replace(/\s+/g, ' ').includes(EVIDENCE));
  const cut = rej.replace(/\*\*Evidence\*\*: not measured as a setup yet; candle patterns alone have weak\s+evidence in general\./, '');
  assert.notStrictEqual(cut, rej);
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(allDifferences({ rejection: cut }), []);
  // Moved: the same sentence taken out of rejection and put into breakout (the pooled count would not see it).
  assert.notDeepStrictEqual(allDifferences({ rejection: cut, breakout: `${brk}\n${EVIDENCE}\n` }), []);
  // Doubled: the same sentence once more.
  assert.notDeepStrictEqual(allDifferences({ rejection: `${rej}\n${KEPT}\n` }), []);
  // Edited: one word changed.
  assert.notDeepStrictEqual(allDifferences({ rejection: rej.replace('Never anticipate it.', 'Never rush it.') }), []);
  // A changed sentence reverted to its old text (the exception no longer needed) also fails: the list only shrinks.
  assert.notDeepStrictEqual(allDifferences({ rejection: rej.replace('**Paired with `breakout`**', '**Paired with `mtf-breakout`**') }), []);
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
