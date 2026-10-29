'use strict';

// The gate-refusals skill was split by the family of check: gate-refusals keeps the order itself (the hook's block, its
// tag, the replay clock, its stop bracket, its account id, the broker's tick specs, an order of unknown outcome) and
// says where the rest is; gate-refusals-limits takes the account, prop attempt, strategy and size limits;
// gate-refusals-positions the refusals while managing a position; gate-refusals-cycle the autonomous cycle's roles
// and phase 2's FACTS. This test proves nothing was lost or doubled: every sentence (and every table cell and code
// line) of the skill as it was (tests/fixtures/skill-split/gate-refusals.before.txt, frozen) is in the new homes
// exactly as many times as before, byte-for-byte after whitespace is normalised, in its old order within each home.
// The only exceptions are listed, each with its reason; an exception that no longer differs fails too.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { units, differences } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const skill = name => read(`skills/${name}/SKILL.md`);

// skills/gate-refusals/SKILL.md as main had it before the split (at 6b8febfa, with the exits-by-contract-month rows):
// pinned, so a sentence can't be dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/gate-refusals.before.txt';
const BEFORE_SHA256 = '763da862497ba38fd4f587f7736df09ebc7428e6ca80aa7c8675e0a32d7dc4a0';
const HOMES = ['gate-refusals', 'gate-refusals-limits', 'gate-refusals-positions', 'gate-refusals-cycle'];

// Deliberate differences, each with its reason.
const ALLOWED = [
  // Every piece is a table of refusals: each carries the table's header.
  ...['Message', 'Meaning', 'Do'].map(old => ({ old, copies: 4, reason: 'the table header, in each of the four pieces' })),
  // The hub's example refusals are ones it holds: [max-risk] is gate-refusals-limits' now.
  { old: 'The order gate refused an order call: a message in brackets (`[stop-defined]`, `[max-risk]`, ...) or `Blocked by trading harness`.',
    now: 'The order gate refused an order call: a message in brackets (`[stop-defined]`, `[contract-specs]`, ...) or `Blocked by trading harness`.',
    reason: 'the example names a row of this piece, not one that moved' },
];

// Rows added since the split (a refusal the gate gained later), each with its reason: the only rows not in the old table.
const ADDED_ROWS = [
  { row: '`[bracket-leg] …`', reason: 'fix/orphan-orders (owner-approved 2026-10-26: "don\'t remove bracket and have orphan"): a model\'s cancel of a bracket leg of an open position, a new refusal' },
  { row: '`[bracket-only] …`', reason: 'fix/orphan-orders (owner-approved 2026-10-26: "always manage risk using stop loss brackets and adjust it accordingly using modify order"): a separate [protect] beside the brackets, a new refusal' },
  { row: '`[combine] <account>: N losing trades in a row this session, at the loss streak stop (loss_streak_stop N): no new entries until the next session`',
    reason: 'feat/prop-portfolio-missing (owner-approved): the account rulebook\'s loss streak stop, a new [combine] refusal' },
  { row: '`[prop-account-attempt] account <id> is a <profile> prop account and no <profile> attempt is running` (or its marker or profile is invalid)',
    reason: 'feat/prop-account-marker (owner-approved 2026-10-22): an entry on a marked prop account without its attempt, a new refusal' },
  { row: '`[loss-streak] N losses in a row. Cooling down for M min more`', reason: 'fix/skills-match-code: the gate\'s loss-streak cooldown (order-gate.js) had no Do row' },
  { row: '`[briefing-age] Stale data: …` (or no bar briefing)', reason: 'fix/skills-match-code: the gate\'s stale-briefing refusal (order-gate.js briefingAgeRefusal) had no row' },
  { row: '`[modify-size] …`', reason: 'fix/skills-match-code: the modify_order size refusal (order-gate.js evaluateModify, account-gate.js) had no row' },
  { row: '`[composed-reprice] …`', reason: 'fix/skills-match-code: a composed entry repriced worse than its record (order-gate.js evaluateModify) had no row' },
  { row: '`[phase2-size] size <n> is over the <m> risk-manager phase 2 approved`', reason: 'fix/phase2-verdict-format (owner-approved 2026-10-22): the gate\'s new tighten-only phase2-size refusal (order-gate.js, roles-ran.js sizeRefusal)' },
  { row: '`[min-contracts] setup:<policy>: size <n> <ROOT> is under the floor of <m> contracts`', reason: 'feat/prop-min-contracts (owner-approved 2026-10-23, "sizing floor is 3"): the rulebook\'s min_contracts, a new prop refusal (prop-state.js minContractsRefusal)' },
];

