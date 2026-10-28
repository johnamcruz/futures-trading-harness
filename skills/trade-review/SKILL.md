---
name: trade-review
description: Use after every closed or cancelled entry (the gate blocks the next entry until it is reviewed) and at end of session - review against plan, write lessons.
---

# Trade Review

## When to Use

- After every closed (or cancelled, unfilled) entry. The order gate blocks the
  next entry until each entry has a review.
- End of session: distil 1–3 lessons.

## How It Works

1. **Gather facts.** `search_trades` for the fills (P&L is on the closing fill;
   fees are separate), `search_orders` for what was placed and modified, and
   `journal_read {kind:"plan"}` / `{kind:"order_placed"}` for the plan and
   rationale.
2. **Look back before grading:**
   - **What you saw when you entered.** Autonomous: the cycle that placed
     the entry in `<FTH_HOME>/logs/cycles-<day>.jsonl` (match its time and
     `orders`), then its record in `logs/cycles/<day>/`: the prompt (the last
     10 bars, what fired and its confluence, the trend rule, your last 10
     decisions) and what you did. Interactive: the plan entry. Then the bars
     after the entry (the harness tool `bars_fetch` with `name`: "review", or the runner's file): was the read wrong,
     or the execution?
   - **Your last 10 trades.** The harness tool `lessons` (it starts
     with the form of the last 10: record, expectancy, repeated mistakes)
     and `journal_read {kind:"review", tag:"setup:<name>"}` for this
     setup's last reviews. Is this a mistake you already made? If the same
     `mistake:*` tag appears twice in the last 10 trades, write the lesson
     **now** (with the trades as evidence), not at end of day.
3. **Compute.** Planned risk $ = |entry − stop| ÷ tickSize × tickValue × size.
   R = net P&L ÷ planned risk. MAE <= 0, MFE >= 0 (R) from `get_bars` over
   the hold: MAE near -1R on a win = poor entry; high MFE on a loss = good
   setup, wasted exit; MAE near 0, MFE >= 2R = clean trend setup.
4. **Grade the process (A–F)** independently of the result:
   - Was the trigger real (the plan's condition actually happened)?
   - Entry at the planned price ± slippage? Stop placed at the exchange at once?
   - Managed per the plan (no widened stop, no early panic exit, no moved target)?
   - Size per the position-sizing rules?
5. **Write the review** with `journal_add {kind:"review", contractId, orderId, text, tags}`
   (on the runner's, `by:runner`: no `result:` or `r:` unless the fills contradict it):
   - text: plan vs. actual, R, grade, what to repeat or change.
   - tags: exactly one of `result:win | result:loss | result:scratch (|R| < 0.2) |
     result:nofill`; `setup:<name>`; `regime:<primary>` (from the plan); the
     symbol; `r:<R net of fees>` (e.g. `r:-1.11`); any `mistake:<kind>`
     (`mistake:chased`, `mistake:no-stop`, `mistake:moved-stop`,
     `mistake:early-exit`, `mistake:oversize`, `mistake:rule-break`).
   The `lessons` tool turns these tags into instincts each later cycle
   sees: without them a review teaches nothing.
6. **Lessons** (end of session) with `journal_add {kind:"lesson", tags}`:
   advice, its evidence count and condition. No lesson from a single
   trade unless it's a rule break.
7. Also review blocked orders: the server's (`order_blocked` journal
   entries) and the harness gate's (`<FTH_HOME>/logs/gate-log.jsonl`, FTH_HOME defaulting to `~/.futures-trading-harness`, with the
   checks that refused each). A block means the plan or sizing was wrong
   before a guardrail had to say so.

## Examples

```text
review: "Composed long MNQ: 1h up, at prior vah, 15m rejected prior vah up, 3m close top.
Plan: limit 21540.25, stop 21512.50 (111 ticks), target 21598.00, 1 contract, $55.50 risk.
Filled 21540.25. Stopped at 21512.50 after the 1h closed back below the VAH: 111 ticks =
$55.50 + $0.74 fees = $56.24 net loss, R = -56.24 / 55.50 = -1.01. Process B: reads true,
but the 3m momentum read was missing and the bar's volume was 0.6x."
tags: ["result:loss", "setup:trade_lifecycle", "MNQ", "regime:trend-up", "r:-1.01"]

lesson: "trade_lifecycle 15m rejection without a 3m momentum read: 1W/5L over 6 trades."
tags: ["setup:trade_lifecycle", "MNQ"]
```
