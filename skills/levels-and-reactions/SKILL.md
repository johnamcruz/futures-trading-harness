---
name: levels-and-reactions
description: Which levels matter (prior RTH high, low and close, overnight high and low, opening range, IB, VWAP, value-area edges and POC, swings, round numbers, higher-timeframe swings) with the briefing field for each, and how price reacts at them - rejection, acceptance, sweep. A read for trader-process step 3, never a veto.
---

# Levels and Reactions

## When to Use

- Trader-process step 3: what is near price and how price behaved there.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`.

**Levels**: prior RTH `day.priorRth.high`, `day.priorRth.low`,
`day.priorRth.close`; overnight `m3.overnight.high`, `m3.overnight.low`;
opening range `m3.today.openingRange` (null until formed); IB
`m3.today.ibHigh`, `m3.today.ibLow`; VWAP `m3.vwap.rth`,
`m3.vwap.session` (`m3.vwap.applies`); prior value `day.priorProfile.vah`,
`day.priorProfile.val`, `day.priorProfile.poc`; session value
`m3.sessionProfile.vah`, `m3.sessionProfile.val`, `m3.sessionProfile.poc`;
swings `m3.swings.high`, `m3.swings.low`, 15m and 1h `m3.htfLevels`
(`brokenAt` null: holds), `m3.untested1hSwings`; equal highs and lows
`m3.liquidity.equalHighs`, `m3.liquidity.equalLows` (`taken`); open FVGs
`m3.liquidity.openFvgs` and partly filled ones
`m3.liquidity.partlyFilledFvgs` (the unfilled part); round numbers: `round number` in
`m3.nearestLiquidity` (the multiples of the family's configured step just
above and below price; price on one: its `at`; a refused step: none, the
reason in its `roundNumbers`).

**Which matter now**: the nearest, `m3.nearestLiquidity.above` and
`m3.nearestLiquidity.below` (in points and R); for a setup,
`candidate.inTheWay` and `candidate.ahead` in its own R. Where price sits:
`m3.location.priorValue`, `m3.location.sessionValue`, `m3.vwap.side`.
Hypothesis: levels a few ticks apart act as one zone. Which kind matters
most is not measured: the level families fired too rarely (F4, F7, F8, F9:
docs/research/mtf-setup-catalog.md).

**Reactions**, on closed bars:

- rejection: reaches it, closes back away in the far third, no close
  beyond (`candle-reading`);
- acceptance: closes beyond that hold (`breakout-vs-fakeout`);
- sweep: through and back within 1-3 bars, `m3.sweeps`;
- none yet: not reached. No reaction is not a rejection.

## Examples

```text
Take: m3.vwap.rth 21520.50; lows 21520.75, 21519.50, 21521.00, closes back above. Read: rejection.
  vwap_reclaim long; candidate.inTheWay session VAH at 2.6R. Priority order: room -> take.
Skip: crt_1h short at 21481.25, prior VAL 21480.00 5 ticks below, inTheWay 0.3R.
  Priority order (step 3, room): skip.
Loser: rejection at prior RTH low 21402.00 (wick 21401.25); crt_1h long at 21408.50, stop 21399.75
  (8.75 pts = 35 ticks, $17.50 on 1 MNQ); a close at 21398.00, acceptance below. -35 ticks, -$17.50.
```
