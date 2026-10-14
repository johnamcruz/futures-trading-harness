---
name: rejection
description: The rejection setup on any timeframe (3m, 5m, 15m, 60m) - at a key level, a completed candle trades through and closes back inside - what it weighs by timeframe, strongest when a lower timeframe confirms a higher one. Today a read that supports or argues against a strategy that fired at the level, never an entry by itself.
---

# Rejection

## When to Use

- A strategy fired at a key level, and the plan asks whether a completed
  candle rejected that level, on any timeframe (trader-process step 4).

## How It Works

**Today it is a read, not a trigger.** The order gate allows an entry
only when a strategy fired on the bar. This setup supports, or argues
against, a strategy that fired at the level (`crt_1h`, `crt_4h`,
`value_area_reentry`, `vwap_reclaim`, `orb`); a dedicated detector strategy
for it is coming. It is never a reason to enter without a fired strategy.

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`. Completed candles only, on 3m,
5m, 15m and 60m (`candle-reading`).

**By timeframe**, the same setup:

| Timeframe | What it reads | Weight |
|---|---|---|
| 3m, 5m | entry timing at an HTF level; alone, a minor level | least |
| 15m | the working structure and the session levels | more |
| 60m | HTF levels (prior day, overnight, CRT) | most |

**Strongest**: a 15m or 60m rejection confirmed on 3m or 5m (step 6),
with the HTF bias (step 1); a lone 3m or 5m one against it is counter-trend.

By PLAN step:

- **1 HTF**: the 60m and 15m bias (`h1.h1.trend`, `m15.frame.trend`) and
   `trend-vs-range`.
- **3 Location**: price at a key level (`levels-and-reactions`; the
   previous candle's high/low, a CRT range; `m3.candles` has them).
- **4 Setup**: a completed candle rejects the level: it trades through and
   closes back inside, with a long wick and the close in the opposite
   third, or an engulfing at the level (`candle-reading`;
   each timeframe's entry of `m3.candles`: `rejected`). After
   an HTF BOS, at the level a pullback reaches (`pullback-vs-reversal`),
   it is a continuation. Against the HTF, whether a structure break went its way
   (`m15.lastBreak.last` or `h1.lastBreak.last` a CHoCH) is read in item 1
   of `confluence-counting`; the priority order decides. A reversal rejection
   reads strongest with an HTF CHoCH its way (`bos-vs-choch`).
- **5 Confluence**: volume or absorption at the level (`momentum-and-volume`,
   `absorption`), counted by `confluence-counting`.
- **6 Entry**: after a 15m or 60m rejection, a completed 3m or 5m candle
   confirms the same way: a displacement candle, or a break of the small
   pullback structure (`m3.lastBreak.last`). Never anticipate it.
- **7 Risk**: the idea is wrong beyond the rejection wick; the stop is the
   strategy's (`candidate.stopPoints`, `order_plan`): check it sits beyond
   the wick (`invalidation`). Aim for the next swing (`m3.swingTargets`); the room to
   the next level (`candidate.inTheWay`, `candidate.ahead`) is step 3's;
   the target and exit stay the strategy's.
- **9 Manage**: invalidation is a close back through the level against the
   trade, or a CHoCH against it on its timeframe or higher (`bos-vs-choch`).

**Paired with `breakout`**: a failed breakout (a close back inside)
is the setup for a rejection the other way.

**Evidence**: not measured as a setup yet; candle patterns alone have weak
evidence in general.

## Examples

```text
Take: at the RTH VWAP 21520.50, 60m and 15m up: on the 15m close a wick to 21517.25, close 21523.00
  (top third); then on the 3m close a displacement up. vwap_reclaim long fired. Priority order -> take.
Skip: at the swing high 21588.25 (3m, a minor level), 60m and 15m up: on the 3m close a shooting star
  (H 21590.75, C 21585.50). ofi_absorption short fired. Priority order (step 2, a fade only at an HTF level): skip.
Loser: at the prior RTH low 21402.00: on the 60m close a rejection (L 21396.75, C 21405.50), on the
  3m close a displacement. crt_1h long at 21407.25, stop 21396.25 (11.00 pts = 44 ticks,
  $22.00 on 1 MNQ); the next 15m closed back below 21402.00. -44 ticks, -$22.00.
```
