---
name: htf-to-ltf
description: Use when tying higher timeframes to the entry - top down from the HTF level to the 15m setup, 3m trigger, stop and target; alignment labels.
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

From the highest timeframe down, for each side:

| Label | Means | What to do |
|---|---|---|
| `aligned` | no timeframe against it, most with it | Step 4 of the priority order (strategy-library) sets the size; with room to its trail activation and confluence it is the opportunity (the briefing's candidate `facts` show both) |
| `pullback` | every timeframe above the lowest is with it; the lowest is against it | The setup timeframe is pulling back. Wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then step 4 of the priority order (strategy-library) sets the size. Do not enter while it is still moving against you |
| `mixed` | timeframes disagree without a clear pullback | Step 4 of the priority order (strategy-library) sets the size. Target the nearest opposing level; skip in a quiet session |
| `counter` | the highest timeframe is against it | Step 4 of the priority order (strategy-library); a reversal at a higher-timeframe level is its step 2, and the plan says why |

A policy strategy's verdict is a ceiling: the read halves or skips it like
any setup (the priority order, strategy-library).

Reversal strategies (`crt_1h`, `crt_4h`, `ofi_absorption`,
`value_area_reentry`) trade
against the lower timeframes by design, and the trend rule lets them fade
the prevailing trend. Judge the setup against the timeframe above its range
candle (for `crt_1h`, the 4-hour trend; for `crt_4h`, the daily): against
that one too, it is a `counter` reversal (the priority order, step 2, decides it: level,
size, target).

### 2. Levels flow down

Take levels from the higher timeframes and treat them as targets on the
trigger timeframe, or as reasons to skip a setup that runs straight into
one. Where each frame's levels are: the `timeframe-sources` skill.
Each timeframe's last completed candle and the levels it met, and the next
swing each side: the `candle-reading` skill.

### 3. Top down to the entry

Completed candles; the strategy and the gate decide entries.

1. **HTF: side and level.** Today's bias (`daily-bias`) and the level
   price comes into (`levels-and-reactions`).
2. **15m: the setup there.** `mtf-rejection`, `mtf-breakout`, `cisd`,
   `pullback-vs-reversal`, `bos-vs-choch`.
3. **3m/5m: the trigger.** A close its way, with momentum
   (`candle-reading`, `momentum-and-volume`).
4. **Stop: beyond the reaction.** The LTF structure past it (`invalidation`).
5. **Target: the next HTF swing.** `m3.swingTargets`; `candidate.inTheWay`
   is the first level in the way.

Disagreeing: the table labels it; the HTF gives the side, the LTF the timing.

## Examples

```text
1h UP, 15m DOWN, 3m CHoCH up at 21600.25: long pullback, the trigger turned back -> step 4 sizes it.
Target the 1h swing high 21652.75: 52.50 points (210 ticks, $105.00 per MNQ).
```

NQ, back-adjusted CSV prices:

```text
2022-06-22: bias up; 15m 12:45 rejects prior POC 14942.75, 3m 13:03 closes top third:
long 14960.00, stop 14938.50 under the 15m low (21.50 pts = 86 ticks, $43.00 per MNQ);
target 15m swing high 15040.25 (80.25 pts, 3.73R), hit 14:15.
```
