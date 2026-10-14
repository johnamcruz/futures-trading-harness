---
name: fx_cross
description: A test fixture strategy - the 9 EMA crossing the 20 EMA with ADX(14) >= 18 on 3-minute bars, regime-gated to trend and transition. Test use only; it fires with fx_break on the parity bars for the confluence tests.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
regimes: [trend, transition]   # harness filter: never in a range (chop)
regime_gate: true             # the order gate refuses an entry outside these regimes too
signal: rules
rules:
  long:
    - ema(9) crosses_above ema(20)
    - adx(14) >= 18
    - atr(20) > 0
  short:
    - ema(9) crosses_below ema(20)
    - adx(14) >= 18
    - atr(20) > 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: tests/fixtures/strategies-fx (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture Cross (`setup:fx_cross`)

A fixture for the tests that need a second rules strategy firing with
`fx_break` on the same parity bar (2026-04-28T04:09, long). Never shipped;
never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-fx`.

## How It Works

The 9 EMA crosses the 20 EMA with ADX(14) at 18 or more; the stop is
0.5 × ATR(20); the runner trails from +2R, 0.5R back.

## Examples

```text
fx_cross long: EMA 9 crosses above EMA 20, ADX 24; stop 0.5 x ATR(20)
```
