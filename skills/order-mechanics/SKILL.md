---
name: order-mechanics
description: Use when an order replied - refused, unknown outcome, partial fill; check it once, never wait for a fill.
---

# Order mechanics

## When to Use

- After an order's reply: refused, outcome unknown, working, or filled (in
  whole or in part)?

## How It Works

- **Refused**: a reply with `success: false` and an `errorCode` other than
  6 (`OrderPending`) or 7 (`UnknownError`) (a refusal of the brackets
  included), or a `Blocked by ...` refusal. Nothing was
  opened. Don't send it again without its brackets, and never enter without
  them to place a stop afterwards. Journal a note with the message, report
  it to the user verbatim (what it asks of the account is the user's to
  fix), and end the cycle as `blocked`.
- **Any other error is an unknown outcome, not a refusal**: codes 6 and 7
  included, any other error reply, a lost reply, a timeout, or a message
  that a position may be open. Read `list_open_positions` and
  `list_open_orders` at once; a position open without a working stop that
  covers it gets a `[protect]` stop, or `close_position`, before anything
  else. Never send the entry again (the gateway refuses new entries with
  `[order-pending]` until the order settles; the `order-failures` skill). Report
  what you found.
- `close_position` leaves resting stop/target orders: cancel them.
- `search_trades`: `profitAndLoss: null` marks an opening fill; fees separate.

- **Partial fills**: a limit or a large market entry may fill in part.
  `get_account_snapshot` / `list_open_positions` give the filled size; a
  bracket covers the filled quantity. Cancel the unfilled rest when the plan
  no longer wants it, and size any `[protect]` stop to the position, not to
  the order.
- **Check a new order once; never wait for a fill**: after `place_order`,
  read its status once (`list_open_orders` and `list_open_positions`, or
  `get_account_snapshot`). Filled: carry on (its stop, its journal entry).
  Still working (a limit or stop entry not reached, or a market order the
  broker hasn't filled yet; a replay broker may fill it only at the next bar,
  and live fills can lag) with its stop bracket attached: journal that
  it is working, with its order id and that its stop bracket is attached (it
  attaches on the fill, so no stop leg shows first: not a reason to
  cancel; the next cycle tells by the entry's `order_placed` record, whose `data.request` carries
  `stopLossBracket`, or the prompt's "attached on fill" line), and end the cycle.
  Flat with no working entry after a successful reply: the broker reports
  the entry closed or not filled (it flattened a position whose stop it
  couldn't confirm, or cancelled the order); journal its review with the
  broker's message: `result:nofill` only when nothing shows the order
  filled. If the reply or the broker's message says a position was opened
  or closed, or `search_trades` shows any fill for the order, the usual
  review of a closed trade. If it can't be told yet (fills can be reported
  late), no review this cycle: the next cycle's flat-with-an-unreviewed-entry
  step decides from `search_trades`.
  Still working without a stop bracket (one the gate never checked, e.g.
  placed outside the harness): don't leave
  it, since it would fill with no stop. `cancel_order` it (cancelling an entry
  only reduces risk), then read `list_open_orders` and `list_open_positions`
  once to confirm. Whatever else it shows, any quantity that filled is
  protected first: its `[protect]` stop, or close it. Gone and flat: journal
  a review tagged `result:nofill` and `setup:<name>` (the gate counts a
  placed entry until it is reviewed) and plan again next cycle. Filled before
  the cancel (in whole or part): it is a live, executed trade, protected as
  above. Still working (the cancel was refused, errored, or lost): cancel
  once more; if it is still working, journal a note naming it as an entry
  without a stop bracket and end the cycle as `error`, so the next cycle
  cancels it first (interactively, tell the user it is still working with no
  stop). The next cycle checks a
  working entry's fill and manages the position: the autonomous runner starts
  a cycle while an order is working or a position is open; interactively, the
  next check. Never wait or poll for a fill: no repeated `get_bars`,
  `get_quote`, `list_open_orders`, or snapshot reads to see it fill. A
  position you must leave (no working stop, end of day) is still closed with
  `close_position` and re-read as the steps for it say: closing is acting,
  not waiting.

## Examples

```text
place_order (a limit entry with its stop bracket) -> success, orderId 812
list_open_orders + list_open_positions, once     -> 812 working, no position
journal_add {kind:"note"}: entry 812 working, its stop bracket attached; end the cycle

place_order -> success:false, errorCode not 6 or 7 -> refused, nothing opened:
journal a note, report the message verbatim, end the cycle as blocked
```
