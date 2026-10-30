---
name: position-sizing
description: Use when sizing a trade plan - risk per contract, the budget, the caps, a policy verdict's size.
---

# Position Sizing

## When to Use

- Writing any trade plan.
- After a loss (the allowance shrinks) or a volatility regime change.

## How It Works

In a prop attempt: the full verdict size; a serious factor against never
cuts it; only a pacing rule does. The code computes it (healthy: balance ≥
start, no loss streak). Fewer than 3 contracts (`min_contracts`) at the stop:
skip.

1. **Specs from the API, always.** `search_contracts` / `get_contract` return
   `tickSize` and `tickValue`. Micro and mini specs to sanity-check them: the
   `micro-mini-specs` skill.
2. **Risk per contract** = |entry − stop| ÷ tickSize × tickValue (+ round-trip
   fees from the account, if known). A stop can fill a tick or more past its
   price: when the room to the loss floor or the daily limit sets the size,
   count a tick of slippage per contract too (a policy verdict already does).
3. **Caps:** the broker server's `maxOrderSize` and `maxPositionSize`
   (`get_server_config`); size 1 on micros for a rules strategy until
   its setup has 30+ reviewed trades with positive expectancy. The order gate enforces two
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
4. **A policy verdict overrides the budget and caps.** While a prop attempt runs a
   policy strategy, the verdict's contract (the selected one), size, and stop
   ticks were sized from the attempt's budget (`combine_status`), each
   contract's risk counting its stop plus a tick of expected slippage
   (`sizing.stop_slippage_ticks`) and fees both ways; place at
   most that size and don't apply the 25% / 10% / size-1 caps to it. The gate
   checks the verdict, not these caps; it still refuses a size over the
   broker's `maxOrderSize`, and over the policy strategy's own
   `risk.max_risk_usd` if it sets one (a rules component's caps don't apply;
   `trade_lifecycle`'s cap does: the lower of it and the verdict (the verdict is the full size; the cap limits the stop)). Everything else (stop first, protective
   stop always working) still applies. The verdict is the most the account
   allows: phase 2 cuts it only on a pacing rule (a losing account, a loss
   streak, drawdown: `Size: <n> (<rule>)`) or passes.
5. **The arithmetic from `order_plan`** (the `order-plan` skill): step 2
   and the size for a compose record (refused over its cap), a policy verdict or a
   rules candidate; use its numbers, never your own. The budget
   and the caps stay your judgement: a budget below its risk is a skip; a
   raised size (a rules setup with 30+ reviewed trades) changes only
   `size`, the risk scaling with it.
6. Write entry, stop, size, and $ risk into the plan.

### Outside a prop attempt

1. Risk budget = the smallest of:
   - the strategy / plan $ risk (a composed trade: at most its $300 cap),
   - 25% of `remainingBeforeLimit` from `get_account_snapshot`, when known,
   - 10% of the trailing-drawdown cushion (balance − loss floor), when shown.
     None shown (no attempt): skip this cap, never $0. Never ask when
     autonomous.
2. Size = floor(budget ÷ risk per contract). If it's 0, the stop is too
   wide for the budget: skip.
   Never a tighter stop to make the size work.
3. A trade marked smaller is halved: half is
   `floor(size / 2)`, 0 means no trade (at size 1 every halving is a skip).
   Halvings don't compound: the size is halved once, never rounded up. A composed
   trade: `confluence-counting` sizes it, under the caps.

## Examples

```text
MNQ long 21500.00, stop 21482.50 → 17.5 pts = 70 ticks × $0.50 = $35/contract
remainingBeforeLimit $600 → 25% = $150; plan risk $75; cushion $1,800 → 10% = $180
budget = $75 → size = floor(75 / 35) = 2 → capped to 1 (setup has 12 reviews)
Plan: 1 MNQ, risk $35.

compose record, a long on MNQ, stop 27.75 pts = 111 ticks ($55.50/MNQ contract):
risk.max_risk_usd $300 -> maxSize 5; size 5, risk $277.50 = 5 x 111 ticks x $0.50/tick
(the same stop on MES: 111 ticks x $1.25 = $138.75 a contract: maxSize 2, $277.50)
```
