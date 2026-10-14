---
name: fx_orb
description: A test fixture strategy - a close beyond the 15-minute opening range from 09:30 ET with ADX(14) >= 18 on 3-minute bars, the rules of the orb port retired on 2026-10-14, kept for the parity test against the original bot's output and as a session-bound rules strategy. Test use only.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: [ny]          # New York session only (09:30-16:00 ET): the range forms at the 09:30 open
regimes: [trend, transition]   # harness filter: never in a range (chop)
regime_gate: true             # the order gate refuses an entry outside these regimes too
signal: rules
rules:
  long:
    - close crosses_above or_high
    - adx(14) >= 18
    - minute_et >= 588
    - minute_et < 960
    - atr(20) > 0
  short:
    - close crosses_below or_low
    - adx(14) >= 18
    - minute_et >= 588
    - minute_et < 960
    - atr(20) > 0
params:
  orbMinutes: 15
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture Opening Range Breakout (`setup:fx_orb`)

A fixture: the rules of the retired `orb` port (strategies/README.md,
"Retired strategies"), so the opening-range series it reads keep their
parity with the original bot's own output (`tests/lib/parity.test.js`), and
tests have a session-bound, regime-gated rules strategy. Never shipped;
never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The close crosses the 15-minute opening range's high (long) or low (short)
from 09:48 to 16:00 ET with ADX(14) at 18 or more; the stop is 0.5 × ATR(20);
the runner trails from +2R, 0.5R back.

## Examples

```text
fx_orb long: close crosses above the opening range high, ADX 22; stop 0.5 x ATR(20)
```
