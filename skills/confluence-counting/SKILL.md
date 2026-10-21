---
name: confluence-counting
description: Trader-process step 5 - a valid setup is the trade; six independent categories, each counted once, set its size by the reads against.
---

# Confluence Counting

## When to Use

- Trader-process step 5: `5 Confluence: for <n>, against <n>, neutral <n>: <categories>`.

## How It Works

**Compose first.** The trend rule's side (or its CHoCH tier), a
rejection or breakout at a key level or FVG, the trigger closed → call
`compose_check`. Never estimate room or R:R: the plan does; its refusal
is the R:R check. Refused → pass, naming it.
OK → **a valid setup is the trade**: full size within the verdict's
ceiling; the against sets the size:

- **Decisive** → pass: a 3m close broke the leg's 15m/1h swing
  (`m3.htfLevels` `brokenAt`: a reversal, `pullback-vs-reversal`).
- **Serious** → half (`floor`, at least 1): 2+ categories against, or
  location against (the trigger into the other side's level).
- **Minor** → full size, never a reason not to compose: thin volume, the
  first level ahead, VWAP distance or "chasing" (no edge in the census),
  no pullback yet, mixed reads.

A missing read is no reason to pass.

**Six independent categories**, one vote each, so for + against +
neutral = 6: reads of one price move are one piece of evidence.

| Category | Its reads |
|---|---|
| structure | 3m, 5m, 15m BOS, CHoCH (`bos-vs-choch`), CISD; momentum, EMA, ADX, SuperTrend |
| location | the level, POI or FVG it reacts at |
| liquidity | a sweep taken, or liquidity as the target |
| trigger | the rejection or engulfing candle and its close |
| participation | volume, delta, absorption; thin is neutral |
| context | VWAP side, value area, day type, session |

**Rules.**

- **One vote**: all its reads your way → for; all against → against;
  mixed, none or `unknown` → neutral. Labels never add: a 3m BOS, an EMA
  slope and ADX are one structure vote.
- **The pullback is neutral** (`pullback-vs-reversal`): entry-timeframe
  structure against the trend; for once it breaks back.
- **Not counted**: the trend rule and the 1h and 4h direction (the side
  rule; compose step bias), R:R, the window, the news.

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