// Each piece's rows, by label (or the message's start when it has no label), in order: a row in the wrong piece fails.
const ROWS = {
  'gate-refusals': ['Blocked by trading harness', 'order-pending', 'replay-clock', 'stop-defined', 'account-required', 'contract-specs', 'contract-specs', 'contract-specs', 'order-pending', 'loss-streak', 'briefing-age'],
  'gate-refusals-limits': ['combine', 'combine', 'combine', 'prop-account-attempt', 'policy', 'min-contracts', 'strategy', 'strategy', 'strategy', 'strategy', 'max-order-size', 'max-order-size', 'max-risk', 'max-risk'],
  'gate-refusals-positions': ['exposure', 'order gate could not run', 'partial-close', '... once recent orders fill', 'modify-entry', 'order gate could not run', 'modify-size', 'bracket-leg', 'bracket-only', 'composed-reprice'],
  'gate-refusals-cycle': ['roles-ran', 'phase2-facts', 'phase2-size'],
};

const homeTexts = () => HOMES.map(skill);
// A table row's message (its first cell), for the refusal it explains.
const rowsOf = text => text.split('\n').filter(l => /^\| `/.test(l)).map(l => l.split(' | ')[0].slice(2));
const label = msg => (/^`\[([a-z0-9-]+)\]/.exec(msg) || [])[1] || null;

test('gate-refusals split: every unit of the old skill is in exactly one new home, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
  // Every row of the old table is a row in exactly one piece.
  const old = rowsOf(read(BEFORE));
  const now = homeTexts().flatMap(rowsOf);
  assert.deepStrictEqual([...now].filter(r => !ADDED_ROWS.some(a => a.row === r)).sort(), [...old].sort());
  for (const a of ADDED_ROWS) assert.ok(a.reason && now.filter(r => r === a.row).length === 1 && !old.includes(a.row), a.row);
  // And each row is in the piece of its family.
  const key = m => label(m) || m.replace(/^`|`.*$/g, '').replace(/ \(.*$/, '');
  for (const s of HOMES) assert.deepStrictEqual(rowsOf(skill(s)).map(key), ROWS[s], s);
});

test('gate-refusals split: a piece\'s index line names only its own refusals, and the hub none of another piece\'s', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const labelsOf = s => new Set(rowsOf(skill(s)).map(label).filter(Boolean));
  const named = s => [...parseFrontmatter(skill(s)).data.description.matchAll(/\[([a-z0-9-]+)\]/g)].map(m => m[1]);
  for (const s of HOMES) {
    for (const l of named(s)) assert.ok(labelsOf(s).has(l), `${s}: its description names [${l}], which it has no row for`);
  }
  // The limits and cycle pieces name every label they hold (the index is how the head trader finds them).
  for (const s of ['gate-refusals-limits', 'gate-refusals-cycle']) {
    for (const l of labelsOf(s)) assert.ok(named(s).includes(l), `${s}: its description names [${l}]`);
  }
  const hub = labelsOf('gate-refusals');
  for (const s of HOMES.slice(1)) for (const l of named(s)) assert.ok(!hub.has(l), `gate-refusals holds [${l}], which ${s} names`);
  // The positions piece's index line covers its rows: a refused management order, a position it can't read.
  assert.match(parseFrontmatter(skill('gate-refusals-positions')).data.description, /managing a position \(an exit by contract month, a trading-day change\), or can't read one/);
});

test('gate-refusals split: the comparison catches a lost, a doubled, an edited or a reordered row', () => {
  const old = read(BEFORE);
  assert.ok(units(old).length > 80, `the units are fine-grained (${units(old).length})`);
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const lim = homes[at('gate-refusals-limits')];
  const ROW = /^\| `\[max-order-size\] size N over.*\n/m.exec(lim)[0];
  assert.notDeepStrictEqual(differences(old, swap('gate-refusals-limits', lim.replace(ROW, '')), ALLOWED), [], 'lost');
  assert.notDeepStrictEqual(differences(old, swap('gate-refusals-cycle', `${homes[at('gate-refusals-cycle')]}\n${ROW}`), ALLOWED), [], 'doubled');
  assert.notDeepStrictEqual(differences(old, swap('gate-refusals-limits', lim.replace('Never split it into several orders.', 'Never split it.')), ALLOWED), [], 'edited');
  // Reordered: two rows swapped (nothing lost, the order changed).
  const R1 = /^\| `\[max-risk\] risk \$X.*\n/m.exec(lim)[0];
  const swapped = lim.replace(ROW, '\u0000').replace(R1, ROW).replace('\u0000', R1);
  assert.deepStrictEqual(differences(old, swap('gate-refusals-limits', swapped), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('gate-refusals-limits', swapped), HOMES, ALLOWED), [], 'but changes the order');
  // A row moved to another piece in its old order: the units still match, the pinned rows of each piece don't.
  const key = m => label(m) || m;
  const moved = lim.replace(ROW, '');
  assert.notDeepStrictEqual(rowsOf(moved).map(key), ROWS['gate-refusals-limits'], 'a moved row is caught');
  // The header in a fifth place, or a section heading dropped.
  assert.notDeepStrictEqual(differences(old, [...homes, '| Message | x |\n'], ALLOWED, { structure: false }), []);
  assert.notDeepStrictEqual(differences(old, swap('gate-refusals-cycle', homes[at('gate-refusals-cycle')].replace('## Examples', '## Example')), ALLOWED), []);
});

