---
name: strategy-library
description: Apply a strategy to a setup (body, trigger, filters, skip rules, stop, tag) and the priority order that takes, skips or sizes it.
---

# Strategy Library

Strategies are Markdown documents, not code. Each lives at
`strategies/<name>/STRATEGY.md` (plus any folder in `FTH_STRATEGIES_DIRS`).

## When to Use

- Before any plan: which strategies apply to this symbol, now?

## How It Works

### Apply a strategy

1. `strategies_show` it and read the whole body.
2. A trade needs, in order (and then the priority order below sizes or skips it): the trigger has fired on a closed bar (scan
   lists it as a candidate, or the manual trigger described in the body), every
   context filter holds, no "Skip when" rule applies, and planned R:R ≥
   `risk.min_rr` (a trailing exit has no target: there, `trailActivateR` ≥
   `min_rr` stands in for it).
3. Stop from `risk.stop`: `atr:<k>` or a distance expression (e.g.
   cisd_ote's `cisd_risk(15)`) → the scan's `stopDistance`;
   `structure`/`swing` → beyond the level the body names. Round the stop
   away from the entry to the tick (a long's stop down, a short's up), the
   target toward it; bracket ticks = `ceil(distance / tickSize)`.
   `atr:<k>` means k × ATR(20) on the strategy's bars.
4. Tag the plan and the order `setup:<name>`.

### The priority order: the rule for every setup

The rule for every setup (a rules strategy's candidate or a policy
verdict). A verdict is a ceiling on size, never an order. Contradicting
facts mean no trade; confluence means trade. Go down the list; a higher step
wins, and each step can only lower the size, never raise it: the size is the
smaller of the verdict's (or position-sizing's) and what the steps allow.
Wherever a step halves, half is `floor(size / 2)`, and 0 means no trade (so
at size 1 every halving is a skip). Halvings don't compound: however many
steps halve, the size is halved once.

1. **Hard stops → no trade**: the candidate is `blocked` (a news blackout
   or the news unknown, a no-entry window), a phase-1 stand-down, or a gate
   refusal.
2. **The trend rule**: a trend strategy against the prevailing trend → no
   trade (the scan and the gate refuse it anyway). A reversal strategy may
   fade it only at a higher-timeframe level, at half size and the nearest
   target.
3. **Room**: the first level in its way (`inTheWay`, in its own R) comes
   before the room it needs (`needR`) → no trade.
4. **The multi-timeframe read for its side**: `aligned` → full;
   `pullback` → no trade until the trigger timeframe turns back with the
   bias (a shift, a reclaim), then full; `mixed` → half; `counter` on a
   non-reversal setup → no trade.
5. **The strategy's own context filter and skip rules** (its STRATEGY.md)
   → any skip rule hit: no trade.
6. **Confluence**: another strategy firing the other side → no trade;
   confluence with it supports the full size; none changes nothing alone.
7. **Secondary context** (the VWAP side, the lunch lull, participation):
   cuts to half, never vetoes alone.

Every other skill and role applies this order; none restates it.

## Examples

```text
strategies_show orb → skip rule "relative volume < 1.0x" → volume analyst reports 0.8x → no trade.

strategies_scan → crt_1h short, a candidate, stopDistance 18.5 → read the
body's skip rules → none apply → plan it.
```
