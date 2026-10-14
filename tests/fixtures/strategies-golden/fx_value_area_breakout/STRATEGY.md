---
name: fx_value_area_breakout
description: A test fixture strategy - the rules of the retired value_area_breakout strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["10:00-15:00@America/New_York"]
regimes: [trend, transition]   # harness filter: never in a range (chop)
regime_gate: true             # the order gate refuses an entry outside these regimes too
signal: rules
rules:
  long:
    - minute_et >= 600                  # after the first 30 minutes of RTH
    - minute_et < 900
    - close > prior_vah                 # second close above value...
    - close[1] > prior_vah
    - close[2] <= prior_vah             # ...after a close inside: fires once per acceptance
    - volume > vol_sma(20)              # with participation
  short:
    - minute_et >= 600
    - minute_et < 900
    - close < prior_val
    - close[1] < prior_val
    - close[2] >= prior_val
    - volume > vol_sma(20)
params:                       # this strategy's volume profile, pinned so its backtests reproduce (defaults: PARAM_DEFAULTS in scripts/lib/trading/volume-profile.js)
  vpRows: 100                 # rows over the prior day's range ...
  vpRowSize: 0                # ... or rows of this many points instead (0.25 = one MNQ/MES tick, 1 = four ticks); 0 = use vpRows
  vpValueArea: 70             # % of the volume in the value area
  vpNodePct: 9                # a high volume node beats this % of the rows on each side
  vpTroughPct: 7              # a low volume node is under this % of the rows on each side
  vpThreshold: 1              # ignore rows under this % of the POC's volume
risk:
  stop:
    long: close - prior_vah + 0.5 * atr(20)       # back inside value by half an ATR: the breakout failed
    short: prior_val - close + 0.5 * atr(20)
  min_rr: 2
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture value_area_breakout (`setup:fx_value_area_breakout`)

A fixture: the rules of the retired `value_area_breakout` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_value_area_breakout: fires where the retired value_area_breakout fired, with the same stop
```
