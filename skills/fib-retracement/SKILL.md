---
name: fib-retracement
description: Measure a Fibonacci retracement of a leg (the impulse leg a setup defines) on completed candles - the 0.5, 0.618, 0.705 and 0.79 levels, the OTE golden zone from 0.62 to 0.79 with its 0.705 mid, premium vs discount - and read a bounce from the zone on a completed candle. A read for trader-process step 4 and the cisd skill, never a veto.
---

# Fib Retracement

## When to Use

- After an impulse, to judge how deep a pullback is and where it may end
  (trader-process step 4, `pullback-vs-reversal`).
- For a CISD's OTE zone (`cisd`): the briefing's `m3.cisd` gives each
  timeframe's `leg`, `ote` and `retracement`, computed for you.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; the numbers are the code's (`scripts/lib/trading/fib.js`
`LEVELS` and `OTE`); a missing field is `unknown`.

**Which leg.** The leg the setup defines, an impulse: from its origin
(where the move started) to its extreme (where it ended), on completed
candles only, never the candle forming. Not any swing: the setup's own
skill says which leg qualifies (for a CISD, the `cisd` skill and its
`leg`).

**Measure.** A retracement r runs back from the extreme: 0 at the extreme,
1 at the origin; the price at r is extreme - r x (extreme - origin), for
a bullish or a bearish leg. The levels read: 0.5, 0.618, 0.705 and 0.79.

**The golden zone (OTE)** is 0.62 to 0.79 of the leg, mid 0.705 (`ote`:
`top`, `bottom`, `mid`).

**Premium and discount.** Above the leg's 0.5 level is premium, below it
discount: a long from a bullish leg's discount, a short from a bearish
leg's premium (hypothesis).

**The bounce.** Price trades into the zone; THEN a completed candle closes
back in the leg's direction: for a bullish leg, above the zone's top, or
bullish with its close in the upper third of its range from inside the
zone (`candle-reading` reads the candle). Never anticipate it: a touch is
not a bounce. A close through the origin, or well beyond 0.79, says the leg
failed.

**Confirmation** of a bounce at the zone: a rejection candle
(`candle-reading`), or absorption at the zone (`absorption`): effort
without result, heavy volume with little progress into the zone, or the
broker's order-flow fields showing the other side absorbed, where a bar
carries them (never derived from OHLCV).

**Evidence** (Train, docs/research/mtf-setup-catalog.md): buying a 0.5 or
0.618 retrace with the 4h trend lost after costs (F5): depth alone is no
edge. The OTE bounce after a CISD showed no edge on Train either
(docs/research/cisd-ote-textbook.md).

## Examples

```text
Take: bullish leg 21478.25 -> 21530.25; ote 21489.25-21498.00 (mid 21493.50);
  a 3m bar to 21492.50 closes 21500.25 above the zone: bounced, after V 1.9x into the zone
  with little progress (absorption). crt_1h long
  fired with it. Priority order: aligned -> take.
Skip: bearish leg 21560.00 -> 21500.00, price 21520.00 = 0.333, not in the
  zone (21537.25-21547.50); no candle closed back. No setup without a fired strategy.
Loser: vwap_reclaim long at 21494.75, stop 21477.25 (17.50 pts = 70 ticks, $35.00 on 1 MNQ);
  inside the zone, the next 3m bar closed through the origin: -70 ticks, -$35.00.
  The touch was not a bounce; the stop held it to 1R.
```
