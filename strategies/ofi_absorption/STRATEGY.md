---
name: ofi_absorption
description: Absorption reversal on 1-minute futures bars - heavy selling (buying) over 5 minutes that fails to move price, then a 1-minute bar turns; trade against the absorbed side.
version: 1
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 1m
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
connectors: [order_flow]
rules:
  long:
    - ofi(5) <= -0.25
    - vol_sma(5) >= 1.5 * vol_sma(60)
    - close + 0.25 * atr(20) >= close[5]
    - ofi(1) > 0
    - close > close[1]
  short:
    - ofi(5) >= 0.25
    - vol_sma(5) >= 1.5 * vol_sma(60)
    - close <= close[5] + 0.25 * atr(20)
    - ofi(1) < 0
    - close < close[1]
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:1
  min_rr: 2
source: harness original (order flow from 1-minute bars); thresholds are starting values, not yet backtested on 1-minute data
---

# Strategy: Absorption Reversal (`setup:ofi_absorption`)

The counterpart of `ofi`. There, aggressive flow moves price (real flow).
Here it doesn't: sellers hit the market hard for 5 minutes on heavy volume,
yet price barely gives ground, because a passive buyer is taking
everything. When the next 1-minute bar turns up, the sellers are trapped.

Order flow is real buy and sell volume from the TopstepX market hub's trade
prints, recorded by the runner (see `ofi` for the data). `ofi(n)` runs
from -1 (all selling) to +1 (all buying).

## When to Use

- 1-minute bars with real volume, during the runner's sessions.
- At a level: prior-day high/low, overnight high/low, VWAP, or the session
  extreme. Absorption in the middle of nowhere is just chop.
- `scan` reports `ofi_absorption` with `candidate: true` and a direction.

## How It Works

### Context filter

- Volume spike: the last 5 bars average at least 1.5× the last 60 bars.

### Trigger

Long, on a 1-minute close (short is the mirror):

- `ofi(5) ≤ -0.25`: sellers dominated the last 5 minutes.
- The close is no more than 0.25 × ATR(20) below the close 5 bars back:
  the selling went nowhere (absorbed).
- The last bar turns: `ofi(1) > 0` and the close is above the prior close.

### Entry, stop, targets

- **Entry:** market on the trigger bar's close.
- **Stop:** 1 × ATR(20) of 1-minute bars from the fill. Beyond the absorbed
  low is the invalidation; skip when that low is further than the stop.
- **Exit:** no fixed target. Hold the stop until +2R; the runner then
  trails it 0.5R behind the best price after every closed bar.

### Skip when (harness judgment)

- Not at a level (see When to Use).
- The 5-bar range is wider than 1.5 × ATR(20): that is a fight, not
  absorption.
- `ofi` (real flow) fired in the same direction as the absorbed side in
  the last 3 bars: the flow is winning.
- Within 5 minutes of high-impact news.

## Examples

```text
10:42 ET MNQ 1m close 21480.50 at the prior-day low 21478.00.
ofi(5) -0.34 on vol_sma(5) 2,400 vs vol_sma(60) 1,300 (1.85x);
close 5 bars back 21481.75, ATR(20) 7.00 -> gave up 1.25 <= 1.75 (absorbed);
last bar ofi(1) +0.40, close 21480.50 > prior close 21478.75.
Entry 21480.50, stop 21473.50 (1 x ATR = 7.00 = 28 ticks), risk $14/MNQ.
Trail from +2R (21494.50); then the stop sits 3.50 behind the best high.
rationale: "setup:ofi_absorption long sellers absorbed at PDL, ofi5 -0.34, stop 21473.50, risk $14"
```
