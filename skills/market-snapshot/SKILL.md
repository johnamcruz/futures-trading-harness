---
name: market-snapshot
description: Compute indicators, key levels, and the market regime from closed bars with the harness tool market_snapshot (deterministic code) instead of mental math. Use whenever an analysis needs EMA, ATR, ADX, SuperTrend, Keltner, VWAP, the volume profile (POC, value area, volume nodes), swings, opening range, prior-day or overnight levels.
---

# Market Snapshot

LLMs are bad at indicator arithmetic. This skill runs it in code.

## When to Use

- Any time a decision depends on an indicator value or a level.
- Checking whether a strategy's mechanical trigger fired on the last closed bar.
- Getting a reference stop distance (0.5 × ATR(20), the stop the original bot trained on).

## How It Works

In an autonomous cycle the bar briefing (`bar_briefing`, the `harness-tools`
skill) already holds this bar's values: `m3` (EMAs, ADX, SuperTrend, Keltner,
ATR, VWAP, participation, the skip-rule counters in `context`, swings and
liquidity, `lastBreak`, `sweeps`, `htfLevels`, the nearest levels in points
and R), `m15` and `h1` (the higher frames). Use it, and compute only what it
doesn't hold.

1. Get closed bars, oldest first, in a file. Autonomous: the runner's bars
   file (the prompt names it). Otherwise the harness tool `bars_fetch`
   (`{"symbol": "MNQ", "timeframe": 3}`: the runner's default, 5000 bars)
   writes `<FTH_HOME>/bars-scratch/MNQ-3m.json` (the path it returns) and says when its last bar closed (see the
   `harness-tools` skill).
   Don't paste a `get_bars` reply into a file: thousands of bars are far more
   than a tool reply can carry. The default is enough for EMA(200), prior-day
   levels, and the multi-timeframe read up to the 4-hour trend (its EMA50
   vote needs about 4000 3-minute bars). The windowed pieces (cisd_ote,
   the regime) read their own trailing 500 bars, as their source did.
   3-minute bars match the strategy parameters (1-minute for the flow
   strategies).
2. (The file is the broker's `get_bars` JSON; a CSV file works too. The
   tools read only JSON and CSV.)
3. Call the harness tool `market_snapshot` with the file and the contract
   root (`symbol`: the volume profile's levels then come on its tick):

   ```text
   market_snapshot {"bars": "/home/u/.futures-trading-harness/bars-scratch/MNQ-3m.json", "symbol": "MNQ"}
   ```

   Override parameters with `params`, e.g. `{"orbMinutes": 30, "emaSlow": 50}`,
   or the volume profile's: `vpRowSize` 0.25 (one-tick rows on the price grid,
   so levels are tick prices), `vpRows`, `vpValueArea`, `vpLookback`
   (bars in the rolling profile). Use the same settings as the strategy you
   are judging (its `params`).
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
     ATR(14), and the closes crossing each VWAP in the last 30 bars
     (`rthCrossesLast30`, `sessionCrossesLast30`; read the one that applies).
   - `participation`: relative volume of the last bar and the last 3 vs the
     opening-range average, the 20 bars before, and the same time the
     previous trading day (orb's skip rule reads `relVolLastVsOpeningRange`).
   - Both count by trading day (from the 18:00 ET open): from 18:00 ET until
     the new range closes (09:30 ET + orbMinutes; 09:45 by default),
     `levels.openingRange` and the opening-range ratios are null, never the
     closed day's.
   - `volumeProfile`: computed from the bars, never estimate it.
     `priorRth` (the last complete RTH day, the day's reference), `session`
     (this Globex session, developing), `rolling` (the last `vpLookback`
     bars). Each: `poc`, `vah`, `val`, `price` (above, inside, or below
     value), `fromPocAtr` ((price - POC) / ATR(14)), the nearest high and low
     volume nodes (`hvnAbove`, `hvnBelow`, `lvnAbove`, `lvnBelow`), and all of
     them (`hvn`, `lvn`). With `symbol` the levels are on its tick; without
     it they are to two decimals and fall between ticks: round to `tickSize`
     before using one as an order price. Bar-based: say so.
   - `day` (RTH only, else null): the open against the prior RTH day
     (`openVs`: inside the prior value area, outside value inside the range,
     or outside the range), the `gap` from the prior close, the `openType`
     (open-drive, open-test-drive, open-rejection-reverse, open-auction, from
     the first 30 minutes), the initial balance (`ibHigh`, `ibLow`, the first
     hour) and how far the day has gone past it (`extUp`, `extDown`), the
     `dayType` so far (inside the initial balance; normal variation: one side
     extended, under 2 IBs; trend: 2 IBs or more, or 1 from a narrow IB under
     0.35 ADR; neutral: both sides), and the `range` against the average daily range (`adr`, over
     `adrDays`, default 10). `line` is the same as the prompt's "day:" line.
   - `liquidity`: the last 4 swing highs and lows, equal highs/lows (within
     0.1 x ATR), open fair value gaps (`openFvgs`: not traded back into) and
     partly filled ones (`partlyFilledFvgs`: traded into, not through; `low`
     to `high` is the part still unfilled, `gapLow` to `gapHigh` the whole gap).
   - `context`: the numbers the strategies' skip rules name: EMA 9/20
     crosses in the last 30 bars, bars of falling ADX, Keltner width vs its
     20-bar average (a squeeze is under 1), the band-close streak, SuperTrend
     flips in the last 20 bars, the last 5 bars' range in ATR, the session's
     high and low so far, and the last bar's volume vs its 60-bar average
     (`volVsAvg60`). Read a skip rule's number here; never estimate it.
   - `regime`: primary (trend-up, trend-down, range, transition), volatility
     (high, normal, low), tags, and the metrics behind them (ADX, EMA(20) slope
     in ATRs, `sessionVwapCrosses`: closes crossing the session VWAP in the
     last 30 bars, the same count as `vwap.sessionCrossesLast30`; ATR vs its
     average).
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
Fractal swings need strictly higher/lower neighbours, so equal highs are not
swings (treat them as liquidity; see levels-and-reactions).
