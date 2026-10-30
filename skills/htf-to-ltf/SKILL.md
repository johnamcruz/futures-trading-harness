---
name: htf-to-ltf
description: Use when timeframes disagree - alignment labels, the side rule (never counter), HTF levels.
---

# HTF to LTF

The bias (4h + 1h) sets the side, the setup (15m) is the entry, the entry
timing (3m) only times it (each frame's trend: `multi-timeframe-analysis`).

## When to Use

- Whenever the trigger timeframe and a higher timeframe disagree.

## How It Works

The alignment and the trend rule are the briefing's; a daily read
(premarket's) is context only, never a second alignment.

### 1. Read the alignment

From the highest timeframe down, for each side (`m15.alignment`; read
`read <side> <label>`):

| Label | Means | What to do |
|---|---|---|
| `aligned` | no timeframe against it, most with it | Priority step 4 (strategy-library); with the count for it, the opportunity |
| `pullback` | every timeframe above the lowest is with it; the lowest is against it | The 15m is pulling back: neutral in the count. The setup (15m) the bias's way ends it |
| `mixed` | timeframes disagree without a clear pullback | Priority step 4; a quiet session is a read against |
| `counter` | the highest timeframe is against it | No entry: never counter |

**The side rule** (in an attempt): each trending 4h or 1h your way,
neither against; both ranging: the 15m and `Trend declared?` your way;
else no trade. A CHoCH against the bias is context, never a way in.
The setup is the 15m (or higher) reaction or break the
bias's way (its candle's strength and close: `candle-reading`): it
is the entry; the 3m only times the entry: the next
3m close after it, no 3m turn to wait for (waiting cost R).
Not in a prop attempt: the trend rule alone (both ranging, the 15m's
side; no trend anywhere, both sides).

### 2. Levels flow down

Levels come from the 1h and higher, the session and day (prior RTH, IB,
overnight), the VWAP and the 15m swings; never the 3m (its swings are for
the stop only). A setup that runs straight into one: a read against. The
trail exits (`take-profit`). Where each frame's levels are: the
`timeframe-sources` skill. Each timeframe's last completed candle and the
levels it met: the `candle-reading` skill. Top down: `top-down-entry`.

## Examples

```text
4h UP, 1h UP, 15m DOWN: long pullback. The 15m rejected the prior VAH up at 21600.25:
the setup; enter on the next 3m close; target trail (the 2R mark that arms the trail, not the exit).
4h UP, 1h DOWN: no side, no entry. 4h and 1h RANGE, 15m DOWN, declared short: short only.
```
