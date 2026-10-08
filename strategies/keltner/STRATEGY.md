---
name: keltner
description: Keltner channel volatility-expansion breakout strategy (EMA20 +/- 1.5 x ATR20, ADX >= 20) on 3-minute futures bars, ported from algoTraderBot. Use when a bar closes outside the Keltner channel in a trending regime.
version: 3
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: rules
rules:
  long:
    - close crosses_above keltner_upper
    - adx(14) >= 20
    - atr(20) > 0
  short:
    - close crosses_below keltner_lower
    - adx(14) >= 20
    - atr(20) > 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: algoTraderBot/strategies/keltner.py
---

# Strategy: Keltner Breakout (`setup:keltner`)

Source: `algoTraderBot/strategies/keltner.py` (KC_LEN=20, KC_MULT=1.5,
KC_ATR_P=20, KC_ADX_THRESH=20, stop 0.5 × ATR(20)).

## When to Use

- `scan` reports `keltner` with `candidate: true` and a direction (the `rules` block above).
- A volatility expansion out of a quiet period.

## How It Works

### Context filter (harness judgment)

- ADX(14) ≥ 20 (in the rules).
- Keltner mid (EMA 20) sloping in the trade direction over 5 bars.
- Better after a squeeze: the channel width over the prior 20 bars was below
  its average.

**Trigger:** a 3-minute close above the upper band (long) or below the lower band
(short), with the prior close inside.

**Entry:** market on the trigger bar's close, as the source does.

**Stop:** 0.5 × ATR(20) from the fill (the scan's `stopDistance`, rounded to
ticks), as algoTraderBot places it.

**Exit:** no fixed target. Hold the stop until the trade is up 2R; from
then on the runner trails it 0.5R behind the best price (the `exit` block),
after every closed bar. Don't move the stop yourself; exit early only with an
`[exit]` order when the plan's invalidation happens.

### Skip when (harness judgment: the source takes every signal)

- The breakout bar is larger than 2 × ATR(14) (exhaustion risk).
- It breaks directly into prior-day or overnight high/low.
- More than 3 band closes in a row already (late in the move).
- Within 15 minutes of high-impact news.

## Examples

```text
10:06 ET 3m close 21655.50 > upper band 21652.10, prior close inside,
ADX 24.3, mid slope +, channel width was 0.8× its 20-bar average.
Entry 21655.50, stop 21650.00, risk 22 ticks = $11/MNQ.
Trail from +2R (21666.50); then the stop sits 0.5R behind the best high.
rationale: "setup:keltner long close above upper KC 21652.10, stop 21650.00, risk $11"
```
