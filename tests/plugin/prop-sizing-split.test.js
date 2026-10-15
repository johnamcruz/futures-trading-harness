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
    // Edits made since the split (skill-split-late.js), each with its reason.
    late: [
      { from: "How often a policy strategy passes, blows or times out on history is the evaluator's answer.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "It is the user's command, as the backtester is; an agent never runs it: `node <root>/scripts/evaluate.js --prop <policy> --data <SYMBOL>=<bars file> --from <date> --to <date>` (`docs/BACKTESTING.md`, \"The two-layer evaluator\").",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "It prints the pass, blow and timeout rates with their intervals, the effective sample size (attempts that share no session), the resampled paths, the expectancy cuts, and the promotion gate's verdict.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "When you read or report its result:",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "**Only Train runs freely.** The evaluator refuses any other window without a look (`--look-candidate`, `--look-purpose tuning|judging`, `--ledger <file>`) that the ledger allows.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "It logs the look before reading a bar.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "Looking spends the out-of-sample budget: only the user decides to take one, knowing which window and what it spends.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "A refusal (`needs a look`, `retired`, `reserved`, `crosses a unit`) is final: report it, don't route around it with another window or tool.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "**Flow-off results.** For a policy whose strategies read broker fields, attempts outside the fields' coverage are marked `flowOff`.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "They show the policy without that branch, not as it trades live.",
        to: null, reason: "the evaluator passage was rewritten (owner-approved, PR #196): a replay run's prop score is the Monte Carlo of the model's own trades (replay.js report); scripts/evaluate.js is deleted" },
      { from: "Its numbers (the `sizing`, the trail `exit`, the soft daily stop, and the verdict's multiplier items) are in the account's rulebook, `accounts/<name>/RULEBOOK.md`, the one place for them: read them there, never from a strategy or this skill.",
        to: "Its numbers (the `sizing`, the `exit`, the soft daily stop, the loss streak stop, and the verdict's multiplier items) are in the account's rulebook, `accounts/<name>/RULEBOOK.md`, the one place for them: read them there, never from a strategy or this skill.",
        reason: "feat/prop-portfolio-missing (owner-approved): the rulebook's exit has a mode and the account has a loss streak stop" },
      { from: "Once in, the policy strategy's own exit (its trail) manages the trade; nothing closes it early past the ratchet.",
        to: "Once in, the rulebook's `exit` manages the trade (exit mode `target`, `target_then_trail` or `trail`).",
        reason: "feat/prop-portfolio-missing (owner-approved): the policy's exit is a rulebook mode (target, target_then_trail: past the target the code trails the stop, or trail), no longer always the trail" },
      { from: "The order gate refuses (`[combine]`, `[policy]`, `[prop-one-position]`; none can be skipped): no started attempt (`node <root>/scripts/combine.js start --account <name>`, the user's call); a snapshot older than 10 minutes or dated in the future (a clock that stepped back: tell the user); a missed close (the user records it with `combine.js record-day`: tell them the exact command); a passed or finished attempt; the soft or firm daily limit; a size over the budget (at the verdict's multiplier); a verdict that isn't `full`, or carries no multiplier above 0 and at most 1; any entry that doesn't match the verdict, or whose verdict is not for the last recorded bar, or is for a setup of a strategy that isn't active; any position already open on the account, or any order working on it (a resting entry on another market could fill next to it); any entry once another went in since the latest account snapshot (\"wait for the next bar's snapshot\"; one whose journal time is unreadable counts as since it: tell the user); and, while an attempt runs, any entry from a strategy that isn't its policy strategy.",
        to: "The order gate refuses (`[combine]`, `[policy]`, `[prop-one-position]`; none can be skipped): no started attempt (`node <root>/scripts/combine.js start --account <name>`, the user's call); a snapshot older than 10 minutes or dated in the future (a clock that stepped back: tell the user); a missed close (the user records it with `combine.js record-day`: tell them the exact command); a passed or finished attempt; the soft or firm daily limit; the loss streak stop; a size over the budget (at the verdict's multiplier); a verdict that isn't `full`, or carries no multiplier above 0 and at most 1; any entry that doesn't match the verdict, or whose verdict is not for the last recorded bar, or is for a setup of a strategy that isn't active; any position already open on the account, or any order working on it (a resting entry on another market could fill next to it); any entry once another went in since the latest account snapshot (\"wait for the next bar's snapshot\"; one whose journal time is unreadable counts as since it: tell the user); and, while an attempt runs, any entry from a strategy that isn't its policy strategy.",
        reason: "feat/prop-portfolio-missing (owner-approved): the gate refuses entries at the account's loss streak stop" },
      { from: "Entries under an attempt go through `prop_portfolio`'s verdict on `trade_lifecycle`: `compose_check` asks for it, with the record's side and stop (`trade_lifecycle`), and records it at the record's bar: the strategy, the side, `full` or `skip` (never anything else), the contract (the selected one: MNQ or NQ, MES or ES, ...), the largest size, the stop in ticks, and its multiplier: the share of the budget the rulebook's enforced items allow (1 while it lists none; 0 is a skip, as is an item whose fact is missing or stale).",
        to: "Entries under an attempt go through `prop_portfolio`'s verdict on `trade_lifecycle`: `order_plan` for `trade_lifecycle` records it once per compose record, from its side and stop, at its bar (`trade-lifecycle`): the side, `full` or `skip` (never anything else), the contract (the selected one: MNQ or NQ, MES or ES, ...), the largest size, the stop in ticks, and its multiplier: the share of the budget the rulebook's enforced items allow (1 while it lists none; 0 is a skip, as is an item whose fact is missing or stale).",
        reason: "review of #169: as the merged code does it (#172-#174): order_plan for trade_lifecycle records the policy's verdict once per compose record (lifecycle-order.js, prop/composed-verdict.js)" },
      { from: "**A verdict is a ceiling, never an order**: take it only when the priority order (the strategy-library skill) says so, and then exactly as given: rationale `setup:<policy strategy> ...`, that contract and side, at most that size, `stopLossBracket.ticks` equal to its stop ticks (`order_plan` with the policy strategy's name, the bars file and its `symbol`, the micro whose bars the runner scans, gives exactly these arguments, or refuses with the gate's reason).",
        to: "**A verdict is a ceiling, never an order**: take it only when the priority order (the strategy-library skill) says so, and then as given: rationale `setup:<policy strategy> ...`, the record's contract and side, at most the lower of the verdict's size and the composed cap, the record's ticks (`order_plan` for `trade_lifecycle` gives exactly these arguments, or refuses with the gate's reason).",
        reason: "review of #169: as the merged code does it (#172-#174): the record's contract, side and ticks, at most the lower of the verdict and the composed cap" },
    ],
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
      { old: "`prop_portfolio`) is the prop challenge as a strategy: it trades the setups of the rules strategies it lists on an account profile (`accounts/<name>/ACCOUNT.md`, e.g. a 100K combine: $6,000 target, $3,000 trailing max loss, $2,000 daily limit), sized from the cushion in the selected contract (`contracts: micro | mini | auto` only when none is selected): each setup gets the largest size its `sizing` allows, or is skipped.",
        now: "`prop_portfolio`) is the prop challenge as a strategy: it trades its component's setups (`trade_lifecycle`) on an account profile (`accounts/<name>/ACCOUNT.md`, e.g. a 100K combine: $6,000 target, $3,000 trailing max loss, $2,000 daily limit), sized from the cushion in the selected contract (`contracts: micro | mini | auto` only when none is selected): each setup gets the largest size its `sizing` allows, or is skipped.",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle" },
      { old: "At each setup the runner records a verdict: the strategy that fired, the side, `full` or `skip` (never anything else), the contract (the selected one: MNQ or NQ, MES or ES, ...), the largest size, the stop in ticks, and its multiplier: the share of the budget the rulebook's enforced items allow (1 while it lists none; 0 is a skip, as is an item whose fact is missing or stale).",
        now: "Entries under an attempt go through `prop_portfolio`'s verdict on `trade_lifecycle`: `compose_check` asks for it, with the record's side and stop (`trade_lifecycle`), and records it at the record's bar: the strategy, the side, `full` or `skip` (never anything else), the contract (the selected one: MNQ or NQ, MES or ES, ...), the largest size, the stop in ticks, and its multiplier: the share of the budget the rulebook's enforced items allow (1 while it lists none; 0 is a skip, as is an item whose fact is missing or stale).",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle" },
      { old: "**A verdict is a ceiling, never an order**: take it only when the priority order (the strategy-library skill) says so (it may skip it or halve it), and then exactly as given: rationale `setup:<policy strategy> ...`, that contract and side, at most that size, `stopLossBracket.ticks` equal to its stop ticks (`order_plan` with the policy strategy's name, the bars file and its `symbol`, the micro whose bars the runner scans, gives exactly these arguments, or refuses with the gate's reason).",
        now: "**A verdict is a ceiling, never an order**: take it only when the priority order (the strategy-library skill) says so, and then exactly as given: rationale `setup:<policy strategy> ...`, that contract and side, at most that size, `stopLossBracket.ticks` equal to its stop ticks (`order_plan` with the policy strategy's name, the bars file and its `symbol`, the micro whose bars the runner scans, gives exactly these arguments, or refuses with the gate's reason).",
        reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved" },
      { old: "Once a newer bar is recorded without a verdict for its setup (for example the component fired again and no new verdict came), the old one is refused (`[policy] ... the latest verdict is for the 3m bar opened X; the setup on the bar opened Y has no verdict yet`), as is a verdict that names no bar: stand aside until the next setup's verdict.",
        now: "Once a newer bar is recorded without a verdict for its setup, the old one is refused (`[policy] ... the latest verdict is for the 3m bar opened X; the setup on the bar opened Y has no verdict yet`), as is a verdict that names no bar: stand aside until the next setup's verdict.",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle: a component no longer \"fires\"" },
      { old: "**Before the first live entry** (the user's steps, not an agent's): the policy strategy must be `active` (`prop_portfolio` and `prop_flow_1m` are; their sizing rules decide each verdict), and the user starts the attempt with `combine.js start`.",
        now: "**Before the first live entry** (the user's steps, not an agent's): the policy strategy must be `active` (`prop_portfolio` is; its sizing rules decide each verdict), and the user starts the attempt with `combine.js start`.",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle" },
      { old: "**Two policies, one account.** `prop_portfolio` (3-minute) and `prop_flow_1m` (1-minute) both trade the same account (the `account` both name).",
        copies: 0,
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle" },
      { old: "The runner trades one timeframe, so only one of them has setups in a run: enter only as the policy its verdict names (`setup:<that policy>`).",
        copies: 0,
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle" },
      { old: "Both draw on the one attempt.",
        copies: 0,
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle" },
      { old: "Within one runner (one harness home) the gate holds one cushion and one position at a time across the account; it does not see another runner's entries, so a second runner on the same broker account must not be started (a per-account lock is coming).",
        now: "**One runner per account.** Within one runner (one harness home) the gate holds one cushion and one position at a time across the account; it does not see another runner's entries, so a second runner on the same broker account must not be started (the account lock refuses one).",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle; the account lock (account-lock.js) is built, no longer \"coming\"" },
      { old: "**A policy trades only its active strategies.** A `paper` strategy stays paper inside a policy: the runner passes over its setup (it takes the next active strategy that fired; with none, the policy has no setup that bar), and the gate refuses an entry whose latest verdict names a strategy that isn't active, or none it knows (`[policy] setup:<policy>: the latest verdict's setup is from <name>: <name> has status \"paper\": ...`; it can't be skipped).",
        now: "**A policy trades only its active strategies.** A `paper` component stays paper inside a policy: the gate refuses an entry whose latest verdict names a strategy that isn't active, or none it knows (`[policy] setup:<policy>: the latest verdict's setup is from <name>: <name> has status \"paper\": ...`; it can't be skipped).",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle: the one component is trade_lifecycle, no other strategy to pass to" },
      { old: "prop_portfolio: long setup from orb: full, at most 4 NQ with a 40-tick stop",
        now: "prop_portfolio: long setup from trade_lifecycle: full, at most 4 NQ with a 40-tick stop",
        reason: "the skill audit (fix/skills-composed-process, S3/D4): prop_flow_1m and the rules components are retired; entries under an attempt go through prop_portfolio's verdict on trade_lifecycle; orb is retired" },
      { old: "$207.80 each, $831.20 in all). Halved by the priority order: 22 micros, 2 NQ.",
        now: "$207.80 each, $831.20 in all). With MNQ selected the verdict is 45 MNQ ($955.80).",
        reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved" },
      { old: "With MNQ selected the verdict is 45 MNQ ($955.80), halved 22 MNQ.",
        copies: 0,
        reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; the MNQ verdict joins the line above" },
    ],
  },
  'position-sizing': {
    before: 'tests/fixtures/skill-split/position-sizing.before.txt',
    sha256: 'ad2b70ca7fa99844f29287fe5cb751e97f64d6fcfd336b7b7cc73e54daf45790',
    homes: ['position-sizing', 'micro-mini-specs'],
    late: [
      { from: "**Caps:** the broker server's `maxOrderSize` and `maxPositionSize` (`get_server_config`); size 1 on micros until the setup has 30+ reviewed trades with positive expectancy.",
        to: "**Caps:** the broker server's `maxOrderSize` and `maxPositionSize` (`get_server_config`); size 1 on micros for a rules strategy until its setup has 30+ reviewed trades with positive expectancy.",
        reason: "review of #169: as the merged code does it (#172-#174): the size-1 rule is a rules strategy's; a composed trade's size is its own under its cap" },
      { from: "The gate checks the verdict, not these caps; it still refuses a size over the broker's `maxOrderSize`, and over the policy strategy's own `risk.max_risk_usd` if it sets one (its components' caps don't apply).",
        to: "The gate checks the verdict, not these caps; it still refuses a size over the broker's `maxOrderSize`, and over the policy strategy's own `risk.max_risk_usd` if it sets one (a rules component's caps don't apply; `trade_lifecycle`'s cap does: the lower of it and the verdict).",
        reason: "review of #169: as the merged code does it (#172-#174): trade_lifecycle's cap applies under the verdict (lifecycle-order.js)" },
      { from: "**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4's arithmetic for the strategy and side you chose and shows its working (the `order-plan` skill); for a composed trade, the compose record (its `maxSize`: the most `risk.max_risk_usd` allows).",
        to: "**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4's arithmetic for the strategy and side you chose and shows its working (the `order-plan` skill); for a composed trade it plans the compose record (`trade-lifecycle`; refused over its cap).",
        reason: "review of #169: as the merged code does it (#172-#174): order_plan plans the compose record (#173)" },
      { from: "risk.max_risk_usd $100 -> maxSize 1; size 1, risk $55.50 = 1 x 111 ticks x $0.50/tick",
        to: "risk.max_risk_usd $300 -> maxSize 5; size 5, risk $277.50 = 5 x 111 ticks x $0.50/tick",
        reason: "review of #169: as the merged code does it (#172-#174): trade_lifecycle's cap is $300 (#173)" },
      { from: "(the same stop on MES: 111 ticks x $1.25 = $138.75, over $100: maxSize 0)",
        to: "(the same stop on MES: 111 ticks x $1.25 = $138.75 a contract: maxSize 2, $277.50)",
        reason: "review of #169: as the merged code does it (#172-#174): trade_lifecycle's cap is $300 (#173)" },
    ],
    moved: {
      // Step 1's table and the contract-naming paragraph, and the sentence that introduced the table.
      'micro-mini-specs': { lines: [[18, 28]], units: ['The table is for sanity checks only:'] },
    },
    allowed: [
      { old: "**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4's arithmetic for the strategy and side you chose and shows its working (the `order-plan` skill).",
        now: "**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4's arithmetic for the strategy and side you chose and shows its working (the `order-plan` skill); for a composed trade, the compose record (its `maxSize`: the most `risk.max_risk_usd` allows).",
        reason: "the skill audit (fix/skills-composed-process, X2): a composed trade's numbers are its compose record's" },
      { old: "order_plan for an orb long on MNQ, stop distance 5.25 pts:",
        now: "compose record, a long on MNQ, stop 27.75 pts = 111 ticks ($55.50/MNQ contract):",
        reason: "the skill audit (fix/skills-composed-process): orb is retired; the example is a composed trade, tick-correct" },
      { old: "stop 5.25 pts = 21 ticks ($10.50/MNQ contract), size 1, risk $10.50 = 1 x 21 ticks x $0.50/tick",
        now: "risk.max_risk_usd $100 -> maxSize 1; size 1, risk $55.50 = 1 x 111 ticks x $0.50/tick",
        reason: "the composed example (above)" },
      { old: "(the same distance on MES: 21 ticks x $1.25 = $26.25)",
        now: "(the same stop on MES: 111 ticks x $1.25 = $138.75, over $100: maxSize 0)",
        reason: "the composed example (above), MES at $1.25 a tick" },
    ],
  },
};

// The late edits applied to each split's allow-list; one that matches nothing fails (the list only shrinks).
const { withLate } = require('./skill-split-late');
const LATE_STALE = [];
for (const s of Object.values(SPLITS)) {
  const r = withLate(s.allowed, s.late || [], units(fs.readFileSync(path.join(ROOT, s.before), 'utf8')));
  s.allowed = r.allowed;
  LATE_STALE.push(...r.stale.map(l => l.from));
}

/** The old units each home must hold: Map home -> Map unit -> count (the kept skill takes every unit not moved). */
function expectedHomes(s, beforeText) {
  const lines = beforeText.split('\n');
  const dropped = new Set(s.allowed.filter(a => !a.copies && !a.now).map(a => a.old));
  const all = count(units(beforeText).filter(u => !STRUCTURE.includes(u) && !dropped.has(u)));
  const out = new Map();
  const rest = new Map(all);
  for (const [home, m] of Object.entries(s.moved)) {
    const text = (m.lines || []).map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n\n');
    const want = count([...units(text), ...(m.units || [])].filter(u => !STRUCTURE.includes(u) && !dropped.has(u)));
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
  // An edited unit (an allow-list `now`) counts as its old text, in the home its old section maps to.
  const nowToOld = new Map(s.allowed.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  s.homes.forEach((home, i) => {
    const got = count(units(homeTexts[i]).map(u => nowToOld.get(u) || u).filter(u => old.has(u) && !STRUCTURE.includes(u)));
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

test('prop and sizing splits: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});
