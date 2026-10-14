'use strict';

// The trade-session skill was split by job: trade-session keeps the cycle every run follows (loading, the state checks,
// the bar briefing and the trigger, the step 3 order and the priority order, the no-trade rule, the verdict, executing,
// the report) and points to the rest; role-round takes the full cycle's roles, lean-cycle the lean cycle,
// manage-position an open position, leftover-orders a flat account's working orders, setup-judgment step 3's checks,
// day-context the premarket plan, the news and the day so far, trade-plan step 4 (byte for byte), entry-outcome what
// follows placing; the paragraph on an analyst on its own timeframe went to runner-lanes. This test proves nothing was
// lost or doubled: every sentence (and table cell and code line) of the skill as it was
// (tests/fixtures/skill-split/trade-session.before.txt, frozen) is in exactly one new home, the home its range maps
// to, in its old order. It also holds the head trader's per-cycle reading to the base's (batch B's, merged) on every
// path, and no role prompt grows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { units, differences } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');
const { homeErrors, sha256 } = require('./skill-split-homes');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const skill = name => read(`skills/${name}/SKILL.md`);
const flat = s => s.replace(/\s+/g, ' ');

// skills/trade-session/SKILL.md as main had it before the split (at 6f972d0e, batch B merged; batch B's own, df52bf54, is
// the same): pinned, so a sentence
// can't be dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/trade-session.before.txt';
const BEFORE_SHA256 = 'f6f1ee174abbea27ba9a23414337ba85e372410e6defaa8e44451e129ab9fc8e';
const PIECES = ['role-round', 'lean-cycle', 'manage-position', 'leftover-orders', 'setup-judgment', 'day-context', 'trade-plan', 'entry-outcome'];
const HOMES = ['trade-session', ...PIECES, 'runner-lanes'];

// Each home's old units (inclusive indexes into units(BEFORE)); together they cover every unit once.
const RANGES = {
  'trade-session': [[0, 22], [32, 34], [41, 63], [108, 110], [115, 116], [150, 151], [177, 185], [197, 206]],
  'manage-position': [[23, 31], [134, 138]],
  'leftover-orders': [[35, 40]],
  'lean-cycle': [[64, 69]],
  'role-round': [[70, 76], [81, 107]],
  'runner-lanes': [[77, 80]],
  'setup-judgment': [[111, 114], [117, 124], [130, 133], [139, 149]],
  'day-context': [[125, 129]],
  'trade-plan': [[152, 176]],
  'entry-outcome': [[186, 196]],
};

