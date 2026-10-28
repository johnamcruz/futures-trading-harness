---
name: trend-vs-range
description: Trader-process step 1 and the regime in step 2 - whether each timeframe trends, ranges or is in transition, before any setup. A read, never a veto.
---

# Trend vs Range

## When to Use

- Trader-process step 1 (HTF), and the regime in step 2.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Code holds
the regime only by a policy's entry rule (`entry`). Thresholds are the
code's or hypotheses; a missing field is `unknown`.

Each timeframe's trend is its votes (`multi-timeframe-analysis`; read
`<15m|1h|4h> up|down|range`); ADX is a metric
(`trend-momentum-indicators`). Here: the regime (`regime <name>`) and
structure.

**The computed regime** (`m3.regime.primary`; 15m:
`m15.indicators.regime.primary`), as regime.js decides it:

- `trend-up`: ADX(14) at least 20 (`m3.regime.metrics.adx`), at most 3
  session-VWAP crosses in the last 30 bars (`m3.regime.metrics.sessionVwapCrosses`),
  EMA(20) up at least 0.3 ATR(14) over 5 bars
  (`m3.regime.metrics.ema20SlopeAtr`), the close above EMA(50)
  (`m3.regime.metrics.closeAboveEma50`).
- `trend-down`: the mirror.
- `range`: neither, and ADX under 18 or 5 or more crosses.
- `transition`: everything else.

`m3.vwap.sessionCrossesLast30` is the regime's count (`rthCrossesLast30`
can differ).

**Structure.** Swing patterns (`HH/HL`, `LH/LL`, `mixed`, `unclear`)
and the latest breaks per timeframe: `bos-vs-choch`. A stop belongs
behind structure (a swing), not at an arbitrary distance (`invalidation`).

**The read**, per timeframe:

- trend: regime `trend-up`/`trend-down`, swings HH/HL (LH/LL), the breaks
  a sequence of BOS that way;
- range: regime `range`, swings `mixed`, alternating breaks on that
  timeframe (its last two opposite CHoCHs) or none; a lower-timeframe
  CHoCH back the HTF way inside an HTF trend is the pullback ending
  (`pullback-vs-reversal`), not a range;
- transition: regime `transition`, or regime and structure disagree.

The 3m read sits inside `h1.h4.trend`, `h1.h1.trend`, `m15.frame.trend`;
`m3.trendRule` wins where they differ. Indicators (EMAs, ADX) confirm the
structure read, never override it (`momentum-and-volume`). A 3m range inside a 15m trend is a
pause, not a range day. The side and the pullback: `htf-to-ltf`.

## Examples

```text
Take: 4h, 1h, 15m up; m3 trend-up (adx 24.10, crosses 1); BOS up 2 bars ago. Read: trend.
  Reads: 1h up, 3m bos up. Priority order: aligned; the count for -> take.
Skip: m3 transition (adx 19.20); CHoCH down, previous CHoCH up; 15m up. Read: transition.
  Reads: regime transition, read long mixed; the priority order's rule (contradicting facts) decided skip.
Loser: read trend; long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ);
  CHoCH down, stopped: -17 ticks, -$8.50. A right read gives odds, not a promise.
```
