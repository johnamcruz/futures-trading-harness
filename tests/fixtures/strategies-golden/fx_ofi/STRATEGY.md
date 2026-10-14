---
name: fx_ofi
description: A test fixture strategy - the rules of the retired ofi strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 1
status: active                # the owner activated it after order flow moved to the broker servers (replay and live)
instruments: [MNQ, MES, MYM, M2K]
timeframe: 1m
signal: rules
rules:                        # field(...): order flow the broker puts on its bars (see Data); none on a bar, no signal
  long:
    - field("flow.ofiTrade") >= 0.3
    - field("flow.windows.3.ofiTrade") >= 0.3
    - field("flow.windows.5.ofiTrade") >= 0.3
    - close > close[1]
    - close > close[3]
    - close >= close[5] + 0.5 * atr(20)
    - vol_sma(5) >= 1.2 * vol_sma(60)
  short:
    - field("flow.ofiTrade") <= -0.3
    - field("flow.windows.3.ofiTrade") <= -0.3
    - field("flow.windows.5.ofiTrade") <= -0.3
    - close < close[1]
    - close < close[3]
    - close + 0.5 * atr(20) <= close[5]
    - vol_sma(5) >= 1.2 * vol_sma(60)
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:1
  min_rr: 2
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture ofi (`setup:fx_ofi`)

A fixture: the rules of the retired `ofi` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_ofi: fires where the retired ofi fired, with the same stop
```
