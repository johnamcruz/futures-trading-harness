---
name: fx_value_area
description: A test fixture strategy - the rules of the retired value_area strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 1
status: active                # the owner activated it after order flow moved to the broker servers (replay and live)
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["10:00-15:00@America/New_York"]
signal: rules
rules:
  long:
    - minute_et >= 600                    # after the first 30 minutes of RTH
    - minute_et < 900                     # no new entries after 15:00 ET
    - any:                                # the setup at the POC
        - all:                            # rejection: came down from above, tested the POC, closed back up
            - close[1] > prior_poc
            - low <= prior_poc + 0.1 * atr(20)
            - close > prior_poc
            - 2 * close >= high + low     # closed in the upper half of its range
            - any:                        # a fresh rejection: the bar before wasn't one already
                - low[1] > prior_poc + 0.1 * atr(20)
                - 2 * close[1] < high[1] + low[1]
        - all:                            # breakout: a decisive close up through the POC
            - close crosses_above prior_poc
            - close > open
            - close - prior_poc >= 0.25 * atr(20)
    - any:                                # confirmation
        - field("flow.windows.3.ofiTrade") >= 0.2   # order flow from the broker's bars: buyers in control over the last 3 bars
        - all:                            # expansion: a wide bar on heavy volume
            - high - low >= 1.5 * atr(20)
            - volume >= 1.5 * vol_sma(20)
    - prior_vah - close >= 2 * close - 2 * lowest(3) + 0.5 * atr(20)   # the value area high is at least 2R away
  short:
    - minute_et >= 600
    - minute_et < 900
    - any:
        - all:
            - close[1] < prior_poc
            - high >= prior_poc - 0.1 * atr(20)
            - close < prior_poc
            - 2 * close <= high + low
            - any:
                - high[1] < prior_poc - 0.1 * atr(20)
                - 2 * close[1] > high[1] + low[1]
        - all:
            - close crosses_below prior_poc
            - close < open
            - prior_poc - close >= 0.25 * atr(20)
    - any:
        - field("flow.windows.3.ofiTrade") <= -0.2
        - all:
            - high - low >= 1.5 * atr(20)
            - volume >= 1.5 * vol_sma(20)
    - close - prior_val >= 2 * highest(3) - 2 * close + 0.5 * atr(20)
params:                       # this strategy's volume profile, pinned so its backtests reproduce (defaults: PARAM_DEFAULTS in scripts/lib/trading/volume-profile.js)
  vpRows: 100                 # rows over the prior day's range ...
  vpRowSize: 0                # ... or rows of this many points instead (0.25 = one MNQ/MES tick, 1 = four ticks); 0 = use vpRows
  vpValueArea: 70             # % of the volume in the value area
  vpNodePct: 9                # a high volume node beats this % of the rows on each side
  vpTroughPct: 7              # a low volume node is under this % of the rows on each side
  vpThreshold: 1              # ignore rows under this % of the POC's volume
risk:
  stop:
    long: close - lowest(3) + 0.25 * atr(20)     # below the POC test or the breakout's base
    short: highest(3) - close + 0.25 * atr(20)
  min_rr: 2
exit:
  target:
    long: prior_vah - close                       # the edge of value
    short: close - prior_val
  max_bars: 40                                    # time stop: 2 hours
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture value_area (`setup:fx_value_area`)

A fixture: the rules of the retired `value_area` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_value_area: fires where the retired value_area fired, with the same stop
```
