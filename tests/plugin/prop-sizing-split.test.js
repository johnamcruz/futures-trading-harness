'use strict';

// prop-challenge-pacing and position-sizing were split by job. prop-challenge-pacing keeps the harness-tracked attempt
// (its state, its verdicts, what the gate refuses); prop-evaluator takes scoring a policy on history, and
// prop-pacing-judgment pacing with no running attempt. position-sizing keeps the sizing steps; micro-mini-specs takes
// the micro and mini spec table. These tests prove nothing was lost or doubled: every sentence (and every table cell
// and code line) of each skill as it was (tests/fixtures/skill-split/*.before.txt, frozen) is in its new homes exactly
// as many times as before, byte-for-byte after whitespace is normalised, in the home its old section maps to, in its
// old order within each home. The only exceptions are listed, each with its reason; an exception that no longer
// differs fails too, so the lists only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, count, differences, STRUCTURE } = require('./skill-split');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const skill = s => read(`skills/${s}/SKILL.md`);

// Each old skill, as main had it before the split (at ef7c9544, after the retired tool skill was split: the combine_status
// row in prop-challenge-pacing, position-sizing step 8's pointer to order-plan): pinned, so a sentence can't be
// dropped from the fixture and from its new home together. `moved`: the homes other than the kept skill (homes[0]), each with the old
// fixture's line ranges (1-based, inclusive) that go to it, and single units moved out of a block that stays; every
// other unit of the old skill belongs to the kept skill.
const SPLITS = {
  'prop-challenge-pacing': {
    before: 'tests/fixtures/skill-split/prop-challenge-pacing.before.txt',
    sha256: 'fab004b179da5f5ce4d4b89b42a7a16323927845fba4c7e1acb92dd611fb548d',
    homes: ['prop-challenge-pacing', 'prop-evaluator', 'prop-pacing-judgment'],
    moved: {
      // "Scoring a policy strategy on history (the evaluator)", its body.
      'prop-evaluator': { lines: [[124, 146]] },
      // When to Use (start of day, after a big win or a drawdown), "Pacing by judgment", and its example.
      'prop-pacing-judgment': { lines: [[10, 11], [150, 176], [197, 201]] },
    },
    allowed: [
      // Section headings dropped: each section is now a skill, named by its own heading.
      { old: 'Scoring a policy strategy on history (the evaluator)', reason: 'now the prop-evaluator skill' },
      { old: 'Pacing by judgment (no account profile)', reason: 'now the prop-pacing-judgment skill, whose When to Use and How It Works state its scope' },
    ],
  },
  'position-sizing': {
    before: 'tests/fixtures/skill-split/position-sizing.before.txt',
    sha256: 'ad2b70ca7fa99844f29287fe5cb751e97f64d6fcfd336b7b7cc73e54daf45790',
    homes: ['position-sizing', 'micro-mini-specs'],
    moved: {
      // Step 1's table and the contract-naming paragraph, and the sentence that introduced the table.
      'micro-mini-specs': { lines: [[18, 28]], units: ['The table is for sanity checks only:'] },
    },
    allowed: [],
  },
};

/** The old units each home must hold: Map home -> Map unit -> count (the kept skill takes every unit not moved). */
function expectedHomes(s, beforeText) {
  const lines = beforeText.split('\n');
  const dropped = new Set(s.allowed.filter(a => !a.copies && !a.now).map(a => a.old));
  const all = count(units(beforeText).filter(u => !STRUCTURE.includes(u) && !dropped.has(u)));
  const out = new Map();
  const rest = new Map(all);
  for (const [home, m] of Object.entries(s.moved)) {
    const text = (m.lines || []).map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n\n');
    const want = count([...units(text), ...(m.units || [])].filter(u => !STRUCTURE.includes(u)));
    for (const [u, n] of want) {
      if ((rest.get(u) || 0) < n) throw new Error(`${home}: "${u}" is not in the old skill ${n} time(s)`);
      rest.set(u, rest.get(u) - n);
    }
    out.set(home, want);
  }
  out.set(s.homes[0], new Map([...rest].filter(([, n]) => n > 0)));
  return out;
}

