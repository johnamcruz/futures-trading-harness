---
name: position-sizing
description: Use when sizing a trade plan - risk per contract, the budget, the caps, a policy verdict's size.
---

# Position Sizing

## When to Use

- Writing any trade plan.
- After a loss (the allowance shrinks) or a volatility regime change.

## How It Works

1. **Specs from the API, always.** `search_contracts` / `get_contract` return
   `tickSize` and `tickValue`. Micro and mini specs to sanity-check them: the
   `micro-mini-specs` skill.
2. **Risk per contract** = |entry − stop| ÷ tickSize × tickValue (+ round-trip
   fees from the account, if known). A stop can fill a tick or more past its
   price: when the room to the loss floor or the daily limit sets the size,
   count a tick of slippage per contract too (a policy verdict already does).
3. **Risk budget** = the smallest of:
   - the strategy / plan $ risk,
   - 25% of `remainingBeforeLimit` from `get_account_snapshot`,
   - 10% of the trailing-drawdown cushion (balance − loss floor).
4. **Size** = floor(budget ÷ risk per contract). If it's 0, the stop is too
   wide for the budget: skip, or find a tighter, structure-based stop. Never
   shrink the stop to make the size work.
5. **Caps:** the broker server's `maxOrderSize` and `maxPositionSize`
   (`get_server_config`); size 1 on micros until the setup has 30+
   reviewed trades with positive expectancy. The order gate enforces two
   of them on every entry: the size at most `maxOrderSize` (the harness
   records it from `get_server_config`, and refuses entries until it has),
   and, when the strategy sets `risk.max_risk_usd`, size × stop ticks ×
   tickValue at most that cap. It measures the stop from
   `stopLossBracket.ticks`, which every entry carries (the gate refuses an
   entry without one; always send it), and, for a limit or stop entry, from its price to the
   rationale's stop price when that is farther (the farthest one on the
   losing side; a part tick counts as a whole one).
   Over a cap, reduce the size (never split the entry into several orders,
   never shrink the stop to fit). The cap is checked when the entry is
   placed: a `[protect]` stop that later repairs the position's protection
   goes where the rationale said, never farther.
6. **A policy verdict overrides steps 3-5.** While a prop attempt runs a
   policy strategy, the verdict's contract (the selected one), size, and stop
   ticks were sized from the attempt's budget (`combine_status`), each
   contract's risk counting its stop plus a tick of expected slippage
   (`sizing.stop_slippage_ticks`) and fees both ways; place at
   most that size and don't apply the 25% / 10% / size-1 caps to it. The gate
   checks the verdict, not these caps; it still refuses a size over the
   broker's `maxOrderSize`, and over the policy strategy's own
   `risk.max_risk_usd` if it sets one (its components' caps don't apply). Everything else (stop first, protective
   stop always working) still applies.
7. **Half size** wherever the priority order (strategy-library) halves a
   trade, computed as it says there. Never round a half up.
8. **The arithmetic from `order_plan`.** For a scan candidate (or a policy
   verdict), the harness tool `order_plan` does steps 2 and 4's arithmetic
   for the strategy and side you chose and shows its working (the
   `order-plan` skill). Use its numbers
   instead of computing them by hand. The budget (step 3) and the caps are
   still your judgement: a budget below its risk is a skip, and a size you
   are allowed to raise (30+ reviewed trades) changes only `size`, with the
   risk scaling by it.
9. Write entry, stop, size, and $ risk into the plan.

## Examples

```text
MNQ long 21500.00, stop 21482.50 → 17.5 pts = 70 ticks × $0.50 = $35/contract
remainingBeforeLimit $600 → 25% = $150; plan risk $75; cushion $1,800 → 10% = $180
budget = $75 → size = floor(75 / 35) = 2 → capped to 1 (setup has 12 reviews)
Plan: 1 MNQ, risk $35.

order_plan for an orb long on MNQ, stop distance 5.25 pts:
stop 5.25 pts = 21 ticks ($10.50/MNQ contract), size 1, risk $10.50 = 1 x 21 ticks x $0.50/tick
(the same distance on MES: 21 ticks x $1.25 = $26.25)
```
