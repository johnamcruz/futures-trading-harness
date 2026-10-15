---
name: bos-vs-choch
description: Structure breaks as computed - confirmed swings, BOS (continuation), CHoCH (a possible reversal) - and what each means by timeframe, for PLAN steps 1, 4 and 9.
---

# BOS vs CHoCH

## When to Use

- Trader-process steps 1 (HTF), 4 (Setup) and 9 (Manage): whenever a read
  rests on a structure break.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. A missing field
or a null break is `unknown`.

The bar briefing holds the breaks. The latest BOS or CHoCH (`lastBreak`)
is computed there from confirmed swings: never call it by eye.

**Swings.** Confirmed fractal swings (k=2: a pivot with 2 strictly lower
highs or higher lows on each side, confirmed 2 bars later). The same on
3m bars and completed 15m and 1h candles (structure-events.js). Fields:
`m3.swings.high`, `m3.swings.low`, `m3.htfLevels` (15m and 1h swings),
`m15.frame.swingPattern`, `h1.h1.swingPattern`.

**Breaks.** A close strictly beyond the last confirmed swing not yet
broken; each swing breaks once. Only closes count, on completed candles.
A wick through a swing that closes back inside is a sweep, not a break
(the `breakout-vs-fakeout` skill).

- BOS: a close beyond the last swing in the trend's direction. In the
  code, that is the previous break's direction (the first break too).
- CHoCH: the first close beyond the last swing against it, an early
  warning, not a reversal by itself (the `pullback-vs-reversal` skill).

**Fields**: `m3.lastBreak.last` and `m3.lastBreak.previous`; the same
under `m15.lastBreak` and `h1.lastBreak` (`knownAt`: the candle's close);
a 5m lane's briefing has it in its `bar` part. Each: `kind` (`BOS` or
`CHoCH`), `direction` (`up` or `down`), `level`, `barsAgo` (that
timeframe's candles). The 4h has swings only (`h1.h4.swingPattern`).

**By timeframe.** No one timeframe is the signal; read them top-down.

| Timeframe | BOS | CHoCH |
|---|---|---|
| 3m, 5m | continuation; entry timing | against the HTF: usually a pullback; back with it: the pullback ends |
| 15m | the working structure continues | the working structure shifting: a deeper pullback, or a reversal starting |
| 1h (4h swings) | the HTF trend continues | the strongest sign of an HTF trend change, not a reversal by itself: a BOS the new way confirms it |

A 3-minute BOS against a 1-hour downtrend is a counter-trend trade.
CHoCHs stacking up the timeframes (3m, then 15m, then 1h) are a reversal
developing.

**In the PLAN.**

- **1 HTF**: the 15m and 1h breaks, read in item 1 of
  `confluence-counting`.
- **4 Setup**: continuation, a BOS the HTF way, a pullback to a level, a
  lower-timeframe CHoCH back the HTF way; reversal, CHoCHs stacking up.
- **9 Manage**: a CHoCH against an open trade on its timeframe or higher
  is significant (`invalidation`); lower is mostly noise. The exit stays
  the strategy's.

## Examples

```text
Take: 1h, 15m BOS up; pullback to the RTH VWAP 21520.50; m3 CHoCH up 0 bars ago.
  Reads: 1h bos up, at vwap rth, 3m choch up. Priority order: aligned, room -> take.
Skip: 1h, 15m last BOS up; m3 CHoCH down through 21512.50. Read: a 3m pullback, not a reversal.
  A short: no 1h CHoCH down; the priority order (step 2) decided skip.
Loser: 1h up; m3, then 15m CHoCH down through 21560.00. Read: reversal developing.
  short at 21548.75 (15m choch down), stop 21557.25 (8.50 pts = 34 ticks, $17.00 on 1 MNQ); no 1h CHoCH;
  a 15m CHoCH up through 21562.50: the CHoCH failed, price resumed. -34 ticks, -$17.00.
```