/** Old units in a home their old section doesn't map to (or missing from the one it does): [] when each is home. */
function homeErrors(s, beforeText, homeTexts) {
  const expected = expectedHomes(s, beforeText);
  const old = new Set(units(beforeText));
  const bad = [];
  s.homes.forEach((home, i) => {
    const got = count(units(homeTexts[i]).filter(u => old.has(u) && !STRUCTURE.includes(u)));
    const want = expected.get(home);
    for (const u of new Set([...got.keys(), ...want.keys()])) {
      if ((got.get(u) || 0) !== (want.get(u) || 0)) bad.push(`${home}: ${JSON.stringify(u)} ${got.get(u) || 0} time(s), its old section maps ${want.get(u) || 0} here`);
    }
  });
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
  test(`${name} split: every unit of the old skill is in exactly one new home, the one its section maps to, byte-for-byte, in its old order`, () => {
    assert.strictEqual(sha(s.before), s.sha256, 'the fixture is the old skill, unchanged');
    const homes = s.homes.map(skill);
    assert.deepStrictEqual(differences(read(s.before), homes, s.allowed), []);
    assert.deepStrictEqual(homeErrors(s, read(s.before), homes), [], 'each unit is in the home its old section maps to');
    assert.deepStrictEqual(orderErrors(read(s.before), homes, s.homes, s.allowed), [], 'moved text keeps its old order in each home');
    for (const a of s.allowed) assert.ok(a.reason, a.old);
  });
}

