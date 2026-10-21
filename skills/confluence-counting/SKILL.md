---
name: confluence-counting
description: Trader-process step 5 - count six independent categories for, against or neutral, each once, never labels; the count decides take or pass.
---

# Confluence Counting

## When to Use

- Trader-process step 5: `5 Confluence: for <n>, against <n>, neutral <n>: <categories>`.

## How It Works

**The count decides**, on the trend rule's side: count categories, not
labels; for at least against + 2 → take, larger with more categories for,
up to the verdict's ceiling; else pass. No against category is a pass
alone; the hard steps stay hard (strategy-library).

**Six independent categories**, each counted once, so for + against +
neutral = 6. Reads of the same price move are one piece of evidence, not
several labels.

| Category | Its reads (compose step) |
|---|---|
| structure | 3m, 5m, 15m BOS, CHoCH (`bos-vs-choch`), CISD; momentum, EMA, ADX, SuperTrend (setup, entry) |
| location | the level, POI or FVG it reacts at (location) |
| liquidity | a sweep taken, or liquidity as the target (setup, target) |
| trigger | the rejection or engulfing candle and its close (setup, entry) |
| participation | volume, delta, absorption (entry) |
| context | VWAP side, value area, day type, session (location) |

**Rules.**

- **One vote a category**: all its reads your way → for; all against →
  against; mixed, none or `unknown` → neutral.
- **Labels never add**: a 3m BOS, an EMA slope and ADX are one structure
  for; a rejection, its pattern and the same reaction on another
  timeframe are one trigger.
- **Not counted**: the trend rule and the 1h and 4h direction (the side
  rule, hard; the compose step bias), R:R to the target (hard), the
  window, the news (the gate's).
- **Context, never a pass alone**: the first level ahead, the VWAP
  distance (no edge in the census), an analyst's read against.

## Examples

```text
Take: long, trend rule long: structure (15m cisd up, 3m momentum up: one), location (at prior vah),
  trigger (15m rejected prior vah up, hammer: one), context (vwap above): for; liquidity, participation:
  neutral. 5 Confluence: for 4, against 0, neutral 2 -> take.
Skip: long: structure (3m choch down), context (vwap below): against; location, liquidity, trigger,
  participation: neutral. 5 Confluence: for 0, against 2, neutral 4 -> pass.
Loser: for 4, against 0, neutral 2; long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ). -111 ticks, -$55.50. A high count is odds, not a promise.
```
