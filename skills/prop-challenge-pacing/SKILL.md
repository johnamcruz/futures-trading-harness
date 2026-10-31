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
challenge as a strategy: it trades its component's setups
(`trade_lifecycle`) on an account profile (`accounts/<name>/ACCOUNT.md`, e.g. a
100K combine: $6,000 target, $3,000 trailing max loss, $2,000 daily limit),
sized from the cushion in the selected contract (`contracts: micro | mini |
auto` only when none is selected): each setup's size is the size
translation's, or it is skipped. Its numbers (the `sizing`, the `exit`, the
soft daily stop, the loss streak stop, and the verdict's multiplier items) are in the
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
  Its facts (attempt day, profit needed, room to the daily limit and
  `daily_loss_soft`, today's trades and losses, the session's losing streak,
  consistency headroom) count every trade of the day, including any closed
  before your first cycle, as the gate counts them.
- **Read the attempt line before the setup:**
  - Near the floor: clearest setup only, at or under the verdict's size, or
    pass (a pass costs a day, a blow the attempt).
  - A healthy account: the verdict's full size.
  - After a loss today: never trade to win it back.
  - A stop would take most of the day's room: done for the day.
  - Consistency is the account's rule, enforced by code: don't plan around it.
  - Near the target (`sizing.near_target_usd`): code trades the floor; never risk the day the pass depends on.
- The harness tool `combine_status` shows the balance, floor, cushion,
  profit, sessions left, the size budget in dollars, whether entries are
  blocked, and each policy strategy's live verdict. Read it before planning;
  quote it in the `plan` entry. The size budget is per policy strategy (each
  has its own `sizing`); the gate checks the verdict's size against it.
- Entries under an attempt go through `prop_portfolio`'s verdict on
  `trade_lifecycle`: `order_plan` for `trade_lifecycle` records it once per
  compose record, from its side and stop, at its bar (`trade-lifecycle`): the
  side, `full` or `skip` (never anything else), the contract (the selected one: MNQ or NQ, MES or ES, ...), the largest
  size, the stop in ticks, and its multiplier: the share of the budget the
  rulebook's enforced items allow (1 while it lists none; 0 is a skip, as is
  an item whose fact is missing or stale). The size is already sized at it. **A verdict is a ceiling, never an order**:
  take it only when the priority order (the strategy-library skill) says so,
  and then as given: rationale `setup:<policy strategy> ...`, the record's
  contract and side, at most the lower of the verdict's size and the
  composed cap (the size translation's number), the record's ticks (`order_plan` for `trade_lifecycle`
  gives exactly these arguments, or refuses with the gate's reason). A verdict is for its own bar: the gate takes it only while
  that bar is still the last one recorded for the policy strategy's
  timeframe (the runner records each bar it scans). Once a newer bar is recorded
  without a verdict for its setup, the old one is refused (`[policy] ... the latest
  verdict is for the 3m bar opened X; the setup on the bar opened Y has no
  verdict yet`), as is a verdict that names no bar: stand aside until the
  next setup's verdict. A verdict permits one
  entry: after a stop-out, wait for the next setup's verdict. Never exceed it
  or route around it. Once in, the rulebook's `exit` manages the trade (exit
  mode `target`, `target_then_trail` or `trail`). Let a winner run past its
  target once it is reached: in `target_then_trail` the code holds the stop
  at the target's R less `lock_giveback_r` until a 15m swing confirms
  past it, then behind that swing; you
  never widen it, close early or pull the target in by feel.
- **Loss streak stop.** After `loss_streak_stop` losses in a row in a
  session (a win ends the streak, a scratch neither), the gate refuses
  entries until the next session: losses in a row mean the day's read is
  off, not that a winner is due. The gate holds it; don't pre-empt it.
- **Pacing** (`sizing.clock_k`, tuned by the phase-2 search, or `off`)
  caps a trade at what the pass still needs per session left. Never size up
  to catch up.
- **Before the first live entry** (the user's steps, not an agent's): the
  policy strategy must be `active` (`prop_portfolio` is; its sizing rules
  decide each verdict), and the user starts the attempt
  with `combine.js start`. A policy strategy at `paper` stays so until the
  user activates it, and every verdict entry is refused
  (`[strategy] ... status "paper"`): report it and stand aside.
- **One runner per account.** Within one runner (one harness home) the
  gate holds one cushion and one position at a time across the account; it
  does not see another runner's entries, so a second runner on the same
  broker account must not be started (the account lock refuses one). If you see one, report it and stand
  aside.
- **A policy trades only its active strategies.** A `paper` component stays
  paper inside a policy: the gate refuses an entry whose latest verdict names a strategy that
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
  daily limit; the loss streak stop; a size over the budget (at the verdict's multiplier); a verdict
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

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `combine_status` | `account`?, `json`? | each started prop attempt and the policy verdicts; an `account` that isn't a profile (a run id, the broker's account) reads every started attempt and says so | `combine.js status [--account <name>] [--json]` |

## Examples

```text
combine_status {}
my_100k: active, balance $101250 (floor $98000, cushion $3250), profit $1250 of $6000,
day $250, 4 sessions done, 26 left; prop_portfolio size budget $975; entries allowed

prop_portfolio: long setup from trade_lifecycle: full, at most 4 NQ with a 40-tick stop

Yesterday closed at $101000, so the floor trails to $101000 - $3000 = $98000.
prop_portfolio's sizing (its numbers are in the account's RULEBOOK.md, the
one place for them): cushion_frac x $3250 = $975 (under cap_usd; no
drawdown from the peak). A 40-tick stop plus a tick of expected slippage
risks 41 x $0.50 = $20.50 + $0.74 fees = $21.24 a micro: 45 micros ($975 /
$21.24), traded as 4 NQ with NQ selected (NQ: 41 x $5 = $205 + $2.80 fees =
$207.80 each, $831.20 in all). With MNQ selected the verdict is 45 MNQ ($955.80).
The entry's size is the size translation's (order_plan gives it); the verdict's is a ceiling.
```