// Deliberate differences, each with its reason.
const ALLOWED = [
  { old: 'The analysts the prompt doesn\'t name read the runner\'s bars and briefing as above.',
    now: 'The analysts the prompt doesn\'t name read the runner\'s bars and briefing as the `role-round` skill says.',
    reason: '"as above" was trade-session step 2\'s full cycle, which is role-round now' },
  // Relative references the moved text made to trade-session (review): each names what it means where it is now.
  { old: 'They are context, not a verdict: judge the setup by its strategy\'s STRATEGY.md (`strategies_show`: its context filter and skip rules) and the rules below (the trend rule, the alignment table in `htf-to-ltf`, its min R:R).',
    now: 'They are context, not a verdict: judge the setup by its strategy\'s STRATEGY.md (`strategies_show`: its context filter and skip rules) and these rules (the trend rule, the alignment table in `htf-to-ltf`, its min R:R).',
    reason: '"below" pointed past it in trade-session step 3; the parenthesis names the rules' },
  { old: 'A setup the trend rule allows, `aligned` for its side, with room past what it needs and confluence with it is the opportunity this harness looks for, when the rest of this step agrees and it isn\'t `blocked`: the strategy\'s normal size (position-sizing and the prop budget), and let its own exit work (don\'t bank before its trail or target).',
    now: 'A setup the trend rule allows, `aligned` for its side, with room past what it needs and confluence with it is the opportunity this harness looks for, when the rest of this skill agrees and it isn\'t `blocked`: the strategy\'s normal size (position-sizing and the prop budget), and let its own exit work (don\'t bank before its trail or target).',
    reason: '"this step" was trade-session step 3, whose checks are this skill now' },
  { old: 'The priority order below decides: a policy strategy\'s verdict too.',
    now: 'The priority order decides: a policy strategy\'s verdict too.',
    reason: 'the priority order is the core\'s step 3 bullet now, not below it' },
  { old: 'An order list may not show a bracket before the entry fills, so tell by the entry\'s own `order_placed` journal record (`journal_read {kind:"order_placed"}`, kind only, no `contractId` filter: the one whose `data.result.orderId` is the order; its `data.request` has `stopLossBracket` when the bracket went with it); step 6\'s note on a working entry adds context.',
    now: 'An order list may not show a bracket before the entry fills, so tell by the entry\'s own `order_placed` journal record (`journal_read {kind:"order_placed"}`, kind only, no `contractId` filter: the one whose `data.result.orderId` is the order; its `data.request` has `stopLossBracket` when the bracket went with it); entry-outcome\'s note on a working entry adds context.',
    reason: 'step 6\'s note on a working entry is the entry-outcome skill now' },
  // opencode's head trader in index mode has these skills in its prompt and no skill tool (head-prompt.js): step 0 and
  // the round say so, so it never reloads them or calls a tool it doesn't have (review). No path grows.
  { old: 'The order gate refuses an entry from a session whose transcript doesn\'t show each one loaded (a load that returned an error, such as a skill not found, doesn\'t count: load it again by the name the error lists).',
    now: 'The order gate refuses an entry until each is loaded (an errored load doesn\'t count: load it again by the name the error lists); one already in your prompt counts: don\'t reload it (no skill tool: skill_lookup).',
    reason: 'a skill embedded in the head trader\'s prompt is loaded (the gate counts it on the runner\'s attestation); without a skill tool, skill_lookup' },
  { old: 'A role\'s call is that role\'s own analysis (the order gate counts it as its report): never ask a role to read, load or summarize skills or files for you; load skills yourself (your skill tool, or without one read their `SKILL.md`).',
    now: 'A role\'s call is that role\'s own analysis (the order gate counts it as its report): never ask a role to read, load or summarize skills or files for you; load skills yourself (your skill tool; none: skill_lookup or `SKILL.md`).',
    reason: 'the head trader without a skill tool (opencode, index mode) reads a skill with skill_lookup, which the gate counts' },
];

const homeTexts = () => HOMES.map(skill);

