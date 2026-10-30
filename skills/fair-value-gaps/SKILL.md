---
name: fair-value-gaps
description: Use when an open or partly filled fair value gap is near price, ahead of a setup, or retested after a sweep. A location, never a trigger.
---

# Fair Value Gaps

## When to Use

- Trader-process step 3: a gap near price, retested, or ahead of a setup.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses; a missing field is `unknown`. Source: Flux Charts, "Fair Value
Gaps (FVG) Explained" (fluxcharts.com/articles/fair-value-gaps-fvg-explained).

**Fair value gap (FVG):** a 3-bar pattern where bar 1's high is below bar 3's
low (bullish) or bar 1's low is above bar 3's high (bearish), with a
strong displacement middle bar the gap's way (the `cisd` skill's strong
candle). A gap behind a weak middle bar, or one the wrong way, is no FVG. Price often
revisits the gap; a gap that holds on retest supports continuation
(`m3.fvgs`). By what price has done since: **open** (not
traded back into), **partly filled** (traded into, not through: only the
unfilled part is still a gap; `m3` `liquidity.partlyFilledFvgs` give it
as `low`-`high`, the whole gap as `gapLow`-`gapHigh`), or **filled**
(traded through: no longer a gap). Price inside a gap is never "at an
open FVG".

**Source vs ours.** The same in substance (fair price just moved, a large
middle candle, invalid past the far edge); ours adds the CISD strength
rule, wicks count, and partly filled. `m3.fvgs` holds the 5m, 15m and
1h gaps, the last 3 of each kind (the entry frame gives none); a filled
gap is in neither list.
Never mark one by eye.

**The read.** A location, never a trigger. The source: price back in the
zone tends to reverse its way. Ours:
a completed candle reacting there (`candle-reading`), momentum
(`momentum-and-volume`) and the other reads; a 15m gap outweighs a 5m one;
gaps are among `levels-and-reactions`' levels.
After a sweep (`breakout-vs-fakeout`) and displacement (`cisd`), the
retest of its gap is the liquidity-grab setup read: it lives here.

**The read forms**, on the `m3.fvgs` gaps (the base bars' own: none):
location `at 15m fvg`; setup `15m rejected 15m fvg high up` (a bullish gap
held), `15m broke 15m fvg low down` (it failed) or, a close inside,
`15m touched 15m fvg high` (it reached the high edge, closed inside);
bearish mirrored.

**Ahead of a setup**: the unfilled part beyond `m3.price` its way. The
briefing does not rank gaps among the levels in a setup's way
(`inTheWay`): give the near edge in R. Like the first level ahead, a
read in the count, never a pass alone.

**Evidence**: not measured; no FVG series in the census.

## Examples

```text
Take: bullish 15m gap partly filled, unfilled 21512.00-21515.25; a 15m close back above: held.
  Reads: at 15m fvg, 15m rejected 15m fvg high up, 3m close top. Priority order -> take.
Skip: short at 21481.25, stop 8.00 points; open gap edge 21477.50 = 0.47R,
  inTheWay at 0.6R; the entry close not in yet -> pass. The edge is a read, not the reason.
Loser: long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ); gap edge
  21509.50 = 1.47R ahead; it stalled: -17 ticks, -$8.50.
```
