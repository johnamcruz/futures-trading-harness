---
description: End-of-day routine - confirm flat before the 15:10 CT Topstep cut-off, cancel leftover orders, review all trades, write lessons, and summarize the day.
argument-hint: "[account id]"
---

# /eod

1. `get_account_snapshot` for the account in `$ARGUMENTS` (or the session's
   account).
2. If positions are open, ask the user whether to flatten. On yes, call
   `trade-executor` to `close_position` each (rationale/journal `[exit] end of
   day`) and cancel every working order. Topstep flattens at 15:10 CT; don't
   wait for it.
3. Confirm with `list_open_positions` and `list_open_orders` that nothing is
   left.
4. Run `/trade-review --eod`.
5. Summarize: net P&L after fees, trades, R total, rule breaks, blocked orders,
   lessons written, and tomorrow's focus. Save it with
   `journal_add {kind:"note", tags:["eod"]}`.
