---
name: confluence-counting
description: Trader-process step 5 - a valid setup is the trade; six independent categories, each counted once, set its size by the reads against.
---

# Confluence Counting

## When to Use

- Trader-process step 5: `5 Confluence: for <n>, against <n>, neutral <n>: <categories>`.

## How It Works

**A valid setup is the trade.** Valid: the trend rule's side (or its
CHoCH tier), a rejection or breakout at a key level or FVG, the trigger
closed, the stop at the invalidation, R:R to the real target ≥
`risk.min_rr`, the gate's rules. Valid → take, full size within the
verdict's ceiling; the against sets the size:

- **Decisive** → pass: a 3m close broke the leg's 15m/1h swing
  (`m3.htfLevels` `brokenAt`: a reversal, `pullback-vs-reversal`).
- **Serious** → half (`floor`, at least 1): 2+ categories against, or
  location against (the trigger into the other side's level).
- **Minor** → full size: thin volume, the first level ahead, the VWAP
  distance (no edge in the census), mixed reads, an analyst's read.

A missing read is no reason to pass.

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
  structure against the trend; for once it breaks back.
- **Not counted**: the trend rule and the 1h and 4h direction (the side
  rule, hard; compose step bias), R:R to the target (hard), the window,
  the news.

## Examples

```text
Take: valid long: structure (15m cisd up, 3m momentum up: one), location, trigger, context: for.
  for 4, against 0, neutral 2 -> full.
Skip: long: structure (3m close broke the 15m swing low: a reversal): against.
  for 0, against 1, neutral 5: decisive -> pass.
Half: valid long: structure (the pullback): neutral; context, participation: against.
  for 2, against 2, neutral 2: serious -> half.
Loser: for 4, against 0, neutral 2; long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ). -111 ticks, -$55.50. A high count is odds, not a promise.
```
