---
name: strategy-library
description: Apply a strategy, and the priority order that sizes or skips a setup.
---

# Strategy Library

Strategies are Markdown documents, not code. Each lives at
`strategies/<name>/STRATEGY.md` (plus any folder in `FTH_STRATEGIES_DIRS`).

## When to Use

- Before any plan: which strategies apply to this symbol, now?

## How It Works

### Apply a rules strategy (none active; composed: `trade-lifecycle`)

1. `strategies_show` it and read the whole body.
2. A trade needs, in order (then the priority order sizes or skips it):
   the trigger fired on a closed bar (a scan candidate, or the body's
   manual trigger), every context filter holds, no "Skip when" rule
   applies, and planned R:R ≥ `risk.min_rr` (a trailing exit:
   `trailActivateR` ≥ `min_rr`).
3. Stop from `risk.stop`: `atr:<k>` (k × ATR(20) on its bars) or a distance
   expression → the scan's `stopDistance`; `structure`/`swing` → beyond the
   level the body names. Round the stop away from the entry to the tick,
   the target toward it; bracket ticks = `ceil(distance / tickSize)`.
4. Tag the plan and the order `setup:<name>`.

### The priority order: the rule for every setup

A verdict is a ceiling on size, never an order. A valid setup is the
trade (`confluence-counting`). Go down the list; a higher step
wins, and each step can only lower the size, never raise it: the size is the
smaller of the verdict's (or position-sizing's) and what the steps allow.
In a prop attempt nothing halves: a serious factor against doesn't cut the size; the code sets the full verdict size. Outside one, the steps below size it.
Wherever a step halves, half is `floor(size / 2)`, and 0 means no trade (so
at size 1 every halving is a skip). Halvings don't compound: however many
steps halve, the size is halved once. A composed trade: `confluence-counting`
sizes it, under the code's caps.

1. **Hard stops → no trade**: the candidate is `blocked` (a news blackout
   or the news unknown, a no-entry window), a phase-1 stand-down, or a gate
   refusal.
2. **The trend rule** (never counter): any setup or strategy against a
   trending 4h or 1h, or with both ranging against the 15m → no trade,
   whatever CHoCH.
3. **Room**: the first level ahead (`inTheWay`, its own R) and the R it
   aims for (`needR`): a read, never a no trade alone. Hard: R:R to the
   target at least `risk.min_rr` (compose_check's).
4. **The multi-timeframe read for its side**: a rules strategy:
   `aligned` → full; `pullback` → full (the setup the bias's way ends
   it); `mixed` → half; `counter` → no trade. Composed: the side rule
   (`htf-to-ltf`).
5. **The strategy's own context filter and skip rules** (its STRATEGY.md)
   → any skip rule hit: no trade.
6. **Confluence** (rules strategies): another firing the other side → no trade;
   confluence with it supports the full size.
7. **Secondary context** (the VWAP side, the lunch lull, participation):
   cuts to half (not in a prop attempt), never vetoes alone.

Every other skill and role applies this order; none restates it.

## Examples

```text
trade_lifecycle short, 1h up, a 1h CHoCH down → step 2: no trade (never counter).
```
