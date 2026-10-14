---
name: order-plan
description: Use when reading order_plan's order numbers.
---

# Order Plan

## When to Use

- Planning or checking an order's stop, ticks, size and $ risk.

## How It Works

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `order_plan` | `bars`, `symbol`, `strategy`, `side`, `accountId`? | a calculator for the order of a trade you chose (strategy and side are yours; it never picks, ranks, or advises): when that strategy is a candidate on that side on the last closed bar (or, for a policy strategy, its live verdict), one line showing its working (entry reference, the stop and target in points and whole ticks, prices on the tick with a long's stop below the entry and a short's above, how the size was derived, $ risk) and the exact `place_order` arguments as JSON; refused, with the reason, when it isn't a candidate now, its rules fired the other side, the bars aren't the strategy's timeframe, their last bar closes more than a minute after the harness clock or is older than the gate's signal age, (a policy strategy) the verdict is for another bar than the last closed one or than the last bar recorded for its timeframe (the gate's check), or the broker's tick specs for the contract aren't recorded yet (`search_contracts` / `get_contract` for it first, then call it again). It places nothing | `strategies.js plan <bars> --symbol MNQ --strategy orb --side long [--account-id 7]` |

Its working includes the risk per contract. Never supply tick numbers of your
own. Round a stop away from the entry and a target toward it; bracket ticks =
`ceil(distance / tickSize)`, the same numbers in the rationale and the
brackets.

## Examples

```text
order_plan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ", "strategy": "vwap_reclaim", "side": "long", "accountId": 7}
→ vwap_reclaim long: 1 MNQ at market (entry ref 21503.25) | stop 21498.00, below the entry: 5.25 pts = 21 ticks ($10.50/MNQ contract), stopLossBracket.ticks 21 | target 21513.75 (2R): 42 ticks, takeProfitBracket.ticks 42 | risk $10.50 = 1 x 21 ticks x $0.50/tick (before fees) | size 1: the minimum; no account budget sizes a rules strategy (position-sizing: size 1 until the setup has 30+ reviewed trades)
  place_order arguments: {"accountId":7,"contractId":"MNQ","side":"buy","type":"market","size":1,"stopLossBracket":{"ticks":21,"type":"stop"},"takeProfitBracket":{"ticks":42,"type":"limit"},"rationale":"setup:vwap_reclaim long at market from 21503.25 (the signal bar's close), stop 21498.00 (21 ticks), target 21513.75 (42 ticks), 1 MNQ risks $10.50"}
```
