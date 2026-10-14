'use strict';

// The harness-tools skill was split by single responsibility, and each piece is referenced where a role needs it
// rather than embedded where embedding would make a prompt grow (the owner's rule: no role and no head-trader cycle
// grows). harness-tools keeps the server's general argument, path and refusal rules, the map of the moved rows, and
// the rows whose topic skills are loaded by roles that never loaded harness-tools or by the head trader every cycle
// (strategies, blackouts, lessons, reconcile, skill_lookup); bar-briefing, order-plan and reason-check are new;
// combine_status went to prop-challenge-pacing. These tests prove nothing was lost, doubled or misplaced: every
// sentence (and every table cell and code line) of the skill as it was (tests/fixtures/skill-split/
// harness-tools.before.txt, frozen) is in the new homes exactly as many times as before, byte-for-byte after
// whitespace is normalised, each in the home its old lines map to. position-sizing step 8 points to order-plan the
// same way (tests/fixtures/skill-split/order-plan.before.txt). The only exceptions are listed, each with its reason;
// an exception that no longer differs fails too, so the lists can only shrink. And every role still has the row of
// every harness tool it holds, or a reasoned reference.

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
const flat = text => text.replace(/\s+/g, ' ');

// skills/harness-tools/SKILL.md as main had it before the split (at 0b1a2f79): pinned, so a sentence can't be dropped
// from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/harness-tools.before.txt';
const BEFORE_SHA256 = '1eb1759e1253d7b9032966b8c73fe73bccbedc22dbe13d26888a9025c6183576';
const HOMES = ['harness-tools', 'bar-briefing', 'order-plan', 'reason-check', 'prop-challenge-pacing'];
// The fixture's lines (1-based, inclusive) each home other than harness-tools takes; harness-tools keeps the rest.
const MOVED = {
  // The bar_briefing, bars_fetch, market_snapshot and mtf_read rows and their example calls.
  'bar-briefing': [[29, 29], [36, 37], [43, 43], [93, 94], [96, 96], [110, 110]],
  'order-plan': [[35, 35], [107, 109]],
  'reason-check': [[44, 44], [113, 119]],
  // The combine_status row and its example call (already prop-challenge-pacing's first example line).
  'prop-challenge-pacing': [[40, 40], [112, 112]],
};
// The tool table's header: one in each home.
const HEADER = ['Tool', 'Arguments', 'What it returns', 'Script (people)'];

// The bar_briefing row's description, with the CISD block the briefing has carried since #125 (briefing.js
// cisdBlock and its summary line) named where the old row lists the m3 fields.
const BRIEFING_CELL = units(read(BEFORE)).find(u => u.startsWith('the bar briefing the autonomous runner built'));
const CISD = [
  ['a line per timeframe for its last completed candle, the next swing targets,', 'a line per timeframe for its last completed candle, the latest CISD per timeframe, the next swing targets,'],
  ['`location`, `candles` (per timeframe,', '`location`, `cisd` (the latest CISD per timeframe, 3m, 5m, 15m and 1h, on completed candles: its direction, level, displacement, any key-level sweep before it, and its leg\'s OTE zone with its status and whether price is in it; a read, not a signal), `candles` (per timeframe,'],
];

// Deliberate differences, each with its reason.
const ALLOWED = [
  ...HEADER.map(old => ({ old, copies: HOMES.length, reason: `the tool table header, in each of the ${HOMES.length} homes` })),
  // The example call was already prop-challenge-pacing's own first example line: one copy, not two.
  { old: 'combine_status {}', copies: 1, reason: 'already the first line of prop-challenge-pacing\'s Examples' },
  { old: BRIEFING_CELL, now: CISD.reduce((t, [a, b]) => t.replace(a, b), BRIEFING_CELL || ''), reason: 'the briefing\'s `m3` `cisd` (#125), which the old row didn\'t name' },
];

