---
name: vwap_reclaim
description: Trend-day VWAP reclaim on equity index micros - a 3-minute close back through RTH VWAP in the direction of the 50 EMA with ADX confirming. Example of a strategy whose trigger is written as rules in Markdown, no code.
version: 1
status: paper
instruments: [MNQ, MES]
timeframe: 3m
sessions: ["10:00-15:00@America/New_York"]
regimes: [trend]
regime_gate: true
signal: rules
rules:
  long:
    - close crosses_above vwap_rth
    - close > ema(50)
    - adx(14) >= 20
  short:
    - close crosses_below vwap_rth
    - close < ema(50)
    - adx(14) >= 20
filters:
  max_vwap_distance_atr: 1.5
risk:
  stop: atr:1
  min_rr: 2
source: example rules strategy (no backtest yet); keep in paper until reviewed
---

# Strategy: VWAP Reclaim (`setup:vwap_reclaim`)

An example of a fully Markdown-defined mechanical strategy: the `rules` block
above is the trigger, evaluated in code by `strategies.js scan` on every
closed bar. No JavaScript was written for it.

## When to Use

- Trend days after the opening drive (10:00–15:00 ET) when price pulls back to
  RTH VWAP and reclaims it in the direction of the 50 EMA.
- `scan` reports `vwap_reclaim` with `candidate: true` and a direction.

## How It Works

### Context filter

- The rules already require the close on the right side of EMA(50) and
  ADX(14) ≥ 20, and the filter keeps price within 1.5 × ATR(14) of VWAP.
- The 15-minute trend agrees (structure analyst), and there's no opposing
  liquidity pool within 1R.

### Trigger

- A 3-minute bar closes back across RTH VWAP (`crosses_above` for longs,
  `crosses_below` for shorts) with the EMA(50) and ADX conditions true on
  that bar.

### Entry, stop, targets

- Entry at market on the trigger close, or a limit at VWAP on the next bar.
- Stop: 1 × ATR(20) (`risk.stop: atr:1`), widened beyond the pullback's swing
  if that is close by.
- Target: 2R, or the session high/low; breakeven at +1R.

### Skip when

- VWAP has been crossed 4+ times in the last 30 bars (rotation day).
- High-impact news within 15 minutes.
- The trigger bar is larger than 2 × ATR(14).

## Examples

```text
11:12 ET MNQ 3m: previous close 21487.50 below RTH VWAP 21489.10, close 21492.25
above it; EMA(50) 21470.00; ADX 22.4 → scan: vwap_reclaim long, candidate true.
Entry 21492.25, ATR(20) 6.00 → stop 21486.25, risk 24 ticks = $12/MNQ,
target 21504.25 (2R).
rationale: "setup:vwap_reclaim long VWAP reclaim, stop 21486.25, target 21504.25, risk $12"
```
