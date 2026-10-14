'use strict';

// prop-challenge-pacing and position-sizing were split by job. prop-challenge-pacing keeps the harness-tracked attempt
// (its state, its verdicts, what the gate refuses); prop-evaluator takes scoring a policy on history, and
// prop-pacing-judgment pacing an account with no profile. position-sizing keeps the sizing steps; micro-mini-specs takes
// the micro and mini spec table. These tests prove nothing was lost or doubled: every sentence (and every table cell
// and code line) of each skill as it was (tests/fixtures/skill-split/*.before.txt, frozen) is in its new homes exactly
// as many times as before, byte-for-byte after whitespace is normalised, in its old order within each home. The only
// exceptions are listed, each with its reason; an exception that no longer differs fails too, so the lists only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const skill = s => read(`skills/${s}/SKILL.md`);

/**
 * A skill's units: its body (no frontmatter) in blocks (a heading, a list item, a table row, a paragraph, a code
 * line), whitespace normalised, list and heading markers dropped; table rows split into cells; prose into sentences.
 * The same units as tests/plugin/broker-mcp-split.test.js.
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

// Each old skill, as main had it before the split (at e7433091): pinned, so a sentence can't be dropped from the
// fixture and from its new home together.
const SPLITS = {
  'prop-challenge-pacing': {
    before: 'tests/fixtures/skill-split/prop-challenge-pacing.before.txt',
    sha256: '15ec75fd42eea551f6a3994197488de1bb1b26592d429e09f642426d7f5d4d30',
    homes: ['prop-challenge-pacing', 'prop-evaluator', 'prop-pacing-judgment'],
    allowed: [
      // Section headings dropped: each section is now a skill, named by its own heading.
      { old: 'Scoring a policy strategy on history (the evaluator)', reason: 'now the prop-evaluator skill' },
      { old: 'Pacing by judgment (no account profile)', reason: 'now the prop-pacing-judgment skill' },
    ],
  },
  'position-sizing': {
    before: 'tests/fixtures/skill-split/position-sizing.before.txt',
    sha256: '744ff368b4011358e016478be0db4aa625aa6461ce5990f058881ae996804db0',
    homes: ['position-sizing', 'micro-mini-specs'],
    allowed: [],
  },
};

/** What differs between the old skill and the new homes, beyond the allowed exceptions: [] when nothing does. */
function differences(beforeText, homeTexts, allowed) {
  const before = count(units(beforeText));
  const after = count(homeTexts.flatMap(units));
  const byOld = new Map(allowed.map(a => [a.old, a]));
  const bad = [];
  for (const [u, n] of before) {
    if (STRUCTURE.includes(u)) continue;
    const a = byOld.get(u);
    const want = a ? (a.copies || 0) : n;
    if ((after.get(u) || 0) !== want) bad.push(`${JSON.stringify(u)}: ${n} before, ${after.get(u) || 0} after${a ? ` (allowed: ${want})` : ''}`);
  }
  for (const a of allowed) {
    if (!before.has(a.old)) bad.push(`allow-list entry not in the old skill: ${a.old}`);
    for (const now of [a.now || []].flat()) if (after.get(now) !== 1) bad.push(`changed sentence in ${after.get(now) || 0} homes, not 1: ${now}`);
  }
  for (const h of STRUCTURE) if (after.get(h) !== homeTexts.length) bad.push(`"${h}" heading: ${after.get(h) || 0}, not one per skill`);
  return bad;
}

