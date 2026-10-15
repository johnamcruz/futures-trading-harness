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
// The fixture is the skill exactly as main had it before the split (skills/broker-mcp/SKILL.md at 3465bb5d): pinned,
// so a sentence can't be dropped from the fixture and from its new home together.
const BEFORE_SHA256 = 'dc8cf0a817ec8b6a5eb27fb1a8642d5dc534e946ad754d7825db0276b7c05e35';
const HOMES = ['broker-mcp', 'order-mechanics', 'order-failures', 'order-rationale', 'trade-journal', 'gate-refusals', 'broker-refusals'];
// Skills split later (tests/plugin/order-mechanics-split.test.js, tests/plugin/gate-refusals-split.test.js): their
// pieces hold the units too; broker-mcp points to order-types, and to gate-refusals, which points to the rest.
const LATER = ['order-types', 'gate-refusals-limits', 'gate-refusals-positions', 'gate-refusals-cycle'];

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
    now: '(Right after a close whose reply was an error, the gate refuses the `[protect]`: `close_position` again; see the `gate-refusals-positions` skill.)',
    reason: 'the Errors table\'s row for it is in the gate-refusals-positions skill (gate-refusals was split later)' },
  // A pointer to a skill retired later (tests/plugin/harness-tools-split.test.js): these tools' bars rows are
  // bar-briefing's.
  { old: 'Bars to a file: the runner\'s bars file, or the harness tool `bars_fetch` `{symbol:"MNQ", timeframe:3, record:true}` (+ `get_quote`), then `market_snapshot`, `mtf_read`, and `strategies_scan` with `record` (the `harness-tools` skill).',
    now: 'Bars to a file: the runner\'s bars file, or `bars_fetch` `{symbol:"MNQ", timeframe:3, record:true}` (+ `get_quote`), then `market_snapshot`, `mtf_read` (`bar-briefing`) and `strategies_scan` with `record` (`strategy-tools`).',
    reason: 'the tool skill is retired; the bars tools\' rows are in bar-briefing, the scan\'s in strategy-tools (no longer than the old sentence: the trade executor loads broker-mcp and may not grow)' },
  // A truth fix in moved text: the kinds are the broker interface's (scripts/lib/broker/interface.js, JOURNAL), which
  // the old list left short (the trade-executor writes `exit`; the interface takes `entry` and `exit` too).
  { old: 'Kinds: `plan`, `note`, `review`, `lesson`; every `place_order` writes an `order_placed` entry by itself.',
    now: ['Kinds you write: `plan`, `entry`, `exit`, `review`, `lesson`, `note`.',
      'The server writes its own: every `place_order` an `order_placed` entry, a guardrail refusal an `order_blocked`, `close_position` and `partial_close_position` an `exit`, and `modify_order` with a reason a `note`.'],
    reason: 'the kinds as the broker interface states them (JOURNAL.agentWritten and serverWritten)' },
  // Deliberately in five homes: every refusal skill carries the error table's header (gate-refusals in four pieces).
  { old: 'Message', copies: 5, reason: 'the table header, in the four gate-refusals pieces and broker-refusals' },
  { old: 'Meaning', copies: 5, reason: 'the table header, in the four gate-refusals pieces and broker-refusals' },
  { old: 'Do', copies: 5, reason: 'the table header, in the four gate-refusals pieces and broker-refusals' },
];

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "place_order {accountId, contractId:\"MNQ\", side:\"buy\", type:\"market\", size:1,",
    to: "place_order {accountId, contractId:\"MNQ\", side:\"buy\", type:\"limit\", limitPrice:21540.25,",
    reason: "the example is a composed entry (orb is retired: strategies/retired.json): a limit at the record's reference, its stop and target ticks, tick-correct (fix/skills-stale-examples)" },
  { from: "stopLossBracket:{ticks:40, type:\"stop\"}, takeProfitBracket:{ticks:80, type:\"limit\"},",
    to: "size:1, stopLossBracket:{ticks:111, type:\"stop\"}, takeProfitBracket:{ticks:231, type:\"limit\"},",
    reason: "the example is a composed entry (orb is retired: strategies/retired.json): a limit at the record's reference, its stop and target ticks, tick-correct (fix/skills-stale-examples)" },
  { from: "rationale:\"setup:orb long close above OR high 21500.00, stop 21490.00, target 21520.00, risk $20\"}",
    to: "rationale:\"setup:trade_lifecycle long, stop 21512.50, target 21598.00, risk $55.50\"}",
    reason: "the example is a composed entry (orb is retired: strategies/retired.json): a limit at the record's reference, its stop and target ticks, tick-correct (fix/skills-stale-examples)" },
  { from: "place_order {..., side:\"sell\", type:\"stop\", size:1, stopPrice:21490.00,",
    to: "place_order {..., side:\"sell\", type:\"stop\", size:1, stopPrice:21512.50,",
    reason: "the example is a composed entry (orb is retired: strategies/retired.json): a limit at the record's reference, its stop and target ticks, tick-correct (fix/skills-stale-examples)" },
  { from: "rationale:\"[protect] stop for ORB long filled at 21500.25\"}",
    to: "rationale:\"[protect] long filled at 21540.25\"}",
    reason: "the example is a composed entry (orb is retired: strategies/retired.json): a limit at the record's reference, its stop and target ticks, tick-correct (fix/skills-stale-examples)" },
];
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();

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

const homeTexts = () => [...HOMES, ...LATER].map(s => read(`skills/${s}/SKILL.md`));

test('broker-mcp split: every unit of the old skill is in exactly one new home, byte-for-byte (whitespace normalised)', () => {
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts()), []);
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('trade-journal: the kinds it lists are the broker interface\'s, the agent\'s and the server\'s', () => {
  const { JOURNAL } = require('../../scripts/lib/broker/interface');
  const t = read('skills/trade-journal/SKILL.md').replace(/\s+/g, ' ');
  const kinds = s => [...s.matchAll(/`([a-z_]+)`/g)].map(m => m[1]);
  const mine = /Kinds you write: ([^.]*)\./.exec(t);
  assert.ok(mine, 'the skill lists the kinds the agent writes');
  assert.deepStrictEqual(kinds(mine[1]).sort(), [...JOURNAL.agentWritten].sort());
  const server = /The server writes its own: ([^.]*)\./.exec(t);
  assert.ok(server, 'the skill lists the kinds the server writes');
  for (const k of Object.keys(JOURNAL.serverWritten)) assert.ok(kinds(server[1]).includes(k), `server kind ${k}`);
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
  assert.notDeepStrictEqual(differences(old, withFailures(homes[at].replace('see the `gate-refusals-positions` skill.)', 'see Errors.)'))), []);
});

test('broker-mcp split: each new skill answers one question in a short index line, and broker-mcp says where the rest is', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of [...HOMES, ...LATER]) {
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

test('broker-mcp-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});
