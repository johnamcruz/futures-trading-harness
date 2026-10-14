---
name: trend-vs-range
description: Read whether a timeframe trends, ranges or is in transition - from its swings and latest break, the computed regime (the rule regime.js applies) and the higher-timeframe reads. A read for trader-process step 1, never a veto. Use when classifying the market before any setup.
---

# Trend vs Range

## When to Use

- Trader-process step 1 (HTF), and the regime in step 2.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are the
code's or hypotheses; a missing field is `unknown`.

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

`m3.vwap` counts each VWAP's crosses, labeled: `sessionCrossesLast30` is
the regime's count; `rthCrossesLast30`, the RTH VWAP's, can differ from it.

**Structure.** Swing pattern (`HH/HL`, `LH/LL`, `mixed`, or `unclear`:
fewer than two confirmed swings, no vote):
`m15.frame.swingPattern`, `h1.h1.swingPattern`, `h1.h4.swingPattern`; on
3m, from `m3.liquidity.swingHighs` and `m3.liquidity.swingLows`. Latest
break (`bos-vs-choch`): `m3.lastBreak.last` (`kind` BOS or CHoCH, `direction`, `barsAgo`),
`m3.lastBreak.previous`, `m15.lastBreak`, `h1.lastBreak`.

**The read**, per timeframe:

- trend: regime `trend-up`/`trend-down`, swings HH/HL (LH/LL), the breaks
  a sequence of BOS that way;
- range: regime `range`, swings `mixed`, alternating breaks (the last two
  opposite CHoCHs) or none;
- transition: regime `transition`, or regime and structure disagree.

The 3m read sits inside `h1.h4.trend`, `h1.h1.trend`, `m15.frame.trend`;
`m3.trendRule` wins where they differ. Indicators (EMAs, ADX) confirm the
structure read, never override it (`momentum-and-volume`). A 3m range inside a 15m trend is a
pause (`pullback-vs-reversal`), not a range day.

## Examples

```text
Take: 4h, 1h, 15m up; m3 trend-up (adx 24.10, crosses 1); BOS up 2 bars ago. Read: trend.
  orb long fired. Priority order: aligned, room -> take.
Skip: m3 transition (adx 19.20); CHoCH down, previous CHoCH up; 15m up. Read: transition.
  vwap_reclaim long; the priority order (step 4, mixed) decided skip.
Loser: read trend; orb long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ);
  CHoCH down, stopped: -17 ticks, -$8.50. A right read gives odds, not a promise.
```