test('prop and sizing splits: the comparison catches a lost, a doubled, an edited, a misplaced or a reordered unit, and a stale exception', () => {
  const P = SPLITS['prop-challenge-pacing'];
  const old = read(P.before);
  assert.ok(units(old).length > 80, `the units are fine-grained (${units(old).length})`);
  const homes = P.homes.map(skill);
  const at = name => P.homes.indexOf(name);
  const swap = (...pairs) => homes.map((h, i) => { const p = pairs.find(([n]) => at(n) === i); return p ? p[1] : h; });
  const pj = homes[at('prop-pacing-judgment')];
  const ev = homes[at('prop-evaluator')];
  const pp = homes[at('prop-challenge-pacing')];
  const RED = '**After a red day,** the next day\'s budget is half until a green day.';
  assert.ok(units(pj).includes(RED), 'a list item is a unit');
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(differences(old, swap(['prop-pacing-judgment', pj.replace(`4. ${RED}\n`, '')]), P.allowed), [], 'lost');
  // Doubled: the same sentence in a second home.
  assert.notDeepStrictEqual(differences(old, swap(['prop-evaluator', `${ev}\n${RED}\n`]), P.allowed), [], 'doubled');
  // Edited: one number changed.
  assert.notDeepStrictEqual(differences(old, swap(['prop-pacing-judgment', pj.replace('≤ 10% of the cushion', '≤ 15% of the cushion')]), P.allowed), [], 'edited');
  // Misplaced: a gate-refusal bullet moved from prop-challenge-pacing (core) to prop-evaluator (read by no role), or to
  // prop-pacing-judgment: nothing is lost or doubled, but it left its home.
  const MARKETS = /^- \*\*Several markets, one account\*\*[^]*?whole cushion\.\n/m.exec(pp)[0];
  for (const to of ['prop-evaluator', 'prop-pacing-judgment']) {
    const moved = swap(['prop-challenge-pacing', pp.replace(MARKETS, '')], [to, homes[at(to)].replace('\n## Examples', `\n${MARKETS}\n## Examples`)]);
    assert.deepStrictEqual(differences(old, moved, P.allowed), [], `a move to ${to} loses nothing`);
    assert.notDeepStrictEqual(homeErrors(P, old, moved), [], `but a move to ${to} leaves its home`);
  }
  // Reordered: two rules of thumb swapped (the content is all there, the order is not).
  const R4 = /4\. \*\*After a red day,\*\*[^\n]*\n/.exec(pj)[0];
  const R5 = /5\. \*\*Near the target,\*\*[^\n]*\n/.exec(pj)[0];
  const swapped = swap(['prop-pacing-judgment', pj.replace(`${R4}${R5}`, `${R5}${R4}`)]);
  assert.deepStrictEqual(differences(old, swapped, P.allowed), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swapped, P.homes, P.allowed), [], 'but changes the order');
  // A stale exception: a dropped heading put back.
  assert.notDeepStrictEqual(differences(old, swap(['prop-evaluator', ev.replace('## How It Works\n', '## How It Works\n\n### Scoring a policy strategy on history (the evaluator)\n')]), P.allowed), [], 'stale');
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap(['prop-evaluator', ev.replace('## Examples', '## Example')]), P.allowed), [], 'structure');
  // The sizing split: a table cell edited, and the table moved back into position-sizing.
  const S = SPLITS['position-sizing'];
  const sh = S.homes.map(skill);
  assert.ok(units(read(S.before)).includes('12.50'), 'a table cell is a unit');
  assert.notDeepStrictEqual(differences(read(S.before), [sh[0], sh[1].replace('| 12.50 |', '| 12.00 |')], S.allowed), [], 'cell edited');
  const ROW = '   | MCL | CL | 0.01 | 1.00 | 10.00 |\n';
  assert.ok(sh[1].includes(ROW));
  assert.notDeepStrictEqual(homeErrors(S, read(S.before), [`${sh[0]}\n${ROW}`, sh[1].replace(ROW, '')]), [], 'a row moved back');
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
  // Judgment pacing says in its own text (full mode doesn't embed descriptions) that a running attempt isn't its.
  const pj = skill('prop-pacing-judgment').replace(/^---\n[^]*?\n---\n/, '').replace(/\s+/g, ' ');
  for (const sec of ['## When to Use', '## How It Works']) {
    const body = pj.slice(pj.indexOf(sec), pj.indexOf('## ', pj.indexOf(sec) + 3));
    assert.match(body, /no harness-tracked attempt is running \(`combine_status` lists none[^.]*the `prop-challenge-pacing` skill/, sec);
  }
  // The risk manager carries judgment pacing in its core (stand-down rules with no trigger) and reads the spec table
  // only when a cycle needs it (the gate checks specs in code); the evaluator is the user's command, read by no role.
  const rm = read('agents/risk-manager.md');
  assert.match(rm, /^role-skills: \[position-sizing, prop-challenge-pacing, prop-pacing-judgment,/m);
  assert.match(rm, /^role-index: \[[^\]]*\bmicro-mini-specs\b/m);
  assert.doesNotMatch(rm, /^role-index: \[[^\]]*\bprop-pacing-judgment\b/m);
  assert.match(rm.replace(/\s+/g, ' '), /no running attempt \(`combine_status` lists none\), pace by the `prop-pacing-judgment` skill\./);
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) assert.doesNotMatch(read(`agents/${f}`), /prop-evaluator/, f);
});

test('micro-mini-specs: every row whose roots contracts.js lists agrees with it (scripts/lib/trading/contracts.js)', () => {
  const { CONTRACT_SPECS } = require('../../scripts/lib/trading/contracts');
  const rows = skill('micro-mini-specs').split('\n').map(l => l.trim()).filter(l => /^\| M[A-Z0-9]+ \|/.test(l));
  assert.ok(rows.length >= 4, 'the table has rows');
  let checked = 0;
  for (const row of rows) {
    const [micro, mini, tick, microValue, miniValue] = row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    for (const [root, value] of [[micro, microValue], [mini, miniValue]]) {
      const spec = CONTRACT_SPECS[root];
      if (!spec) continue; // a root contracts.js doesn't list (the broker's specs decide)
      assert.strictEqual(Number(tick), spec.tickSize, `${root} tick size`);
      assert.strictEqual(Number(value), spec.tickValue, `${root} tick value`);
      checked += 1;
    }
  }
  assert.ok(checked >= 8, `checked ${checked}`);
});
