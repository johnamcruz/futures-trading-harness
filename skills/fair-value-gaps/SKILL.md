---
name: fair-value-gaps
description: Read fair value gaps as the code computes them (open, partly filled, filled) and a gap ahead of a setup, in its own R. A read, never a veto.
---

# Fair Value Gaps

## When to Use

- A setup fired and an open or partly filled gap lies ahead of it, in its
  direction (in index mode the gate counts your report only after you look
  this skill up).
- Trader-process step 3, when a gap is near price.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`.

**Fair value gap (FVG):** a 3-bar pattern where bar 1's high is below bar 3's
low (bullish) or bar 1's low is above bar 3's high (bearish). Price often
revisits the gap; a gap that holds on retest supports continuation
(`m3` `liquidity.openFvgs`). By what price has done since: **open** (not
traded back into), **partly filled** (traded into, not through: only the
unfilled part is still a gap; `m3` `liquidity.partlyFilledFvgs` give it
as `low`-`high`, the whole gap as `gapLow`-`gapHigh`), or **filled**
(traded through: no longer a gap). Price inside a gap is never "at an
open FVG".

**What the code gives** (`m3.liquidity.openFvgs`,
`m3.liquidity.partlyFilledFvgs`): the gaps of the last 60 bars of the
briefing's own timeframe, the last 3 of each kind, oldest first, each with
its `side`, `low`, `high` and `at` (the middle bar's open). A filled gap is
in neither list. Never mark one by eye.

**A gap ahead of a setup**: its unfilled part beyond `m3.price` in the
setup's direction (above for a long, below for a short). The briefing does
not rank gaps among the levels in a setup's way (`candidate.inTheWay`,
`candidate.ahead`): measure the near edge yourself, in points and in the
setup's own R (the distance over `candidate.stopPoints`), and report it as
a fact. The room step stays the priority order's, on `inTheWay`.

**The read**: a gap that held on its retest (partly filled, then closes
away from it) is a reaction at a level (`levels-and-reactions`); a gap
ahead is where a move may stall; a gap filled since is no level.

**Evidence**: not measured. The census has no FVG series
(docs/research/mtf-setup-catalog.md): the hypotheses above are untested.

## Examples

```text
Take: bullish gap partly filled, unfilled 21512.00-21515.25 below, closes back above it: held.
  vwap_reclaim long at 21520.50; no gap ahead; candidate.inTheWay at 2.4R. Priority order: room -> take.
Skip: cisd_ote short at 21481.25, stopPoints 8.00; bullish open gap 21474.00-21477.50 below,
  near edge 3.75 pts = 0.47R; candidate.inTheWay prior VAL at 0.6R. Priority order (step 3, room): skip.
Loser: orb long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ); bearish open gap
  21509.50-21513.00 ahead, near edge 6.25 pts = 1.47R, reported; price stalled in it and fell: -17 ticks, -$8.50.
```
