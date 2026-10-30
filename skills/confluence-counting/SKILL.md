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
`compose_check`. Never estimate room or R:R: the briefing's "Standard
plan" line states it; OK → compose with its reads, refused → pass,
naming it.
OK → **a valid setup is the trade**: full size within the verdict's
ceiling; the against sets the size:

- **Decisive** → pass: a 1h CHoCH against (the trend rule's tier,
  `trade-lifecycle`; with the 4h and 1h your way, context), or a hard step fails.
- **Serious** → half (`floor`, at least 1): 2+ categories against,
  location against (the trigger into the other side's level), or a 3m
  close beyond the leg's 15m swing (`m3.htfLevels` `brokenAt`). Closed
  back inside, it is a sweep (`breakout-vs-fakeout`): liquidity for.
  In a prop attempt the translated size is full; phase 2 cuts it only on a pacing rule.
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
Skip: long: structure (3m choch down): neutral; the 1h CHoCH down, the 1h ranging.
  for 2, against 0, neutral 4: decisive -> pass.
Half: valid long: structure (the pullback): neutral; context, participation: against.
  for 2, against 2, neutral 2: serious -> half.
Loser: for 4, against 0, neutral 2; long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ). -111 ticks, -$55.50. A high count is odds, not a promise.
```
