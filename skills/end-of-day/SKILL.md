---
name: end-of-day
description: End-of-day routine - flatten before the 16:00 ET close (the harness's hard rule; prop firms often flatten at 15:10 CT), cancel leftover orders, review every trade, write lessons, and journal a day summary. Use at the end of each session, from /eod, or when the autonomous runner reaches its end-of-day time.
---

# End of Day

## When to Use

- At end of day (`eodAt`, by 16:00 ET) every trading day, or on request. The
  autonomous runner closes positions itself first; this routine confirms it,
  cancels leftovers, and does the reviews.

## How It Works

1. `get_account_snapshot`.
2. Open positions: flatten every one by `eodAt` (by 16:00 ET; 12:50 ET on
   an early-close day), in every mode, without asking: no position is held
   into the daily break. The trade-executor role uses `close_position` and
   journals `[exit] end of day`, then cancels every working order. In an
   interactive session you may ask the user only about cancelling a pending
   entry earlier than that.
3. Confirm with `list_open_positions` and `list_open_orders` that nothing is
   left. A close the broker accepted isn't a flat account: a position still
   open after its close is closed again, unless its earlier close still shows
   as a working order in `list_open_orders` (it hasn't filled yet; a second
   close could cross it). The autonomous runner keeps closing,
   and its end of day is done only once the account reads flat. Don't wait
   for a close to fill (no repeated bar or quote reads): if it still reads
   open after the second close (a replayed broker fills at the next bar),
   report it in the journal note and the cycle result, and the runner keeps
   closing until it reads flat (interactively, close again and tell the user
   it is still open).
4. Run trade-review with end-of-day lessons (the trade-reviewer role).
5. Prop attempt running: the autonomous runner records the day's closing
   balance itself (it retries a failed record and lists a close it couldn't
   record in the harness tool `combine_status`). A catch-up end of day (a day the runner
   missed) records that day's own balance: today's less what the fills since
   that day ended made, so an overnight loss counts on the day it was booked. Interactive, or a missed close: the user
   records it with `node <root>/scripts/combine.js record-day --account <name>
   --day YYYY-MM-DD --balance <dollars>` (the balance after the session's
   last fill); tell them the exact command. Agents don't run it.
6. Autonomous days: the harness tool `reconcile` (`{"day": "<trading day>",
   "timeframe": <minutes>}`) compares the day's entries with the signals the
   runner saw: how many were taken, passed (with the note that says why), and
   entries with no signal behind them. Quote its first line.
7. The harness tool `lessons`: the instincts the reviews add up to
   (setups to favour or avoid by regime, recurring mistakes). Write a lesson
   only when one has the evidence (the trade-review rules).
8. `journal_add {kind:"note", tags:["eod"]}`: net P&L after fees, trades, R
   total, rule breaks, blocked orders (journal `order_blocked` and
   `<FTH_HOME>/logs/gate-log.jsonl`), signals taken vs passed, lessons, and
   tomorrow's focus.

## Examples

```text
EOD 2026-10-08: flat, 0 working orders. 3 trades (orb +2.0R, ema_cross -1.0R,
orb +0.1R scratch), net +$11.30 after fees, 0 rule breaks, 1 blocked order
(time-window). Lesson: none (sample too small). Focus: orb only before 10:30.
```
