---
name: market-snapshot
description: Use without a current bar briefing, for a number it doesn't carry, or a reference stop distance - indicators, levels and the regime from market_snapshot.
---

# Market Snapshot

LLMs are bad at indicator arithmetic. This skill runs it in code.

## When to Use

- The bar briefing says there is no current briefing, or that it is old.
- A number the briefing doesn't carry: another timeframe, a strategy's own
  `params`, `volVsAvg60`, the session's high and low as numbers.
- Getting a reference stop distance (0.5 × ATR(20), the stop the original bot trained on).

## How It Works

1. Get closed bars, oldest first, in a file. Autonomous: the runner's bars
   file (the prompt names it). Otherwise the harness tool `bars_fetch`
   (`{"symbol": "MNQ", "timeframe": 3}`: the runner's default, 5000 bars)
   writes `<FTH_HOME>/bars-scratch/MNQ-3m.json` (the path it returns) and says when its last bar closed (see the
   `bar-briefing` skill).
   Don't paste a `get_bars` reply into a file: thousands of bars are far more
   than a tool reply can carry. The default is enough for EMA(200), prior-day
   levels, and the multi-timeframe read up to the 4-hour trend (its EMA50
   vote needs about 4000 3-minute bars). The regime reads its own trailing
   500 bars, as its source did.
   3-minute bars match the strategy parameters (1-minute for the flow
   strategies).
2. (The file is the broker's `get_bars` JSON; a CSV file works too. The
   tools read only JSON and CSV.)
3. Call the harness tool `market_snapshot` with the file. The volume
   profile's levels come on the contract's tick: the root a harness bars
   file is named for (`MNQ-3m.json`, as the runner and `bars_fetch` name
   them), or `symbol` for a file named otherwise:

   ```text
   market_snapshot {"bars": "/home/u/.futures-trading-harness/bars-scratch/MNQ-3m.json", "symbol": "MNQ"}
   ```

   Override parameters with `params`, e.g. `{"orbMinutes": 30, "emaSlow": 50}`,
   or the volume profile's: `vpRowSize` 0.25 (one-tick rows on the price grid,
   so levels are tick prices), `vpRows`, `vpValueArea`, `vpLookback`
   (bars in the rolling profile). Use the same settings as the strategy you
   are judging (its `params`).
4. Read the JSON: the briefing's values under the snapshot's own keys. What
   each means is in its topic skill:
   - `trend` (`emaFast`, `emaSlow`, `ema50`, `ema200`, `adx`, `adxSlope`,
     `supertrend`, `keltner`), `volatility` (`atr14`, `atr20`), `context`
     and `regime`: `trend-momentum-indicators`; the regime's rule,
     `trend-vs-range`.
   - `participation`: `momentum-and-volume`.
   - `levels` (`priorRth`, `overnight`, `openingRange`, `vwapSession`,
     `vwapRth`), `structure` (the last swing high and low) and `liquidity`:
     `levels-and-reactions`; its gaps, `fair-value-gaps`.
   - `vwap`, `volumeProfile` (`priorRth`, `session`, `rolling`) and `day`
     (RTH only, else null): `vwap-volume-profile`.
   - Only in this tool's output: `context.volVsAvg60` (the last bar's volume
     vs its 60-bar average) and `context.session` (the session's high and
     low so far; the briefing has them only as named levels, `session high`
     and `session low`, ranked with the others in `nearestLiquidity` and the
     candidates' `ahead`). No strategy's skip rule reads `volVsAvg60`; the
     strategies whose rules compare volume with an average compute it in
     their own rules (`vol_sma`), and the scan reports the result.
   - `referenceStop`: distance and long/short stop prices. Round to `tickSize`.
5. Check the last bar's time (`last.t`, UTC): older than one bar of the timeframe
   (plus a minute) at the time you read it means stale data; say so and
   don't plan from it.
6. Never quote a number the snapshot did not produce or a tool did not return.

## Examples

```text
adx 24.1, adxSlope +3.2, regime trend-up
→ trending; strategy triggers come from `strategies_scan` (each STRATEGY.md's rules).

referenceStop.long = 21481.37 → round down to tick 0.25 → 21481.25
```

Timestamps are UTC; sessions and ranges are computed in America/New_York.
