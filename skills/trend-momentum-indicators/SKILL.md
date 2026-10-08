---
name: trend-momentum-indicators
description: Interpret EMA, ADX, ATR, SuperTrend, and Keltner channel readings for futures - trend presence, strength, volatility regime, and when each signal is unreliable. Use when a playbook gates on an indicator or when classifying the regime.
---

# Trend and Momentum Indicators

## When to Use

- A playbook gate depends on ADX, an EMA relationship, SuperTrend, or Keltner.
- Classifying the regime (trend, range, high or low volatility) for sizing and
  playbook choice.

## How It Works

Get every value from market-snapshot. Never estimate.

| Indicator | Settings | Read |
|---|---|---|
| EMA 9/20 | close, ewm adjust=False | 9 above 20 and both rising → short-term uptrend. Cross = momentum shift. |
| EMA 50/200 | close | Higher-timeframe slope and location filter. |
| ADX(14) | Wilder | < 18: no trend, crossover signals whipsaw. 18–25: emerging trend. > 25: trending. Rising slope matters more than the level. ADX is directionless. |
| ATR(14/20) | Wilder | Volatility per bar. Stops and targets scale with it. Compare with its 20-day average for the regime. |
| SuperTrend(10, 3) | ATR bands | Direction and trailing level. Flips late in chop; useful as a trailing stop in trends. |
| Keltner(20, 1.5) | EMA20 ± 1.5 × ATR20 | Close outside the band with ADX ≥ 20 → expansion. Inside and flat → range. |

Regime map:

- **Trend:** ADX > 20 and rising, price on one side of EMA 20, SuperTrend
  stable → breakout and pullback playbooks.
- **Range:** ADX < 18, EMA 9/20 tangled, repeated VWAP crosses → no trend
  playbooks; trade the range edges or stand aside.
- **Volatility expansion:** ATR > 1.5 × its average → halve size (keep the $
  risk constant), widen stops to structure.

## Examples

```text
3m: ADX 16.4 falling, EMA 9/20 crossed 3 times in 40 bars → range. EMA-cross
and Keltner playbooks are gated off (their ADX gate fails anyway).

3m: ADX 23 rising (+4 over 5 bars), close above upper Keltner → keltner
signal "long" is valid; check playbook-keltner-breakout skip rules.
```