/** The old units each home must hold: Map home -> Map unit -> count (harness-tools takes every unit not moved). */
function expectedHomes(beforeText) {
  const lines = beforeText.split('\n');
  let fence = false;
  const fenced = lines.map(l => { if (/^```/.test(l)) { fence = !fence; return false; } return fence; });
  const skip = u => STRUCTURE.includes(u) || HEADER.includes(u);
  const rest = count(units(beforeText).filter(u => !skip(u)));
  const out = new Map();
  for (const [home, ranges] of Object.entries(MOVED)) {
    // A range inside the Examples block is code: fence it, so its lines are code lines, as in the old skill.
    const text = ([a, b]) => { const t = lines.slice(a - 1, b).join('\n'); return fenced[a - 1] ? `\`\`\`\n${t}\n\`\`\`` : t; };
    const want = count(units(ranges.map(text).join('\n\n')).filter(u => !skip(u)));
    for (const [u, n] of want) {
      if ((rest.get(u) || 0) < n) throw new Error(`${home}: "${u}" is not in the old skill ${n} time(s)`);
      rest.set(u, rest.get(u) - n);
    }
    out.set(home, want);
  }
  out.set('harness-tools', new Map([...rest].filter(([, n]) => n > 0)));
  return out;
}

/** Old units in a home their old lines don't map to (or missing from the one they do): [] when each is home. */
function homeErrors(beforeText, homeTexts) {
  const expected = expectedHomes(beforeText);
  const old = new Set(units(beforeText));
  const asOld = new Map(ALLOWED.filter(a => a.now).map(a => [a.now, a.old]));
  const bad = [];
  HOMES.forEach((home, i) => {
    const got = count(units(homeTexts[i]).map(u => asOld.get(u) || u).filter(u => old.has(u) && !STRUCTURE.includes(u) && !HEADER.includes(u)));
    const want = expected.get(home);
    for (const u of new Set([...got.keys(), ...want.keys()])) {
      if ((got.get(u) || 0) !== (want.get(u) || 0)) bad.push(`${home}: ${JSON.stringify(u.slice(0, 80))} ${got.get(u) || 0} time(s), its old lines map ${want.get(u) || 0} here`);
    }
    for (const h of HEADER) if (count(units(homeTexts[i])).get(h) !== 1) bad.push(`${home}: the table header's "${h}" not once`);
  });
  return bad;
}

// position-sizing step 8 as main had it (at 0b1a2f79): what order_plan shows is order-plan's now; step 8 points to it.
const OP_BEFORE = 'tests/fixtures/skill-split/order-plan.before.txt';
const OP_BEFORE_SHA256 = '6d319c1504ba47d0c7bcae2931a69f48f720225000dacb946959aed075244594';
const OP_HOMES = ['position-sizing', 'order-plan'];
const OP_ALLOWED = [
  { old: '**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4\'s arithmetic for the strategy and side you chose and shows it: the stop in points and whole ticks, the risk per contract, the size and where it came from (1 for a rules strategy, the size-1 rule; the verdict\'s, within the attempt\'s budget, for a policy strategy), and the dollar risk.',
    now: '**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4\'s arithmetic for the strategy and side you chose and shows its working (the `order-plan` skill).',
    reason: 'what it shows is the order_plan row (stop and target in points and whole ticks, how the size was derived, $ risk) plus order-plan\'s "Its working includes the risk per contract."' },
];

test('harness-tools split: every unit of the old skill is in exactly one new home, the one its old lines map to, byte-for-byte', () => {
  assert.strictEqual(sha(BEFORE), BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.ok(BRIEFING_CELL, 'the old bar_briefing row');
  const homes = HOMES.map(skill);
  assert.deepStrictEqual(differences(read(BEFORE), homes, ALLOWED), []);
  assert.deepStrictEqual(homeErrors(read(BEFORE), homes), [], 'each unit is in the home its old lines map to');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('order-plan: position-sizing step 8 points to it for what order_plan shows; order-plan holds the read rules', () => {
  assert.strictEqual(sha(OP_BEFORE), OP_BEFORE_SHA256, 'the fixture is main\'s step 8, unchanged');
  assert.deepStrictEqual(differences(read(OP_BEFORE), OP_HOMES.map(skill), OP_ALLOWED, { structure: false }), []);
  for (const a of OP_ALLOWED) assert.ok(a.reason, a.old);
  const op = flat(skill('order-plan'));
  for (const s of ['Its working includes the risk per contract.', 'Never supply tick numbers of your own.', 'Round a stop away from the entry and a target toward it; bracket ticks = `ceil(distance / tickSize)`']) assert.ok(op.includes(s), s);
});

test('harness-tools split: the comparison catches a lost, a doubled, an edited or a misplaced unit, and a stale exception', () => {
  const old = read(BEFORE);
  assert.ok(units(old).length > 100, 'the units are fine-grained');
  const homes = HOMES.map(skill);
  const at = name => HOMES.indexOf(name);
  const swap = (...pairs) => homes.map((h, i) => { const p = pairs.find(([n]) => at(n) === i); return p ? p[1] : h; });
  const bb = homes[at('bar-briefing')];
  const ROW = /^\| `market_snapshot` \|.*\n/m;
  const row = ROW.exec(bb)[0];
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', bb.replace(ROW, '')]), ALLOWED), [], 'lost');
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', `${bb}\n${row}`]), ALLOWED), [], 'doubled');
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', bb.replace('Reuse it; don\'t recompute what it holds.', 'Reuse it.')]), ALLOWED), [], 'edited');
  // Misplaced: the market_snapshot row moved from bar-briefing (core for the analysts and the risk manager) to
  // order-plan: nothing is lost or doubled, but it left its home.
  const op = homes[at('order-plan')];
  const moved = swap(['bar-briefing', bb.replace(ROW, '')], ['order-plan', op.replace(/^(\| `order_plan` \|.*\n)/m, `$1${row}`)]);
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a cross-home move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved), [], 'but leaves its home');
  // A stale exception: the example dropped from prop-challenge-pacing too.
  const pp = homes[at('prop-challenge-pacing')];
  assert.notDeepStrictEqual(differences(old, swap(['prop-challenge-pacing', pp.replace('combine_status {}\n', '')]), ALLOWED), [], 'stale');
  // The CISD exception reverted (the old row back) fails too.
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', bb.replace(ALLOWED[ALLOWED.length - 1].now, BRIEFING_CELL)]), ALLOWED), [], 'cisd reverted');
});

