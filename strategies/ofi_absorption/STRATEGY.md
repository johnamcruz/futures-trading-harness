---
name: ofi_absorption
description: Absorption reversal on 1-minute futures bars - heavy selling (buying) over 5 minutes that fails to move price, then a 1-minute bar turns; trade against the absorbed side.
version: 1
status: active                # the owner activated it after order flow moved to the broker servers (replay and live)
instruments: [MNQ, MES, MYM, M2K]
timeframe: 1m
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:                        # field(...): order flow the broker puts on its bars (see Data); none on a bar, no signal
  long:
    - field("flow.windows.5.ofiTrade") <= -0.25
    - vol_sma(5) >= 1.5 * vol_sma(60)
    - close + 0.25 * atr(20) >= close[5]
    - field("flow.ofiTrade") > 0
    - close > close[1]
  short:
    - field("flow.windows.5.ofiTrade") >= 0.25
    - vol_sma(5) >= 1.5 * vol_sma(60)
    - close <= close[5] + 0.25 * atr(20)
    - field("flow.ofiTrade") < 0
    - close < close[1]
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:1
  min_rr: 2
source: harness original (order flow from the broker's 1-minute bars); thresholds are starting values, not yet backtested on 1-minute data
---

# Strategy: Absorption Reversal (`setup:ofi_absorption`)

Real flow is aggressive flow that moves price. Here it doesn't: sellers
hit the market hard for 5 minutes on heavy volume, yet price barely gives
ground, because a passive buyer is taking everything. When the next
1-minute bar turns up, the sellers are trapped.

Order flow is aggressive buy and sell volume per minute, which the broker
MCP server puts on its bars; the harness computes none. The order-flow
imbalance over n bars ("OFI n") is buy minus sell volume over the last n
bars divided by their buy plus sell volume, from -1 (all selling) to +1
(all buying).

**Data.** The rules read the broker's fields with `field(...)`:

| Rule | Broker field | Meaning |
|---|---|---|
| OFI 1 | `field("flow.ofiTrade")` | (buy - sell) / (buy + sell) on this bar |
| OFI 3 | `field("flow.windows.3.ofiTrade")` | the same over the 3 bars ending with this one (the skip rules) |
| OFI 5 | `field("flow.windows.5.ofiTrade")` | the same over the 5 bars ending with this one |

The broker sets a field to null when its minutes are not complete, and a
window is null unless every bar in it is complete. A missing or null field
makes its condition false, so a bar without complete flow never fires: no
estimate stands in for it. The harness's former `ofi(n)` was the same ratio
over the last n bars present, but estimated a bar without recorded flow from
where it closed in its range; live trades only real flow now. Micro bars
carry the full-size contract's flow (MNQ the NQ's), a ratio, so the
thresholds still apply.

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

- OFI 5 ≤ -0.25: sellers dominated the last 5 minutes.
- The close is no more than 0.25 × ATR(20) below the close 5 bars back:
  the selling went nowhere (absorbed).
- The last bar turns: OFI 1 > 0 and the close is above the prior close.

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
- Real flow in the absorbed side's direction in the last 3 bars (OFI 1, 3
  and 5 all at 0.3 or more that way, with the close at least 0.5 × ATR(20)
  past the close 5 bars back): the flow is winning.
- Within 5 minutes of high-impact news.

### Status

Active, for replay and live: the owner activated it after order flow moved
to the broker MCP servers' bars (live from the live server, history from the
replay server's local L1/L2 store). The replay smoke and a fresh replay are
its verification before any live session. A bar without the flow fields
gives no signal.

## Examples

```text
10:42 ET MNQ 1m close 21480.50 at the prior-day low 21478.00.
OFI 5 -0.34 on vol_sma(5) 2,400 vs vol_sma(60) 1,300 (1.85x);
close 5 bars back 21481.75, ATR(20) 7.00 -> gave up 1.25 <= 1.75 (absorbed);
last bar OFI 1 +0.40, close 21480.50 > prior close 21478.75.
Entry 21480.50, stop 21473.50 (1 x ATR = 7.00 = 28 ticks), risk $14/MNQ.
Trail from +2R (21494.50); then the stop sits 3.50 behind the best high.
rationale: "setup:ofi_absorption long sellers absorbed at PDL, ofi5 -0.34, stop 21473.50, risk $14"
```
