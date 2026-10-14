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

// Deliberate differences, each with its reason. None today: every unit moved unchanged. An entry is
// { old, now?, copies?, reason }, as in the broker-mcp split.
const ALLOWED = [];

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

test('strategy-library split: every unit of the old skill is in exactly one new home, byte-for-byte (whitespace normalised)', () => {
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts()), []);
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
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap('harness-root', homes[at('harness-root')].replace('## Examples', '## Example'))), []);
});

test('strategy-library split: each skill answers one question in a short index line; strategy-library keeps the priority order and points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
  }
  const sl = read('skills/strategy-library/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(sl, new RegExp(`the \`${s}\` skill`), `strategy-library points to ${s}`);
  assert.match(sl, /### Apply a strategy/);
  assert.match(sl, /### The priority order: the rule for every setup/);
  assert.doesNotMatch(sl, /### (Read the library|What the code enforces|Find the harness root)|retired-lane|trigger-fired|FTH_ROOT|filtersFailed/);
  // The priority order is in strategy-library only (the content test holds the rest of the priority-order guard).
  for (const s of HOMES.slice(1)) assert.doesNotMatch(read(`skills/${s}/SKILL.md`), /\*\*Hard stops → no trade\*\*|floor\(size \/ 2\)/, s);
  // The place the strategies_* tool rows land (the harness-tools split): strategy-scan's own section.
  assert.match(read('skills/strategy-scan/SKILL.md'), /### The strategy tools/);
});
