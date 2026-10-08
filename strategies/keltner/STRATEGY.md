---
name: keltner
description: Keltner channel volatility-expansion breakout strategy (EMA20 +/- 1.5 x ATR20, ADX >= 20) on 3-minute futures bars, ported from algoTraderBot. Use when a bar closes outside the Keltner channel in a trending regime.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:35-15:30@America/New_York"]
signal: keltner
filters:
  adx_min: 20
risk:
  stop: atr:0.5
  min_rr: 2
source: algoTraderBot/strategies/keltner.py
---

# Strategy: Keltner Breakout (`setup:keltner`)

Source: `algoTraderBot/strategies/keltner.py` (KC_LEN=20, KC_MULT=1.5,
KC_ATR_P=20, KC_ADX_THRESH=20, stop 0.5 × ATR(20)).

## When to Use

- market-snapshot `signals.keltner` is `long` or `short`.
- A volatility expansion out of a quiet period.

## How It Works

### Context filter

- ADX(14) ≥ 20 (built into the signal).
- Keltner mid (EMA 20) sloping in the trade direction over 5 bars.
- Better after a squeeze: the channel width over the prior 20 bars was below
  its average.

**Trigger:** a 3-minute close above the upper band (long) or below the lower band
(short), with the prior close inside.

**Entry:** market on the close.

**Stop:** `referenceStop`; or the Keltner mid if it's closer than 1 × ATR(20).

**Targets and management:** 2R. Exit when a bar closes back inside the channel
at the mid line. Trail along the band that was broken after 1.5R.

### Skip when

- The breakout bar is larger than 2 × ATR(14) (exhaustion risk).
- It breaks directly into prior-day or overnight high/low.
- More than 3 band closes in a row already (late in the move).
- Within 15 minutes of high-impact news.

## Examples

```text
10:06 ET 3m close 21655.50 > upper band 21652.10, prior close inside,
ADX 24.3, mid slope +, channel width was 0.8× its 20-bar average.
Entry 21655.50, stop 21650.00, target 21666.50.
rationale: "setup:keltner long close above upper KC 21652.10, stop 21650.00, target 21666.50, risk $11"
```
