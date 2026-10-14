---
name: mtf-bias-filter
description: Use when filtering a rules strategy by the higher-timeframe trend (mtf_bias in its rules, backtested).
---

# MTF Bias Filter

## When to Use

- Authoring or testing a rules strategy that should trade only with the
  higher timeframe.

## How It Works

### In rules (mechanical strategies)

`mtf_bias(m)` is the multi-timeframe trend per bar in strategy rules (the
`strategy-authoring` skill defines it).
Add it to a strategy's rules
to keep its trades with the higher timeframe, and backtest both versions:

```yaml
rules:
  long:
    - close crosses_above ema(20)
    - mtf_bias(60) > 0          # the 1-hour trend is up
    - mtf_bias(240) >= 0        # and the 4-hour isn't down
```

The ported strategies keep their source's rules (parity); try a filter in a
copy (e.g. `strategies/orb_mtf/`) and compare the two with
`scripts/backtest.js`.

## Examples

```text
orb      long at 21500.25, stop 21490.25 (40 ticks, $20.00 per MNQ), 4h DOWN
orb_mtf  same bar: mtf_bias(240) >= 0 fails -> no trade; compare both with scripts/backtest.js
```
