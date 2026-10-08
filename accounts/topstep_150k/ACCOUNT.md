---
name: topstep_150k
description: Topstep $150K Trading Combine on TopstepX - reach the profit target without touching the trailing max-loss floor. Verify the numbers against Topstep's current rules before trading.
firm: Topstep
type: combine
starting_balance: 150000
profit_target: 9000
max_loss: 4500
max_loss_mode: trailing_eod   # floor = highest end-of-day balance - max_loss; locks at the starting balance
daily_loss_limit: 3000          # the firm's daily limit (0 = none); verify, Topstep has changed it
daily_loss_soft: 1500           # the harness's: no new entries for the day once reached
consistency_pct: 50           # best day at most this share of the total profit for a pass
max_contracts:
  MNQ: 150
  MES: 150
  MYM: 150
  M2K: 150
  NQ: 15
  ES: 15
sessions: 30                  # attempt length for training and evaluation (not a firm rule)
fees_per_side:
  MNQ: 0.37
  MES: 0.37
  MYM: 0.37
  M2K: 0.37
  NQ: 1.4
  ES: 1.4
---

# Account: Topstep $150K Trading Combine (`topstep_150k`)

The challenge a policy strategy with `account: topstep_150k` trades and trains for.

## When to Use

- A policy strategy (`signal: policy`) names this account (`account: topstep_150k`) to size by its
  cushion and to be trained for it.
- Before a session: the `prop-challenge-pacing` skill reads the attempt
  (`node scripts/combine.js status`) to set the day's budget.

## How It Works

- **Pass**: realized profit reaches $9000 (balance $159000) with the
  best day at most 50% of the total profit.
- **Blow**: equity at or below the floor at any moment. The floor starts at
  $145500 and trails the highest end-of-day balance by $4500, locking
  at $150000 once an end-of-day balance reaches $154500.
- **Daily**: the harness stops new entries at -$1500 for the day; the firm's
  daily limit is $3000.
- **Size**: at most 15 minis or 150 micros. The harness sizes each trade from
  the cushion (balance minus floor), and from the time left when the
  strategy's `sizing.clock_k` is set; a stopped trade never reaches the floor
  or the daily limit.
- All figures are as of this file's writing. Check Topstep's current rules
  and edit this file if they differ.

## Examples

```text
Balance $151200, highest end-of-day balance $151500:
floor $147000, cushion $4200, progress 1200 / 9000.
```
