---
name: day-context
description: Use when deciding a cycle - the premarket plan, the news, and the day so far.
---

# Day Context

## When to Use

- Every decision (`trade-session` step 3).

## How It Works

- **Premarket plan**: start from its bias and levels; say in the plan if
  the day has invalidated it.
- **Blackout** in force: no entries. One soon: enter only with room to work
  before it, or skip.
- **The day so far** ("day:" line, market-snapshot `day`: open vs prior
  day, opening type, initial balance (IB) and extension, day type, average
  daily range (ADR) used). Read it before choosing a setup:
  - Trend day (one side extended two IBs, or one from a narrow IB; often
    after an open outside the prior range and an open-drive): trade with
    it; fade only on a reversal setup at a higher-timeframe level.
  - Normal variation (one side extended, less): move made; often rotates
    back.
  - Open inside prior value, staying inside the IB: balance; fade the
    edges, small targets, stand aside in the middle.
  - Neutral (both sides extended): two-sided.
  - ADR 80%+ used: little room; say so, prefer the nearest target.

## Examples

```text
trend day up, 85% ADR used -> nearest target
```
