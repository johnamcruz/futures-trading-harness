---
name: bar-briefing
description: Use when reading this bar's briefing or bars.
---

# Bar Briefing

## When to Use

- Every cycle: this bar's facts; without a briefing, the bars, the reads
  and the news blackouts.

## How It Works

Use the briefing; compute only what it lacks. No current briefing (or it
says old): read the bars yourself; news blackouts: `blackouts_list`.

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `bar_briefing` | `symbol` (a root, or a contract by month), `timeframe`?, `json`? | the runner's briefing for the bar this cycle decides (parts below). Opens with a summary: price and 1R, trend rule, alignment, regime, VWAP, news, room above and below, each timeframe's last completed candle, next swing targets, latest CISD per timeframe, each setup with its facts. Times ET; distances in points and R (1R: a setup's own stop, else the reference stop, 0.5 x ATR(20) of its own bars, named by timeframe: `oneR`) | `briefing.js --symbol MNQ [--timeframe 15m] [--json]` |
| `bars_fetch` | `symbol`, `timeframe` (minutes 1-60, or `"daily"`), `count`?, `record`?, `name`? | writes closed bars to this home's `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json` (`-1d.json` daily; `name`: `<SYMBOL>-<tf>m-<name>.json`); returns the path, the contract, when the last bar closed; `record` also records the multi-timeframe read | `bars.js --symbol MNQ --timeframe 3 [--daily] [--count N] [--record]` |
| `market_snapshot` | `bars`, `params`?, `symbol`? | indicator and level snapshot, one-line JSON (profile levels on `symbol`'s tick, default the bars file's root) | `market-snapshot.js <bars> [--symbol=MNQ] [--name=value]` |
| `mtf_read` | `bars`, `timeframes`?, `daily`?, `json`?, `record`?, `symbol`? | the multi-timeframe read; `record` (with `symbol`) records it. Autonomous cycle, current briefing: the default read points to it (`m15`, `h1` frames and alignment; `m3` `trendRule`); `daily`, other `timeframes` or `json` still read | `mtf.js <bars> [--tf=15,60,240] [--daily=<file>] [--json] [--record --symbol MNQ]` |
| `blackouts_list` | none | the news blackout windows | `blackouts.js list` |

### Parts

Each part has a version and changes only on expiry; reuse it, never
recompute it.

`m3`, every bar:

- price; bar OHLC, range in ATR; ET time
- `windowText`: market open or closed, entries allowed or not, until when (also `windowEntries`, `windowRefusal`, `marketOpen`; the gate's clock)
- `news`: next blackout
- regime (tags, metrics); EMA9/20/50/200, ADX, SuperTrend, Keltner, ATR(14)
- VWAP: which applies, side, distance, crosses; participation
- `context`: skip-rule counters; `referenceStop`
- swings, liquidity (equal highs and lows, taken or not)
- `lastBreak`: BOS or CHoCH, its age
- `sweeps`: key levels first; only levels that existed before
- `htfLevels`: 15m and 1h swings vs price; the last a 3m close broke
- `untested1hSwings`
- `nearestLiquidity`: three nearest levels each side; `at`: the round number price sits on (only then); `roundNumbers`: why none (only if the family's step was refused)
- today so far, overnight range, session profile and nodes, `location`
- `candidates`: each with stop, exit, first level in its way in R, room needed, `facts` (trend rule and MTF read for its side, room, confluence, VWAP side, window); `null`: scan failed or bar not scanned; `blocked`: no-entry window (named, with its end), news blackout, or news unknown
- `trendRule`
- `cisd`: latest CISD per timeframe (3m, 5m, 15m, 1h; completed candles): direction, level, displacement, key-level sweep before it, its leg's OTE zone, status, price in it; a read, not a signal
- `candles`: per timeframe (3m, 5m, 15m, 1h, 4h) the last COMPLETED candle, never the forming one:
  - OHLCV, close time, body and wick shares, close third, range in its ATR, volume vs average
  - pattern: doji, hammer, shooting star, bullish or bearish engulfing, inside, outside, displacement, none
  - levels met: `rejected` (traded through, closed back), `broke` (closed beyond, most of the body beyond), `touched`; fixed levels as at the candle's open (never its own bars' or later ones), moving ones (VWAP, session profile) at its close; incl. round numbers in range (family's step; none without), previous candle, CRT range; at most four, strongest first (`moreLevels`: the rest)
  - not whole base bars (5m from 3m): built from a 1m lane if one runs (the candle ending now only once its last 1m bar is in), else `unavailable` with the reason (off the summary without a 1m lane); never approximated
- `swingTargets`: next swing high above, low below, on base bars, 15m, 1h, 4h; points, ticks, R

`m15`, until the next 15m close:

- `frame`: trend, bias, close, EMA20/50, swing pattern, ADX, ATR, last 20 candles' range and mid
- `alignment`
- `lastBreak`: times are candle opens; `knownAt` is the breaking candle's close
- `indicators`: EMA9/20, regime, ADX, SuperTrend, Keltner

`h1`, until the next 1h close: the 1h and 4h frames, `lastBreak`.

`day`, until the first bar after 16:00 ET: the prior RTH day and its profile.

### `timeframe` (`"15m"`, `"1h"`)

Only when the caller gave one (the runner config puts some analysts on
their own timeframe). That timeframe's briefing:

- `bar`: `m3` facts on its own bars, valid until its next close (the last before the 16:00 ET break: until the first bar after the open); points to the runner's `candles`, `swingTargets`, `cisd` (session levels, one value each)
- 1R and ATR named by its timeframe
- no trend rule: the gate's is the runner's briefing's
- no session facts (today, overnight, VWAP, session profile, `location`): `sessionLevels` points to the runner's, their one value; levels and room from its own bars; a traded lane's add the runner's session levels, its values
- setups only if a lane trades those bars, else in the runner's briefing
- plus the runner's parts that change no faster (`m15` up to 15m, `h1` up to 1h, `day`); names its bars file
- a report on it may be reused until that close: up to one bar old

## Examples

```text
bars_fetch {"symbol": "MNQ", "timeframe": 15, "count": 160}
→ wrote 160 15-minute bars for MNQ (tick 0.25, $0.5/tick) to /home/u/.futures-trading-harness/bars-scratch/MNQ-15m.json; last bar 2026-10-07T13:45:00.000Z, closed 2026-10-07T14:00:00.000Z

market_snapshot {"bars": "/home/u/.futures-trading-harness/bars-scratch/MNQ-15m.json"}
mtf_read {"bars": "/home/u/.futures-trading-harness/bars-scratch/MNQ-3m.json", "daily": "/home/u/.futures-trading-harness/bars-scratch/MNQ-1d.json"}
```
