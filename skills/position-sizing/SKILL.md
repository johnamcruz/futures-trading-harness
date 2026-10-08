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

   ProjectX contract roots can differ from exchange symbols (E-mini NQ is `ENQ`,
   ES is `EP`). Confirm with `search_contracts`.
2. **Risk per contract** = |entry − stop| ÷ tickSize × tickValue (+ round-trip
   fees from the account, if known).
3. **Risk budget** = the smallest of:
   - the strategy / plan $ risk,
   - 25% of `remainingBeforeLimit` from `get_account_snapshot`,
   - 10% of the trailing-drawdown cushion (balance − loss floor).
4. **Size** = floor(budget ÷ risk per contract). If it's 0, the stop is too
   wide for the budget: skip, or find a tighter, structure-based stop. Never
   shrink the stop to make the size work.
5. **Caps:** the server's `PROJECTX_MAX_ORDER_SIZE` and
   `PROJECTX_MAX_POSITION_SIZE`; size 1 on micros until the setup has 30+
   reviewed trades with positive expectancy.
6. **A policy verdict overrides steps 3-5.** While a prop attempt runs a
   policy strategy, the verdict's contract (micro or mini), size, and stop
   ticks were sized from the attempt's budget (`combine.js status`); place at
   most that size and don't apply the 25% / 10% / size-1 caps to it. The gate
   checks the verdict, not these caps. Everything else (stop first, protective
   stop always working) still applies.
7. **Half size** (a `mixed` multi-timeframe read): `floor(size / 2)`; if
   that is 0, skip the trade. Never round a half up.
8. Write entry, stop, size, and $ risk into the plan.

## Examples

```text
MNQ long 21500.00, stop 21482.50 → 17.5 pts = 70 ticks × $0.50 = $35/contract
remainingBeforeLimit $600 → 25% = $150; plan risk $75; cushion $1,800 → 10% = $180
budget = $75 → size = floor(75 / 35) = 2 → capped to 1 (setup has 12 reviews)
Plan: 1 MNQ, risk $35.
```
