---
name: invalidation
description: Trader-process steps 7 and 9, and each cycle with a position open - what proves the idea wrong and what makes management exit. Never moves a stop; never a veto.
---

# Invalidation

## When to Use

- Trader-process steps 7 and 9 (PLAN line 9), and each cycle with a
  position open.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. A missing field
is `unknown`.

**The idea's invalidation**, on a close: a pullback long, below the swing
low that made it (`m3.swings.low`, or a swing in `m3.htfLevels`); a
breakout long, back inside the level (`breakout-vs-fakeout`); a reversal
long after a sweep, beyond its extreme (`m3.sweeps[].wick`). Shorts: the
mirror.

**The stop is the strategy's**: `candidate.stopPoints` (its 1R), in ticks
by `order_plan`; a structure stop's level is in its STRATEGY.md. This
skill never moves, widens or replaces it.

**The read**: for a long the stop is entry minus `candidate.stopPoints`.
Invalidation above the stop: consistent. Below it: the stop can be hit
while the idea stands; say so on line 7, a fact, never a reason to change
the stop. `m3.referenceStop.long`, `m3.referenceStop.short` compare.

**What makes management exit**: the stop, the target or trail, the time
stop (`candidate.exit.maxBars`), the end-of-day flatten, and the cases
the trade-session skill names. A close beyond the invalidation before the
stop goes on line 9 as `invalidation hit`; acting on it is management's
call under trade-session, never a wider stop. Stops move toward the
market only.

**A CHoCH against the trade** (`bos-vs-choch`) weighs by its timeframe
against the trade's own: on the trade's timeframe or higher
(`m3.lastBreak.last` for a 3m trade, `m15.lastBreak.last`,
`h1.lastBreak.last`) it is an invalidation sign for line 9; on a lower
one it is mostly noise.

Line 9: `9 Manage: invalidation <price, what>, exit <the strategy's exit>`.

## Examples

```text
Take: orb long at 21503.25, stopPoints 4.25: stop 21499.00; invalidation 3m swing low 21500.50,
  above the stop: consistent. Priority order -> take. 9 Manage: invalidation 21500.50, exit trail.
Skip: crt_1h long; invalidation the sweep wick 21474.00; inTheWay 0.8R.
  Priority order (step 3, room): skip.
Loser: orb long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ); the next bar
  traded through the swing low and the stop in one move: stopped at 21499.00. -17 ticks, -$8.50.
```
