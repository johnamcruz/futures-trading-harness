---
name: bos
description: Break of structure continuation strategy - a close beyond the last confirmed fractal swing (k=2) on 3-minute futures bars, ported from algoTraderBot. Use when price closes through the latest swing high/low in the direction of the higher-timeframe trend.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:35-15:30@America/New_York"]
regimes: [trend]
signal: bos
risk:
  stop: atr:0.5
  min_rr: 1.5
source: algoTraderBot/strategies/bos.py
---

# Strategy: Break of Structure (`setup:bos`)

Source: `algoTraderBot/strategies/bos.py` (SWING_K=2 confirmed fractals, stop
0.5 × ATR(20)). See market-structure for the BOS vs CHoCH distinction.

## When to Use

- market-snapshot `signals.bos` is `long` or `short`.
- Trend continuation after a pullback.

## How It Works

### Context filter

- The break is in the direction of the 15-minute or 1-hour structure (a true
  BOS, not a CHoCH against the trend).
- ADX(14) ≥ 18 preferred.
- The broken swing is recent (formed within the last ~40 bars).

**Trigger:** a 3-minute close beyond the last confirmed swing high (long) or swing
low (short), with the prior close on the other side.

**Entry:** market on the close; or a limit at the broken level on the first
retest (break-and-retest), cancelled after 5 bars.

**Stop:** `referenceStop`, or beyond the swing that formed the pullback's
extreme (the higher low for longs), if within 1.5 × ATR(20).

**Targets and management:** the next opposing swing or liquidity pool; minimum
1.5R. Breakeven at +1R.

### Skip when

- The break is a single wick-heavy bar that closes barely beyond the level
  (< 2 ticks).
- It breaks into prior-day or overnight high/low within 1R (sweep risk).
- Counter to the 1h trend (that's a CHoCH; use strategy-cisd-ote rules instead).

## Examples

```text
15m uptrend. 3m HL at 21560, last swing high 21588.25 (confirmed 10:12).
10:27 close 21591.50 → BOS long. Entry 21591.50, stop 21585.75, target 21603.00
(1h swing high 21610 is the runner target).
rationale: "setup:bos long close above swing high 21588.25, stop 21585.75, target 21603.00, risk $11.50"
```
