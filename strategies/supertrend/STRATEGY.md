---
name: supertrend
description: SuperTrend(10, 3) direction-flip strategy on 1- or 3-minute futures bars, ported from algoTraderBot. Use when SuperTrend flips and higher-timeframe structure supports the new direction.
version: 3
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: rules
rules:
  long:
    - supertrend_dir crosses_above 0
    - atr(20) > 0
  short:
    - supertrend_dir crosses_below 0
    - atr(20) > 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: algoTraderBot/strategies/supertrend.py
---

# Strategy: SuperTrend Flip (`setup:supertrend`)

Source: `algoTraderBot/strategies/supertrend.py` (ST_PERIOD=10, ST_MULT=3.0,
stop 0.5 × ATR(20)); the only algoTraderBot strategy with a 1-minute model.

## When to Use

- `scan` reports `supertrend` with `candidate: true` and a direction (the `rules` block above).

## How It Works

**Context filter** (harness judgment; the source takes every flip)

- ADX(14) ≥ 18, or rising for 5 bars.
- 15-minute trend in the flip direction (EMA 20 slope or a 15m BOS).
- The flip bar closes beyond the last 3-minute swing in the new direction.

**Trigger:** SuperTrend direction changes on a closed bar.

**Entry:** market on the trigger bar's close, as the source does.

**Stop:** 0.5 × ATR(20) from the fill (the scan's `stopDistance`, rounded to
ticks), as algoTraderBot places it.

**Exit:** no fixed target. Hold the stop until the trade is up 2R; from
then on the runner trails it 0.5R behind the best price (the `exit` block),
after every closed bar. While the runner runs, don't move the stop yourself (interactively, trail it by
the same rule after each bar: the trade-session skill); exit early only with an
`[exit]` order when the plan's invalidation happens.

### Skip when (harness judgment: the source takes every signal)

- 2+ flips in the last 20 bars (chop).
- ADX < 15.
- Against the 1h trend in the lunch session.

## Examples

```text
10:42 ET 3m SuperTrend flips up, line 21598.25. ADX 19.6 rising, 15m BOS up at
10:30. Entry 21607.00, stop 21602.25 (0.5 × ATR20 = 4.75), risk 19 ticks =
$9.50/MNQ. Trail from +2R (21616.50); then the stop sits 0.5R behind the best high.
rationale: "setup:supertrend long flip up, stop 21602.25, risk $9.50"
```
