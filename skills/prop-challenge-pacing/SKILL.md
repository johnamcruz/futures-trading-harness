---
name: prop-challenge-pacing
description: Use when a policy strategy trades a harness-tracked prop attempt - its state, its verdicts, the gate's refusals.
---

# Prop Challenge Pacing

## When to Use

- A policy strategy (`signal: policy`) is trading, or `combine_status` lists an attempt.

## How It Works

Scoring a policy on history: the `prop-evaluator` skill. Pacing an account
with no profile: the `prop-pacing-judgment` skill.

### Harness-tracked attempts (a policy strategy)

A policy strategy (`signal: policy`, e.g. `prop_portfolio`) is the prop
challenge as a strategy: it trades the setups of the rules strategies it
lists on an account profile (`accounts/<name>/ACCOUNT.md`, e.g. a
100K combine: $6,000 target, $3,000 trailing max loss, $2,000 daily limit),
sized from the cushion in the selected contract (`contracts: micro | mini |
auto` only when none is selected): each setup gets the largest size its
`sizing` allows, or is skipped. Its numbers (the `sizing`, the trail
`exit`, the soft daily stop, and the verdict's multiplier items) are in the
account's rulebook, `accounts/<name>/RULEBOOK.md`, the one place for them:
read them there, never from a strategy or this skill. A missing, incomplete or
malformed rulebook refuses the account and its policies (every entry; exits,
flattens and protective stops still go, and the runner keeps trailing an open
position by the exit plan it had): the refusal names the file and the
key, so tell the user exactly that and stand aside; fixing it is theirs. A contract's risk is its stop plus the
stop's expected slippage (`sizing.stop_slippage_ticks`, a tick by default,
as the backtester fills stops) plus fees both ways, so a stop filled
within its expected slippage never reaches the floor or the daily limit; a
gap or fast market that fills it further past the stop still can. The harness tracks the attempt and enforces
it:

- In autonomous runs the cycle prompt carries each running attempt's state
  (balance, floor, cushion, profit, the day, sessions left, the size budget,
  any entry block) and the live verdicts, from the runner's latest snapshot.
- The harness tool `combine_status` shows the balance, floor, cushion,
  profit, sessions left, the size budget in dollars, whether entries are
  blocked, and each policy strategy's live verdict. Read it before planning;
  quote it in the `plan` entry. The size budget is per policy strategy (each
  has its own `sizing`); the gate checks the verdict's size against it.
- At each setup the runner records a verdict: the strategy that fired, the
  side, `full` or `skip` (never anything else), the contract (the selected one: MNQ or NQ, MES or ES, ...), the largest
  size, the stop in ticks, and its multiplier: the share of the budget the
  rulebook's enforced items allow (1 while it lists none; 0 is a skip, as is
  an item whose fact is missing or stale). The size is already sized at it. **A verdict is a ceiling, never an order**:
  take it only when the priority order (the strategy-library skill) says so (it may
  skip it or halve it), and then exactly as given: rationale
  `setup:<policy strategy> ...`, that contract and side, at most that size,
  `stopLossBracket.ticks` equal to its stop ticks (`order_plan` with the
  policy strategy's name, the bars file and its `symbol`, the micro whose
  bars the runner scans, gives exactly these arguments, or refuses with the
  gate's reason). A verdict is for its own bar: the gate takes it only while
  that bar is still the last one recorded for the policy strategy's
  timeframe (the runner records each bar it scans). Once a newer bar is recorded
  without a verdict for its setup (for example the component fired again and
  no new verdict came), the old one is refused (`[policy] ... the latest
  verdict is for the 3m bar opened X; the setup on the bar opened Y has no
  verdict yet`), as is a verdict that names no bar: stand aside until the
  next setup's verdict. A verdict permits one
  entry: after a stop-out, wait for the next setup's verdict. Never exceed it
  or route around it. Once in, the policy strategy's own exit (its trail)
  manages the trade; nothing closes it early past the ratchet.
- **Before the first live entry** (the user's steps, not an agent's): the
  policy strategy must be `active` (`prop_portfolio` and `prop_flow_1m` are;
  their sizing rules decide each verdict), and the user starts the attempt
  with `combine.js start`. A policy strategy at `paper` stays so until the
  user activates it, and every verdict entry is refused
  (`[strategy] ... status "paper"`): report it and stand aside.
- **Two policies, one account.** `prop_portfolio` (3-minute) and
  `prop_flow_1m` (1-minute) both trade the same account (the `account` both
  name). The runner trades one
  timeframe, so only one of them has setups in a run: enter only as the
  policy its verdict names (`setup:<that policy>`). Both draw on the one
  attempt. Within one runner (one harness home) the gate holds one cushion
  and one position at a time across the account; it does not see another
  runner's entries, so a second runner on the same broker account must not
  be started (a per-account lock is coming). If you see one, report it and
  stand aside.
- **A policy trades only its active strategies.** A `paper` strategy stays
  paper inside a policy: the runner passes over its setup (it takes the next
  active strategy that fired; with none, the policy has no setup that bar),
  and the gate refuses an entry whose latest verdict names a strategy that
  isn't active, or none it knows (`[policy] setup:<policy>: the latest
  verdict's setup is from <name>: <name> has status "paper": ...`; it can't
  be skipped). Stand aside: activating a strategy is the user's call. Exits
  and `[protect]` stops always go.
