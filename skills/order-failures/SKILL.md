---
name: order-failures
description: What to do when an order or read call errors or times out - never resend, the [order-pending] hold, and protecting an uncovered position first.
---

# Order failures

## When to Use

- A broker call errored, timed out, or its reply was lost.
- A position has no working protective stop.
- `get_bars` requests near the rate limit.

## How It Works

- `get_bars`: 50 requests per 30 s across all agents. Reuse the runner's bars
  file; one request per extra timeframe.
- A read times out or errors (429, 5xx): retry once after a few seconds, then
  stand aside for this cycle.
- An order call times out or errors without a clear rejection: **don't
  resend**. Read `list_open_orders` and `get_account_snapshot` first; the
  order may be working or filled. Only place it again when both show it
  isn't there, and the plan still holds.
- The gateway tracks such an order itself: every `place_order` goes out with
  a `customTag` (yours, or one it adds), and until the broker's orders
  (`search_orders`) show that tag, or 2 minutes pass without it, new entries
  are refused with `[order-pending]`. Exits, stop moves and cancels are still
  checked: an unknown market order counts as filled, an unknown limit or stop
  as resting. `close_position` always goes. If an exit's own `customTag` is
  already carried by an order of unknown outcome, the exit goes under a fresh
  tag: find it by the `orderId` in the reply, not by your tag.
- A position without a working protective stop (its bracket stop missing
  after the fill, a partial exit, cancelled by mistake): place a `[protect]`
  stop at once, or close the position. Nothing else comes first. (Right after a close whose reply was an
  error, the gate refuses the `[protect]`: `close_position` again; see the `gate-refusals` skill.)

## Examples

```text
place_order (entry) -> timeout, no reply: don't resend
list_open_orders + get_account_snapshot -> long 1 MNQ, no working stop
place_order {side:"sell", type:"stop", size:1, stopPrice:<the plan's stop>,
  rationale:"[protect] stop for the long whose entry reply was lost"}   (first, before anything else)
```
