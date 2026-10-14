'use strict';

// The session-timing skill was split by job: session-timing keeps the clock (the trading day, the named sessions, the
// windows table and which windows allow entries); news-blackouts takes the scheduled news and the blackouts file,
// exchange-holidays the holiday and early-close calendar, contract-roll the quarterly roll. This test proves nothing
// was lost or doubled: every sentence (and every table cell and code line) of the skill as it was
// (tests/fixtures/skill-split/session-timing.before.txt, frozen) is in the new homes exactly as many times as before,
// byte-for-byte after whitespace is normalised, in its old order within each home. The only exceptions are listed,
// each with its reason; an exception that no longer differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/session-timing/SKILL.md as main had it before the split (at e7433091): pinned, so a sentence can't be dropped
// from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/session-timing.before.txt';
const BEFORE_SHA256 = '945dce149bfc098d267f9717d5311cfbb45c34f0e7f5b87abe5aaa58564b490e';
const HOMES = ['session-timing', 'news-blackouts', 'exchange-holidays', 'contract-roll'];

// Deliberate differences, each with its reason.
const ALLOWED = [
  // The news rows of the windows table moved to news-blackouts, which carries the table's header for them.
  ...['Window (ET)', 'Character', 'Harness'].map(old => ({ old, copies: 2, reason: 'the windows table header, in session-timing and news-blackouts' })),
];

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('session-timing split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('session-timing split: the comparison catches a lost, a doubled, an edited or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 60, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('Blackout 08:25–08:40'), 'a table cell is a unit');
  assert.ok(u.includes('Tell the user; never work around it.'), 'a sentence is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const S = 'Tell the user; never work around it.';
  const hol = homes[at('exchange-holidays')];
  assert.ok(hol.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap('exchange-holidays', hol.replace(S, '')), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('contract-roll', `${homes[at('contract-roll')]}\n${S}\n`), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('exchange-holidays', hol.replace('(default 12:50 ET)', '(default 12:45 ET)')), ALLOWED), []);
  // Reordered: two rows of the news table swapped (nothing lost, the order changed).
  const nb = homes[at('news-blackouts')];
  const R1 = /^\| 08:30 .*\n/m.exec(nb)[0];
  const R2 = /^\| 10:00 .*\n/m.exec(nb)[0];
  const swapped = nb.replace(R1, '\u0000').replace(R2, R1).replace('\u0000', R2);
  assert.deepStrictEqual(differences(old, swap('news-blackouts', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('news-blackouts', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // A table header in a third home, or a section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap('contract-roll', `${homes[at('contract-roll')]}\n| Window (ET) | x |\n`), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap('contract-roll', homes[at('contract-roll')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('session-timing split: each skill has a short "Use when" index line, and session-timing points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const st = read('skills/session-timing/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(st, new RegExp(`the \`${s}\` skill`), `session-timing points to ${s}`);
  assert.doesNotMatch(st, /Holidays and early closes\.|Contract roll\.|Blackouts\.|Blackout 08:25/);
  for (const s of HOMES.slice(1)) assert.ok(!STRUCTURE.some(h => !read(`skills/${s}/SKILL.md`).includes(`## ${h}`)), s);
});

test('session-timing split: the news analyst loads what its steps use (the events and blackouts, the calendar)', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const nc = parseFrontmatter(read('agents/news-calendar-analyst.md')).data['role-skills'];
  for (const s of ['news-blackouts', 'exchange-holidays']) assert.ok(nc.includes(s), s);
  // The head trader's pointers name the skill that has the fact.
  assert.match(read('skills/premarket/SKILL.md'), /see `exchange-holidays`/);
  assert.match(read('skills/premarket/SKILL.md').replace(/\s+/g, ' '), /read with care \(`contract-roll`\)/);
  assert.match(read('skills/trade-session/SKILL.md').replace(/\s+/g, ' '), /the roll guidance in `contract-roll`/);
});