/** Units out of their old order: in each home, the units that came from the old skill keep their old relative order. */
function orderErrors(beforeText, homeTexts, homes, allowed) {
  const old = units(beforeText);
  const nowToOld = new Map(allowed.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  homeTexts.forEach((text, h) => {
    const used = new Map();
    let last = -1;
    let lastUnit = '';
    for (const u0 of units(text)) {
      const u = nowToOld.get(u0) || u0;
      if (STRUCTURE.includes(u)) continue;
      const at = old.indexOf(u, used.has(u) ? used.get(u) + 1 : 0);
      if (at < 0) continue; // new text, not from the old skill
      used.set(u, at);
      if (at < last) bad.push(`${homes[h]}: ${JSON.stringify(u)} now comes after ${JSON.stringify(lastUnit)}; it came before it`);
      last = at;
      lastUnit = u;
    }
  });
  return bad;
}

for (const [name, s] of Object.entries(SPLITS)) {
  test(`${name} split: every unit of the old skill is in exactly one new home, byte-for-byte, in its old order`, () => {
    assert.strictEqual(sha(s.before), s.sha256, 'the fixture is the old skill, unchanged');
    const homes = s.homes.map(skill);
    assert.deepStrictEqual(differences(read(s.before), homes, s.allowed), []);
    assert.deepStrictEqual(orderErrors(read(s.before), homes, s.homes, s.allowed), [], 'moved text keeps its old order in each home');
    for (const a of s.allowed) assert.ok(a.reason, a.old);
  });
}

test('prop and sizing splits: the comparison catches a lost, a doubled, an edited or a reordered unit, and a stale exception', () => {
  const P = SPLITS['prop-challenge-pacing'];
  const old = read(P.before);
  assert.ok(units(old).length > 80, `the units are fine-grained (${units(old).length})`);
  const homes = P.homes.map(skill);
  const swap = (name, text) => homes.map((h, i) => (i === P.homes.indexOf(name) ? text : h));
  const pj = homes[P.homes.indexOf('prop-pacing-judgment')];
  const RED = '**After a red day,** the next day\'s budget is half until a green day.';
  assert.ok(units(pj).includes(RED), 'a list item is a unit');
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(differences(old, swap('prop-pacing-judgment', pj.replace('4. **After a red day,** the next day\'s budget is half until a green day.\n', '')), P.allowed), [], 'lost');
  // Doubled: the same sentence in a second home.
  assert.notDeepStrictEqual(differences(old, swap('prop-evaluator', `${homes[1]}\n${RED}\n`), P.allowed), [], 'doubled');
  // Edited: one number changed.
  assert.notDeepStrictEqual(differences(old, swap('prop-pacing-judgment', pj.replace('≤ 10% of the cushion', '≤ 15% of the cushion')), P.allowed), [], 'edited');
  // Reordered: two rules of thumb swapped (the content is all there, the order is not).
  const R4 = /4\. \*\*After a red day,\*\*[^\n]*\n/.exec(pj)[0];
  const R5 = /5\. \*\*Near the target,\*\*[^\n]*\n/.exec(pj)[0];
  const swapped = swap('prop-pacing-judgment', pj.replace(`${R4}${R5}`, `${R5}${R4}`));
  assert.deepStrictEqual(differences(old, swapped, P.allowed), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swapped, P.homes, P.allowed), [], 'but changes the order');
  // A stale exception: a dropped heading put back.
  assert.notDeepStrictEqual(differences(old, swap('prop-evaluator', homes[1].replace('## How It Works\n', '## How It Works\n\n### Scoring a policy strategy on history (the evaluator)\n')), P.allowed), [], 'stale');
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap('prop-evaluator', homes[1].replace('## Examples', '## Example')), P.allowed), [], 'structure');
  // The sizing split: a table cell lost from micro-mini-specs.
  const S = SPLITS['position-sizing'];
  const sh = S.homes.map(skill);
  assert.ok(units(read(S.before)).includes('12.50'), 'a table cell is a unit');
  assert.notDeepStrictEqual(differences(read(S.before), [sh[0], sh[1].replace('| 12.50 |', '| 12.00 |')], S.allowed), [], 'cell edited');
});

test('prop and sizing splits: each new skill answers one question in a short index line, and the old skills point to the new', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of Object.values(SPLITS).flatMap(x => x.homes)) {
    const { data } = parseFrontmatter(skill(s));
    assert.strictEqual(data.name, s);
    assert.ok(data.description.length <= 160, `${s}: description ${data.description.length} chars, over 160`);
    assert.match(data.description, /^Use when /, s);
  }
  const pp = skill('prop-challenge-pacing');
  for (const s of ['prop-evaluator', 'prop-pacing-judgment']) assert.match(pp, new RegExp(`the \`${s}\` skill`), `prop-challenge-pacing points to ${s}`);
  assert.doesNotMatch(pp, /evaluate\.js|Rules of thumb|Target remaining/, 'the evaluator and judgment pacing left it');
  assert.match(skill('position-sizing'), /the\s+`micro-mini-specs`\s+skill/);
  assert.doesNotMatch(skill('position-sizing'), /\| MNQ \| NQ \|/, 'the table left position-sizing');
  // The risk manager reads judgment pacing and the spec table only when a cycle needs them; the evaluator is the
  // user's command, read by no role.
  const rm = read('agents/risk-manager.md');
  assert.match(rm, /^role-index: \[[^\]]*\bmicro-mini-specs\b[^\]]*\bprop-pacing-judgment\b/m);
  assert.match(rm, /^role-skills: \[position-sizing, prop-challenge-pacing,/m);
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) assert.doesNotMatch(read(`agents/${f}`), /prop-evaluator/, f);
});

test('micro-mini-specs: every row the harness\'s own table lists agrees with it (scripts/lib/trading/contracts.js)', () => {
  const { CONTRACT_SPECS } = require('../../scripts/lib/trading/contracts');
  const rows = skill('micro-mini-specs').split('\n').map(l => l.trim()).filter(l => /^\| M[A-Z0-9]+ \|/.test(l));
  assert.ok(rows.length >= 4, 'the table has rows');
  let checked = 0;
  for (const row of rows) {
    const [micro, mini, tick, microValue, miniValue] = row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    for (const [root, value] of [[micro, microValue], [mini, miniValue]]) {
      const spec = CONTRACT_SPECS[root];
      if (!spec) continue; // a root the harness's table doesn't list (the broker's specs decide)
      assert.strictEqual(Number(tick), spec.tickSize, `${root} tick size`);
      assert.strictEqual(Number(value), spec.tickValue, `${root} tick value`);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `checked ${checked}`);
});
