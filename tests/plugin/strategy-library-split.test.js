'use strict';

// The strategy-library skill was split into single-responsibility skills (strategy-library keeps applying a strategy
// and the priority order; strategy-scan, strategy-gate-checks and harness-root take the rest). This test proves
// nothing was lost or doubled: every sentence (and every code line) of the skill as it was
// (tests/fixtures/skill-split/strategy-library.before.txt, frozen) appears in the new skills exactly as many times as
// it did before, byte-for-byte after whitespace is normalised. The only exceptions are listed below, each with its
// reason; an exception that no longer differs fails too, so the list can only shrink. The unit rules are the
// broker-mcp split's (tests/plugin/broker-mcp-split.test.js), so both splits are held to the same standard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BEFORE = 'tests/fixtures/skill-split/strategy-library.before.txt';
// The fixture is the skill exactly as main had it before the split (skills/strategy-library/SKILL.md at e7433091):
// pinned, so a sentence can't be dropped from the fixture and from its new home together.
const BEFORE_SHA256 = '04ad2fa5415f803c9c90fb3c7fca24e0b929aa22d34d1ea869bcc10577b67c64';
const HOMES = ['strategy-library', 'strategy-scan', 'strategy-gate-checks', 'harness-root'];

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

// The skill format's own section headings: every new skill has them (CLAUDE.md, skill format).
const STRUCTURE = ['When to Use', 'How It Works', 'Examples'];

// Deliberate differences, each with its reason. An entry is { old, now?, copies?, reason }, as in the broker-mcp split.
const ALLOWED = [
  // A truth fix in moved text (pre-existing): orb's `risk.min_rr` is 2 (strategies/orb/STRATEGY.md), and the scan's
  // summary prints the stop in points, whole ticks and one contract's dollars, then the exit and the confluence, in full
  // (harness-tools/compact.js candidateLine; orb's exit trails from 2R giving back 0.5R).
  { old: 'strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stopDistance 5.25, minRR 1.5 (a candidate)',
    now: 'strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none (a candidate)',
    reason: 'the example as the scan prints it, with orb\'s own min R:R' },
  // A pointer to a skill retired later (tests/plugin/harness-tools-split.test.js): the strategies tools' rows are
  // strategy-tools'.
  { old: 'With the harness tools (the `harness-tools` skill):', now: 'With the harness tools (`strategy-tools`):',
    reason: 'the tool skill is retired; the strategies tools\' rows are in strategy-tools' },
];

/** What differs between the old skill and the new homes, beyond the allowed exceptions: [] when nothing does. */
function differences(beforeText, homeTexts) {
  const before = count(units(beforeText));
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
    if (!before.has(a.old)) bad.push(`allow-list entry not in the old skill: ${a.old}`);
    for (const now of [a.now || []].flat()) if (after.get(now) !== 1) bad.push(`changed sentence in ${after.get(now) || 0} homes, not 1: ${now}`);
  }
  for (const h of STRUCTURE) if (after.get(h) !== homeTexts.length) bad.push(`"${h}" heading: ${after.get(h) || 0}, not one per skill`);
  return bad;
}

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

/**
 * Units out of their old order: in each home, the units that came from the old skill (a changed one standing in for
 * its old text) keep their old relative order, numbered steps included. [] when every home keeps it.
 */
function orderErrors(beforeText, homeTexts) {
  const old = units(beforeText);
  const nowToOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  homeTexts.forEach((text, h) => {
    const used = new Map();
    let last = -1;
    let lastUnit = '';
    for (const u0 of units(text)) {
      const u = nowToOld.get(u0) || u0;
      if (STRUCTURE.includes(u)) continue;
      const from = used.has(u) ? used.get(u) + 1 : 0;
      const at = old.indexOf(u, from);
      if (at < 0) continue; // new text, not from the old skill
      used.set(u, at);
      if (at < last) bad.push(`${HOMES[h]}: ${JSON.stringify(u)} now comes after ${JSON.stringify(lastUnit)}; it came before it`);
      last = at;
      lastUnit = u;
    }
  });
  return bad;
}

