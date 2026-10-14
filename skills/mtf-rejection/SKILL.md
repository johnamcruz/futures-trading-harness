---
name: mtf-rejection
description: The multi-timeframe rejection setup, step by step on the trader-process PLAN - an HTF bias, a key level, a completed 15m or 60m candle rejecting it, a completed 3m or 5m candle confirming. Today a read that supports or argues against a strategy that fired at the level, never an entry by itself.
---

# MTF Rejection

## When to Use

- A strategy fired at a key level, and the plan asks whether a higher
  timeframe rejected that level.

## How It Works

**Today it is a read, not a trigger.** The order gate allows an entry
only when a strategy fired on the bar. This setup supports, or argues
against, a strategy that fired at the level (`crt_1h`, `crt_4h`,
`value_area_reentry`, `vwap_reclaim`, `orb`); a dedicated detector strategy
for it is coming. It is never a reason to enter without a fired strategy.

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`. Completed candles only, on 3m,
5m, 15m and 60m (`candle-reading`).

By PLAN step:

- **1 HTF**: the 60m and 15m bias (`h1.h1.trend`, `m15.frame.trend`) and
   `trend-vs-range`.
- **3 Location**: price at a key level (`levels-and-reactions`: POC,
   VAH/VAL, CRT high/low, prior-day and overnight high/low, VWAP, IB/OR,
   swing, previous candle high/low).
- **4 Setup**: a completed 15m or 60m candle rejects the level: it trades
   through and closes back inside, with a long wick and the close in the
   opposite third, or an engulfing at the level (`candle-reading`). At
   the end of a pullback with the HTF (`pullback-vs-reversal`) it is a
   continuation. Against the HTF, whether a structure break went its way
   (`m15.lastBreak.last` or `h1.lastBreak.last` a CHoCH) is read in item 1
   of `confluence-counting`; the priority order decides.
- **5 Confluence**: volume or absorption at the level (`momentum-and-volume`,
   `absorption`), counted by `confluence-counting`.
- **6 Entry**: after the HTF rejection, a completed 3m or 5m candle confirms
   the same way: a displacement candle, or a break of the small pullback
   structure (`m3.lastBreak.last`). Never anticipate it.
- **7 Risk**: the idea is wrong beyond the rejection wick; the stop is the
   strategy's (`candidate.stopPoints`, `order_plan`): check it sits beyond
   the wick (`invalidation`). Size: the priority order and the rulebook.
- **9 Manage**: invalidation is a close back through the level against the
   trade.

**Paired with `mtf-breakout`**: a failed breakout (a close back inside)
is the setup for a rejection the other way.

**Evidence**: not measured as a setup yet; candle patterns alone have weak
evidence in general.

## Examples

```text
Take: at the RTH VWAP 21520.50, 60m and 15m up: on the 15m close a wick to 21517.25, close 21523.00
  (top third); then on the 3m close a displacement up. vwap_reclaim long fired. Priority order -> take.
Skip: at the overnight high 21614.75: the 15m candle still forming (no read yet); orb long fired.
  candidate.inTheWay the overnight high at 0.2R. Priority order (step 3, room): skip.
Loser: at the prior RTH low 21402.00: on the 60m close a rejection (L 21396.75, C 21405.50), on the
  3m close a displacement. crt_1h long at 21407.25, stop 21396.25 (11.00 pts = 44 ticks,
  $22.00 on 1 MNQ); the next 15m closed back below 21402.00. -44 ticks, -$22.00.
```
