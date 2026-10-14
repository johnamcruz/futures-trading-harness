---
name: fx_crt_1h
description: A test fixture strategy - the rules of the retired crt_1h strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 2
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["08:00-15:30@America/New_York"]
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:
  long:
    - crt_dir(60) > 0
  short:
    - crt_dir(60) < 0
params:
  crtSweepBars: 10      # the sweep extreme is at most 10 bars (30 minutes) old at the shift
  crtShiftBars: 5       # the shift closes beyond the extreme of the 5 bars before it
  crtMaxDepth: 0.5      # the sweep goes at most half the previous hour's range past it
  crtMinRangeAtr: 3     # the previous hour's range is at least 3 x ATR(20) of 3-minute bars
  crtBufferAtr: 0.25    # the stop sits 0.25 x ATR(20) beyond the sweep extreme
  crtMinRR: 2           # the far side of the range is at least 2R away
risk:
  stop: crt_risk(60)
  min_rr: 2
exit:
  target: crt_target(60)   # the far side of the previous hour's range (the CRT target)
  max_bars: 40             # time stop: 2 hours; the distribution should come within the next candle
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture crt_1h (`setup:fx_crt_1h`)

A fixture: the rules of the retired `crt_1h` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_crt_1h: fires where the retired crt_1h fired, with the same stop
```