const { TOOLS } = require('../../scripts/lib/harness-tools/registry');
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).filter(s => fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')));
const rowOf = (text, tool) => text.split('\n').find(l => l.startsWith(`| \`${tool}\` |`));
const homeOf = tool => SKILLS.filter(s => rowOf(skill(s), tool));

/** The map in harness-tools: tool -> the skill it references for the tool's row (a tool it doesn't list: below). */
function namedHomes() {
  const ht = skill('harness-tools');
  const list = ht.slice(ht.indexOf('### Which skill has each tool\'s row'), ht.indexOf('### Arguments, paths and refusals'));
  const named = new Map(TOOLS.map(t => [t.name, 'harness-tools']));
  for (const item of list.split(/\n(?=- )/).filter(l => l.startsWith('- '))) {
    const [tools, where] = item.split(/:\s+(?=the\s+`[a-z-]+`\s+skill\.)/);
    const home = /^the\s+`([a-z-]+)`\s+skill\./.exec(where.trim())[1];
    for (const m of tools.matchAll(/`([a-z_]+)`/g)) {
      assert.ok(named.has(m[1]), `the map names a tool that doesn't exist: ${m[1]}`);
      named.set(m[1], home);
    }
  }
  return named;
}

test('every harness tool has its row in exactly one skill: the one the harness-tools map references, else harness-tools', () => {
  const named = namedHomes();
  for (const t of TOOLS) assert.deepStrictEqual(homeOf(t.name), [named.get(t.name)], `${t.name}: its row's skill`);
  assert.deepStrictEqual([...new Set(named.values())].sort(), ['bar-briefing', 'harness-tools', 'order-plan', 'prop-challenge-pacing', 'reason-check']);
});

test('every role has the row of every harness tool it holds in its core, or a reasoned reference', () => {
  // Reasoned exceptions: a tool whose row is in a skill the role doesn't embed (the owner's rule: no role grows; the
  // role references the skill instead, and the tool's MCP schema carries its arguments).
  const REFERENCED = {
    // The risk manager calls order_plan; its arguments are in the tool's schema and its use is in its step 5, which
    // references the order-plan skill and states the two read rules it acts on.
    'risk-manager': ['order_plan'],
    // Neither ever loaded harness-tools, so neither had these rows on main; embedding them would grow its prompt.
    'trade-reviewer': ['bars_fetch', 'lessons', 'reconcile'],
    'strategy-researcher': ['strategies_validate', 'strategies_list', 'strategies_show'],
  };
  const MAIN_HAD_HARNESS_TOOLS = ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
  for (const a of require('../../scripts/lib/role-skills').loadRoles(ROOT)) {
    const held = a.tools.filter(t => t.startsWith('mcp__harness__')).map(t => t.slice('mcp__harness__'.length));
    for (const tool of held) {
      // The core (role-skills): in index mode a role-index skill isn't in the prompt.
      const loaded = homeOf(tool).some(s => a.skills.includes(s));
      if ((REFERENCED[a.name] || []).includes(tool)) {
        assert.ok(!loaded, `${a.name}: ${tool}'s row is embedded now; drop the exception`);
        continue;
      }
      assert.ok(loaded, `${a.name}: holds ${tool} but embeds no skill with its row (${homeOf(tool)})`);
    }
    if (MAIN_HAD_HARNESS_TOOLS.includes(a.name)) assert.ok(a.skills.includes('harness-tools') && a.skills.includes('bar-briefing'), `${a.name}: harness-tools and bar-briefing are core`);
  }
  // The risk manager's step 5: it references order-plan and keeps the two rules it acts on.
  const rm = flat(read('agents/risk-manager.md'));
  assert.match(rm, /Approve the plan's numbers as order_plan shows them; never supply tick numbers of your own\. Its refusal \(the `order-plan` skill\) is a VETO\./);
  assert.match(rm, /^.*role-skills: \[[^\]]*\breason-check\b/);
  assert.doesNotMatch(read('agents/risk-manager.md'), /^role-skills: \[[^\]]*\border-plan\b/m);
  assert.match(flat(skill('bar-briefing')), /Without one, the news blackouts are `blackouts_list`\./);
});

test('the new skills answer one question in a short index line; the topic skills reference bar-briefing for the briefing', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of ['harness-tools', 'bar-briefing', 'order-plan', 'reason-check']) {
    const d = parseFrontmatter(skill(s)).data.description;
    assert.ok(d.length <= 120, `${s}: description ${d.length} chars, over 120`);
  }
  for (const s of ['liquidity-concepts', 'vwap-volume-profile', 'market-structure', 'trend-momentum-indicators', 'market-snapshot', 'multi-timeframe-analysis']) {
    assert.match(skill(s), /In an autonomous cycle the bar briefing \(`bar_briefing`, the\s+`bar-briefing`\s+skill\)/, s);
  }
});

