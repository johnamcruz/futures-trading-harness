---
name: fx_keltner
description: A test fixture strategy - a close through the Keltner channel (EMA20 +/- 1.5 x ATR20) with ADX(14) >= 20 on 3-minute bars, the rules of a port retired on 2026-10-13, kept only for the parity test against the original bot's output. Test use only.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
regimes: [trend, transition]
regime_gate: true
signal: rules
rules:
  long:
    - close crosses_above keltner_upper
    - adx(14) >= 20
    - atr(20) > 0
  short:
    - close crosses_below keltner_lower
    - adx(14) >= 20
    - atr(20) > 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: tests/fixtures/strategies-fx-parity (test fixture; loaded with FTH_STRATEGIES_DIRS by tests/lib/parity.test.js)
---

# Strategy: Fixture Keltner (`setup:fx_keltner`)

A fixture for `tests/lib/parity.test.js`: the rules of the retired `keltner`
port (strategies/README.md, "Retired strategies"), so the rule series it
reads keep their parity with the original bot's own output. Never shipped;
never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-fx-parity`.

## How It Works

The close crosses the upper (long) or lower (short) Keltner band with ADX(14) at 20 or more; the stop is 0.5 × ATR(20); the runner trails from +2R, 0.5R back.

## Examples

```text
fx_keltner long: close crosses above the upper Keltner band, ADX 24; stop 0.5 x ATR(20)
```
