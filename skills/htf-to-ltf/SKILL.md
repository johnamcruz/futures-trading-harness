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
| `aligned` | no timeframe against it, most with it | Priority step 4 (strategy-library) sets the size; with room and confluence it is the opportunity |
| `pullback` | every timeframe above the lowest is with it; the lowest is against it | The setup timeframe is pulling back. A rules strategy: wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then priority step 4 |
| `mixed` | timeframes disagree without a clear pullback | Priority step 4 sets the size. Target the nearest opposing level; skip in a quiet session |
| `counter` | the highest timeframe is against it | Priority step 4; a rules reversal at a higher-timeframe level is its step 2, and the plan says why |

**The side rule** (composed, long and short alike): the prevailing HTF
trend sets the side. `pullback` or `mixed` inside it: an entry at the
pullback's end; while the `m3` regime still trends against the side it
hasn't ended: wait for the setup reaction at the level and an entry close
the trend's way (`pullback-vs-reversal`). `counter` (the HTF against): pass
unless the trend rule's CHoCH tier (`trade-lifecycle`) allows it; name the
tier. Range or transition: the trend rule decides.

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
