---
name: position-sizing
description: Size futures trades from the stop distance, tick value, and the remaining daily loss allowance, with contract specs for CME micros and minis. Use for every plan before an order, and whenever volatility changes.
---

# Position Sizing

## When to Use

- Writing any trade plan.
- After a loss (the allowance shrinks) or a volatility regime change.

## How It Works

1. **Specs from the API, always.** `search_contracts` / `get_contract` return
   `tickSize` and `tickValue`. The table is for sanity checks only:

   | Micro | Mini | Tick size | Micro $/tick | Mini $/tick |
   |---|---|---|---|---|
   | MNQ | NQ | 0.25 | 0.50 | 5.00 |
   | MES | ES | 0.25 | 1.25 | 12.50 |
   | MYM | YM | 1.0 | 0.50 | 5.00 |
   | M2K | RTY | 0.10 | 0.50 | 5.00 |
   | MGC | GC | 0.10 | 1.00 | 10.00 |
   | MCL | CL | 0.01 | 1.00 | 10.00 |

   Contract ids can name a root by another symbol than the exchange's
   (the harness names contracts by their root: `NQ`, `MNQ`; another month is `NQ:2026-03`). Confirm with `search_contracts`.
2. **Risk per contract** = |entry − stop| ÷ tickSize × tickValue (+ round-trip
   fees from the account, if known).
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
   `stopLossBracket.ticks`, or from a limit or stop entry's price to the
   rationale's stop price (the farthest one on the losing side; a part tick
   counts as a whole one); a market
   entry with its stop only in the rationale can't be measured, so a
   strategy with a cap is refused unless you send `stopLossBracket.ticks`.
   Over a cap, reduce the size (never split the entry into several orders,
   never shrink the stop to fit). The cap is checked when the entry is
   placed: the `[protect]` stop you place after the fill goes where the
   rationale said, never farther.
6. **A policy verdict overrides steps 3-5.** While a prop attempt runs a
   policy strategy, the verdict's contract (micro or mini), size, and stop
   ticks were sized from the attempt's budget (`combine_status`); place at
   most that size and don't apply the 25% / 10% / size-1 caps to it. The gate
   checks the verdict, not these caps; it still refuses a size over the
   broker's `maxOrderSize`, and over the policy strategy's own
   `risk.max_risk_usd` if it sets one (its components' caps don't apply). Everything else (stop first, protective
   stop always working) still applies.
7. **Half size** (a `mixed` multi-timeframe read): `floor(size / 2)`; if
   that is 0, skip the trade. Never round a half up.
8. **The arithmetic from `order_plan`.** For a scan candidate (or a policy
   verdict), the harness tool `order_plan` does steps 2 and 4's arithmetic
   for the strategy and side you chose and shows it: the stop in points and
   whole ticks, the risk per contract, the size and where it came from (1 for
   a rules strategy, the size-1 rule; the verdict's, within the attempt's
   budget, for a policy strategy), and the dollar risk. Use its numbers
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
