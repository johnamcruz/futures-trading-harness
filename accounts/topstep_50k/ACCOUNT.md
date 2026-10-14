---
name: topstep_50k
description: Topstep $50K Trading Combine on TopstepX - reach the profit target without touching the trailing max-loss floor. Verify the numbers against Topstep's current rules before trading.
firm: Topstep
type: combine
starting_balance: 50000
profit_target: 3000
max_loss: 2000
max_loss_mode: trailing_eod   # floor = highest end-of-day balance - max_loss; locks at the starting balance
daily_loss_limit: 1000          # the firm's daily limit (0 = none); verify, Topstep has changed it
consistency_pct: 50           # best day at most this share of the total profit for a pass
max_contracts:
  MNQ: 50
  MES: 50
  MYM: 50
  M2K: 50
  NQ: 5
  ES: 5
  YM: 5
  RTY: 5
sessions: 30                  # attempt length for backtests and evaluation (not a firm rule)
fees_per_side:
  MNQ: 0.37
  MES: 0.37
  MYM: 0.37
  M2K: 0.37
  NQ: 1.4
  ES: 1.4
  YM: 1.4
  RTY: 1.4
---

# Account: Topstep $50K Trading Combine (`topstep_50k`)

The challenge a policy strategy with `account: topstep_50k` trades.

## When to Use

- A policy strategy (`signal: policy`) names this account (`account: topstep_50k`) to size by its
  cushion.
- Before a session: the `prop-challenge-pacing` skill reads the attempt
  (`node scripts/combine.js status`) to set the day's budget.

## How It Works

- **Pass**: realized profit reaches $3000 (balance $53000) with the
  best day at most 50% of the total profit.
- **Blow**: equity at or below the floor at any moment. The floor starts at
  $48000 and trails the highest end-of-day balance by $2000, locking
  at $50000 once an end-of-day balance reaches $52000.
- **Daily**: the firm's daily limit is $1000. The harness's own soft daily
  stop, like every number the policies trade this account with, is in its
  rulebook (`RULEBOOK.md` beside this file).
- **Size**: at most 5 minis or 50 micros. The harness sizes each trade from
  the cushion (balance minus floor), and from the time left when the
  strategy's `sizing.clock_k` is set; a stopped trade never reaches the floor
  or the daily limit.
- All figures are as of this file's writing. Check Topstep's current rules
  and edit this file if they differ.

## Examples

```text
Balance $51200, highest end-of-day balance $51500:
floor $49500, cushion $1700, progress 1200 / 3000.
```
