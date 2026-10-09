---
name: prop-challenge-pacing
description: Pace a prop-firm evaluation or funded account - profit target, trailing max loss, daily loss limit, consistency - so the account survives long enough for the edge to show. Covers harness-tracked attempts (accounts/<name>/ACCOUNT.md, scripts/combine.js) and trained policies. Use at the start of each day, after big wins or losses, and whenever a policy strategy (signal policy) is trading.
---

# Prop Challenge Pacing

## When to Use

- Start of each trading day: set today's risk budget.
- After a large win (protect it) or a drawdown (de-risk).

## How It Works

### Harness-tracked attempts (a policy strategy)

A policy strategy (`signal: policy`, e.g. `prop_portfolio_3m`) is the prop
challenge as a strategy: it trades the setups of the rules strategies it
lists on an account profile (`accounts/<name>/ACCOUNT.md`, e.g.
`topstep_100k`: $6,000 target, $3,000 trailing max loss, $2,000 daily limit),
sized from the cushion in micros or minis (`contracts: micro | mini | auto`),
with a trained policy (`policy: { bundle }`) deciding which setups to take.
The harness tracks the attempt and enforces it:

- In autonomous runs the cycle prompt carries each running attempt's state
  (balance, floor, cushion, profit, the day, sessions left, the size budget,
  any entry block) and the live verdicts, from the runner's latest snapshot.
- `node <root>/scripts/combine.js status` (`<root>`: the harness root, FTH_ROOT) shows the balance, floor, cushion,
  profit, sessions left, the size budget in dollars, whether entries are
  blocked, and each policy strategy's live verdict. Read it before planning;
  quote it in the `plan` entry. The size budget is per policy strategy (each
  has its own `sizing`); the gate checks the verdict's size against it.
- At each setup the runner records a verdict: the strategy that fired, the
  side, `skip` / `half` / `full`, the contract (MNQ or NQ, ...), the largest
  size, and the stop in ticks. **Place exactly the verdict**: rationale
  `setup:<policy strategy> ...`, that contract and side, at most that size,
  `stopLossBracket.ticks` equal to its stop ticks. A verdict permits one
  entry: after a stop-out, wait for the next setup's verdict. Never argue with
  it or route around it. Past the ratchet the runner may close the trade on the policy's
  word.
- **Before the first live entry** (the user's steps, not an agent's): the
  policy strategy ships with `status: paper`, so the user sets
  `status: active` in its STRATEGY.md (and `policy: { bundle }` once a
  bundle passed `rl/ship.py`), and starts the attempt with `combine.js
  start`. Until then every verdict entry is refused (`[strategy] ... status
  "paper"`): report it and stand aside.
- **A verdict for the mini** (`NQ` while the bars are MNQ's): find the NQ
  contractId with `search_contracts` (the active contract; contract ids name NQ
  `ENQ`, ES `EP`), and write the plan **and** the order with that
  contractId; a plan for the MNQ contract doesn't count for an NQ order.
- The order gate refuses (`[combine]`, `[policy]`, `[prop-one-position]`;
  none can be skipped): no started attempt
  (`node <root>/scripts/combine.js start --account <name>`, the user's call); a
  snapshot older than 10 minutes; a missed close (record it:
  `combine.js record-day`); a passed or finished attempt; the soft or firm
  daily limit; a size over the budget; any entry that doesn't match the
  verdict; any position already open on the account; and, while an attempt
  runs, any entry from a strategy that isn't its policy strategy.

### Pacing by judgment (no account profile)

Ask the user for the account's current rules; don't assume them. Track these
numbers each morning (from `get_account_snapshot` and the user):

- **Target remaining** = profit target − profit so far.
- **Cushion** = balance − trailing loss floor. The floor trails the end-of-day
  high-water mark on the bundled combine profiles; it stops trailing at the starting
  balance once the passmark is reached (account-type dependent).
- **Days traded** and the best day's share of total profit (consistency).

Rules of thumb (the PropEvolve objective: pass without blowing the account):

1. **Survival first.** Daily risk budget ≤ 25–30% of the cushion; per-trade risk
   ≤ 10% of the cushion. A small cushion means smaller size, not "make it back".
2. **Pace, don't sprint.** Aim for the target remaining ÷ 10–15 days per day. Stop for the
   day at +1.5× the daily pace; protecting a green day is worth more than
   stretching it.
3. **Consistency.** If one day would exceed the firm's best-day share,
   stop for the day. Past the target, the gate stops entries once today's
   close would pass; while the best day is still too large a share, the
   attempt keeps trading (at normal size) on days smaller than the best one,
   and stops for the day once today is the best day (more can't help).
4. **After a red day,** the next day's budget is half until a green day.
5. **Near the target,** cut size: the last 10% isn't worth risking the account.
6. **Funded accounts,** scale only per the firm's scaling plan and the
   journal's evidence.

Write the day's numbers into the `plan` entry so reviews can grade pacing.

## Examples

```text
$ node <root>/scripts/combine.js status
topstep_100k: active, balance $101250 (floor $98000, cushion $3250), profit $1250 of $6000,
day $250, 4 sessions done, 26 left; prop_portfolio_3m size budget $975; entries allowed

prop_portfolio_3m: long setup from supertrend: full, at most 4 NQ with a 40-tick stop

Yesterday closed at $101000, so the floor trails to $101000 - $3000 = $98000.
prop_portfolio_3m's sizing: 0.3 x $3250 = $975 (under the $1,000 cap; no
drawdown from the peak). A 40-tick stop risks $20 + $0.74 fees = $20.74 a
micro: 47 micros ($975 / $20.74), traded as 4 NQ (contracts: auto; NQ: $200 +
$2.80 fees = $202.80 each, $811.20 in all). A `half` verdict: 23 micros, 2 NQ.
```

```text
Target $3,000, profit $1,150 → remaining $1,850. Cushion $1,400.
Daily budget = 25% × 1,400 = $350; per trade ≤ 10% × 1,400 = $140;
pace ≈ $1,850 ÷ 10 = $185/day; stop for the day at +1.5 × $185 ≈ $280.
```
