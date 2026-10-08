---
name: ofi
description: Order-flow imbalance continuation on 1-minute futures bars - enter when buying (or selling) dominates over 1, 3 and 5 minutes and price actually moves with it (real flow, not absorption).
version: 1
status: disabled
instruments: [MNQ, MES, MYM, M2K]
timeframe: 1m
signal: rules
rules:
  long:
    - ofi(1) >= 0.3
    - ofi(3) >= 0.3
    - ofi(5) >= 0.3
    - close > close[1]
    - close > close[3]
    - close >= close[5] + 0.5 * atr(20)
    - vol_sma(5) >= 1.2 * vol_sma(60)
  short:
    - ofi(1) <= -0.3
    - ofi(3) <= -0.3
    - ofi(5) <= -0.3
    - close < close[1]
    - close < close[3]
    - close + 0.5 * atr(20) <= close[5]
    - vol_sma(5) >= 1.2 * vol_sma(60)
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:1
  min_rr: 2
source: harness original (order flow from 1-minute bars); thresholds are starting values, not yet backtested on 1-minute data
---

# Strategy: Order-Flow Imbalance (`setup:ofi`)

Order flow read from 1-minute bars, no tick feed needed. Each bar's volume
is signed by where it closed in its range: a close at the high counts all
of its volume as buying, a close at the low all as selling. `ofi(n)` is
that signed volume over the last n bars divided by their volume, from -1
(all selling) to +1 (all buying).

**On hold (`status: disabled`).** Real order flow (aggressor buy and sell
volume from TopstepX trade prints) has to come through projectx-mcp, which
doesn't serve it yet. Until it does, `ofi(n)` and `delta(n)` estimate the
flow from each bar's shape and volume (below), and this strategy stays off.
When projectx-mcp's bars carry buy and sell volume, the same rules use it
with no change to this file.

**Real flow vs absorption.** Aggressive buying that is real moves price.
Buying that runs into a passive seller is absorbed: heavy volume, little
progress. This strategy trades only the first. It needs the price change
over 5 minutes to be at least half an ATR in the direction of the flow. The
mirror case, flow that fails to move price, is `ofi_absorption`.

## When to Use

- 1-minute bars with real volume (the runner's `timeframe: 1`, or 1-minute
  backtest data with a volume column).
- Liquid hours, when volume carries information: the runner's sessions.
- `scan` reports `ofi` with `candidate: true` and a direction.

## How It Works

### Context filter

- Volume is awake: the last 5 bars average at least 1.2× the last 60 bars.
- The imbalance agrees across horizons: 1, 3 and 5 minutes.

### Trigger

Long, on a 1-minute close (short is the mirror):

- `ofi(1)`, `ofi(3)` and `ofi(5)` are all ≥ 0.3 (buyers dominate at
  each horizon).
- The close is above the closes 1 and 3 bars back (price follows the flow
  at each horizon).
- The close is at least 0.5 × ATR(20) above the close 5 bars back (the flow
  moved price: real, not absorbed).
- `vol_sma(5) ≥ 1.2 × vol_sma(60)`.

### Entry, stop, targets

- **Entry:** market on the trigger bar's close.
- **Stop:** 1 × ATR(20) of 1-minute bars from the fill (the scan's
  `stopDistance`, rounded to ticks).
- **Exit:** no fixed target. Hold the stop until +2R; the runner then
  trails it 0.5R behind the best price after every closed bar.

### Skip when (harness judgment)

- The trigger bar is larger than 2.5 × ATR(20): a spike, not flow.
- The 5-minute move already ran into the prior-day or overnight high/low
  (in the trade direction) within 0.5 × ATR.
- The opposite side shows absorption at the level you are trading into:
  `ofi_absorption` fired the other way in the last 5 bars.
- Within 5 minutes of high-impact news.

### Limits of bar-based order flow

Bars carry total volume, not the bid/ask split, so the signed volume is an
estimate from the bar's shape. It tracks real delta well on liquid index
futures at 1 minute, less so in thin trading. Keep this in `paper` until the
scorecard and a 1-minute backtest support it.

## Examples

```text
10:14 ET MNQ 1m close 21512.25. ofi(1) 0.62, ofi(3) 0.48, ofi(5) 0.41;
close > 21508.50 (1 bar back) and > 21505.00 (3 back);
5 bars back 21503.75, ATR(20) 8.00 -> moved 8.50 >= 4.00 (real flow);
vol_sma(5) 1,850 vs vol_sma(60) 1,240 (1.49x).
Entry 21512.25, stop 21504.25 (1 x ATR = 8.00 = 32 ticks), risk $16/MNQ.
Trail from +2R (21528.25); then the stop sits 4.00 behind the best high.
rationale: "setup:ofi long ofi 1/3/5m 0.62/0.48/0.41, +8.50 in 5m, stop 21504.25, risk $16"
```
