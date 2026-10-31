---
name: leftover-orders
description: Use when flat with working orders - cancel leftovers, keep only a bracketed planned entry.
---

# Leftover Orders

## When to Use

- Flat with working orders (`trade-session` step 1).

## How It Works

- **Flat with working orders**: cancel leftovers from a closed trade (its stop
  or target) right away; they could fill into an unplanned position. Keep only
  a pending entry from your own plan that carries its stop bracket. No bracket shows
  before the fill: keep an entry the prompt lists as "bracket attached on fill",
  else tell by the entry's
  own `order_placed` journal record (`journal_read {kind:"order_placed"}`, kind
  only, no `contractId` filter: the
  one whose `data.result.orderId` is the order; its `data.request` has
  `stopLossBracket` when the bracket went with it); entry-outcome's note on a
  working entry adds context. An entry without one, or with no such record,
  is cancelled first, the cancel
  confirmed (the `order-mechanics` skill), and a `result:nofill` review journalled: cancelling an
  entry only reduces risk. New entries wait until no order is working in the
  contract. The runner also cancels leftovers before each bar.
- A stop is never a leftover while fills or an order's status show the
  position, even if positions read flat: `[cancel-protection]` refuses it; keep it.

## Examples

```text
flat, old stop working -> cancel, confirm
```
