---
name: end-of-day
description: End-of-day routine - flatten before Topstep's 15:10 CT cut-off, cancel leftover orders, review every trade, write lessons, and journal a day summary. Use at the end of each session, from /eod, or when the autonomous runner reaches its end-of-day time.
---

# End of Day

## When to Use

- Before 15:10 CT every trading day, or on request.

## How It Works

1. `get_account_snapshot`.
2. Open positions: interactive sessions ask the user; autonomous runs flatten
   without asking. The trade-executor role uses `close_position` and journals
   `[exit] end of day`, then cancels every working order.
3. Confirm with `list_open_positions` and `list_open_orders` that nothing is
   left.
4. Run trade-review with end-of-day lessons (the trade-reviewer role).
5. `journal_add {kind:"note", tags:["eod"]}`: net P&L after fees, trades, R
   total, rule breaks, blocked orders, lessons, and tomorrow's focus.

## Examples

```text
EOD 2026-10-08: flat, 0 working orders. 3 trades (orb +2.0R, ema_cross -1.0R,
orb +0.1R scratch), net +$11.30 after fees, 0 rule breaks, 1 blocked order
(time-window). Lesson: none (sample too small). Focus: orb only before 10:30.
```
