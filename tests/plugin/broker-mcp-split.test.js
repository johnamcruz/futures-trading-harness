'use strict';

// The broker-mcp skill was split into single-responsibility skills (broker-mcp keeps the server, its tools and the
// session loop; order-mechanics, order-failures, order-rationale, trade-journal, gate-refusals and broker-refusals
// take the rest). This test proves nothing was lost or doubled: every sentence (and every table cell and code line)
// of the skill as it was (tests/fixtures/skill-split/broker-mcp.before.txt, frozen) appears in the new skills exactly
// as many times as it did before, byte-for-byte after whitespace is normalised. The only exceptions are listed below,
// each with its reason; an exception that no longer differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BEFORE = 'tests/fixtures/skill-split/broker-mcp.before.txt';
const HOMES = ['broker-mcp', 'order-mechanics', 'order-failures', 'order-rationale', 'trade-journal', 'gate-refusals', 'broker-refusals'];

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

// Deliberate differences, each with its reason.
const ALLOWED = [
  // Section headings dropped: each section is now a skill, named by its own heading.
  { old: 'Failures and limits', reason: 'now the order-failures skill' },
  { old: 'Journal', reason: 'now the trade-journal skill' },
  { old: 'Harness rationale convention (the order gate reads it)', reason: 'now the order-rationale skill' },
  { old: 'Errors', reason: 'now the gate-refusals and broker-refusals skills' },
  // Pointers to a section that is now another skill.
  { old: 'Never send the entry again (the gateway refuses new entries with `[order-pending]` until the order settles; Failures and limits).',
    now: 'Never send the entry again (the gateway refuses new entries with `[order-pending]` until the order settles; the `order-failures` skill).',
    reason: 'the Failures and limits section is the order-failures skill' },
  { old: '(Right after a close whose reply was an error, the gate refuses the `[protect]`: `close_position` again; see Errors.)',
    now: '(Right after a close whose reply was an error, the gate refuses the `[protect]`: `close_position` again; see the `gate-refusals` skill.)',
    reason: 'the Errors table\'s row for it is in the gate-refusals skill' },
  // Deliberately in two homes: both refusal skills carry the error table's header.
  { old: 'Message', copies: 2, reason: 'the table header, in gate-refusals and broker-refusals' },
  { old: 'Meaning', copies: 2, reason: 'the table header, in gate-refusals and broker-refusals' },
  { old: 'Do', copies: 2, reason: 'the table header, in gate-refusals and broker-refusals' },
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
    if (a.now && after.get(a.now) !== 1) bad.push(`changed sentence in ${after.get(a.now) || 0} homes, not 1: ${a.now}`);
  }
  for (const h of STRUCTURE) if (after.get(h) !== homeTexts.length) bad.push(`"${h}" heading: ${after.get(h) || 0}, not one per skill`);
  return bad;
}

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('broker-mcp split: every unit of the old skill is in exactly one new home, byte-for-byte (whitespace normalised)', () => {
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts()), []);
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('broker-mcp split: the comparison catches a lost, a doubled or an edited sentence, and a stale exception', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 200, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('errorCode 5 `OutsideTradingHours`'), 'a table cell is a unit');
  assert.ok(u.includes('Reuse the runner\'s bars file; one request per extra timeframe.'), 'a sentence is a unit');
  const homes = homeTexts();
  const at = HOMES.indexOf('order-failures');
  const withFailures = text => homes.map((h, i) => (i === at ? text : h));
  const CLOSE = '`close_position` leaves resting stop/target orders: cancel them.';
  const mech = HOMES.indexOf('order-mechanics');
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(differences(old, homes.map((h, i) => (i === mech ? h.replace(CLOSE, '') : h))), []);
  // Doubled: the same sentence in a second home.
  assert.notDeepStrictEqual(differences(old, withFailures(`${homes[at]}\n${CLOSE}\n`)), []);
  // Edited: one word changed.
  assert.notDeepStrictEqual(differences(old, withFailures(homes[at].replace(/Reuse the runner's bars\s+file;/, 'Reuse the bars file;'))), []);
  // A changed sentence reverted to its old text (the exception no longer needed) also fails: the list only shrinks.
  assert.notDeepStrictEqual(differences(old, withFailures(homes[at].replace('see the `gate-refusals` skill.)', 'see Errors.)'))), []);
});

test('broker-mcp split: each new skill answers one question in a short index line, and broker-mcp says where the rest is', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
  }
  const bm = read('skills/broker-mcp/SKILL.md');
  for (const s of HOMES.slice(1)) assert.match(bm, new RegExp(`the \`${s}\` skill`), `broker-mcp points to ${s}`);
  // The tool table and the session loop stay in broker-mcp; the order sections left it.
  assert.match(bm, /### Session loop/);
  assert.match(bm, /### Tools/);
  assert.doesNotMatch(bm, /### (Order mechanics|Failures and limits|Journal|Errors)|stopLossBracket|errorCode/);
});
