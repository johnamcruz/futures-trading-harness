---
name: market-snapshot
description: Compute indicators, key levels, and the market regime from projectx-mcp get_bars output with a deterministic script instead of mental math. Use whenever an analysis needs EMA, ATR, ADX, SuperTrend, Keltner, VWAP, swings, opening range, prior-day or overnight levels.
---

# Market Snapshot

LLMs are bad at indicator arithmetic. This skill runs it in code.

## When to Use

- Any time a decision depends on an indicator value or a level.
- Checking whether a strategy's mechanical trigger fired on the last closed bar.
- Getting a reference stop distance (0.5 × ATR(20), the stop algoTraderBot trained on).

## How It Works

1. Get closed bars, oldest first, in a file. Autonomous: the runner's bars
   file (the prompt names it). Otherwise:
   `node <root>/scripts/bars.js --symbol MNQ --timeframe 3 --count 2000`
   writes `/tmp/fth/MNQ-3m.json` and prints when its last bar closed.
   Don't paste a `get_bars` reply into a file: 2000 bars are far more than a
   tool reply can carry. 2000 bars are enough for EMA(200), prior-day levels, and the
   1-hour trend in the multi-timeframe read. The windowed pieces (cisd_ote,
   the regime) read their own trailing 500 bars, as their source did.
   3-minute bars match the strategy parameters (1-minute for the flow
   strategies).
2. (The file is projectx get_bars JSON; CSV and Parquet files work too.)
3. Run the script from the harness root (`<root>`, an absolute path; see the
   `strategy-library` skill for how to find it):

   ```bash
   node <root>/scripts/market-snapshot.js /tmp/fth/MNQ-3m.json
   ```

   Override parameters with flags, e.g. `--orbMinutes=30 --emaSlow=50`.
4. Read the JSON:
   - `trend`: emaFast(9), emaSlow(20), ema50, ema200, adx(14) and its 5-bar slope,
     supertrend(10,3) direction and line, keltner(20, 1.5×ATR20).
   - `volatility`: atr14, atr20.
   - `structure`: last confirmed fractal swing high/low (k=2) and when.
   - `levels`: priorRth high/low/close, overnight high/low, openingRange
     (first 15 min from 09:30 ET, only after it closes), vwapSession (18:00 ET
     anchor), vwapRth (09:30 ET anchor; null before today's 09:30 ET open
     and after 16:00 ET: use vwapSession then, as the strategy filters do).
   - `vwap`: which VWAP applies now (`rth` or `session`), the distance in
     ATR(14), and the RTH and session crosses in the last 30 bars.
   - `participation`: relative volume of the last bar and the last 3 vs the
     opening-range average, the 20 bars before, and the same time the
     previous day (orb's skip rule reads `relVolLastVsOpeningRange`).
   - `liquidity`: the last 4 swing highs and lows, equal highs/lows (within
     0.1 x ATR), and open fair value gaps.
   - `regime`: primary (trend-up, trend-down, range, transition), volatility
     (high, normal, low), tags, and the metrics behind them (ADX, EMA(20) slope
     in ATRs, VWAP crosses in 30 bars, ATR vs its average).
   - `referenceStop`: distance and long/short stop prices. Round to `tickSize`.
5. Check the last bar's time (`last.t`, UTC): older than one bar of the timeframe
   (plus a minute) at the time you read it means stale data; say so and
   don't plan from it.
6. Never quote a number the script did not produce or a tool did not return.

## Examples

```text
adx 24.1, adxSlope +3.2, regime trend-up
→ trending; strategy triggers come from `strategies.js scan` (each STRATEGY.md's rules).

referenceStop.long = 21481.37 → round down to tick 0.25 → 21481.25
```

Timestamps are UTC; sessions and ranges are computed in America/New_York.
Fractal swings need strictly higher/lower neighbours, so equal highs are not
swings (treat them as liquidity; see liquidity-concepts).
