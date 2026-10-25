---
name: invalidation
description: Trader-process steps 7 and 9, and each cycle with a position open - what proves the idea wrong, the stop read, what makes management exit; never a veto.
---

# Invalidation

## When to Use

- Trader-process steps 7 and 9 (PLAN line 9), and each cycle with a
  position open.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). A missing field
is `unknown`.

**The idea's invalidation**, on a close: a pullback long, below the swing
low that made it (`m3.swings.low`, or a swing in `m3.htfLevels`); a
breakout long, back inside the level (`breakout-vs-fakeout`); a reversal
long after a sweep, beyond its extreme (`m3.sweeps[].wick`). Shorts: the
mirror.

**The stop read** (step stop) names that level: `stop <tf> low|high
<price>` (a completed candle's), `stop <tf> swing low|high <price>` (a
confirmed swing, tf optional: `m3.swings`, `m3.liquidity`, `m3.htfLevels`), `stop
<tf> box low|high <price>` (a box's far side: `compression`) or `stop
<level> <price>`. Code places the stop one tick beyond it, at least the
larger of 8 ticks and 0.25 x ATR(20); a closer one is refused, never
widened: name a farther level, or pass. This skill never moves, widens or
replaces it.

**What makes management exit**: the stop, the target or trail, the
end-of-day flatten, and the cases `manage-position` names. A close beyond
the invalidation before the stop goes on line 9 as `invalidation hit`, a
fact, never a reason to change the stop; acting on it is management's
call under trade-session, never a wider stop. Stops move toward the
market only.

**A CHoCH against the trade** (`bos-vs-choch`) weighs by its timeframe
against the trade's own: on the trade's timeframe or higher
(`m3.lastBreak.last` for a 3m trade, `m15.lastBreak.last`,
`h1.lastBreak.last`) it is an invalidation sign for line 9; on a lower
one it is mostly noise.

Line 9: `9 Manage: invalidation <price, what>, exit <target|trail>`.

## Examples

```text
Take: long at 21540.25, invalidation the 15m low 21512.75 (the candle that rejected prior VAH):
  stop 15m low 21512.75 -> stop 21512.50, 111 ticks. 9 Manage: invalidation 21512.75, exit target.
Skip: long at 21540.25, invalidation the 3m low 21538.75: stop 21538.50 is 7 ticks, under the
  8-tick floor; compose_check refuses it, no farther level: priority order (step 1): skip.
Loser: long at 21540.25, stop 21512.50 (27.75 pts = 111 ticks, $55.50 on 1 MNQ); the next bars
  traded through the 15m low and the stop in one move: stopped at 21512.50. -111 ticks, -$55.50.
```
