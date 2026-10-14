---
name: daily-bias
description: Use when setting the day's bias - the daily read as context, the bias score, the daily and 4h swing levels.
---

# Daily Bias

Whether price is more likely up or down today, from the higher timeframes
(the trend per timeframe: `multi-timeframe-analysis`).

## When to Use

- Premarket: the bias per timeframe and the levels of the day.

## How It Works

### The daily read

Without `daily` the highest timeframe is the 4-hour: the alignment is then
judged from it, and the plan says "no daily read". Fetch the daily bars once
a session (premarket) and reuse the file; if the fetch fails, go on without
them rather than retrying.

### The bias

The `bias` (long, short, or neutral) weights the higher timeframes more
(score out of ±max): use it for the game plan's headline.

### The levels

The prior RTH day's high and low are in the briefing (`timeframe-sources`).
The daily and 4-hour swing highs and
lows are not in it: take them from `mtf_read` (premarket's daily read).

## Examples

```text
Daily UP, 4h UP, 1h UP, 15m DOWN; bias long (score 8 of ±10).
-> Game plan headline: bias long. The daily swing high 21720.50 is the target above,
   69.50 points (278 ticks, $139.00 per MNQ) over 21651.00.
```