test('trade-session split: every unit of the old skill is in exactly one new home, its own, in its old order', () => {
  assert.strictEqual(sha256(read(BEFORE)), BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.strictEqual(units(read(BEFORE)).length, 207);
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  assert.deepStrictEqual(homeErrors(read(BEFORE), homeTexts(), HOMES, RANGES, ALLOWED), [], 'each unit is in the home its range maps to');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('trade-session split: the comparison catches a lost, a doubled, a moved or a reordered sentence', () => {
  const old = read(BEFORE);
  const homes = homeTexts();
  const at = n => HOMES.indexOf(n);
  const swap = (pairs) => homes.map((h, i) => (pairs[HOMES[i]] !== undefined ? pairs[HOMES[i]] : h));
  const sj = homes[at('setup-judgment')];
  const S = 'Under 30 trades is anecdotal, not evidence.';
  assert.ok(flat(sj).includes(S));
  const cut = sj.replace(/Under 30 trades is anecdotal, not evidence\./, '');
  assert.notDeepStrictEqual(differences(old, swap({ 'setup-judgment': cut }), ALLOWED), [], 'lost');
  assert.notDeepStrictEqual(differences(old, swap({ 'day-context': `${homes[at('day-context')]}\n${S}\n` }), ALLOWED), [], 'doubled');
  const moved = swap({ 'setup-judgment': cut, 'day-context': homes[at('day-context')].replace('## Examples', `${S}\n\n## Examples`) });
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved, HOMES, RANGES, ALLOWED), [], 'but leaves its home');
  // Two bullets of setup-judgment swapped: nothing lost, the order changed.
  const B1 = /- Tabulate each analyst's bias[^]*?strongly opposed\.\n/.exec(sj)[0];
  const B2 = /- Start from the computed regime[^]*?say why in the plan\.\n/.exec(sj)[0];
  const swapped = sj.replace(B1, '\u0000').replace(B2, B1).replace('\u0000', B2);
  assert.deepStrictEqual(differences(old, swap({ 'setup-judgment': swapped }), ALLOWED), []);
  assert.notDeepStrictEqual(orderErrors(old, swap({ 'setup-judgment': swapped }), HOMES, ALLOWED), []);
});

test('trade-session split: the core keeps its numbered steps, step 0 as it was, and points to each piece', () => {
  const ts = skill('trade-session');
  for (let n = 0; n <= 7; n += 1) assert.match(ts, new RegExp(`^### ${n}\\. `, 'm'), `step ${n}`);
  // Step 0 names the same skills as before: a new name there would read as a per-cycle load.
  const step0 = t => [...t.slice(t.indexOf('### 0.'), t.indexOf('### 1.')).matchAll(/`([a-z0-9-]+)`/g)].map(m => m[1]);
  assert.deepStrictEqual(step0(ts), step0(read(BEFORE)));
  const f = flat(ts);
  for (const s of PIECES) assert.match(f, new RegExp(`\`${s}\``), `trade-session points to ${s}`);
  // The head trader is told to read the two the gate requires before an entry (REQUIRED_AT_ENTRY), in step 3.
  const step3 = flat(ts.slice(ts.indexOf('### 3.'), ts.indexOf('### 4.')));
  assert.match(step3, /before an entry, `trade-plan` too \(the order gate refuses an entry until `setup-judgment` and `trade-plan` were read\)/);
  // The refusal labels the gate's messages cite stay in trade-session (gate-refusals-split.test.js POINTERS).
  assert.ok(ts.includes('`[roles-ran]`'));
  assert.match(f, /### 6\. Execute On `APPROVE`, hand the plan and verdict line to `trade-executor`\. If the order gate, the MCP gateway, or the server blocks it, report the block and end\./);
  // Each piece says which step of trade-session it serves, and each has a short "Use when" index line.
  for (const s of PIECES) {
    assert.match(skill(s), /## When to Use\n\n- [^\n]*`trade-session` steps? \d/, s);
    const d = parseFrontmatter(skill(s)).data.description;
    assert.ok(d.length <= 120, `${s}: description ${d.length} chars`);
    assert.match(d, /^Use (when|before|after) /, s);
  }
  assert.ok(parseFrontmatter(ts).data.description.length <= 120);
});

test('trade-session split: trade-plan is step 4 byte for byte (tests/plugin/harness-tools-split.test.js pins it)', () => {
  const tp = skill('trade-plan');
  const body = tp.slice(tp.indexOf('## How It Works\n\n') + '## How It Works\n\n'.length, tp.indexOf('## Examples'));
  const old = read(BEFORE);
  assert.strictEqual(`### 4. Plan\n\n${body}`, old.slice(old.indexOf('### 4. Plan'), old.indexOf('### 5. Verdict')));
});

// The head trader's reading per cycle, by path: workspace/AGENTS.md (its skill index), the skills it loads every cycle
// (the order gate's REQUIRED_FOR_ENTRY with the trade-session core, trader-process, htf-to-ltf, autonomous-trading) and
// the pieces the path reads. Before the split (main at 6ef8cd4c, batch B merged with its descriptions shortened):
// AGENTS.md was 24466 bytes (27240 at batch B's head) and trade-session the fixture. The skills common to both sides
// are read from the tree, so they cancel; in index mode the head trader's situational skills are the same on both
// sides too, so each path's budget holds in both modes.
const OLD_AGENTS_MD = 24466;
const EVERY_CYCLE = ['multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks', 'trader-process', 'htf-to-ltf', 'autonomous-trading'];
const PATHS = {
  'full cycle, no candidate': ['role-round', 'setup-judgment', 'day-context'],
  'lean cycle': ['lean-cycle'],
  'managing a position': ['manage-position'],
  'worst entry': ['leftover-orders', 'role-round', 'setup-judgment', 'day-context', 'trade-plan', 'entry-outcome'],
};
const bytes = rel => fs.statSync(path.join(ROOT, rel)).size;

test('trade-session split: no head-trader path reads more than the base\'s every-cycle load', () => {
  const common = EVERY_CYCLE.reduce((n, s) => n + bytes(`skills/${s}/SKILL.md`), 0);
  const before = OLD_AGENTS_MD + bytes(BEFORE) + common;
  const table = Object.entries(PATHS).map(([name, pieces]) => {
    const now = bytes('workspace/AGENTS.md') + bytes('skills/trade-session/SKILL.md') + common + pieces.reduce((n, s) => n + bytes(`skills/${s}/SKILL.md`), 0);
    return { name, now, before };
  });
  for (const r of table) assert.ok(r.now <= r.before, `${r.name}: ${r.now} bytes, over the base's ${r.before}`);
  // The worst path is the largest: every piece but the lean cycle's and an open position's.
  assert.strictEqual(table.reduce((a, b) => (b.now > a.now ? b : a)).name, 'worst entry');
  // AGENTS.md lists every piece (its index line is how the head trader finds one).
  for (const s of [...PIECES, 'gate-refusals-skills']) assert.match(read('workspace/AGENTS.md'), new RegExp(`^- \`${s}\` \\(skills/${s}/SKILL\\.md\\): Use `, 'm'), s);
});

// Each role's generated prompt (opencode's, the only adapter that embeds skills) in bytes, at main 6ef8cd4c (batch B
// merged; each at most batch B's own but risk-manager and trend-momentum-analyst in full mode, which main's merge
// review grew by 6 bytes).
const ROLE_PROMPTS = {
  full: { 'market-structure-analyst': 88188, 'news-calendar-analyst': 10523, 'risk-manager': 90633, 'strategy-researcher': 25662, 'trade-executor': 30268, 'trade-reviewer': 9195, 'trend-momentum-analyst': 55850, 'volume-liquidity-analyst': 49365 },
  index: { 'market-structure-analyst': 43667, 'news-calendar-analyst': 10523, 'risk-manager': 81270, 'strategy-researcher': 25662, 'trade-executor': 30268, 'trade-reviewer': 9195, 'trend-momentum-analyst': 40995, 'volume-liquidity-analyst': 33580 },
};

test('trade-session split: no role prompt grows, in full or index mode, and no role lists a piece', () => {
  const { opencodeJson } = require('../../scripts/lib/harness-sync');
  for (const mode of ['full', 'index']) {
    const agents = JSON.parse(opencodeJson(ROOT, { mode })).agent;
    for (const [role, max] of Object.entries(ROLE_PROMPTS[mode])) {
      const n = Buffer.byteLength(agents[role].prompt);
      assert.ok(n <= max, `${mode}: ${role}'s prompt is ${n} bytes, over the base's ${max}`);
    }
  }
  const { loadRoles } = require('../../scripts/lib/role-skills');
  for (const r of loadRoles(ROOT)) for (const s of [...PIECES, 'gate-refusals-skills']) assert.ok(![...r.skills, ...r.index].includes(s), `${r.name}: ${s}`);
});

test('trade-session split: the gate requires setup-judgment and trade-plan at entry, apart from the per-cycle list', () => {
  const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_AT_ENTRY, ['setup-judgment', 'trade-plan']);
  for (const s of REQUIRED_AT_ENTRY) assert.ok(!REQUIRED_FOR_ENTRY.includes(s), s);
  // Not on the runner's per-cycle load list: the prompt doesn't name them.
  const A = require('../../scripts/lib/autotrader');
  const p = A.prompts(A.validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  for (const s of REQUIRED_AT_ENTRY) assert.ok(!p.includes(s), `the cycle prompt names ${s}`);
  // The refusal is taught: its row in the gate-refusals family, which says exits and stops still go.
  const row = flat(skill('gate-refusals-skills'));
  assert.match(row, /\| `\[skills-at-entry\] … not read in this session: <skills>` \|/);
  assert.match(row, /Exits, `\[protect\]` stops, stop moves, size cuts and cancels still go\./);
});
