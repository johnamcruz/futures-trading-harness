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
  (never faded: never counter); a normal
  variation day (one side extended, less) has made its move and often
  rotates back; an open inside the prior value area that stays
  inside the IB is balance (the edges are its levels; the middle
  is a read against); a neutral day (both sides extended) is two-sided. With 80% or
  more of the ADR used, the room left is small: say so (a read against).
- **Day so far line** (code, RTH; is the morning trending, rotating or
  mixed SO FAR): say it in your read ("trending down so far", "rotating
  so far", "mixed so far"). It describes the RTH morning so far (its
  bars since 09:30), never the rest: on 56 recorded days it matched the
  09:30-12:00 day, but its read of the rest of the morning was a coin flip
  (AUC 0.56/0.48/0.52/0.48 at 09:45/10:15/10:45/11:15 on 736 days out of
  sample); rotating mornings trended later about as often as not.
  Cumulative, no recency: 30 trending minutes then two hours of range
  still read `directional`; the candles and `Trend declared?` carry the
  recent bars. The read: efficiency (net move / the
  bars' summed range) x sqrt(bars), one scale all morning:
  - `directional up|down`: 0.75+: one-way so far.
  - `rotational`: under 0.34: back and forth so far (many RTH VWAP
    crosses agree).
  - `mixed`: between: neither yet.
  - `too early (a read from 10 bars)`: no read. Reads on few bars are
    mostly noise: trust the word from about 10:15 ET.
  The day's move is the `Trend declared?` line's; range in ADR
  `today.rangeVsAdr`; the IB day type above.
- **Naming the day** (chop evidence, trend evidence, conflicting, no
  read yet): the band on the score, never the raw efficiency (0.25 on
  40 bars: 1.58, directional): `directional` is trend evidence,
  `rotational` chop evidence. Conflicting: one field reads trend, one
  chop; `mixed`, `too early`, `unknown`, `neither` or none is neutral,
  never a conflict. Nothing either way: no read yet. An unfinished
  with-trend pullback is no chop sign (`trend-vs-range`).
- **RTH volatility** (beside the regime's word): the last 30 min's bar
  range vs the same minutes on prior sessions (`high` 1.33x+, `low`
  0.75x-). The regime's word compares ATR(14) with its last 100 bars,
  mostly overnight early in RTH, so it reads `high` on most mornings.

## Examples

```text
trend day up, 85% ADR used -> little room left: a read against
Day so far: rotational (x sqrt(bars) 0.21), RTH VWAP crosses 12 -> "rotating so far"
Day so far: directional down (x sqrt(bars) 1.55) -> "trending down so far": a description, not a forecast
```
