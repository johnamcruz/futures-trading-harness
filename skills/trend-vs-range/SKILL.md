---
name: trend-vs-range
description: Trader-process steps 1-2 - whether each timeframe trends, ranges or is in transition, and whether the trend has declared itself. A read, never a veto.
---

# Trend vs Range

## When to Use

- Trader-process step 1 (HTF), and the regime in step 2.
- An entry: has the day's trend declared itself your way yet?

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Code holds
the regime only by a policy's `entry` rule. A missing field is `unknown`.

Each timeframe's trend is its votes (`multi-timeframe-analysis`; read
`<15m|1h|4h> up|down|range`).

**The computed regime** (`m3.regime.primary`; 15m:
`m15.indicators.regime.primary`; read `regime <name>`):

- `trend-up`: ADX(14) at least 20 (`m3.regime.metrics.adx`), at most 3
  session-VWAP crosses in the last 30 bars (`m3.vwap.sessionCrossesLast30`),
  EMA(20) up at least 0.3 ATR(14) over 5 bars, the close above EMA(50).
- `trend-down`: the mirror.
- `range`: neither, and ADX under 18 or 5 or more crosses.
- `transition`: everything else.

**Structure**: swings and breaks per timeframe (`bos-vs-choch`). A stop
belongs behind structure (a swing), not at an arbitrary distance (`invalidation`).

**The read**, per timeframe:

- trend: regime `trend-up`/`trend-down`, swings HH/HL (LH/LL), the breaks
  a sequence of BOS that way;
- range: regime `range`, swings `mixed`, alternating breaks on that
  timeframe (its last two opposite CHoCHs) or none; a 15m setup the HTF way
  inside an HTF trend is the pullback ending (`pullback-vs-reversal`), not
  a range;
- transition: regime `transition`, or regime and structure disagree.

The 3m read sits inside `h1.h4.trend`, `h1.h1.trend` (prop: both its
way), `m15.frame.trend`;
`m3.trendRule` wins where they differ. Indicators confirm structure, never
override it. A 3m range inside a 15m trend is a pause. Side: `htf-to-ltf`.

**Declared yet?** (`Trend declared?` line; ATR, + your way; census
hypotheses):

- Declared (any one): regime `with`, overnight range broke out its way,
  RTH VWAP +1 to +2.5, day's move +3 or more.
- Not yet (false starts): RTH VWAP and EMA20 under 0 (EMA20 under -1
  worse), regime `against`, inside the overnight range (back third worst):
  wait for it, in the count; size is the verdict's. An unfinished
  pullback is no chop sign.

## Examples

```text
Take: 4h, 1h, 15m up; m3 trend-up (adx 24.10); overnight broke out its way. Read: trend.
  Reads: 1h up, 15m bos up. Priority order: aligned; the count for -> take.
Skip: m3 transition (adx 19.20); CHoCH down, previous CHoCH up; 15m up. Read: transition.
  Reads: regime transition, read long mixed; the priority order's rule (contradicting facts) decided skip.
Loser: not yet declared (EMA20 -0.4); long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ);
  CHoCH down, stopped: -17 ticks, -$8.50. A right read gives odds, not a promise.
```
