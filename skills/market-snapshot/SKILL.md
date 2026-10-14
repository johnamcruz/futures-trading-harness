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

In an autonomous cycle the bar briefing (`bar_briefing`, the `bar-briefing`
skill) already holds this bar's values: `m3` (EMAs, ADX, SuperTrend, Keltner,
ATR, VWAP, participation, the skip-rule counters in `context`, swings and
liquidity, `lastBreak`, `sweeps`, `htfLevels`, the nearest levels in points
and R), `m15` and `h1` (the higher frames). Use it, and compute only what it
doesn't hold.

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
   - `participation`: `lastBarVolume`; the last bar and the last 3 bars'
     average vs the opening-range average bar (`relVolLastVsOpeningRange`,
     `relVolLast3VsOpeningRange`); the last 3 vs the 20 bars before them
     (`relVolLast3VsPrior20`); and the last bar vs the one bar at the same
     ET time on the previous trading day (`relVolVsSameTimePriorDay`: one
     bar, not an average over sessions). orb's skip rule reads
     `relVolLastVsOpeningRange`.
   - Both count by trading day (from the 18:00 ET open): from 18:00 ET until
     the new range closes (09:30 ET + orbMinutes; 09:45 by default),
     `levels.openingRange` and the opening-range ratios are null, never the
     closed day's.
   - `volumeProfile`: computed from the bars, never estimate it.
     `priorRth` (the last complete RTH day, the day's reference), `session`
     (this Globex session, developing), `rolling` (the last `vpLookback`
     bars). Each: `poc`, `vah`, `val`, `price` (above, inside, or below
     value, from the exact levels: a shown VAH a tick under price can still
     read inside), `fromPocAtr` ((price - POC) / ATR(14)), the nearest high and low
     volume nodes (`hvnAbove`, `hvnBelow`, `lvnAbove`, `lvnBelow`), and all of
     them (`hvn`, `lvn`). On the contract's tick (as in the briefing) for a
     harness bars file or with `symbol`; otherwise to two decimals, between
     ticks: round to `tickSize` before using one as an order price.
     Bar-based: say so.
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
     0.1 x ATR), fair value gaps (3-bar gaps with a strong displacement
     middle bar, the CISD strength rule), open (`openFvgs`: not traded back into) and
     partly filled ones (`partlyFilledFvgs`: traded into, not through; `low`
     to `high` is the part still unfilled, `gapLow` to `gapHigh` the whole gap).
   - `context`: the numbers the strategies' skip rules name: EMA 9/20
     crosses in the last 30 bars, bars of falling ADX, Keltner width vs its
     20-bar average (a squeeze is under 1), the band-close streak, SuperTrend
     flips in the last 20 bars, the last 5 bars' range in ATR, the session's
     high and low so far, and the last bar's volume vs its 60-bar average
     (`volVsAvg60`). Read a skip rule's number here; never estimate it. The
     bar briefing's `m3` `context` has the same counters except
     `volVsAvg60` and `session` (the session high and low reach the
     briefing only as named levels, `session high` and `session low`,
     ranked with the others in `nearestLiquidity` and the candidates'
     `ahead`):
     `volVsAvg60` is in this tool's output only.
     No strategy's skip rule reads it; the strategies whose rules compare
     volume with an average compute it in their own rules (`vol_sma`),
     and the scan reports the result.
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
Fractal swings need strictly higher/lower neighbours (2 bars each side), so
a flat top or bottom (bars side by side at the same high or low) is no swing.
`liquidity.equalHighs`/`equalLows` are pairs of separate confirmed swings
within 0.1 x ATR(14) of each other (see levels-and-reactions); a flat
top shows up in neither.
