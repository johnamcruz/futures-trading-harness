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
    now: "Never argue a trend strategy into a counter-trend trade; a composed one goes against it only with a true CHoCH its way at or above the trend's frame (`trade-lifecycle`).",
    reason: "owner decision D2 (fix/skills-composed-process): a composed entry may go against the trend with a verified CHoCH at or above the trend's frame its way" },
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

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "**Bars, interactively** (no runner bars file): the harness tool `bars_fetch` (`{\"symbol\": \"<SYMBOL>\", \"timeframe\": <3 or 1>, \"record\": true}`) writes the runner's default count of closed bars (5000 3-minute, 15000 1-minute) to `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json` (this harness home's own; use the path it returns) and records the multi-timeframe read for the gate (the `bar-briefing` skill).",
    to: "**Bars, interactively** (no runner bars file): the harness tool `bars_fetch` (`{\"symbol\": \"<SYMBOL>\", \"timeframe\": <3 or 1>, \"record\": true}`) writes the runner's default count of closed bars to `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json` (this harness home's own; use the path it returns) and records the multi-timeframe read for the gate (the `bar-briefing` skill).",
    reason: "feat/htf-history: the runner's bar count follows the read's window (config/analysis.json mtf.historyHours), so the skills name no count (its one home is the config)" },
  { from: "**Confluence.** Several strategies firing the same side on the bar (the scan's `confluence.with`, the prompt's \"fired on this bar\" line) is a stronger setup: say so in the plan, and prefer it over a lone signal.",
    to: "**Confluence.** A composed setup's: the count of `confluence-counting`.",
    reason: "review of #169: composed-correct, against the merged trade_lifecycle code: a composed setup counts confluence-counting's items; the strategies-firing rules are the rules strategies'" },
  { from: "Strategies firing both sides (`confluence.against`) is a conflict: stand aside (the priority order, step 6: no exception).",
    to: "Rules strategies firing the same side on the bar (`confluence.with`) are a stronger setup; both sides (`confluence.against`) a conflict: stand aside (the priority order, step 6: no exception).",
    reason: "review of #169: composed-correct, against the merged trade_lifecycle code: one sentence for the rules strategies" },
  { from: "The backtest reports results by confluence (`byConfluence`); trust it over a feeling that agreement helps.",
    to: "Trust the backtest's `byConfluence` over a feeling that agreement helps.",
    reason: "review of #169: composed-correct, against the merged trade_lifecycle code: shortened, so the head prompt doesn't grow" },
  { from: "No candidate and no setup you compose (`trade_lifecycle`) → note and end (`candidates: null`, the scan failed or the bar wasn't scanned, counts as none).",
    to: "No candidate and no setup you compose (`trade-lifecycle`) → note and end (`candidates: null`, the scan failed or the bar wasn't scanned, counts as none).",
    reason: "the pointer goes to the trade-lifecycle skill now that it exists (#172-#174)" },
  { from: "**Read each setup's facts first**: a composed setup's are your reads and the record's plan, each checked by `compose_check` (`trade_lifecycle`); a candidate's, `facts`, `inTheWay`, `needR` and `blocked` in `m3` `candidates`.",
    to: "**Read each setup's facts first**: a composed setup's are your reads and the record's plan, each checked by `compose_check` (`trade-lifecycle`); a candidate's, `facts`, `inTheWay`, `needR` and `blocked` in `m3` `candidates`.",
    reason: "the pointer goes to the trade-lifecycle skill now that it exists (#172-#174)" },
  { from: "Otherwise compose one (`trade_lifecycle`), or pick at most one strategy that is a `candidate` in the scan in this direction on the last closed bar (candidates are already in session and in regime: the trigger fired), or a manual strategy whose trigger you verified on closed bars and whose `regimes` fit; quote the trigger in the plan.",
    to: "Otherwise compose one (`trade-lifecycle`), or pick at most one strategy that is a `candidate` in the scan in this direction on the last closed bar (candidates are already in session and in regime: the trigger fired), or a manual strategy whose trigger you verified on closed bars and whose `regimes` fit; quote the trigger in the plan.",
    reason: "the pointer goes to the trade-lifecycle skill now that it exists (#172-#174)" },
  { from: "The exit: a composed trade's target is the record's level (`trade_lifecycle`); a policy's or a rules strategy's follows its `exit` (the rulebook, the scan):",
    to: "The exit: a composed trade's target is the record's level (`trade-lifecycle`); a policy's or a rules strategy's follows its `exit` (the rulebook, the scan):",
    reason: "the pointer goes to the trade-lifecycle skill now that it exists (#172-#174)" },
  { from: "**The exact numbers come from `order_plan`** (a rules strategy, a policy verdict) **or the compose record** (`trade_lifecycle`), not from your own arithmetic: once you have chosen the strategy and the side, call it with them, e.g.",
    to: "**The exact numbers come from `order_plan`** (a rules strategy, a policy verdict, or `trade_lifecycle`'s compose record: `trade-lifecycle`), not from your own arithmetic: once you have chosen the strategy and the side, call it with them, e.g.",
    reason: "the pointer goes to the trade-lifecycle skill now that it exists (#172-#174); order_plan plans the compose record (#173)" },
  { from: "Its size is the starting size: 1 for a rules strategy (position-sizing's size-1 rule) and, for a policy, the verdict's cut to the attempt's size budget now, which is the most a policy entry may have; a composed trade's is the size you stated, at most the record's `maxSize`.",
    to: "Its size is the starting size: 1 for a rules strategy (position-sizing's size-1 rule) and, for a policy, the verdict's cut to the attempt's size budget now, which is the most a policy entry may have; a composed trade's is the size you stated, refused over its cap (in an attempt, also the verdict).",
    reason: "review of #169: composed-correct, against the merged trade_lifecycle code: order_plan refuses a composed size over its cap and, in an attempt, the verdict" },
  { from: "A different size from your plan changes only `size`, and the risk scales with it.",
    to: "A different size from your plan changes only `size`, and the risk scales with it: for a rules strategy, smaller for a `mixed` read or a reversal fade, and larger only as position-sizing allows (a setup with 30+ reviewed trades and positive expectancy, within the budget and caps).",
    reason: "review of #169: composed-correct, against the merged trade_lifecycle code: the halving and the size steps stay for a rules strategy" },
  { from: "If the strategy's exit trails (`exit` in the scan) and the autonomous runner is running, it already moved the stop on this bar: don't touch it unless you are exiting.", to: "A rules strategy (none active) whose exit trails (`exit` in the scan): the runner already moved the stop on this bar: don't touch it unless you are exiting.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "**Interactive, no runner:** nobody else manages the trade, so run this skill again after every closed bar while the position is open (fetch the bar with `bars_fetch`).", to: "**Interactive, no runner**: the brackets are the whole exit, a composed trade's too; nothing moves them.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "**Every cycle, first:** the bar briefing (`bar_briefing {\"symbol\": \"<SYMBOL>\"}`, the `bar-briefing` skill): this bar's analysis by timeframe, computed once by the runner (the multi-timeframe read with the alignment per side, the trend rule, the scan's candidates and confluence, the snapshot's levels, VWAP, participation and liquidity, the session window), each part with its version and how long it holds.", to: "**Every cycle, first:** the bar briefing (`bar_briefing {\"symbol\": \"<SYMBOL>\"}`, the `bar-briefing` skill): this bar's analysis by timeframe, computed once by the runner (the multi-timeframe read with the alignment per side, the trend rule, the setups to check, the snapshot's levels, VWAP, participation and liquidity, the session window), each part with its version and how long it holds.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "**The trend rule is enforced:** a trend strategy never enters against the prevailing trend (the highest of 4h, 1h, 15m with a trend); only a strategy with `mtf: reversal` may fade it.", to: "**The trend rule is enforced:** no entry against the prevailing trend (the highest of 4h, 1h, 15m with a trend), long or short alike: a composed one only on a true CHoCH its way at or above the trend's frame (`trade-lifecycle`), a rules one only with `mtf: reversal`.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "The scan already drops such candidates and the order gate refuses them.", to: null,
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "**The trigger is checked too.** The scan's `candidate` is the trigger: the gate refuses a rules strategy's entry unless that strategy fired, on that side, on a bar that closed at most 3 bars of its own timeframe ago, and never more than 45 minutes ago (3 min on 1m, 9 min on 3m, 45 min on 15m and 1h), per the signal record (the runner records every bar; interactively, `strategies_scan` with the bars file, `symbol`, and `record: true`).", to: "A rules strategy's (none active): the scan's `candidate` on that side, on a bar that closed at most 3 bars of its own timeframe ago and never more than 45 minutes ago (3 min on 1m, 9 min on 3m), per the signal record (interactively, `strategies_scan` with `record: true`); enter only on the strategy that fired.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "A different setup tag on the same trade is refused: enter only on the strategy that fired.", to: null,
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Yourself, in order: step 1, the bar briefing (without one: the multi-timeframe read, `market_snapshot` and `strategies_scan` on the bars file), and the blackouts (`blackouts_list`).", to: "Yourself, in order: step 1, the bar briefing (without one: the multi-timeframe read and `market_snapshot` on the bars file), and the blackouts (`blackouts_list`).",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Bias, swings, levels, structure strategies in play", to: "Bias, swings, levels, breaks, candle reactions",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Regime, indicator values, strategy scan results", to: "Regime, indicator values, trend and momentum",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "**Track record.** Each strategy that fired carries its record: the recorded backtest (overall, in this regime, at this hour, when there are enough trades) and your reviewed live trades.", to: "**Track record** (a rules strategy; none active): weigh its signal by its recorded backtest and reviewed live trades: no recorded edge, a negative slice for this regime or hour, or live results well under it is a smaller trade or none.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Weigh the signal by it: a strategy with no recorded edge, a negative slice for this regime or hour, or live results well under its backtest is a smaller trade or no trade; say which in the plan.", to: null,
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Under 30 trades is anecdotal, not evidence.", to: "Under 30 trades is anecdotal; \"no backtest recorded\" is the weakest case; a STALE record doesn't describe it.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Manage it by its strategy's exit (`exit` in its STRATEGY.md: trail, target, time stop); never loosen the stop.", to: "Manage it by its `exit` (trail, target, time stop); never loosen the stop.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "`show` it (strategy-library) and check every context filter and skip rule against the reports.", to: null,
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "They are context, not a verdict: judge the setup by its strategy's STRATEGY.md (`strategies_show`: its context filter and skip rules) and these rules (the trend rule, the alignment table in `htf-to-ltf`, its min R:R).", to: "They are context, not a verdict: judge by the side rule (`htf-to-ltf`) and its alignment table, and the min R:R (compose_check's; a rules strategy: also its STRATEGY.md).",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "A setup the trend rule allows, `aligned` for its side, with room past what it needs and confluence with it is the opportunity this harness looks for, when the rest of this skill agrees and it isn't `blocked`: the strategy's normal size (position-sizing and the prop budget), and let its own exit work (don't bank before its trail or target).", to: "A setup on that side, with room past what it needs and confluence with it is the opportunity this harness looks for, when the rest of this skill agrees and it isn't `blocked`: the strategy's normal size (position-sizing and the prop budget), and let its own exit work (don't bank before its trail or target).",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Never argue a trend strategy into a counter-trend trade; a composed one goes against it only with a true CHoCH its way at or above the trend's frame (`trade-lifecycle`).", to: null,
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "No candidate and no setup you compose (`trade-lifecycle`) \u2192 note and end (`candidates: null`, the scan failed or the bar wasn't scanned, counts as none).", to: "No setup you compose (`trade-lifecycle`; a rules candidate: none active) \u2192 note and end.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "A candidate or a composed setup \u2192 `risk-manager` phase 1 and 2, then execute.", to: "A composed setup \u2192 `risk-manager` phase 1 and 2, then execute.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "**Read each setup's facts first**: a composed setup's are your reads and the record's plan, each checked by `compose_check` (`trade-lifecycle`); a candidate's, `facts`, `inTheWay`, `needR` and `blocked` in `m3` `candidates`.", to: "**Read each setup's facts first**: a composed setup's are your reads and the record's plan, each checked by `compose_check` (`trade-lifecycle`); a rules candidate's (none active), `facts`, `inTheWay`, `needR` and `blocked` in `m3` `candidates`.",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Otherwise compose one (`trade-lifecycle`), or pick at most one strategy that is a `candidate` in the scan in this direction on the last closed bar (candidates are already in session and in regime: the trigger fired), or a manual strategy whose trigger you verified on closed bars and whose `regimes` fit; quote the trigger in the plan.", to: "**The setup**: compose it (`trade-lifecycle`).",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "The exit: a composed trade's target is the record's level (`trade-lifecycle`); a policy's or a rules strategy's follows its `exit` (the rulebook, the scan):", to: "The exit: a composed trade sends the record's stop and target (`trade-lifecycle`); its policy's `exit` (the rulebook; a rules strategy's: the scan's) manages it:",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Rules strategies firing the same side on the bar (`confluence.with`) are a stronger setup; both sides (`confluence.against`) a conflict: stand aside (the priority order, step 6: no exception).", to: "Rules strategies (none active) firing both sides (`confluence.against`): stand aside (priority step 6: no exception).",
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Trust the backtest's `byConfluence` over a feeling that agreement helps.", to: null,
    reason: "fix/skills-match-code: trade_lifecycle is the one active strategy (no rules strategy: strategies/retired.json), so the rules-only text is labelled or dropped; one side rule for every entry, long and short alike; a composed trade's exit is its policy's" },
  { from: "Steps 3-7 apply, with \"the analysts\" read as the bar briefing (without one, your own snapshot, scan and multi-timeframe read); the two-of-three-analysts rule in step 3 doesn't apply: the briefing's alignment for the side and the trend rule decide.", to: "Steps 3-7 apply, with \"the analysts\" read as the bar briefing (without one, your own snapshot and multi-timeframe read); the two-of-three-analysts rule in step 3 doesn't apply: the briefing's alignment for the side and the trend rule decide.",
    reason: "fix/skills-match-code: no rules strategy is active (strategies/retired.json): the rules-only text is labelled or dropped" },
  { from: "Every other role runs every full cycle: each carries skills the decision needs (market structure and liquidity, trend and momentum, VWAP, volume profile and session timing, sizing and pacing), and neither the prompt's facts (the trend rule, which strategies fired) nor the bar briefing are their reports: the briefing is their input, not their analysis.", to: "Every other role runs every full cycle: each carries skills the decision needs (market structure and liquidity, trend and momentum, VWAP, volume profile and session timing, sizing and pacing), and neither the prompt's facts (the trend rule) nor the bar briefing are their reports: the briefing is their input, not their analysis.",
    reason: "fix/skills-match-code: no rules strategy is active (strategies/retired.json): the rules-only text is labelled or dropped" },
  { from: "No record (\"no backtest recorded\") is the weakest case, not a neutral one, and a STALE record (the strategy changed since) doesn't describe it.", to: null,
    reason: "fix/skills-match-code: no rules strategy is active (strategies/retired.json): the rules-only text is labelled or dropped" },
  { from: "The line compares it with the strategy's backtested winners (how far they ran, how deep 80% of them dipped, how often +1R was given back): a trade already deeper than most winners went, or one that reached +1R in a strategy that often gives it back, is weaker than its R says.", to: "A rules strategy's (none active): the line compares it with the strategy's backtested winners (how far they ran, how deep 80% of them dipped, how often +1R was given back): a trade already deeper than most winners went, or one that reached +1R in a strategy that often gives it back, is weaker than its R says.",
    reason: "fix/skills-match-code: no rules strategy is active (strategies/retired.json): the rules-only text is labelled or dropped" },
  { from: "The gate checks a rules strategy's trigger from the signal record; a manual strategy's trigger is yours and risk-manager's to verify.", to: null,
    reason: "fix/skills-match-code: no rules strategy is active (strategies/retired.json): the rules-only text is labelled or dropped" },
  { from: "Don't launch a role whose report the prompt gives (where the harness can, it refuses the launch; in a trade cycle it also refuses roles outside the desk, such as `strategy-researcher`): use that report for its 15m-and-up view, and take this bar's 3m facts (the trigger, the VWAP side, the candidates) from the bar briefing.", to: "Don't launch a role whose report the prompt gives (where the harness can, it refuses the launch; in a trade cycle it also refuses roles outside the desk, such as `strategy-researcher`): use that report for its 15m-and-up view, and take this bar's 3m facts (the trigger, the VWAP side, the setups to check) from the bar briefing.",
    reason: "fix/skills-match-code: no rules strategy is active: the briefing's setups to check, not a scan's candidates" },
  { from: "**Flat, with an earlier entry today that has no review** (it closed or was cancelled between cycles): run trade-review (`trade-reviewer` role) first.", to: "**Flat, with an earlier entry today that has no review** (it closed or was cancelled between cycles): the runner reviews it next bar.",
    reason: "fix/runner-writes-reviews: the runner writes the factual review of each entry it sees end (runner-reviews.js); the trade-reviewer adds the grade" },
  { from: "It orders the thinking and adds no filter: the priority order decides.",
    to: ["It orders the thinking and adds no filter.", "**Compose first** (`confluence-counting`): trend side, a reaction at a key level, the trigger closed → `compose_check`, never your own R:R.", "OK → take: full, half on serious against, pass on a 1h CHoCH against."],
    copies: 0,
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "Trade only when at least two of the three market analysts agree and none is strongly opposed.",
    to: null,
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "Read it before choosing a setup: a trend day (one side extended two IBs, or one from a narrow IB), often after an open outside the prior range and an open-drive, is traded with it (fading needs a reversal setup at a higher-timeframe level); a normal variation day (one side extended, less) has made its move and often rotates back; an open inside the prior value area that stays inside the IB is balance (fade the edges, small targets, stand aside in the middle); a neutral day (both sides extended) is two-sided.",
    to: "Read it before choosing a setup: a trend day (one side extended two IBs, or one from a narrow IB), often after an open outside the prior range and an open-drive, is traded with it (fading needs a reversal setup at a higher-timeframe level); a normal variation day (one side extended, less) has made its move and often rotates back; an open inside the prior value area that stays inside the IB is balance (fade the edges, small targets; the middle is a read against); a neutral day (both sides extended) is two-sided.",
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "It checks each reason against the bar briefing (the session window and whether it allows entries, the trend rule per side, the candidates and verdict, the room in R against the room needed, the multi-timeframe read for the side) and the attempt line, and lists each setup's priority-order steps as the facts answer them: judge each step on its own.",
    to: "It checks each reason against the bar briefing (the session window and whether it allows entries, the trend rule per side, the candidates and verdict, the first level ahead in R against the R it aims for, the multi-timeframe read for the side) and the attempt line, and lists each setup's priority-order steps as the facts answer them: judge each step on its own.",
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "A setup on that side, with room past what it needs and confluence with it is the opportunity this harness looks for, when the rest of this skill agrees and it isn't `blocked`: the strategy's normal size (position-sizing and the prop budget), and let its own exit work (don't bank before its trail or target).",
    to: "A valid setup on that side (`confluence-counting`) is the trade this harness looks for, when it isn't `blocked`: the strategy's normal size (position-sizing and the prop budget), and let its own exit work (don't bank before its trail or target).",
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "No setup (no candidate, no `compose_check` OK), a failed skip rule, an event within 15 minutes, or an unanswered red flag → **no trade**: journal a short `note` with the reason and what would change it, and end.",
    to: "No setup (no candidate, no `compose_check` OK), a failed skip rule, or an event within 15 minutes → **no trade**: journal a short `note` with the reason and what would change it, and end.",
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "`journal_add {kind:\"plan\", contractId, tags:[\"setup:<name>\", \"<SYMBOL>\", \"regime:<primary>\"]}`: thesis, trigger (what happened, price, time), entry, stop, exit, size (position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's P&L, and for a prop attempt the cushion and size budget), skip rules checked, analyst agreement, and what each role reported that the plan rests on: the structure bias and the level the entry and stop sit against (market structure); the VWAP side, the value area or POC, the nearest liquidity in the trade's way (`inTheWay`, the compose record's or a candidate's: the first level in its direction in points and R, where 1R is its own stop: check there is room to the target or the trail's activation), and the session window (the briefing's `m3` `windowText`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the multi-timeframe alignment for the side (aligned, pullback, mixed, counter) and the size it implies; and risk-manager phase 1's budget and pace.",
    to: "`journal_add {kind:\"plan\", contractId, tags:[\"setup:<name>\", \"<SYMBOL>\", \"regime:<primary>\"]}`: thesis, trigger (what happened, price, time), entry, stop, exit, size (position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's P&L, and for a prop attempt the cushion and size budget), skip rules checked, analyst agreement, and what each role reported that the plan rests on: the structure bias and the level the entry and stop sit against (market structure); the VWAP side, the value area or POC, the nearest liquidity in the trade's way (`inTheWay`, the compose record's or a candidate's: the first level in its direction in points and R, where 1R is its own stop: a read beside the target, not a pass), and the session window (the briefing's `m3` `windowText`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the multi-timeframe alignment for the side (aligned, pullback, mixed, counter) and the size it implies; and risk-manager phase 1's budget and pace.",
    reason: "fix/confluence-not-vetoes: a soft read (the room, the analysts, a red flag, the middle of balance) is a read in the count, never a pass alone; the count under the bias decides (owner, 2026-10-21)" },
  { from: "An order list may not show a bracket before the entry fills, so tell by the entry's own `order_placed` journal record (`journal_read {kind:\"order_placed\"}`, kind only, no `contractId` filter: the one whose `data.result.orderId` is the order; its `data.request` has `stopLossBracket` when the bracket went with it); entry-outcome's note on a working entry adds context.",
    to: "No bracket shows before the fill: keep an entry the prompt lists as \"bracket attached on fill\", else tell by the entry's own `order_placed` journal record (`journal_read {kind:\"order_placed\"}`, kind only, no `contractId` filter: the one whose `data.result.orderId` is the order; its `data.request` has `stopLossBracket` when the bracket went with it); entry-outcome's note on a working entry adds context.",
    reason: "fix/entry-keep: a runner-placed entry's bracket attaches on the fill, so a list shows none; the model cancelled valid entries as unbracketed. The runner's record, listed in the prompt, decides first" },
];
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();

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
  const S = 'Tabulate each analyst\'s bias and confidence.';
  assert.ok(flat(sj).includes(S));
  const cut = sj.replace(S, '');
  assert.notDeepStrictEqual(differences(old, swap({ 'setup-judgment': cut }), ALLOWED), [], 'lost');
  assert.notDeepStrictEqual(differences(old, swap({ 'day-context': `${homes[at('day-context')]}\n${S}\n` }), ALLOWED), [], 'doubled');
  const moved = swap({ 'setup-judgment': cut, 'day-context': homes[at('day-context')].replace('## Examples', `${S}\n\n## Examples`) });
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved, HOMES, RANGES, ALLOWED), [], 'but leaves its home');
  // Two bullets of setup-judgment swapped: nothing lost, the order changed.
  const B1 = /- Tabulate each analyst's bias[^]*?of the count\.\n/.exec(sj)[0];
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
  // confluence-counting joins last (fix/confluence-not-vetoes): the count that decides, loaded every cycle.
  assert.deepStrictEqual(step0(ts), [...before0.slice(0, 2), 'trade-lifecycle', ...before0.slice(2), 'confluence-counting']);
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
// skills in its core: perf/replay-fixes); then raised by the owner-approved prop rules (feat/prop-portfolio-missing: the loss
// streak stop, the exit modes and pacing in prop-challenge-pacing, position-sizing and gate-refusals-limits: +1526 bytes each
// mode; strategy-researcher +141, strategy-authoring's policy exit modes); then +433 bytes each mode for the risk manager
// on merging feat/prop-mc-model (#196, owner-approved) with it: prop-challenge-pacing's reading of the attempt line's facts
// to stand down before the gate refuses (the session's losing streak among them), both sides' text kept; then +577 bytes
// each mode for the risk manager (feat/practice-account-states, owner-approved): prop-challenge-pacing's counts carried
// from before the first cycle and its judgment from the attempt line (near the floor, after a loss, near the target).
// Then tightened to the exact sizes when the skills were matched to the code (fix/skills-match-code): every role shrank.
// Then tightened again with the soft reads made reads in the count (fix/confluence-not-vetoes): every role shrank or held.
// Then the analysts' reports as reads for or against, never advice, and the count's context with its evidence: +85 to
// +146 bytes for the three analysts, +38 for the risk manager (the owner's OK while performance holds).
// Then the count of independent categories (the owner's duplicated-evidence principle), its wording tightened: every role
// shrank or held against that.
// Then the pullback neutral in the count and the margin's size (full at 2+, half at 1): the risk manager +140, the
// market-structure analyst +28 (htf-to-ltf), under main's pins (the owner's OK while performance holds).
// Then a valid setup is the trade (the owner, 2026-10-21), the against setting its size: the risk manager +303 and the
// analysts +51 to +60 (trader-process's decision line; the owner's OK while performance holds).
// Then compose first (the plan, never the model, works out R:R), its wording tightened: every role shrank or held but the
// strategy researcher (+2, strategy-library's R:R line).
// Then decisive is a 1h CHoCH against (a 15m swing broken is serious, a sweep a read for) and the briefing's Standard plan
// line is named: the risk manager +211 (confluence-counting; the owner's OK while performance holds).
// Then the gate's [prop-account-attempt] refusal (feat/prop-account-marker, owner-approved 2026-10-22): the risk manager's
// prompt +454 bytes each mode (its row in gate-refusals-limits; 90222 and 76099 on main), the pin +432 (22 bytes of its
// slack absorbed).
// Then phase 2's report format and its size (fix/phase2-verdict-format, owner-approved 2026-10-22): the risk manager
// +995 each mode over main's 90676 and 76553 (its agent's format rules, headings included, the phrasings that read as a
// veto, a Size line in the example and the cut rule, approve the smaller size; gate-refusals-cycle's new [phase2-size]
// row), so a looser model's APPROVE isn't read as a veto and no entry exceeds the size phase 2 approved; trader-process's
// step-8 line, now take or pass first, shrank every role it is embedded in. With #258, the risk manager +1449 over 90222.
// Then the prop sizing floor and the size translation (feat/prop-min-contracts, owner-approved 2026-10-23), against
// main's prompts: the risk manager +1027 each mode (gate-refusals-limits' [min-contracts] row; position-sizing's sentence
// that the size stated in an attempt is a suggestion translated at entry, and its half; the agent's translated size to
// approve, half its cut, under min_contracts a VETO), the market-structure, trend-momentum analysts and the strategy
// researcher +96 (strategy-library's half in an attempt); every other role unchanged.
// Then the compression setup (feat/compression, the owner's "Create this new compression skill and let's use it",
// 2026-10-24): the market-structure analyst carries it in its index (looked up as needed in index mode, one line there:
// +286 with its load sentence and its step-3 pointer; embedded in full mode: +3630), candle-reading's displacement line
// and inside-bar stack held to its size (trimmed to fit), breakout's pointer within those; the risk manager +64 each mode
// (invalidation's box stop source, the one home of stops); every other role unchanged or
// shrank a few bytes.
// Then the bracket rule (fix/orphan-orders, the owner's "always manage risk using stop loss brackets and adjust it
// accordingly using modify order", 2026-10-26): the trade-executor +525 each mode (gate-refusals-positions'
// [bracket-leg] and [bracket-only] rows); every other role unchanged.
const ROLE_PROMPTS = {
  full: { 'market-structure-analyst': 90178, 'news-calendar-analyst': 10182, 'risk-manager': 92762, 'strategy-researcher': 25650, 'trade-executor': 30492, 'trade-reviewer': 9454, 'trend-momentum-analyst': 54540, 'volume-liquidity-analyst': 48495 },
  index: { 'market-structure-analyst': 43175, 'news-calendar-analyst': 10182, 'risk-manager': 78639, 'strategy-researcher': 25650, 'trade-executor': 30481, 'trade-reviewer': 9454, 'trend-momentum-analyst': 40023, 'volume-liquidity-analyst': 32975 },
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

test('trade-session split: the gate requires setup-judgment and trade-plan at entry, and every cycle loads them', () => {
  const { REQUIRED_FOR_ENTRY, REQUIRED_AT_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.deepStrictEqual(REQUIRED_AT_ENTRY, ['setup-judgment', 'trade-plan']);
  for (const s of REQUIRED_AT_ENTRY) assert.ok(!REQUIRED_FOR_ENTRY.includes(s), s);
  // On the runner's per-cycle load list too (ALSO_LOAD), never left to "before an entry": a Claude Code replay lost 2 of 6
  // approved orders to [skills-at-entry] when the head trader was told to load them only before an entry.
  const A = require('../../scripts/lib/autotrader');
  const p = A.prompts(A.validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  assert.match(p, /also load htf-to-ltf, confluence-counting, setup-judgment, trade-plan, and day-context before deciding/);
  // The refusal is taught: its row in the gate-refusals family, which says exits and stops still go.
  const row = flat(skill('gate-refusals-skills'));
  assert.match(row, /\| `\[skills-at-entry\] … not read in this session: <skills>` \|/);
  assert.match(row, /Exits, `\[protect\]` stops, stop moves, size cuts and cancels still go\./);
});

test('trade-session-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});
