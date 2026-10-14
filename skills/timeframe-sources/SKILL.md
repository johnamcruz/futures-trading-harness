---
name: timeframe-sources
description: Use when you need a timeframe's bars or numbers - which file, briefing field or mtf_read call holds it.
---

# Timeframe Sources

Where each timeframe of the multi-timeframe read comes from; how to read it
is the `multi-timeframe-analysis` skill.

## When to Use

- Without a current bar briefing, or for a frame or number it lacks.

## How It Works

### 1. Get the bars (one request per timeframe at most)

`get_bars` allows 50 requests per 30 s across all agents. The higher
intraday timeframes are built from the trigger bars, so you rarely need more
than two requests:

| Role | Timeframe | Source |
|---|---|---|
| Context | daily | `bars_fetch` with `{"symbol": "<SYMBOL>", "timeframe": "daily"}` (60 bars to `<FTH_HOME>/bars-scratch/<SYMBOL>-1d.json`) |
| Context | 4 hours | built from the trigger bars (its EMA50 vote needs 50 candles, about 4000 3m bars; with fewer it votes on two, and the line says so) |
| Bias | 1 hour | built from the trigger bars |
| Setup | 15 minutes | built from the trigger bars |
| Trigger | 3 minutes (1 minute for the flow strategies) | the runner's bars file (at least 2000 bars), or `bars_fetch` with `{"symbol": "<SYMBOL>", "timeframe": 3, "record": true}` (the runner's default, 5000 3-minute bars, to `<FTH_HOME>/bars-scratch/<SYMBOL>-3m.json`, and the read recorded for the gate) |

### 2. Run the read

In an autonomous cycle the bar briefing (`bar_briefing`, the `harness-tools`
skill) already holds this read for the bar: the 15m frame and the alignment
per side (`m15`), the 1h and 4h frames (`h1` `h1` and `h4`), and the trend
rule (`m3` `trendRule`). Each frame there has the trend, bias, swing pattern,
close, EMA20 and EMA50, ADX, ATR and the last 20 candles' range with its mid
(`range`); it leaves out the close's position in that range, the frame's
swing high and low and its previous candle's high and low (the 15m and 1h
swings against price are `m3` `htfLevels`; `mtf_read` with `json` has
the rest). Use it; run `mtf_read` only without a current briefing.

```text
mtf_read {"bars": "<trigger bars>", "daily": "<the daily file bars_fetch returned>"}
mtf_read {"bars": "<trigger bars>", "timeframes": [15, 60, 240], "json": true}    every number
```

`<trigger bars>` is the runner's bars file by absolute path (e.g.
`/home/u/.futures-trading-harness/bars/MNQ-3m.json`; no `~`) or a
`bars_fetch` file (the `harness-tools` skill says which files it reads).

### 3. Levels by timeframe

The briefing shows: the 15m and 1h swing highs and lows against price
(`m3` `htfLevels`), the 1h swings not yet traded back to (`m3`
`untested1hSwings`), each frame's last-20-candle range high, low and mid
(`m15` `frame.range`, `h1` `h1.range` and `h4.range`), and the prior RTH
day's high and low (`day` `priorRth`).

## Examples

```text
No current briefing, MNQ:
bars_fetch {"symbol": "MNQ", "timeframe": 3, "record": true}   -> MNQ-3m.json (3m, 15m, 1h, 4h)
bars_fetch {"symbol": "MNQ", "timeframe": "daily"}             -> MNQ-1d.json (daily)
Two requests; the 1h range high 21660.25 is h1.range in a briefing, here mtf_read with json.
```
