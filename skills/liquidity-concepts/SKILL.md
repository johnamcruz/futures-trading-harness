---
name: liquidity-concepts
description: Identify futures liquidity - prior day/overnight highs and lows, equal highs/lows, stop runs and sweeps, fair value gaps, and round numbers - and decide whether a level is a target, a reaction point, or a trap. Use when picking targets, judging breakouts, or explaining a sharp reversal.
---

# Liquidity Concepts

## When to Use

- Choosing targets and judging whether a breakout will hold.
- Explaining a fast move through a level followed by a reversal.

## How It Works

1. **Map resting liquidity** (stops cluster just beyond obvious levels):
   - Prior RTH high/low/close and overnight high/low (market-snapshot `levels`).
   - Equal highs/lows: 2+ swing points within ~2 ticks of each other.
   - Opening range high/low, weekly high/low, round numbers (MNQ: every
     100 points; MES: every 25).
2. **Sweep vs break.**
   - **Sweep:** price trades through the level and closes back inside within
     1–3 bars on the trigger timeframe. Stops were taken; often reverses.
   - **Break:** a candle *closes* beyond the level and the next pullback holds
     it (old resistance becomes support). Continuation.
   - No call until the close. Wicks are information, not signals.
3. **Fair value gap (FVG):** a 3-bar pattern where bar 1's high is below bar 3's
   low (bullish) or bar 1's low is above bar 3's high (bearish). Price often
   revisits the gap; a gap that holds on retest supports continuation.
4. **Use.**
   - Targets: the next untested liquidity pool in the trade's direction.
   - Skip: don't buy just under prior-day high or sell just above
     prior-day low unless the strategy is a breakout of that level.
   - Reversal setups (cisd_ote strategy) need a sweep first; continuation
     setups (bos strategy) need a break.

## Examples

```text
Overnight high 21614.75 and prior-day high 21615.00 (equal highs, one tick
apart). The 09:39 ET 3m bar wicks to 21624.00 and closes 21606.00. → sweep of a double liquidity pool. Long ideas
paused; watch for a bearish CISD / BOS down for a short with stop above 21624.
```
