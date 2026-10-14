---
name: order-rationale
description: Writing an order's rationale the gate reads - the entry line (setup, side, trigger, stop, target, risk), [exit] and [protect], and stop ticks that match it.
---

# Order rationale

## When to Use

- Writing the `rationale` of any `place_order`.
- The gate refused an entry because its rationale and the order disagree.

## How It Works

- Entry: `setup:<name> <side> <trigger>, stop <price>, target <price>, risk $<n>`.
  The gate checks the order against it (`order-consistency`): `<side>`
  (long/short) must be the order's side, the prices on the tick and on the
  right sides, and the brackets the same distance (from `limitPrice` /
  `stopPrice`; for a market order, stop + target ticks = the stop-to-target
  span). Write a distance as a unit (`stop 40 ticks`) and it isn't read as a
  price.
- Exit / scale-out: `[exit] <why>`.
- Protective order for an existing fill: `[protect] <what it protects>`.
  It repairs protection (a stop missing or cancelled, or resized after a
  partial exit); it is never a way to enter without a bracket.
- **Stop vs rationale**: the rationale's stop price and
  `stopLossBracket.ticks` must say the same stop (ticks =
  `ceil(|entry - stop| / tickSize)`). The harness tool `order_plan` works
  both out for the strategy and side you chose; send its arguments as given. After a market fill the bracket sits
  that many ticks from the fill price, not from the planned entry: read the
  working stop's price in `list_open_orders` and journal it if it differs.

## Examples

```text
place_order {accountId, contractId:"MNQ", side:"buy", type:"market", size:1,
  stopLossBracket:{ticks:40, type:"stop"}, takeProfitBracket:{ticks:80, type:"limit"},
  rationale:"setup:orb long close above OR high 21500.00, stop 21490.00, target 21520.00, risk $20"}

place_order {..., side:"sell", type:"stop", size:1, stopPrice:21490.00,
  rationale:"[protect] stop for ORB long filled at 21500.25"}
```