test('strategy-library split: every unit of the old skill is in exactly one new home, byte-for-byte (whitespace normalised)', () => {
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts()), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts()), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('strategy-library split: the comparison catches a lost, a doubled or an edited sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 80, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('Exits and protective stops on either leg always go.'), 'a sentence is a unit');
  assert.ok(u.includes('strategies_list {} name, status, signal, instruments'), 'a code line is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const LEG = 'Exits and protective stops on either leg always go.';
  const gate = homes[at('strategy-gate-checks')];
  assert.ok(gate.includes(LEG));
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(differences(old, swap('strategy-gate-checks', gate.replace(LEG, ''))), []);
  // Doubled: the same sentence in a second home.
  assert.notDeepStrictEqual(differences(old, swap('harness-root', `${homes[at('harness-root')]}\n${LEG}\n`)), []);
  // Edited: one word changed.
  assert.notDeepStrictEqual(differences(old, swap('strategy-gate-checks', gate.replace('never more than 45 minutes ago', 'never more than 50 minutes ago'))), []);
  // Reordered: two numbered steps of the priority order swapped (the content is all there, the order is not).
  const lib = homes[at('strategy-library')];
  const ROOM = /3\. \*\*Room\*\*[^]*?\(`needR`\) → no trade\.\n/.exec(lib)[0];
  const TREND = /2\. \*\*The trend rule\*\*[^]*?nearest\n {3}target\.\n/.exec(lib)[0];
  const swapped = lib.replace(TREND, '\u0000').replace(ROOM, TREND.replace('2. ', '3. ')).replace('\u0000', ROOM.replace('3. ', '2. '));
  assert.notStrictEqual(swapped, lib);
  assert.deepStrictEqual(differences(old, swap('strategy-library', swapped)), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('strategy-library', swapped)), [], 'but changes the order');
  // Two sentences of one paragraph swapped, in another home.
  const A1 = 'Exits and protective stops on either leg always go.';
  const A2 = '`paper` strategies can only be paper-traded.';
  assert.notDeepStrictEqual(orderErrors(old, swap('strategy-gate-checks', gate.replace(`${A1} ${A2}`, `${A2} ${A1}`))), []);
  // A changed line reverted to its old text (the exception no longer needed) also fails: the list only shrinks.
  const scan = homes[at('strategy-scan')];
  assert.notDeepStrictEqual(differences(old, swap('strategy-scan', scan.replace(ALLOWED[0].now, ALLOWED[0].old))), []);
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap('harness-root', homes[at('harness-root')].replace('## Examples', '## Example'))), []);
});

test('strategy-library split: each skill answers one question in a short index line; strategy-library keeps the priority order; no prompt grows', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
  }
  const sl = read('skills/strategy-library/SKILL.md').replace(/\s+/g, ' ');
  // No prompt grows (the owner's rule): the three pieces a trading role loads together are no larger than the old
  // skill's body, so their new text (headings, a bullet, an example) fits in what harness-root took away.
  const { parseFrontmatter: pf } = require('../../scripts/lib/frontmatter');
  const body = t => pf(t).body.trim().length;
  const pieces = ['strategy-library', 'strategy-scan', 'strategy-gate-checks'].reduce((n, x) => n + body(read(`skills/${x}/SKILL.md`)), 0);
  assert.ok(pieces <= body(read(BEFORE)), `the three pieces are ${pieces} characters, over the old skill's ${body(read(BEFORE))}`);
  assert.match(sl, /### Apply a strategy/);
  assert.match(sl, /### The priority order: the rule for every setup/);
  assert.doesNotMatch(sl, /### (Read the library|What the code enforces|Find the harness root)|retired-lane|trigger-fired|FTH_ROOT|filtersFailed/);
  // The priority order is in strategy-library only (the content test holds the rest of the priority-order guard).
  for (const s of HOMES.slice(1)) assert.doesNotMatch(read(`skills/${s}/SKILL.md`), /\*\*Hard stops → no trade\*\*|floor\(size \/ 2\)/, s);
  // The tool calls point to the strategies tools' rows (the strategy-tools skill).
  assert.match(read('skills/strategy-scan/SKILL.md'), /### Read the library\n\nWith the harness tools \(`strategy-tools`\):\n\n```text\nstrategies_list/);
});

test('strategy-library split: the head trader still loads all of the old skill (the gate requires the pieces; the prompt and trade-session name them)', () => {
  const { REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  // Every unit of the old skill is in a skill the main session must load before an entry, except harness-root's:
  // finding <root> is interactive use, and the autonomous prompt states the root itself ("Harness root (FTH_ROOT)").
  const asOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const loaded = new Set(REQUIRED_FOR_ENTRY.filter(s => HOMES.includes(s)).flatMap(s => units(read(`skills/${s}/SKILL.md`))).map(u => asOld.get(u) || u));
  const rootOnly = new Set(units(read('skills/harness-root/SKILL.md')));
  const lost = units(read(BEFORE)).filter(u => !STRUCTURE.includes(u) && !loaded.has(u) && !rootOnly.has(u));
  assert.deepStrictEqual(lost, [], 'the main session loads every section of the old strategy-library');
  assert.deepStrictEqual(HOMES.filter(s => !REQUIRED_FOR_ENTRY.includes(s)), ['harness-root']);
  // trade-session's step 0 names each required skill; the autonomous prompt does too.
  const step0 = /### 0\. Load the skills([^]*?)###/.exec(read('skills/trade-session/SKILL.md'))[1];
  for (const s of REQUIRED_FOR_ENTRY) assert.match(step0, new RegExp(`\`${s}\``), `trade-session step 0 names ${s}`);
  const A = require('../../scripts/lib/autotrader');
  const prompt = A.prompts(A.validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  // The gate's list, then its parenthetical, then any skill it doesn't require (ALSO_LOAD): "load a, b, and c (the order
  // gate refuses an entry without them); also load d before deciding".
  const sentence = /load ([^.(]*?)(?: \(the order gate refuses an entry without them\))?(?:; also load [^.()]*?)? before deciding/.exec(prompt)[1];
  assert.match(prompt, /\(the order gate refuses an entry without them\)/);
  for (const s of REQUIRED_FOR_ENTRY) assert.ok(sentence.split(/,\s*(?:and\s+)?|\s+and\s+/).includes(s), `the prompt names ${s}`);
});
