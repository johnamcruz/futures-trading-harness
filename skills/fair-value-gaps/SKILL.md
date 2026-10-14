---
name: fair-value-gaps
description: Use when an open or partly filled fair value gap is near price, ahead of a setup, or retested after a sweep. A location, never a trigger.
---

# Fair Value Gaps

## When to Use

- Trader-process step 3: a gap near price, retested, or ahead of a setup.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`. Source: Flux Charts, "Fair Value
Gaps (FVG) Explained" (fluxcharts.com/articles/fair-value-gaps-fvg-explained).

**Fair value gap (FVG):** a 3-bar pattern where bar 1's high is below bar 3's
low (bullish) or bar 1's low is above bar 3's high (bearish), with a
strong displacement middle bar the gap's way (the `cisd` skill's strong
candle: body at least 0.6 of its range, close in the extreme third, range
at least 1.0 x ATR(14) or engulfing). A gap behind a weak middle bar (a
doji, a small body, a close mid-range, the wrong way) is no FVG. Price often
revisits the gap; a gap that holds on retest supports continuation
(`m3` `liquidity.openFvgs`). By what price has done since: **open** (not
traded back into), **partly filled** (traded into, not through: only the
unfilled part is still a gap; `m3` `liquidity.partlyFilledFvgs` give it
as `low`-`high`, the whole gap as `gapLow`-`gapHigh`), or **filled**
(traded through: no longer a gap). Price inside a gap is never "at an
open FVG".

**Source vs ours.** The source: fair price just moved, a large middle
candle, bounds as above, invalid once price passes the far edge. Ours is
the same in substance. Our rule: the middle candle must be a strong
displacement candle the gap's way (the CISD strength rule: body ≥ 0.6 of its
range, close in the extreme third, range ≥ 1.0×ATR(14) or engulfing); wicks
count; partly filled is ours; filled is its invalid. The gaps of the last 60 bars of the briefing's own timeframe, the last 3 of
each kind; a filled gap is in neither list. Never mark one by eye.

**The read.** A location, never a trigger. The source: price back in the
zone tends to reverse its way; gaps form fast and are less accurate;
intraday (3m to 15m) suits them. Ours: a completed candle reacting there
(`candle-reading`), momentum (`momentum-and-volume`) and a fired strategy;
a 15m gap outweighs a 3m one. After a sweep (`levels-and-reactions`) and
displacement (`cisd`), the retest of its gap is the liquidity-grab
entry read: it lives here.

**Ahead of a setup**: the unfilled part beyond `m3.price` its way. The
briefing does not rank gaps among the levels in a setup's way
(`candidate.inTheWay`): give the near edge in its R (over
`candidate.stopPoints`). The room step stays the priority order's, on
`inTheWay`.

**Evidence**: not measured; no FVG series in the census.

## Examples

```text
Take: bullish gap partly filled, unfilled 21512.00-21515.25; a 3m close back above: held.
  vwap_reclaim long at 21520.50. Priority order: room -> take.
Skip: crt_1h short at 21481.25, stopPoints 8.00; open gap edge 21477.50 = 0.47R,
  inTheWay at 0.6R. Priority order (step 3, room): skip.
Loser: orb long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ); gap edge
  21509.50 = 1.47R ahead; it stalled: -17 ticks, -$8.50.
```