test('gate-refusals split: each piece has a short "Use when" index line, and gate-refusals points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(skill(s)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
  }
  const hub = skill('gate-refusals').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(hub, new RegExp(`\`${s}\``), `gate-refusals points to ${s}`);
  // The pointers into the split name the piece that has the row.
  assert.match(skill('order-failures').replace(/\s+/g, ' '), /the gate refuses the `\[protect\]`: `close_position` again; see the `gate-refusals-positions` skill\./);
  assert.ok(rowsOf(skill('gate-refusals-positions')).some(m => m.startsWith('`... once recent orders fill`')));
  assert.match(read('skills/broker-mcp/SKILL.md'), /`Blocked by trading harness` refusal: the `gate-refusals` skill/);
  assert.match(read('skills/broker-refusals/SKILL.md').replace(/\s+/g, ' '), /are in the `gate-refusals` skill/);
});

test('gate-refusals split: exits are never refused, and every piece still says so', () => {
  // The gate never checks an [exit] or [protect] order (order-gate.js) and never gates close_position (account-gate.js).
  const { evaluateOrder } = require('../../scripts/lib/trading/order-gate');
  for (const rationale of ['[exit] flatten', '[protect] stop']) {
    assert.deepStrictEqual(evaluateOrder({ input: { rationale }, config: {} }).violations, []);
  }
  const SAYS = {
    'gate-refusals': /Exits, `\[protect\]` stops, stop moves, cancels and `close_position` still go\./,
    'gate-refusals-limits': /Exits and `\[protect\]` stops always go\./,
    'gate-refusals-positions': /`close_position` itself is never gated\./,
    'gate-refusals-cycle': /Exits and stops still go\./,
  };
  for (const s of HOMES) assert.match(skill(s).replace(/\s+/g, ' '), SAYS[s], s);
  // The positions piece: a refused [protect] after an errored close is answered by close_position, which always goes.
  assert.match(skill('gate-refusals-positions'), /`close_position` again \(it always goes\)/);
  assert.match(skill('gate-refusals-positions'), /No orders but `close_position` \(never gated\)/);
});

test('gate-refusals split: every role that can see a refusal reaches its row; a role that acts on it has it in core', () => {
  const { loadRoles } = require('../../scripts/lib/role-skills');
  const roles = loadRoles(ROOT);
  const holds = (r, re) => r.tools.some(t => re.test(t));
  const ENTRY = /__place_order$/;
  const MANAGE = /__(modify_order|cancel_order|close_position|partial_close_position)$/;
  for (const r of roles) {
    // A role that sends orders acts on the refusals of the order itself and of managing a position: in its core.
    if (holds(r, ENTRY)) assert.ok(r.skills.includes('gate-refusals'), `${r.name}: gate-refusals in its core`);
    if (holds(r, MANAGE)) assert.ok(r.skills.includes('gate-refusals-positions'), `${r.name}: gate-refusals-positions in its core`);
    // The limits and cycle rows are the head trader's to act on: the executor reports them verbatim (its Blocks) and
    // reaches them through gate-refusals, which names their skills.
    if (holds(r, ENTRY)) assert.match(read(`agents/${r.file}`).replace(/\s+/g, ' '), /do not retry, resize, reroute, or relabel it\. Report the block verbatim to the caller\./);
  }
  // The risk manager places nothing; its checks name the refusals of the limits and of its FACTS line: in its core.
  const rm = roles.find(r => r.name === 'risk-manager');
  for (const s of ['gate-refusals-limits', 'gate-refusals-cycle']) assert.ok(rm.skills.includes(s), `risk-manager: ${s}`);
  for (const s of ['gate-refusals', 'gate-refusals-positions']) assert.ok(![...rm.skills, ...rm.index].includes(s), `risk-manager: no ${s}`);
  const rmBody = read('agents/risk-manager.md').replace(/\s+/g, ' ');
  for (const re of [/`maxOrderSize`: VETO, the gate refuses it anyway/, /the gate refuses an entry over it/, /The order gate refuses an entry approved on a fact the briefing contradicts/]) assert.match(rmBody, re);
  // The head trader (the main session) acts on any of them: its skill index (workspace/AGENTS.md) lists every piece.
  const agentsMd = read('workspace/AGENTS.md');
  for (const s of HOMES) assert.match(agentsMd, new RegExp(`^- \`${s}\` \\(skills/${s}/SKILL\\.md\\): Use when `, 'm'), `AGENTS.md lists ${s}`);
});

