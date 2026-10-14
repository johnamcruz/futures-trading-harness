---
name: fx_break
description: A test fixture strategy - a close beyond the last confirmed fractal swing (k=2) on 3-minute bars, regime-gated to trend and transition. Test use only; it stands in for a generic rules strategy that fires on the parity bars.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
regimes: [trend, transition]   # harness filter: never in a range (chop)
regime_gate: true             # the order gate refuses an entry outside these regimes too
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
source: tests/fixtures/strategies-fx (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture Break (`setup:fx_break`)

A fixture for the tests that need a rules strategy firing on a known bar of
the parity data (tests/fixtures/parity/NQ-3m.csv fires it long on the
2026-04-28T04:09 bar, with `fx_cross`). Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-fx`.

## How It Works

The close crosses the last confirmed fractal swing high (long) or low
(short); the stop is 0.5 × ATR(20); the runner trails from +2R, 0.5R back.

## Examples

```text
fx_break long: close 27427.50 crosses above the swing high; stop 0.5 x ATR(20) = 4.4283 pts = 18 ticks
```
