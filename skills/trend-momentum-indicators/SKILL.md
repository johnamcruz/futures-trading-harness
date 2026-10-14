---
name: trend-momentum-indicators
description: Use when a read rests on ADX, an EMA, SuperTrend, Keltner or ATR - their settings and fields, and the volatility regime for sizing. Metrics, not the trend.
---

# Trend and Momentum Indicators

## When to Use

- A read depends on ADX, an EMA relationship, SuperTrend, Keltner or ATR.
- The volatility regime (high or low) for sizing.

## How It Works

The bar briefing holds these values (`m3` `trend`, `context`, `regime`;
`m15` `indicators`); without one, `market-snapshot`. Never estimate.

| Indicator | Settings | Read |
|---|---|---|
| EMA 9/20 | close, ewm adjust=False | 9 above 20 and both rising → short-term uptrend. Cross = momentum shift. |
| EMA 50/200 | close | Higher-timeframe slope and location filter. |
| ADX(14) | Wilder | Trend strength, a metric with no side: never the trend (the votes) nor the regime. Rising slope matters more than the level. |
| ATR(14/20) | Wilder | Volatility per bar. Stops and targets scale with it. The regime compares ATR(14) with its average over the last 100 bars. |
| SuperTrend(10, 3) | ATR bands | Direction and trailing level. Flips late in chop; useful as a trailing stop in trends. |
| Keltner(20, 1.5) | EMA20 ± 1.5 × ATR20 | Close outside the band with ADX ≥ 20 → expansion. Inside and flat → range. |

Each timeframe's trend is its votes (`multi-timeframe-analysis`); the
regime (trend, range or transition, by the code's rule) is the
`trend-vs-range` skill's; momentum and the participation fields, the
`momentum-and-volume` skill's.

- **Volatility:** the computed regime calls it `high` when ATR(14) ≥ 1.4 ×
  its 100-bar average and `low` at ≤ 0.7 × (`m3.regime.volatility`: use
  it, don't recompute). High → keep the $ risk
  constant: the wider stop means a smaller size; widen stops to structure.
  Low → breakouts fail more; prefer strategies that list it.
- **The regime's metrics** (`m3.regime.metrics`): ADX, EMA(20) slope in
  ATRs, `sessionVwapCrosses`, ATR vs its average (`atrRatio`).
- **VWAP** (`m3.vwap`): which applies (`applies`: `rth` from 09:30 to
  16:00 ET, else `session`), price's `side`, `distanceAtr` (in ATR(14)),
  and the closes crossing each in the last 30 bars (`rthCrossesLast30`,
  `sessionCrossesLast30`: many = rotation, few = trend).
- **Skip-rule counters** (`m3.context`): the numbers the strategies' skip
  rules name: EMA 9/20 crosses in the last 30 bars (`emaCrossesLast30`),
  bars of falling ADX (`adxFallingBars`), Keltner width vs its 20-bar
  average (`keltnerWidthVsAvg20`: a squeeze is under 1), the band-close
  streak (`bandCloseStreak`), SuperTrend flips in the last 20 bars
  (`supertrendFlipsLast20`), the last 5 bars' range in ATR (`range5Atr`).
  Read a skip rule's number here; never estimate it.
- **Skip-rule context**: the levels a skip rule names are `day.priorRth`,
  `m3.overnight` and `m3.today.openingRange` (null until the range
  closes); value is `m3.location` (judged on exact levels, so a VAH shown a
  tick below price can read inside); the day type `m3.today.dayType`.
  Meanings: `levels-and-reactions`, `vwap-volume-profile`, `day-context`.

## Examples

```text
3m: ADX 16.4 falling, EMA 9/20 crossed 3 times in 40 bars: metrics of a weak
trend; the regime itself is `m3.regime.primary` (`trend-vs-range`).

3m: ADX 23 rising (+4 over 5 bars), close above upper Keltner → expansion:
a long's `3m momentum up` read has trend strength behind it (ADX has no
side).
```