// A tripwire, not a proof: the scan below reads every script under scripts/ for a skill named in its code (not its
// comments) in three plain forms ("<name> skill", "the `<name>` skill", "skill `<name>`", skills/<name>/SKILL.md). A
// name built by concatenation or a template expression (`${name} skill`) evades it; that is accepted. Every hit is
// listed here: a refusal message's pointer with the label of the refusal it is in (the skill it names must hold that
// refusal), or prompt text, which names the skills a prompt loads and is no refusal.
const POINTERS = [
  // The message cites the rule it enforces ("since the last trade-executor call", "trade-session step 6"), which
  // trade-session states with the refusal's label; it named trade-session before the split too, never gate-refusals.
  { file: 'scripts/lib/trading/roles-ran.js', skill: 'trade-session', label: 'roles-ran' },
];
// Prompt text, not refusals: the runner's cycle prompts (autotrader.js) and a generated role's tool line (harness-sync.js).
const PROMPT_TEXT = [
  ...['trader-process', 'autonomous-trading', 'premarket', 'trade-session', 'prop-challenge-pacing', 'end-of-day', 'trade-lifecycle'].map(skill => ({ file: 'scripts/lib/autotrader.js', skill })),
  { file: 'scripts/lib/harness-sync.js', skill: 'tool-arguments' },
  // The Trend declared? line's part of trend-vs-range, quoted in a cycle's prompt (situational-skills.js SECTIONS).
  { file: 'scripts/lib/situational-skills.js', skill: 'trend-vs-range' },
];
const GATE_CODE = () => fs.readdirSync(path.join(ROOT, 'scripts'), { recursive: true }).map(String).filter(f => f.endsWith('.js')).map(f => `scripts/${f.split(path.sep).join('/')}`);
const SKILL_NAMES = new Set(fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md'))));
/** The skills a source file's code (not its comments) names as "<name> skill" or "the `<name>` skill". */
function namedSkills(text) {
  const code = text.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s\/\/\s.*$/, '')).join('\n');
  const forms = [/`?([a-z][a-z0-9-]*)\\?`? skill\b/g, /\bskill \\?`([a-z][a-z0-9-]*)\\?`/g, /skills\/([a-z][a-z0-9-]*)\/SKILL\.md/g];
  return [...new Set(forms.flatMap(re => [...code.matchAll(re)].map(m => m[1])).filter(n => SKILL_NAMES.has(n)))];
}

test('refusal messages: a skill a refusal names holds that refusal; every such pointer is listed', () => {
  const found = GATE_CODE().flatMap(file => namedSkills(read(file)).map(s => `${file} -> ${s}`)).sort();
  assert.deepStrictEqual(found, [...POINTERS, ...PROMPT_TEXT].map(p => `${p.file} -> ${p.skill}`).sort(), 'every skill a script names is a listed refusal pointer or prompt text');
  assert.ok(found.length > POINTERS.length, `the scan reads every script (${found.length} hits)`);
  for (const p of POINTERS) assert.ok(skill(p.skill).includes(`\`[${p.label}]\``), `${p.skill} holds [${p.label}]`);
  // The message itself, as the gate gives it: an empty transcript, so no role has returned.
  const { checkRolesRan } = require('../../scripts/lib/trading/roles-ran');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-refusal-'));
  try {
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, '');
    assert.match(checkRolesRan(file, 'full'), /\(trade-session skill\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // No refusal message names a gate-refusals piece today; one that does must name the piece that holds its row.
  for (const p of POINTERS.filter(x => HOMES.includes(x.skill))) assert.ok(rowsOf(skill(p.skill)).some(m => label(m) === p.label), `${p.skill} has the [${p.label}] row`);
});

test('refusal messages: the scan finds a skill named in a message, and not one named in a comment', () => {
  assert.deepStrictEqual(namedSkills("const m = `see the gate-refusals-limits skill`;"), ['gate-refusals-limits']);
  assert.deepStrictEqual(namedSkills('throw new Error("read the `order-mechanics` skill");'), ['order-mechanics']);
  assert.deepStrictEqual(namedSkills('// the trade-session skill says so\n * the trade-session skill'), []);
  assert.deepStrictEqual(namedSkills("'load it with the skill tool'"), []);
  assert.deepStrictEqual(namedSkills("`load skill \\`gate-refusals-cycle\\``"), ['gate-refusals-cycle']);
  assert.deepStrictEqual(namedSkills("'see skills/gate-refusals/SKILL.md'"), ['gate-refusals']);
  assert.deepStrictEqual(namedSkills('`see the \\`gate-refusals-limits\\` skill`'), ['gate-refusals-limits']);
});
