---
name: fx_vwap_reclaim
description: A test fixture strategy - the rules of the retired vwap_reclaim strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 1
status: active
instruments: [MNQ, MES]
timeframe: 3m
sessions: ["10:00-15:00@America/New_York"]
regimes: [trend]
regime_gate: true
signal: rules
rules:
  long:
    - close crosses_above vwap_rth
    - close > ema(50)
    - adx(14) >= 20
  short:
    - close crosses_below vwap_rth
    - close < ema(50)
    - adx(14) >= 20
filters:
  max_vwap_distance_atr: 1.5
risk:
  stop: atr:1
  min_rr: 2
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture vwap_reclaim (`setup:fx_vwap_reclaim`)

A fixture: the rules of the retired `vwap_reclaim` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_vwap_reclaim: fires where the retired vwap_reclaim fired, with the same stop
```
