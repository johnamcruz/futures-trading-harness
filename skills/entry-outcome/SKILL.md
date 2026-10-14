---
name: entry-outcome
description: Use after placing an entry - filled, working, refused, an unknown outcome, or flat.
---

# Entry Outcome

## When to Use

- After an entry is placed (`trade-session` step 6).

## How It Works

After placing: read `get_account_snapshot` and `list_open_orders` once.
Filled: check the filled size (a partial fill is a smaller position: its stop
covers what filled; cancel the rest of the entry if the plan doesn't still
want it), the fill price, and that the protective stop is working at the
planned level. A position without a working stop is fixed before anything
else (the trade-executor places a `[protect]` stop, or closes the position).
Not filled yet (a resting limit or stop, or a market order the broker hasn't
filled): with its stop bracket attached,
journal a note that the entry is working (its order
id, and that its stop bracket is attached), report it,
and stop there (in an autonomous cycle, end the cycle; interactively, until
the next check); the next cycle or check verifies the fill and the stop
first. Every entry carries its stop bracket (the gate refuses an entry
without one, a check autonomous runs can't skip). Refused (`success: false`
with an `errorCode` other than 6 (`OrderPending`) or 7 (`UnknownError`), its
brackets included, or a `Blocked by ...`): the
trade-executor reports it with the message; journal it, give the user that
message verbatim, and end (cycle result `blocked`); never send the entry
again without its bracket. Any other error (codes 6 and 7 included, a lost
reply, a timeout, a message that a position may be open) is an unknown outcome, not a refusal:
the trade-executor reads positions and orders at once, protects or closes
any position without a covering stop first, and never re-sends the entry.
Flat after a successful reply (the broker reports the entry closed or not
filled): journal its review with the broker's message: `result:nofill`
only when nothing shows the order filled. If the reply or the broker's
message says a position was opened or closed, or `search_trades` shows any
fill for the order, the usual review of a closed trade. If it can't be told
yet (fills can be reported late), no review this cycle: the next cycle's
flat-with-an-unreviewed-entry step decides from `search_trades`.
Never wait or poll for the fill (the `order-mechanics` skill).

## Examples

```text
filled 1, stop working -> report
```
