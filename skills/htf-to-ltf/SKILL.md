---
name: htf-to-ltf
description: Use when timeframes disagree - alignment labels, reversals, HTF levels.
---

# HTF to LTF

Higher timeframes: bias and levels; 15m: setup; trigger timeframe: entry
(trends: `multi-timeframe-analysis`).

## When to Use

- The trigger timeframe and a higher timeframe disagree.

## How It Works

A plan's alignment and trend rule are the briefing's (intraday frames); a
daily read (premarket's) is context, never a second alignment.

### 1. Read the alignment

Highest timeframe down, per side (`m15.alignment`; read
`read <side> <label>`). Priority step N: the priority order's step N (strategy-library).

| Label | Means | Do |
|---|---|---|
| `aligned` | none against, most with | Priority step 4 sizes it; with room to its trail activation and confluence (candidate `facts`): the opportunity |
| `pullback` | all but the lowest with it, the lowest against: the setup timeframe is pulling back | Wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then priority step 4 sizes it. Never enter while it still moves against you |
| `mixed` | disagree, no clear pullback | Priority step 4 sizes it. Target the nearest opposing level; skip in a quiet session |
| `counter` | the highest against it | Priority step 4; a reversal at a higher-timeframe level is priority step 2, and the plan says why |

- Composed trade: the label is a reason in its plan, never a cut.
- A composed entry against the prevailing trend needs `trade-lifecycle`'s
  CHoCH tier (priority step 2).

### 2. Levels flow down

- Higher-timeframe levels: targets on the trigger timeframe, or a reason to
  skip a setup running into one (where: `timeframe-sources`).
- Last completed candle per timeframe, levels it met, next swing each side:
  `candle-reading`. Top down: `top-down-entry`.

## Examples

```text
1h UP, 15m DOWN, 3m CHoCH up at 21600.25: long pullback, the trigger turned back -> priority step 4 sizes it.
Target the 1h swing high 21652.75: 52.50 points (210 ticks, $105.00 per MNQ).
```
