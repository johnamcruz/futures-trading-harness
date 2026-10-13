---
name: ofi
description: Order-flow imbalance continuation on 1-minute futures bars - enter when buying (or selling) dominates over 1, 3 and 5 minutes and price actually moves with it (real flow, not absorption).
version: 1
status: active                # the owner activated it after order flow moved to the broker servers (replay and live)
instruments: [MNQ, MES, MYM, M2K]
timeframe: 1m
signal: rules
rules:                        # field(...): order flow the broker puts on its bars (see Data); none on a bar, no signal
  long:
    - field("flow.ofiTrade") >= 0.3
    - field("flow.windows.3.ofiTrade") >= 0.3
    - field("flow.windows.5.ofiTrade") >= 0.3
    - close > close[1]
    - close > close[3]
    - close >= close[5] + 0.5 * atr(20)
    - vol_sma(5) >= 1.2 * vol_sma(60)
  short:
    - field("flow.ofiTrade") <= -0.3
    - field("flow.windows.3.ofiTrade") <= -0.3
    - field("flow.windows.5.ofiTrade") <= -0.3
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
source: harness original (order flow from the broker's 1-minute bars); thresholds are starting values, not yet backtested on 1-minute data
---

# Strategy: Order-Flow Imbalance (`setup:ofi`)

Order flow is aggressive buy and sell volume: every trade print classified
as buyer- or seller-initiated and summed per minute. The order-flow
imbalance over n bars ("OFI n" below) is buy minus sell volume over the
last n bars divided by their buy plus sell volume, from -1 (all selling) to
+1 (all buying).

**Data.** The harness computes no order flow. The broker MCP server puts it
on its bars as fields, and the rules read them with `field(...)`:

| Rule | Broker field | Meaning |
|---|---|---|
| OFI 1 | `field("flow.ofiTrade")` | (buy - sell) / (buy + sell) on this bar |
| OFI 3 | `field("flow.windows.3.ofiTrade")` | the same over the 3 bars ending with this one |
| OFI 5 | `field("flow.windows.5.ofiTrade")` | the same over the 5 bars ending with this one |

The broker sets a field to null when its minutes are not complete, and a
window is null unless every bar in it is complete. A missing or null field
makes its condition false, so a bar without order flow never fires: no
estimate stands in for it. The broker serves flow, with the 3- and 5-bar
windows, when its own settings turn it on (`mcp-configs/brokers.json`).

**Against the old `ofi(n)`.** The harness's former `ofi(n)` was the same
ratio, Σ(buy - sell) / Σ(buy + sell) over the last n bars, so with complete
flow the thresholds mean the same. It differed in three ways: a bar without
recorded flow (or whose buy plus sell fell under half its volume) used an
estimate from where it closed in its range, weighted by its volume; it
counted the last n bars present, where the broker's window counts the n bar
spans ending with this bar, so a gap in the bars (a halt, the daily break)
leaves the window incomplete and null; and micro bars carry the full-size
contract's flow (MNQ the NQ's, MES the ES's), a ratio, so the thresholds
still apply. Live now trades only real flow: the estimate is gone.

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

- OFI 1, 3 and 5 are all ≥ 0.3 (buyers dominate at each horizon).
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

### Data

- **Live and replay:** the broker server's bars carry the flow (see Data
  above). With the broker's flow off, or a bar whose minutes are not
  complete, there is no signal.
- **Backtests:** a JSON file of the broker's 1-minute bars (`backtest.js
  fetch --out <file.json>`) keeps the fields; a CSV, or bars the backtester
  builds from shorter ones, has none, so the strategy never fires on it.

### Status

Active, for replay and live: the owner activated it after order flow moved
to the broker MCP servers' bars (live from the live server, history from the
replay server's local L1/L2 store). The replay smoke and a fresh replay are
its verification before any live session. A bar without the flow fields
gives no signal.

## Examples

```text
10:14 ET MNQ 1m close 21512.25. OFI 1/3/5 (flow.ofiTrade, windows 3 and 5): 0.62, 0.48, 0.41;
close > 21508.50 (1 bar back) and > 21505.00 (3 back);
5 bars back 21503.75, ATR(20) 8.00 -> moved 8.50 >= 4.00 (real flow);
vol_sma(5) 1,850 vs vol_sma(60) 1,240 (1.49x).
Entry 21512.25, stop 21504.25 (1 x ATR = 8.00 = 32 ticks), risk $16/MNQ.
Trail from +2R (21528.25); then the stop sits 4.00 behind the best high.
rationale: "setup:ofi long ofi 1/3/5m 0.62/0.48/0.41, +8.50 in 5m, stop 21504.25, risk $16"
```
