---
description: Review every unreviewed entry from this trading day with the trade-reviewer agent - R multiple, process grade, result and setup tags - and unblock the order gate's review-before-next-entry check.
argument-hint: "[--eod to also write lessons]"
---

# /trade-review

1. Run the `trade-reviewer` agent for today's trading day (since 17:00 CT).
   Pass `$ARGUMENTS`; with `--eod` it also writes 1–3 lessons.
2. Show the user the per-trade table, blocked-order patterns, and any lessons.
3. If an entry is still open, don't review it: report its protective stop status
   from `list_open_orders` instead.
