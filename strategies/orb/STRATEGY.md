---
name: orb
description: Opening range breakout strategy for equity index futures (15-minute range from 09:30 ET, ADX-gated, 3-minute trigger), ported from algoTraderBot. Use when price closes beyond the opening range or when planning the morning session.
version: 2
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: orb
params:
  orbMinutes: 15
  orbAdx: 18
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: algoTraderBot/strategies/orb.py
---

# Strategy: Opening Range Breakout (`setup:orb`)

Source: `algoTraderBot/strategies/orb.py` (ORB_BARS=5 × 3-min, ORB_ADX_GATE=18,
no breakouts after 16:00 ET, stop 0.5 × ATR(20), fixed-RR fallback 2R).

## When to Use

- 09:45–11:30 ET on MNQ/MES/MYM/M2K after the 15-minute range has closed.
- market-snapshot shows `signals.orb` = `long` or `short`.

## How It Works

### Context filter

- ADX(14) on 3-minute ≥ 18 (built into the signal), ideally rising.
- Range size between 0.5 and 2.0 × ATR(14) on 15-minute. Tiny ranges fake
  out; huge ranges leave no room to target.
- Higher timeframe (1h) not strongly against the breakout direction.

**Trigger:** a 3-minute bar *closes* beyond the opening range high (long) or low
(short) after the previous close was inside. Wicks don't count.

**Entry:** market on the trigger close, or a limit at the range edge on the first
retest within 3 bars.

**Stop:** `referenceStop` (0.5 × ATR(20)) from entry, or just inside the range
edge (2 ticks beyond the OR level) if that's tighter structure. Never wider than
the range midpoint.

**Targets and management:** 1R partial optional; main target 2R, or the next
liquidity (prior-day or overnight high/low), whichever comes first. Move the
stop to breakeven at +1R. Trail with SuperTrend(10, 3) after 2R.

### Skip when

- Relative volume on the trigger bar < 1.0× the opening-range average.
- The breakout runs straight into prior-day or overnight high/low within 1R.
- A high-impact release is due within 15 minutes.
- The opening range has already been broken and failed in the other direction.
- After 11:30 ET (lunch); never in the 09:30–09:35 window.

## Examples

```text
OR 21480.00–21500.00 (20 pts, 0.9 × 15m ATR). 09:51 ET 3m close 21503.25,
ADX 21 rising, rel-vol 1.6×. Prior-day high 21545.
Entry 21503.25, stop 21498.00 (0.5 × ATR20 = 5.25), risk 21 ticks = $10.50/MNQ,
target 21513.75 (2R) then 21545 runner if 1h is up.
rationale: "setup:orb long close above OR high 21500, stop 21498.00, target 21513.75, risk $10.50"
```

Record live stats here once 30+ reviews exist: n, win rate, expectancy.
