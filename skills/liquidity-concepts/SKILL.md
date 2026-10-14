---
name: liquidity-concepts
description: Identify futures liquidity - prior day/overnight highs and lows, equal highs/lows, stop runs and sweeps, fair value gaps, and round numbers - and decide whether a level is a target, a reaction point, or a trap. Use when picking targets, judging breakouts, or explaining a sharp reversal.
---

# Liquidity Concepts

## When to Use

- Choosing targets and judging whether a breakout will hold.
- Explaining a fast move through a level followed by a reversal.

## How It Works

In an autonomous cycle the bar briefing (`bar_briefing`, the
`harness-tools` skill) holds this bar's liquidity (`m3` `liquidity`,
`sweeps`, `htfLevels`, `nearestLiquidity`): use it, and compute only what
it doesn't hold. The sweeps are computed there: never call one by eye.

1. **Resting liquidity** (stops cluster just beyond obvious levels): the
   levels and their fields are the `levels-and-reactions` skill's. Equal
   highs/lows: two of the last 12 confirmed swing highs (lows) within 0.1
   × ATR(14) of each other (`taken` once traded through).
2. **Sweep vs break**: the `breakout-vs-fakeout` skill. No call until the
   close; wicks are information, not signals.
3. **Fair value gap (FVG):** a 3-bar pattern where bar 1's high is below bar 3's
   low (bullish) or bar 1's low is above bar 3's high (bearish). Price often
   revisits the gap; a gap that holds on retest supports continuation
   (`m3` `liquidity.openFvgs`). By what price has done since: **open** (not
   traded back into), **partly filled** (traded into, not through: only the
   unfilled part is still a gap; `m3` `liquidity.partlyFilledFvgs` give it
   as `low`-`high`, the whole gap as `gapLow`-`gapHigh`), or **filled**
   (traded through: no longer a gap). Price inside a gap is never "at an
   open FVG".
4. **Use.** Targets: the next untested liquidity pool in the trade's
   direction. Room: the first level in a setup's way (`inTheWay`) is the
   priority order's step 3 (strategy-library). Reversal setups (cisd_ote)
   follow a sweep; continuation setups follow a break.

## Examples

```text
Overnight high 21614.75 and prior-day high 21615.00 (equal highs, one tick
apart). The 09:39 ET 3m bar wicks to 21624.00 and closes 21606.00. → sweep of a double liquidity pool
(m3.sweeps lists it). A short idea is wrong above 21624.00 (the invalidation skill).
```
