'use strict';

// The order-mechanics skill was split by job: order-types builds the order call (its type, its side, the stop bracket
// every entry carries); order-mechanics keeps reading its reply (refused or an unknown outcome, the leftovers of a
// close, partial fills, checking a new order once). The risk manager checks the bracket and reports working orders'
// protection, so it loads both, as the executor does. This test proves nothing was lost or doubled: every sentence
// (and every code line) of the skill as it was (tests/fixtures/skill-split/order-mechanics.before.txt, frozen) is in
// the two homes exactly as many times as before, byte-for-byte after whitespace is normalised, in its old order within
// each home. The only exceptions are listed, each with its reason; an exception that no longer differs fails too.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/order-mechanics/SKILL.md as main had it before the split (at e7433091, unchanged through 6b8febfa): pinned,
// so a sentence can't be dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/order-mechanics.before.txt';
const BEFORE_SHA256 = 'ee331528e771e03321738ef5499cd91a7fa6db61c2e86adc0d77b6842db8eb5f';
const HOMES = ['order-mechanics', 'order-types'];

// Deliberate differences, each with its reason. None: every unit moved unchanged.
const ALLOWED = [];

// The units of the old skill each home holds, by their start, in order (the section headings aside): a unit moved to
// the other home fails, though the coverage check alone still passes. order-mechanics holds every other old unit.
const OWN = {
  'order-types': ['Before any `place_order`', 'Types: `market`', '`buy` opens/adds', 'Every entry carries its stop', 'Always send it',
    'The broker server attaches', 'If it can\'t confirm that flatten'],
};
/** Homes whose old units differ from OWN: [] when each holds its own. */
function homeErrors(beforeText, homes) {
  const old = new Set(units(beforeText).filter(u => !STRUCTURE.includes(u)));
  const bad = [];
  for (const [name, want] of Object.entries(OWN)) {
    const got = units(homes[HOMES.indexOf(name)]).filter(u => old.has(u));
    if (got.length !== want.length || got.some((u, i) => !u.startsWith(want[i]))) bad.push(`${name}: ${got.map(u => u.slice(0, 30)).join(' | ')}`);
  }
  return bad;
}

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

test('order-mechanics split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  assert.deepStrictEqual(homeErrors(read(BEFORE), homeTexts()), [], 'each home holds its own units');
});

