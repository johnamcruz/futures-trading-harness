'use strict';

// The edits made to trade-plan (trade-session step 4 as main had it, tests/fixtures/skill-split/trade-session-step4.before.txt)
// since the split, each with its reason. Both byte-for-byte tests (trade-session-split.test.js and
// harness-tools-split.test.js) apply exactly these to the fixture and compare: any other change fails, and an edit whose
// old text is gone from the fixture fails too.

const EDITS = [
  { old: `liquidity in the trade's way (the candidate's \`inTheWay\` in the briefing's
\`m3\` \`candidates\`: the first level in its direction in points and R, where
1R is its own stop; with \`order_plan\`'s stop, check there is room to the
target or the trail's activation, and a level closer than 1R is a skip under
the skip rules that name it), and the session window`,
  now: `liquidity in the trade's way (\`inTheWay\`, the compose record's or a
candidate's: the first level in its direction in points and R, where 1R is
its own stop: check there is room to the target or the trail's
activation), and the session window`,
  reason: 'a composed trade\'s room is its compose record\'s inTheWay; the skip rules that named it were the retired rules strategies\'' },
  { old: 'The exit follows the strategy\'s `exit` (shown in the scan):',
    now: `The exit: a composed trade's target is the record's level (\`trade-lifecycle\`);
a policy's or a rules strategy's follows its \`exit\` (the rulebook, the scan):`,
    reason: 'a composed trade\'s exit is its record\'s target level; a policy trails by its rulebook' },
  { old: '  from the scan\'s `exit`, don\'t assume them.', now: '  from its `exit`, don\'t assume them.', reason: 'a policy\'s exit is its rulebook\'s, not the scan\'s' },
  { old: `- **Target level:** with \`exit.target\` the scan gives \`targetDistance\`: the
  target is the signal bar's close ± that distance (e.g. a CRT range's far
  side).
- **Time stop:** with \`maxBars\`, close at market after that many bars in the
  trade if neither the stop nor the target has filled.
`,
  now: '',
  reason: 'only retired rules strategies had a target distance or a time stop (strategies/retired.json)' },
  { old: `**The exact numbers come from \`order_plan\`**, not from your own arithmetic:
once you have chosen the strategy and the side (the steps above: the trigger,
the trend rule, the skip rules, the account), call it with them, e.g.
\`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "orb", "side": "long"}\`.`,
  now: `**The exact numbers come from \`order_plan\`** (a rules strategy, a policy
verdict, or \`trade_lifecycle\`'s compose record: \`trade-lifecycle\`),
not from your own arithmetic: once you have chosen the strategy and the
side, call it with them, e.g.
\`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "<name>", "side": "long"}\`.`,
  reason: 'a composed trade\'s numbers are its compose record\'s, which order_plan plans (the trade-lifecycle skill); orb is retired' },
  { old: `policy entry may have. A different size from
your plan changes only \`size\`, and the risk scales with it: smaller for a
\`mixed\` read or a reversal fade, and, for a rules strategy, larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual`,
  now: `policy entry may have; a composed trade's is the size you stated, refused
over its cap (in an attempt, also the verdict). A different size from
your plan changes only \`size\`, and the risk scales with it: for a rules
strategy, smaller for a \`mixed\` read or a reversal fade, and larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual`,
  reason: 'owner decision D1: a composed trade\'s size is its own under the caps (order_plan refuses one over them), never halved for a mixed read; the halving and the size steps stay for a rules strategy' },  // The terse rewrite (docs/terse-head-skills): the same plan, exit, tick and order_plan rules in fewer words, each part
  // under its heading. Applied after the edits above, so the expected body is the skill as it is now, byte for byte.
  { old: `\`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}\`:
thesis, trigger (what happened, price, time), entry, stop, exit, size
(position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's
P&L, and for a prop attempt the cushion and size budget), skip rules checked,
analyst agreement, and what each role reported that the plan rests on: the
structure bias and the level the entry and stop sit against
(market structure); the VWAP side, the value area or POC, the nearest
liquidity in the trade's way (\`inTheWay\`, the compose record's or a
candidate's: the first level in its direction in points and R, where 1R is
its own stop: check there is room to the target or the trail's
activation), and the session window (the briefing's \`m3\`
\`windowText\`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the
multi-timeframe alignment for the side (aligned, pullback, mixed, counter)
and the size it implies; and risk-manager phase 1's budget and pace. A plan
that can't name them isn't ready. Add the
tag \`paper\` in plan-only mode.

`,
    now: `\`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}\`
(+ \`paper\` in plan-only mode). It holds:

- Thesis; trigger (what, price, time); entry, stop, exit.
- Size (position-sizing or the policy verdict), $ risk, the account sized
  from (balance, today's P&L; prop: cushion, size budget).
- Skip rules checked; analyst agreement.
- Each role's report it rests on:
  - structure: bias, the level entry and stop sit against;
  - volume-liquidity, session-timing: VWAP side, value area or POC;
    \`inTheWay\` (compose record's or candidate's: first level its way, in
    points and R of its own stop): check room to the target or trail activation.
    Session window (\`m3\` \`windowText\`: entries allowed, until when);
  - trend-momentum: regime, momentum;
  - multi-timeframe alignment for the side (aligned, pullback, mixed,
    counter) and the size it implies;
  - risk-manager phase 1: budget, pace.

Can't name them: not ready.

`,
    reason: 'the plan entry\'s parts as a list, the same parts (the terse rewrite of the head trader\'s embedded skills, docs/terse-head-skills, owner-approved: same rules, fewer bytes)' },
  { old: `The exit: a composed trade's target is the record's level (\`trade-lifecycle\`);
a policy's or a rules strategy's follows its \`exit\` (the rulebook, the scan):

- **Trailing:** stop only, no target order. The runner (or you, without one)
  trails it from \`trailActivateR\` with \`trailGivebackR\` give-back; read both
  from its \`exit\`, don't assume them.
- **Target:** stop and target at \`targetR\` (or \`risk.min_rr\`) times the stop
  distance.

`,
    now: `### The exit

Composed: the record's target level (\`trade-lifecycle\`). Policy or rules
strategy: its \`exit\` (rulebook, scan):

- **Trailing:** stop only, no target order. The runner (or you, without
  one) trails from \`trailActivateR\`, \`trailGivebackR\` give-back; read
  both from its \`exit\`, never assume.
- **Target:** stop, and target at \`targetR\` (or \`risk.min_rr\`) x stop
  distance.

`,
    reason: 'the exit under its own heading, the same two exits (the terse rewrite, owner-approved)' },
  { old: `Tick sizes and values are the broker's: the harness records them when
\`search_contracts\` or \`get_contract\` returns the contract, and the gate,
\`order_plan\` and the scan use only those. A tool that says there are no tick
specs from the broker for a contract yet means: look the contract up with
\`search_contracts\` (or \`get_contract\`) first, then ask again; never supply
tick numbers of your own.

Prices are on the tick (MNQ/MES 0.25). Round a stop away from the entry and a
target toward it; bracket ticks = \`ceil(distance / tickSize)\`, the same
numbers in the rationale and the brackets. The scan's distances are price
points, not ticks: its summary shows both (\`stop 5.25 pts = 21 ticks\`).

`,
    now: `### Ticks

- Tick specs are the broker's, recorded when \`search_contracts\` or
  \`get_contract\` returns the contract; gate, \`order_plan\` and scan use only
  those. No tick specs yet: look the contract up, then ask again. Never
  supply your own.
- On the tick (MNQ/MES 0.25): stop rounded away from entry, target toward.
  Bracket ticks = \`ceil(distance / tickSize)\`, same in rationale and
  brackets.
- Scan distances are points; its summary shows both (\`stop 5.25 pts = 21 ticks\`).

`,
    reason: 'the tick rules under their own heading, as a list, the same rules (the terse rewrite, owner-approved)' },
  { old: `**The exact numbers come from \`order_plan\`** (a rules strategy, a policy
verdict, or \`trade_lifecycle\`'s compose record: \`trade-lifecycle\`),
not from your own arithmetic: once you have chosen the strategy and the
side, call it with them, e.g.
\`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "<name>", "side": "long"}\`.
It is a calculator, not a second opinion: it doesn't choose the setup, the
side, or whether to trade. It shows its working (the entry reference, the
stop and target in points and in whole ticks, the stop below a long's entry
and above a short's, how the size was derived, the dollar risk) and gives
the \`place_order\` arguments with the \`setup:<name> <side>\` rationale. Put its
stop price, ticks, size, and $ risk in the plan, and explain the plan in your
own words (why the stop sits there, the R multiple, the exit). Don't
compute stop prices, ticks, size, or dollar risk by hand. A refusal (the
strategy isn't a candidate now, or its rules fired the other side) means no
entry on that strategy and side; never work around it. For a policy verdict,
call it with the policy strategy's name: it plans exactly the verdict, on
bars whose last closed bar is the verdict's, and refuses (as the gate does)
a verdict for an older bar than the last one recorded: no entry until the
next setup's verdict. Its size is the starting size:
1 for a rules strategy (position-sizing's size-1 rule) and, for a policy,
the verdict's cut to the attempt's size budget now, which is the most a
policy entry may have; a composed trade's is the size you stated, refused
over its cap (in an attempt, also the verdict). A different size from
your plan changes only \`size\`, and the risk scales with it: for a rules
strategy, smaller for a \`mixed\` read or a reversal fade, and larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual
strategy has no order_plan (its stop is your read of STRATEGY.md): work its
numbers by the rules above and position-sizing.

`,
    now: `### \`order_plan\`: the numbers

- Exact numbers come from \`order_plan\` (rules strategy, policy verdict, or
  \`trade_lifecycle\`'s compose record), never your arithmetic. Once strategy
  and side are chosen:
  \`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "<name>", "side": "long"}\`.
- A calculator: never picks setup, side, or whether to trade. Shows its
  working (entry reference, stop and target in points and whole ticks,
  stop below a long's entry, above a short's, size derivation, $ risk) and
  the \`place_order\` arguments with the \`setup:<name> <side>\` rationale.
- Plan: its stop price, ticks, size, $ risk; in your words, why the stop
  sits there, the R multiple, the exit.
- Refused (not a candidate now, or fired the other side): no entry on that
  strategy and side; never work around it.
- Policy: call with the policy strategy's name; plans exactly the verdict,
  on bars whose last closed bar is the verdict's. A verdict older than the
  last recorded bar is refused (as by the gate): wait for the next verdict.
- Starting size: rules strategy 1 (position-sizing's size-1 rule); policy,
  the verdict cut to the attempt's size budget now (its most); composed,
  your stated size, refused over its cap (in an attempt, over the verdict).
- A size other than your plan's changes only \`size\`; risk scales. Rules strategy: smaller
  for \`mixed\` or a reversal fade; larger only as position-sizing allows
  (30+ reviewed trades, positive expectancy, within budget and caps).
- Manual strategy: no order_plan (stop from its STRATEGY.md); work its
  numbers by these rules and position-sizing.

`,
    reason: 'order_plan\'s rules under their own heading, one per bullet, the same rules (the terse rewrite, owner-approved)' },
];

/** The fixture with every edit applied; throws when an edit's old text isn't in it exactly once. */
function edited(fixture) {
  let t = fixture;
  for (const e of EDITS) {
    if (t.split(e.old).length !== 2) throw new Error(`trade-plan edit not in the fixture once: ${e.old.slice(0, 60)}`);
    t = t.replace(e.old, () => e.now);
  }
  return t;
}

module.exports = { EDITS, edited };
