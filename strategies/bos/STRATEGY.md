---
name: bos
description: Break of structure continuation strategy - a close beyond the last confirmed fractal swing (k=2) on 3-minute futures bars, ported from algoTraderBot. Use when price closes through the latest swing high/low in the direction of the higher-timeframe trend.
version: 3
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: rules
rules:
  long:
    - close crosses_above swing_high
    - atr(20) > 0
  short:
    - close crosses_below swing_low
    - atr(20) > 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 1.5
source: algoTraderBot/strategies/bos.py
---

# Strategy: Break of Structure (`setup:bos`)

Source: `algoTraderBot/strategies/bos.py` (SWING_K=2 confirmed fractals, stop
0.5 × ATR(20)). See market-structure for the BOS vs CHoCH distinction.

## When to Use

- `scan` reports `bos` with `candidate: true` and a direction (the `rules` block above).
- Trend continuation after a pullback.

## How It Works

### Context filter (harness judgment)

- The break is in the direction of the 15-minute or 1-hour structure (a true
  BOS, not a CHoCH against the trend).
- ADX(14) ≥ 18 preferred.
- The broken swing is recent (formed within the last ~40 bars).

**Trigger:** a 3-minute close beyond the last confirmed swing high (long) or swing
low (short), with the prior close on the other side.

**Entry:** market on the trigger bar's close, as the source does.

**Stop:** 0.5 × ATR(20) from the fill (the scan's `stopDistance`, rounded to
ticks), as algoTraderBot places it.

**Exit:** no fixed target. Hold the stop until the trade is up 2R; from
then on the runner trails it 0.5R behind the best price (the `exit` block),
after every closed bar. Don't move the stop yourself; exit early only with an
`[exit]` order when the plan's invalidation happens.

### Skip when (harness judgment: the source takes every signal)

- The break is a single wick-heavy bar that closes barely beyond the level
  (< 2 ticks).
- It breaks into prior-day or overnight high/low within 1R (sweep risk).
- Counter to the 1h trend (that's a CHoCH; use strategy-cisd-ote rules instead).

## Examples

```text
15m uptrend. 3m HL at 21560, last swing high 21588.25 (confirmed 10:12).
10:27 close 21591.50 → BOS long. Entry 21591.50, stop 21585.75, risk 23 ticks =
$11.50/MNQ. Trail from +2R (21603.00); then the stop sits 0.5R behind the best high.
rationale: "setup:bos long close above swing high 21588.25, stop 21585.75, risk $11.50"
```
