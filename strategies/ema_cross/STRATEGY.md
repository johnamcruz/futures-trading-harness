---
name: ema_cross
description: 9/20 EMA crossover trend-continuation strategy gated by ADX >= 18 on 3-minute futures bars, ported from algoTraderBot. Use when the fast EMA crosses the slow EMA in a trending regime.
version: 2
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: ema_cross
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: algoTraderBot/strategies/ema_cross.py
---

# Strategy: EMA 9/20 Cross (`setup:ema_cross`)

Source: `algoTraderBot/strategies/ema_cross.py` (EMA_FAST=9, EMA_SLOW=20,
ADX_GATE=18, stop 0.5 × ATR(20)).

## When to Use

- market-snapshot `signals.ema_cross` is `long` or `short`.
- A trend day or a strong session leg (ADX rising).

## How It Works

### Context filter

- ADX(14) ≥ 18 (built into the signal); skip if ADX is falling for 5+ bars.
- The cross agrees with the 15-minute EMA 20 slope and with price vs RTH VWAP.
- EMA 20 slope over the last 5 bars is in the trade direction.

**Trigger:** EMA 9 crosses EMA 20 on a closed 3-minute bar.

**Entry:** market on the close, or a limit at EMA 9 on the next bar if the cross
bar is larger than 1 ATR (don't chase extended bars).

**Stop:** `referenceStop`, or beyond the most recent swing if that's within
1 × ATR(20).

**Targets and management:** 2R, or the next liquidity level. Exit if EMA 9 closes
back across EMA 20 against the trade before 1R.

### Skip when

- EMA 9/20 crossed 3+ times in the last 30 bars (chop).
- Price is more than 2 × ATR(14) from RTH VWAP (stretched).
- Lunch (11:30–13:30 ET) unless ADX > 25.
- Opposing 1h structure level within 1R.

## Examples

```text
10:24 ET 3m: EMA9 21612.4 crosses above EMA20 21611.9, ADX 22.8 (+2.1/5 bars),
15m EMA20 rising, price above RTH VWAP 21590. Entry 21614.00, stop 21608.50,
risk 22 ticks = $11/MNQ, target 21625.00.
rationale: "setup:ema_cross long 9/20 cross ADX 22.8, stop 21608.50, target 21625.00, risk $11"
```
