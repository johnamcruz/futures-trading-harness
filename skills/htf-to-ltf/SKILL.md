---
name: htf-to-ltf
description: Use when timeframes disagree - alignment labels, reversals, HTF levels.
---

# HTF to LTF

The higher timeframes set the bias and the levels, the 15m the setup, the
trigger timeframe the entry (each frame's trend: `multi-timeframe-analysis`).

## When to Use

- Whenever the trigger timeframe and a higher timeframe disagree.

## How It Works

The alignment and the trend rule in a trade plan are the briefing's (intraday
frames); a daily read, if you have one (premarket's), is context only, never a
second alignment.

### 1. Read the alignment

From the highest timeframe down, for each side (`m15.alignment`; read
`read <side> <label>`):

| Label | Means | What to do |
|---|---|---|
| `aligned` | no timeframe against it, most with it | Step 4 of the priority order (strategy-library) sets the size; with room to its trail activation and confluence it is the opportunity (the briefing's candidate `facts` show both) |
| `pullback` | every timeframe above the lowest is with it; the lowest is against it | The setup timeframe is pulling back. Wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then step 4 of the priority order (strategy-library) sets the size. Do not enter while it is still moving against you |
| `mixed` | timeframes disagree without a clear pullback | Step 4 of the priority order (strategy-library) sets the size. Target the nearest opposing level; skip in a quiet session |
| `counter` | the highest timeframe is against it | Step 4 of the priority order (strategy-library); a reversal at a higher-timeframe level is its step 2, and the plan says why |

For a composed trade the label is a reason in its plan, never a cut (the
priority order, strategy-library).

A composed entry against the prevailing trend needs a true 15m or 1h CHoCH
its way among its reads (`bos-vs-choch`; the priority order, step 2).

### 2. Levels flow down

Take levels from the higher timeframes and treat them as targets on the
trigger timeframe, or as reasons to skip a setup that runs straight into
one. Where each frame's levels are: the `timeframe-sources` skill.
Each timeframe's last completed candle and the levels it met, and the next
swing each side: the `candle-reading` skill. Top down: `top-down-entry`.

## Examples

```text
1h UP, 15m DOWN, 3m CHoCH up at 21600.25: long pullback, the trigger turned back -> step 4 sizes it.
Target the 1h swing high 21652.75: 52.50 points (210 ticks, $105.00 per MNQ).
```
