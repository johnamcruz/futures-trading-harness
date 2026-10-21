---
name: confluence-counting
description: Trader-process step 5 - count six independent categories for, against or neutral, each once, never labels; the count decides take or pass.
---

# Confluence Counting

## When to Use

- Trader-process step 5: `5 Confluence: for <n>, against <n>, neutral <n>: <categories>`.

## How It Works

**The count decides**, on the trend rule's side, the trigger there: the
margin, categories for minus against: 2+ → full size within the
verdict's ceiling; 1 → half (`floor`, at least 1); below 1 → pass. No
against category is a pass alone; the hard steps stay hard.

**Six independent categories**, one vote each, so for + against +
neutral = 6: reads of one price move are one piece of evidence.

| Category | Its reads (compose step) |
|---|---|
| structure | 3m, 5m, 15m BOS, CHoCH (`bos-vs-choch`), CISD; momentum, EMA, ADX, SuperTrend (setup, entry) |
| location | the level, POI or FVG it reacts at (location) |
| liquidity | a sweep taken, or liquidity as the target (setup, target) |
| trigger | the rejection or engulfing candle and its close (setup, entry) |
| participation | volume, delta, absorption; thin is neutral (entry) |
| context | VWAP side, value area, day type, session (location) |

**Rules.**

- **One vote**: all its reads your way → for; all against → against;
  mixed, none or `unknown` → neutral. Labels never add: a 3m BOS, an EMA
  slope and ADX are one structure vote.
- **The pullback is neutral** (`pullback-vs-reversal`): entry-timeframe
  structure against the trend; for once it breaks back; against only when
  a 3m close broke the leg's 15m/1h swing (`m3.htfLevels` `brokenAt`).
- **Not counted**: the trend rule and the 1h and 4h direction (the side
  rule, hard; compose step bias), R:R to the target (hard), the window,
  the news.
- **Context, never a pass alone**: the first level ahead, the VWAP
  distance (no edge in the census), an analyst's read against.

## Examples

```text
Take: long: structure (15m cisd up, 3m momentum up: one), location (at prior vah), trigger
  (15m rejected prior vah up), context (vwap above): for. for 4, against 0, neutral 2 -> full.
Skip: long: structure (3m close broke the 15m swing low), context (vwap below): against.
  for 0, against 2, neutral 4 -> pass.
Half: long: structure (3m choch down: the pullback), neutral; location, trigger: for; context:
  against. for 2, against 1, neutral 3 -> half.
Loser: for 4, against 0, neutral 2; long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ). -111 ticks, -$55.50. A high count is odds, not a promise.
```