- **A verdict for the mini** (`NQ` while the bars are MNQ's): use the
  contract name `NQ` as the contractId (the harness translates it to the
  broker's id), and write the plan **and** the order with it; a plan for
  `MNQ` doesn't count for an NQ order.
- The order gate refuses (`[combine]`, `[policy]`, `[prop-one-position]`;
  none can be skipped): no started attempt
  (`node <root>/scripts/combine.js start --account <name>`, the user's call); a
  snapshot older than 10 minutes or dated in the future (a clock that
  stepped back: tell the user); a missed close (the user records it with
  `combine.js record-day`: tell them the exact command); a passed or finished attempt; the soft or firm
  daily limit; a size over the budget (at the verdict's multiplier); a verdict
  that isn't `full`, or carries no multiplier above 0 and at most 1; any entry that doesn't match the
  verdict, or whose verdict is not for the last recorded bar, or is for a
  setup of a strategy that isn't active; any position already open on the account, or any order working
  on it (a resting entry on another market could fill next to it); any entry once another
  went in since the latest account snapshot ("wait for the next bar's
  snapshot"; one whose journal time is unreadable counts as since it: tell
  the user); and, while an attempt runs, any entry from a strategy that
  isn't its policy strategy.
- **Several markets, one account** (a policy strategy over NQ, ES, YM, and
  RTY trades one attempt): one position at a time across all of them. When
  two markets have verdicts on the same bar, place one (the first listed in
  the prompt, unless a verdict says skip) and stand aside on the other: the
  gate refuses it until the account is flat again and a new verdict comes.
  Never split the budget between markets; each verdict is sized from the
  whole cushion.

## Examples

```text
combine_status {}
my_100k: active, balance $101250 (floor $98000, cushion $3250), profit $1250 of $6000,
day $250, 4 sessions done, 26 left; prop_portfolio size budget $975; entries allowed

prop_portfolio: long setup from orb: full, at most 4 NQ with a 40-tick stop

Yesterday closed at $101000, so the floor trails to $101000 - $3000 = $98000.
prop_portfolio's sizing (its numbers are in the account's RULEBOOK.md, the
one place for them): cushion_frac x $3250 = $975 (under cap_usd; no
drawdown from the peak). A 40-tick stop plus a tick of expected slippage
risks 41 x $0.50 = $20.50 + $0.74 fees = $21.24 a micro: 45 micros ($975 /
$21.24), traded as 4 NQ with NQ selected (NQ: 41 x $5 = $205 + $2.80 fees =
$207.80 each, $831.20 in all). Halved by the priority order: 22 micros, 2 NQ.
With MNQ selected the verdict is 45 MNQ ($955.80), halved 22 MNQ.
```
