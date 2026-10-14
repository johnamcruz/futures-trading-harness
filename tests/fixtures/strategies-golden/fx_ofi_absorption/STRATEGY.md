---
name: fx_ofi_absorption
description: A test fixture strategy - the rules of the retired ofi_absorption strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 1
status: active                # the owner activated it after order flow moved to the broker servers (replay and live)
instruments: [MNQ, MES, MYM, M2K]
timeframe: 1m
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:                        # field(...): order flow the broker puts on its bars (see ofi); none on a bar, no signal
  long:
    - field("flow.windows.5.ofiTrade") <= -0.25
    - vol_sma(5) >= 1.5 * vol_sma(60)
    - close + 0.25 * atr(20) >= close[5]
    - field("flow.ofiTrade") > 0
    - close > close[1]
  short:
    - field("flow.windows.5.ofiTrade") >= 0.25
    - vol_sma(5) >= 1.5 * vol_sma(60)
    - close <= close[5] + 0.25 * atr(20)
    - field("flow.ofiTrade") < 0
    - close < close[1]
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:1
  min_rr: 2
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture ofi_absorption (`setup:fx_ofi_absorption`)

A fixture: the rules of the retired `ofi_absorption` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_ofi_absorption: fires where the retired ofi_absorption fired, with the same stop
```
