---
name: fx_value_area_reentry
description: A test fixture strategy - the rules of the retired value_area_reentry strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:30-15:00@America/New_York"]
signal: rules
mtf: reversal                 # trades back into value against the open's move, so it may fade the prevailing trend
rules:
  long:
    - minute_et >= 573                  # from the second RTH bar (09:33 ET)
    - minute_et < 900                   # no new entries after 15:00 ET
    - rth_open < prior_val              # opened below value
    - close > prior_val                 # second close back inside...
    - close[1] > prior_val
    - any:                              # ...completed on this bar: once per acceptance
        - close[2] <= prior_val         # the close before those was outside
        - minute_et <= 573              # or those are the first two bars of the session
    - close < prior_vah
    - prior_vah - close >= 2 * close - 2 * rth_low + 0.5 * atr(20)   # the far side is at least 2R away
  short:
    - minute_et >= 573
    - minute_et < 900
    - rth_open > prior_vah              # opened above value
    - close < prior_vah
    - close[1] < prior_vah
    - any:
        - close[2] >= prior_vah
        - minute_et <= 573
    - close > prior_val
    - close - prior_val >= 2 * rth_high - 2 * close + 0.5 * atr(20)
params:                       # this strategy's volume profile, pinned so its backtests reproduce (defaults: PARAM_DEFAULTS in scripts/lib/trading/volume-profile.js)
  vpRows: 100                 # rows over the prior day's range ...
  vpRowSize: 0                # ... or rows of this many points instead (0.25 = one MNQ/MES tick, 1 = four ticks); 0 = use vpRows
  vpValueArea: 70             # % of the volume in the value area
  vpNodePct: 9                # a high volume node beats this % of the rows on each side
  vpTroughPct: 7              # a low volume node is under this % of the rows on each side
  vpThreshold: 1              # ignore rows under this % of the POC's volume
risk:
  stop:
    long: close - rth_low + 0.25 * atr(20)        # below the whole excursion outside value: today's RTH low
    short: rth_high - close + 0.25 * atr(20)
  min_rr: 2
exit:
  target:
    long: prior_vah - close                        # the far side of the prior day's value area
    short: close - prior_val
  max_bars: 40                                     # time stop: 2 hours
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture value_area_reentry (`setup:fx_value_area_reentry`)

A fixture: the rules of the retired `value_area_reentry` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_value_area_reentry: fires where the retired value_area_reentry fired, with the same stop
```