test('order-mechanics split: the comparison catches a lost, a doubled, an edited or a reordered sentence', () => {
  const old = read(BEFORE);
  assert.ok(units(old).length > 40, `the units are fine-grained (${units(old).length})`);
  const homes = homeTexts();
  const swap = (name, text) => homes.map((h, i) => (i === HOMES.indexOf(name) ? text : h));
  const S = '`buy` opens/adds long or closes short; `sell` the reverse.';
  const ot = homes[HOMES.indexOf('order-types')];
  assert.ok(ot.includes(S));
  assert.notDeepStrictEqual(differences(old, swap('order-types', ot.replace(S, '')), ALLOWED), [], 'lost');
  assert.notDeepStrictEqual(differences(old, swap('order-mechanics', `${homes[0]}\n- ${S}\n`), ALLOWED), [], 'doubled');
  assert.notDeepStrictEqual(differences(old, swap('order-types', ot.replace('closes short', 'closes a short')), ALLOWED), [], 'edited');
  // Reordered: two bullets swapped (nothing lost, the order changed).
  const B1 = /^- Types: [^]*?(?=^- `buy`)/m.exec(ot)[0];
  const B2 = /^- `buy`.*\n/m.exec(ot)[0];
  const swapped = ot.replace(B1, '\u0000').replace(B2, B1).replace('\u0000', B2);
  assert.deepStrictEqual(differences(old, swap('order-types', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('order-types', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // Moved to the other home, after its last old unit: nothing lost, nothing reordered, but in the wrong home.
  const CLOSE = '- `close_position` leaves resting stop/target orders: cancel them.\n';
  const om = homes[HOMES.indexOf('order-mechanics')];
  assert.ok(om.includes(CLOSE));
  const movedTypes = ot.replace('\n## Examples', `${CLOSE}\n## Examples`);
  const moved = homes.map((h, i) => (i === HOMES.indexOf('order-types') ? movedTypes : h.replace(CLOSE, '')));
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a move loses nothing');
  assert.deepStrictEqual(orderErrors(old, moved, HOMES, ALLOWED), [], 'nor reorders');
  assert.notDeepStrictEqual(homeErrors(old, moved), [], 'but the wrong home is caught');
});

test('order-mechanics split: a short "Use when" index line each; the bracket rule and the reply each have one home', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const om = read('skills/order-mechanics/SKILL.md');
  const ot = read('skills/order-types/SKILL.md');
  assert.match(ot, /Every entry carries its stop as `stopLossBracket/);
  assert.doesNotMatch(om, /Every entry carries its stop|^- Types:/m);
  assert.match(om, /\*\*Check a new order once; never wait for a fill\*\*/);
  assert.doesNotMatch(ot, /never wait for a fill/i);
  // order-types points to the reply's home; broker-mcp to both.
  assert.match(ot.replace(/\s+/g, ' '), /Reading the reply: the `order-mechanics` skill\./);
  const bm = read('skills/broker-mcp/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES) assert.match(bm, new RegExp(`the \`${s}\` skill`), `broker-mcp points to ${s}`);
});

test('order-mechanics split: the example is tick-correct (MNQ 0.25 tick, $0.50 a tick)', () => {
  const ex = read('skills/order-types/SKILL.md').split('## Examples')[1];
  const m = /limitPrice:([\d.]+), stopLossBracket:\{ticks:(\d+)[^]*?(\d+) ticks = ([\d.]+) pts[^$]*\$([\d.]+) risk per contract/.exec(ex);
  assert.ok(m, 'the example states the ticks, the points and the dollars');
  assert.strictEqual(Number(m[1]) % 0.25, 0, 'the limit price is on the tick');
  assert.strictEqual(Number(m[2]), Number(m[3]));
  assert.strictEqual(Number(m[4]), Number(m[2]) * 0.25);
  assert.strictEqual(Number(m[5]), Number(m[2]) * 0.5);
});

test('order-mechanics split: each role loads the piece its body uses', () => {
  const { loadRoles } = require('../../scripts/lib/role-skills');
  const roles = Object.fromEntries(loadRoles(ROOT).map(r => [r.name, [...r.skills, ...r.index]]));
  // Every role that may send an order builds it (order-types) and reads its reply (order-mechanics).
  for (const r of loadRoles(ROOT).filter(x => x.tools.some(t => /__(place_order|modify_order|cancel_order|close_position|partial_close_position)$/.test(t)))) {
    for (const s of HOMES) assert.ok(r.skills.includes(s), `${r.name}: ${s} in its core`);
  }
  // The risk manager checks the plan's stop bracket (its check 6): order-types. Its phase 1 reports working orders'
  // protection, and only order-mechanics says a working entry's bracket may not show until it fills: it keeps that too.
  for (const s of HOMES) assert.ok(roles['risk-manager'].includes(s), `risk-manager: ${s}`);
  assert.match(read('agents/risk-manager.md'), /`stopLossBracket\.ticks`/);
  assert.match(read('agents/risk-manager.md'), /working orders, with protective stops yes\/no/);
  assert.match(read('skills/order-mechanics/SKILL.md').replace(/\s+/g, ' '), /an order list may not show the bracket until the entry fills/);
  // The head trader's pointers about checking an order once still name the skill that has it.
  for (const f of ['skills/trade-session/SKILL.md', 'skills/autonomous-trading/SKILL.md', 'rules/trading/risk-management.md']) {
    assert.match(read(f), /the `order-mechanics` skill/, f);
  }
});
