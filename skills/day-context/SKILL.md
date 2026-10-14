---
name: day-context
description: Use when deciding a cycle - the premarket plan, the news, and the day so far.
---

# Day Context

## When to Use

- Every decision (`trade-session` step 3).

## How It Works

- **Today's premarket plan and the news** (the prompt's "premarket plan"
  and blackout lines): start from the plan's bias and levels, and say in the
  plan if the day so far has invalidated it. A blackout in force means no
  entries; one coming soon means a trade entered now must have room to work
  before it, or be skipped.
- **The day so far** (the prompt's "day:" line, market-snapshot `day`):
  the open against the prior day, the opening type, the initial balance
  (IB) and how far the day has extended past it, the day type, and how much
  of the average daily range (ADR) is used. Read it before choosing a setup:
  a trend day (one side extended two IBs, or one from a narrow IB), often
  after an open outside the prior range and an open-drive, is traded with it
  (fading needs a reversal setup at a higher-timeframe level); a normal
  variation day (one side extended, less) has made its move and often
  rotates back; an open inside the prior value area that stays
  inside the IB is balance (fade the edges, small targets, stand aside in
  the middle); a neutral day (both sides extended) is two-sided. With 80% or
  more of the ADR used, the room left for a target is small: say so, and
  prefer the nearest target.

## Examples

```text
trend day up, 85% ADR used -> nearest target
```
