---
name: trade-review
description: Review closed futures trades against their plan - R multiple, plan adherence, execution errors, setup tag, and result tag - and turn evidence into short lessons. Use after every exit, at end of session, and when the order gate reports an unreviewed entry.
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
2. **Compute.** Planned risk $ = |entry − stop| ÷ tickSize × tickValue × size.
   R = net P&L ÷ planned risk. MAE/MFE from `get_bars` over the hold, if useful.
3. **Grade the process (A–F)** independently of the result:
   - Was the trigger real (the plan's condition actually happened)?
   - Entry at the planned price ± slippage? Stop placed at the exchange at once?
   - Managed per the plan (no widened stop, no early panic exit, no moved target)?
   - Size per the position-sizing rules?
4. **Write the review** with `journal_add {kind:"review", contractId, text, tags}`:
   - text: plan vs. actual, R, grade, what to repeat or change.
   - tags: exactly one of `result:win | result:loss | result:scratch (|R| < 0.2) |
     result:nofill`; `setup:<name>`; `regime:<primary>` (from the plan); the
     symbol; any `mistake:<kind>`
     (`mistake:chased`, `mistake:no-stop`, `mistake:moved-stop`,
     `mistake:early-exit`, `mistake:oversize`, `mistake:rule-break`).
5. **Lessons** (end of session) with `journal_add {kind:"lesson", tags}`:
   one rule, the evidence count, and the condition. Don't write a lesson from a
   single trade unless it's a rule break.
6. Also review blocked orders: the server's (`order_blocked` journal
   entries) and the harness gate's (`<FTH_HOME>/logs/gate-log.jsonl`, with the
   checks that refused each). A block means the plan or sizing was wrong
   before a guardrail had to say so.

## Examples

```text
review: "ORB long MNQ. Plan: break of 21500 OR high, stop 21490, target 21520,
1 contract, $20 risk. Filled 21500.75 (3 ticks slip). Stopped at 21490 after a
sweep of the OR high and close back inside: 43 ticks = $21.50 + $0.74 fees = $22.24
net loss, R = -22.24 / 20 = -1.11. Process B: trigger valid,
but relative volume was 0.9x, which the strategy says to skip."
tags: ["result:loss", "setup:orb", "MNQ", "regime:trend-up", "mistake:rule-break"]

lesson: "ORB on MNQ with relative volume < 1.0x: 1W/5L over 6 trades. Skip."
tags: ["setup:orb", "MNQ"]
```
