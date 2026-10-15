---
name: momentum-and-volume
description: Trader-process steps 3 and 5 - whether a move has push behind it from the trigger bar and the last few bars' range, close and volume. A read, never a veto.
---

# Momentum and Volume

## When to Use

- Grading the trigger bar and the last few bars (trader-process steps 3
  and 5).

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`.

**The bar.** `m3.bar.rangeAtr` = (h - l) / ATR(14); `m3.context.range5Atr`
= the last 5 bars' high-to-low / ATR(14). Close location: the 3m
candle line's `close top|middle|bottom third`.

**Participation** (`m3.participation`):

- `m3.participation.relVolLast3VsPrior20`: the last 3 bars' mean volume
  over the mean of the bars before them (the code takes 21);
- `m3.participation.relVolLastVsOpeningRange`,
  `m3.participation.relVolLast3VsOpeningRange`: over today's opening-range
  bar average (null before it closes, and overnight);
- `m3.participation.relVolVsSameTimePriorDay`: over the same ET minute's
  bar the previous trading day; `m3.participation.lastBarVolume`.

The code's note (under 1.0 thin, 1.5 or more strong) is a hypothesis.

**Indicators confirm; price action at levels is primary.** As data, by
timeframe:

- 3m: `m3.trend.ema20`, `m3.trend.ema50`, `m3.regime.metrics.ema20SlopeAtr`
  (EMA(20) now minus 5 bars ago, over ATR(14)), `m3.trend.adx` (ADX(14),
  Wilder), `m3.trend.adxSlope` (now minus 5 bars ago),
  `m3.context.adxFallingBars`, `m3.trend.supertrend.direction`,
  `m3.trend.keltner.upper`, `m3.trend.keltner.lower`;
- 15m: `m15.indicators.ema20`, `m15.indicators.adx`,
  `m15.indicators.adxSlope`, `m15.indicators.supertrend.direction`;
- 1h: `h1.h1.ema20`, `h1.h1.ema50`, `h1.h1.adx`.

They confirm that a price-action read has momentum behind it (a 15m
rejection with the trend while price holds the right side of a rising
EMA20, ADX rising). ADX has no side. They never trigger an entry and never
override the price-action read. In the count they are one item with the
bar's momentum (`confluence-counting`, item 5): all with its side FOR, all
against AGAINST, mixed neutral.

**The read.** Momentum (this skill owns it; read `<tf> momentum up|down`):
the 3m candle line's `momentum up|down` (any timeframe's line alike):
range ≥ 1 ATR, close in the far third, volume ≥ the mean of up to 20 prior
candles, at least 5. A line showing range and vol but no momentum: none.
Trend (ADX, EMAs) is separate. Fading: ADX falling, ranges shrinking,
closes mid-range. High volume with little range: `absorption`.

**Evidence**: above-average volume on a first close through the IB high
did not save it on Train (F8A, docs/research/mtf-setup-catalog.md).

## Examples

```text
Take: bar H 21510.00 L 21499.75 C 21509.25: close top third; rangeAtr 1.40; vol 1.8x: momentum up.
  Trend: adxSlope +3.2. Reads: 3m momentum up, 3m close top. Priority order: aligned, room -> take.
Skip: close middle third, rangeAtr 0.60, relVolLast3VsPrior20 0.7, adxFallingBars 6. Read: fading,
  no close or momentum read its way; the priority order leaves it to judgement: skip.
Loser: momentum up; long at 21512.50, stop 21508.00 (4.50 pts = 18 ticks, $9.00 on 1 MNQ);
  the next bar reversed on the day's top volume. -18 ticks, -$9.00.
```
