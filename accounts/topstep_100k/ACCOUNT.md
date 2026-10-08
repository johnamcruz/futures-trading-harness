---
name: topstep_100k
description: Topstep $100K Trading Combine on TopstepX - reach the profit target without touching the trailing max-loss floor. Verify the numbers against Topstep's current rules before trading.
firm: Topstep
type: combine
starting_balance: 100000
profit_target: 6000
max_loss: 3000
max_loss_mode: trailing_eod   # floor = highest end-of-day balance - max_loss; locks at the starting balance
daily_loss_limit: 2000          # the firm's daily limit (0 = none); verify, Topstep has changed it
daily_loss_soft: 1000           # the harness's: no new entries for the day once reached
consistency_pct: 50           # best day at most this share of the total profit for a pass
max_contracts:
  MNQ: 100
  MES: 100
  MYM: 100
  M2K: 100
  NQ: 10
  ES: 10
sessions: 30                  # attempt length for training and evaluation (not a firm rule)
fees_per_side:
  MNQ: 0.37
  MES: 0.37
  MYM: 0.37
  M2K: 0.37
  NQ: 1.4
  ES: 1.4
---

# Account: Topstep $100K Trading Combine (`topstep_100k`)

The challenge a policy strategy with `account: topstep_100k` trades and trains for.

## When to Use

- A policy strategy (`signal: policy`) names this account (`account: topstep_100k`) to size by its
  cushion and to be trained for it.
- Before a session: the `prop-challenge-pacing` skill reads the attempt
  (`node scripts/combine.js status`) to set the day's budget.

## How It Works

- **Pass**: realized profit reaches $6000 (balance $106000) with the
  best day at most 50% of the total profit.
- **Blow**: equity at or below the floor at any moment. The floor starts at
  $97000 and trails the highest end-of-day balance by $3000, locking
  at $100000 once an end-of-day balance reaches $103000.
- **Daily**: the harness stops new entries at -$1000 for the day; the firm's
  daily limit is $2000.
- **Size**: at most 10 minis or 100 micros. The harness sizes each trade from
  the cushion (balance minus floor), and from the time left when the
  strategy's `sizing.clock_k` is set; a stopped trade never reaches the floor
  or the daily limit.
- All figures are as of this file's writing. Check Topstep's current rules
  and edit this file if they differ.

## Examples

```text
Balance $101200, highest end-of-day balance $101500:
floor $98500, cushion $2700, progress 1200 / 6000.
```
