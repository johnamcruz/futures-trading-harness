---
name: order-types
description: Use when building an order - its type, side and stop bracket.
---

# Order types

## When to Use

- Before any `place_order`, `modify_order`, `cancel_order` or close.

## How It Works

- Types: `market`; `limit` (limitPrice); `stop` (stopPrice); `trailing_stop`
  (trailPrice = absolute price level); `join_bid` / `join_ask`.
- `buy` opens/adds long or closes short; `sell` the reverse.
- Every entry carries its stop as `stopLossBracket {ticks, type: "stop"}`
  (and its target as `takeProfitBracket {ticks, type: "limit"}` when it has
  one), ticks a whole number above 0 from the fill. Always send it: the gate
  refuses an entry without one (`[stop-defined]`), a check autonomous runs
  can't skip. The broker server attaches the stop leg; or refuses the entry
  (`success: false`); or, if it opened a position whose stop it can't
  confirm, flattens it and says so. If it can't confirm that flatten either,
  it returns an error saying a position may be open: that is not a refusal.
  Reading the reply: the `order-mechanics` skill.

## Examples

```text
place_order {accountId, contractId:"MNQ", type:"limit", side:"buy", size:1, limitPrice:21500.25, stopLossBracket:{ticks:20, type:"stop"}}
  MNQ: the stop 20 ticks = 5.00 pts under the fill, $10.00 risk per contract
```
