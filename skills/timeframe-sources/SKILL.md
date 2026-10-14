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

The briefing's fields per timeframe and the `mtf_read` calls: the `bar-briefing`
skill (use a current briefing; `mtf_read`, on the files `tool-arguments` names, only for what it lacks).

## Examples

```text
No current briefing, MNQ:
bars_fetch {"symbol": "MNQ", "timeframe": 3, "record": true}   -> MNQ-3m.json (3m, 15m, 1h, 4h)
bars_fetch {"symbol": "MNQ", "timeframe": "daily"}             -> MNQ-1d.json (daily)
Two requests; the 1h range high 21660.25 is h1.range in a briefing, here mtf_read with json.
```