// trade-session step 4 as main had it (at 0b1a2f79): the head trader's own procedure, read every cycle, stays as it
// was; the one change is the reference to the order-plan skill.
const STEP4 = 'tests/fixtures/skill-split/trade-session-step4.before.txt';
const STEP4_SHA256 = '7fc1e45612ccb7a7569bca0119c44d5a48a9d849c5694f25407e033d5ea06228';
const STEP4_REF = ['**The exact numbers come from `order_plan`**, not from your own arithmetic:', '**The exact numbers come from `order_plan`** (the `order-plan` skill), not from your own arithmetic:'];

test('trade-session step 4 is main\'s, with a reference to order-plan; the head trader\'s load list is unchanged', () => {
  assert.strictEqual(sha(STEP4), STEP4_SHA256, 'the fixture is main\'s step 4, unchanged');
  const ts = skill('trade-session');
  const step4 = ts.slice(ts.indexOf('### 4. Plan'), ts.indexOf('### 5. Verdict'));
  assert.strictEqual(step4, read(STEP4).replace(STEP4_REF[0], STEP4_REF[1]));
  // order-plan is referenced, not loaded every cycle: not in the gate's list, nor in the prompt's.
  const { REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.ok(!REQUIRED_FOR_ENTRY.includes('order-plan'));
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const prompt = prompts(validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  assert.doesNotMatch(prompt, /order-plan/);
});
