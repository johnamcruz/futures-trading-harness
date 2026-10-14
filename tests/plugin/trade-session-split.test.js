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
    now: 'The order gate refuses an entry until each is loaded (an errored load doesn\'t count); one already in your prompt counts: don\'t reload it (no skill tool: skill_lookup).',
    reason: 'a skill embedded in the head trader\'s prompt is loaded (the gate counts it on the runner\'s attestation); without a skill tool, skill_lookup; shortened so step 0 does not grow' },
  // trade_lifecycle is the one entry strategy (the owner's, E12/S1): step 0 loads its list; a rules entry names the
  // strategy skills too.
  { old: 'Before any decision, load `trade-session` (this skill), `multi-timeframe-analysis`, `strategy-library`, `strategy-scan`, and `strategy-gate-checks` with the skill tool.',
    now: 'Before any decision, load `trade-session` (this skill), `multi-timeframe-analysis` and `trade-lifecycle` with the skill tool (a rules entry: `strategy-library`, `strategy-scan`, `strategy-gate-checks` too).',
    reason: 'the composed entry\'s list (trade-lifecycle in place of the strategy skills, which a rules entry still reads)' },
  { old: 'A role\'s call is that role\'s own analysis (the order gate counts it as its report): never ask a role to read, load or summarize skills or files for you; load skills yourself (your skill tool, or without one read their `SKILL.md`).',
    now: 'A role\'s call is that role\'s own analysis (the order gate counts it as its report): never ask a role to read, load or summarize skills or files for you; load skills yourself (your skill tool; none: skill_lookup or `SKILL.md`).',
    reason: 'the head trader without a skill tool (opencode, index mode) reads a skill with skill_lookup, which the gate counts' },
  { old: "Never argue a trend strategy into a counter-trend trade.",
    now: "Never argue a trend strategy into a counter-trend trade; a composed one goes against it only with a true 15m or 1h CHoCH its way among its reads (`bos-vs-choch`).",
    reason: "owner decision D2 (fix/skills-composed-process): a composed entry may go against the trend with a verified 15m or 1h CHoCH its way" },
  { old: "The read for the candidate's side sets its size by the priority order (strategy-library, step 4).",
    copies: 0,
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; its size is the model's under the code's caps, so the size rule is strategy-library's alone, not restated here" },
  { old: "Put the read in the plan entry.",
    now: "Put the read for the side in the plan entry.",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; its size is the model's under the code's caps, so the size rule is strategy-library's alone, not restated here" },
  { old: "A policy verdict (below) is a ceiling: the priority order halves or skips it like any setup.",
    now: "A policy verdict is a ceiling, never an order.",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; its size is the model's under the code's caps, so the size rule is strategy-library's alone, not restated here; the policy's one component is trade_lifecycle (D4)" },
  { old: "Apply its steps in order; the size is the smaller of the verdict's (or position-sizing's) and what they allow.",
    now: "Apply its steps in order.",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; its size is the model's under the code's caps, so the size rule is strategy-library's alone, not restated here" },
  { old: "No candidate, a failed skip rule, an event within 15 minutes, or an unanswered red flag → **no trade**: journal a short `note` with the reason and what would change it, and end.",
    now: "No setup (no candidate, no `compose_check` OK), a failed skip rule, an event within 15 minutes, or an unanswered red flag → **no trade**: journal a short `note` with the reason and what would change it, and end.",
    reason: "the skill audit (fix/skills-composed-process, S1): the composed trade (trade_lifecycle, the one strategy) is a setup too, not only a scan candidate" },
  { old: "Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium, scan: orb",
    now: "Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium), volume",
    reason: "the skill audit (fix/skills-composed-process): the example is a composed trade (orb is retired), tick-correct" },
  { old: "candidate long), volume long (rel-vol 1.6x), no events until 14:00, risk budget",
    now: "long (rel-vol 1.6x), no events until 14:00. compose_check long OK. Plan (numbers",
    reason: "the example's old line (orb, retired): the composed example replaces it" },
  { old: "$40/trade. orb skip rules clear. Plan (numbers from order_plan): long 21503.25,",
    now: "from the record): limit long 21540.25, stop 21512.50 (111 ticks = $55.50),",
    reason: "the example's old line (orb, retired): the composed example replaces it" },
  { old: "stop 21498.00 (1R = 5.25 pts = 21 ticks = $10.50), 1 MNQ; exit: trail from +2R",
    now: "target 21598.00 (231 ticks, 2.08R), 1 MNQ.",
    reason: "the example's old line (orb, retired): the composed example replaces it" },
  { old: "(21513.75), giving back 0.5R.",
    copies: 0,
    reason: "the example's old line (orb, retired): the composed example replaces it" },
  { old: "Verdict APPROVE. Executed with a stop bracket only, stop working.",
    now: "Verdict APPROVE. Executed with stop and target brackets, stop working.",
    reason: "the example's old line (orb, retired): the composed example replaces it" },
  { old: "No candidate → note and end (`candidates: null`, the scan failed or the bar wasn't scanned, counts as none).",
    now: "No candidate and no setup you compose (`trade_lifecycle`) → note and end (`candidates: null`, the scan failed or the bar wasn't scanned, counts as none).",
    reason: "the skill audit (fix/skills-composed-process, S1): the composed trade (trade_lifecycle, the one strategy) is a setup too, not only a scan candidate" },
  { old: "A candidate → `risk-manager` phase 1 and 2, then execute.",
    now: "A candidate or a composed setup → `risk-manager` phase 1 and 2, then execute.",
    reason: "the skill audit (fix/skills-composed-process, S1): the composed trade (trade_lifecycle, the one strategy) is a setup too, not only a scan candidate" },
  { old: "**Read each setup's facts first** (the briefing's summary, and `facts`, `inTheWay`, `needR` and `blocked` in `m3` `candidates`: what the trend rule says for its side, the multi-timeframe read for its side, the first level in its way in its own R against the room it needs, confluence, the VWAP side, the window; `values`, also in the \"fired on this bar\" line: the broker fields its fired side's rules read, on this bar (an `any(...)` group's held branches only), where a field's meaning and units are in the strategy's own document).",
    now: "**Read each setup's facts first**: a composed setup's are your reads and the record's plan, each checked by `compose_check` (`trade_lifecycle`); a candidate's, `facts`, `inTheWay`, `needR` and `blocked` in `m3` `candidates`.",
    reason: "the skill audit (fix/skills-composed-process, S1): the composed trade (trade_lifecycle, the one strategy) is a setup too, not only a scan candidate; a rules candidate's broker-field values went with the retired rules strategies" },
  { old: "Never plan the component strategy (e.g.",
    now: "Never tag the component (`trade_lifecycle`) yourself; the gate refuses it.",
    reason: "the skill audit (fix/skills-composed-process, D4): prop_portfolio's one component is trade_lifecycle (orb is retired)" },
  { old: "`orb`) yourself; the gate refuses it.",
    copies: 0,
    reason: "the second half of the sentence above (orb is retired)" },
  { old: "Otherwise pick at most one strategy that is a `candidate` in the scan in this direction on the last closed bar (candidates are already in session and in regime: the trigger fired), or a manual strategy whose trigger you verified on closed bars and whose `regimes` fit; quote the trigger in the plan.",
    now: "Otherwise compose one (`trade_lifecycle`), or pick at most one strategy that is a `candidate` in the scan in this direction on the last closed bar (candidates are already in session and in regime: the trigger fired), or a manual strategy whose trigger you verified on closed bars and whose `regimes` fit; quote the trigger in the plan.",
    reason: "the skill audit (fix/skills-composed-process, S1): the composed trade (trade_lifecycle, the one strategy) is a setup too, not only a scan candidate" },
  { old: "`journal_add {kind:\"plan\", contractId, tags:[\"setup:<name>\", \"<SYMBOL>\", \"regime:<primary>\"]}`: thesis, trigger (what happened, price, time), entry, stop, exit, size (position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's P&L, and for a prop attempt the cushion and size budget), skip rules checked, analyst agreement, and what each role reported that the plan rests on: the structure bias and the level the entry and stop sit against (market structure); the VWAP side, the value area or POC, the nearest liquidity in the trade's way (the candidate's `inTheWay` in the briefing's `m3` `candidates`: the first level in its direction in points and R, where 1R is its own stop; with `order_plan`'s stop, check there is room to the target or the trail's activation, and a level closer than 1R is a skip under the skip rules that name it), and the session window (the briefing's `m3` `windowText`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the multi-timeframe alignment for the side (aligned, pullback, mixed, counter) and the size it implies; and risk-manager phase 1's budget and pace.",
    now: "`journal_add {kind:\"plan\", contractId, tags:[\"setup:<name>\", \"<SYMBOL>\", \"regime:<primary>\"]}`: thesis, trigger (what happened, price, time), entry, stop, exit, size (position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's P&L, and for a prop attempt the cushion and size budget), skip rules checked, analyst agreement, and what each role reported that the plan rests on: the structure bias and the level the entry and stop sit against (market structure); the VWAP side, the value area or POC, the nearest liquidity in the trade's way (`inTheWay`, the compose record's or a candidate's: the first level in its direction in points and R, where 1R is its own stop: check there is room to the target or the trail's activation), and the session window (the briefing's `m3` `windowText`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the multi-timeframe alignment for the side (aligned, pullback, mixed, counter) and the size it implies; and risk-manager phase 1's budget and pace.",
    reason: "the skill audit (fix/skills-composed-process, X2): a composed trade's room is its compose record's inTheWay (trade-plan-edits.js)" },
  { old: "The exit follows the strategy's `exit` (shown in the scan):",
    now: "The exit: a composed trade's target is the record's level (`trade_lifecycle`); a policy's or a rules strategy's follows its `exit` (the rulebook, the scan):",
    reason: "the skill audit (fix/skills-composed-process, X2): a composed trade's exit is its record's target (trade-plan-edits.js)" },
  { old: "The runner (or you, without one) trails it from `trailActivateR` with `trailGivebackR` give-back; read both from the scan's `exit`, don't assume them.",
    now: "The runner (or you, without one) trails it from `trailActivateR` with `trailGivebackR` give-back; read both from its `exit`, don't assume them.",
    reason: "a policy's trail is its rulebook's exit, not the scan's (trade-plan-edits.js)" },
  { old: "**Target level:** with `exit.target` the scan gives `targetDistance`: the target is the signal bar's close ± that distance (e.g. a CRT range's far side).",
    copies: 0,
    reason: "only retired rules strategies had a target distance (trade-plan-edits.js)" },
  { old: "**Time stop:** with `maxBars`, close at market after that many bars in the trade if neither the stop nor the target has filled.",
    copies: 0,
    reason: "only retired rules strategies had a time stop (trade-plan-edits.js)" },
  { old: "**The exact numbers come from `order_plan`**, not from your own arithmetic: once you have chosen the strategy and the side (the steps above: the trigger, the trend rule, the skip rules, the account), call it with them, e.g.",
    now: "**The exact numbers come from `order_plan`** (a rules strategy, a policy verdict) **or the compose record** (`trade_lifecycle`), not from your own arithmetic: once you have chosen the strategy and the side, call it with them, e.g.",
    reason: "the skill audit (fix/skills-composed-process, X2): numbers from order_plan or the compose record (trade-plan-edits.js)" },
  { old: "`order_plan {\"bars\": \"<bars file>\", \"symbol\": \"MNQ\", \"strategy\": \"orb\", \"side\": \"long\"}`.",
    now: "`order_plan {\"bars\": \"<bars file>\", \"symbol\": \"MNQ\", \"strategy\": \"<name>\", \"side\": \"long\"}`.",
    reason: "orb is retired: the example names a strategy (trade-plan-edits.js)" },
  { old: "Its size is the starting size: 1 for a rules strategy (position-sizing's size-1 rule) and, for a policy, the verdict's cut to the attempt's size budget now, which is the most a policy entry may have.",
    now: "Its size is the starting size: 1 for a rules strategy (position-sizing's size-1 rule) and, for a policy, the verdict's cut to the attempt's size budget now, which is the most a policy entry may have; a composed trade's is the size you stated, at most the record's `maxSize`.",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; its size is the model's under the code's caps, so the size rule is strategy-library's alone, not restated here (trade-plan-edits.js)" },
  { old: "A different size from your plan changes only `size`, and the risk scales with it: smaller for a `mixed` read or a reversal fade, and, for a rules strategy, larger only as position-sizing allows (a setup with 30+ reviewed trades and positive expectancy, within the budget and caps).",
    now: "A different size from your plan changes only `size`, and the risk scales with it.",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; its size is the model's under the code's caps, so the size rule is strategy-library's alone, not restated here (trade-plan-edits.js)" },
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
  // trade-lifecycle joins after multi-timeframe-analysis (the composed entry's list; the strategy skills a rules entry's).
  const before0 = step0(read(BEFORE));
  assert.deepStrictEqual(step0(ts), [...before0.slice(0, 2), 'trade-lifecycle', ...before0.slice(2)]);
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
  // With the edits made since, each with its reason (trade-plan-edits.js).
  assert.strictEqual(`### 4. Plan\n\n${body}`, require('./trade-plan-edits').edited(old.slice(old.indexOf('### 4. Plan'), old.indexOf('### 5. Verdict'))));
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
// review grew by 6 bytes); the risk manager lowered since (its order pieces indexed or dropped, its situational
// skills in its core: perf/replay-fixes).
const ROLE_PROMPTS = {
  full: { 'market-structure-analyst': 88188, 'news-calendar-analyst': 10523, 'risk-manager': 88878, 'strategy-researcher': 25662, 'trade-executor': 30268, 'trade-reviewer': 9195, 'trend-momentum-analyst': 55850, 'volume-liquidity-analyst': 49365 },
  index: { 'market-structure-analyst': 43667, 'news-calendar-analyst': 10523, 'risk-manager': 74343, 'strategy-researcher': 25662, 'trade-executor': 30268, 'trade-reviewer': 9195, 'trend-momentum-analyst': 40995, 'volume-liquidity-analyst': 33580 },
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
