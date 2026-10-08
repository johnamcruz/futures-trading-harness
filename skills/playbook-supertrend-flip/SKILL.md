---
name: playbook-supertrend-flip
description: SuperTrend(10, 3) direction-flip playbook on 1- or 3-minute futures bars, ported from algoTraderBot. Use when SuperTrend flips and higher-timeframe structure supports the new direction. Journal tag setup:supertrend.
---

# Playbook: SuperTrend Flip (`setup:supertrend`)

Source: `algoTraderBot/strategies/supertrend.py` (ST_PERIOD=10, ST_MULT=3.0,
stop 0.5 × ATR(20)); the only algoTraderBot strategy with a 1-minute model.

## When to Use

- market-snapshot `signals.supertrend` is `long` or `short`.

## How It Works

**Context filter** (the raw signal has no gate, so the filter does the work)

- ADX(14) ≥ 18, or rising for 5 bars.
- 15-minute trend in the flip direction (EMA 20 slope or a 15m BOS).
- The flip bar closes beyond the last 3-minute swing in the new direction.

**Trigger:** SuperTrend direction changes on a closed bar.

**Entry:** market on the close, or a limit at the new SuperTrend line on the
first pullback.

**Stop:** `referenceStop`, or 2 ticks beyond the new SuperTrend line, whichever
is wider (the line is where the flip is invalidated).

**Targets and management:** 2R; trail on the SuperTrend line after 1R. Exit on an
opposite flip.

### Skip when

- 2+ flips in the last 20 bars (chop).
- ADX < 15.
- Against the 1h trend in the lunch session.

## Examples

```text
10:42 ET 3m SuperTrend flips up, line 21598.25. ADX 19.6 rising, 15m BOS up at
10:30. Entry 21607.00, stop 21597.75 (line − 2 ticks; wider than 0.5 × ATR),
risk 37 ticks = $18.50/MNQ, target 21625.50 (2R).
rationale: "setup:supertrend long flip up, stop 21597.75, target 21625.50, risk $18.50"
```
