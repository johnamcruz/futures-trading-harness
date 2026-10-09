---
name: cisd_ote
description: ICT-style change in state of delivery (CISD) plus optimal trade entry (OTE) pullback strategy - a displacement on the 12-minute zone timeframe defines a fib zone, limit entry on the pullback into it, pivot-based stop. Ported from algoTraderBot. Use after a liquidity sweep and displacement.
version: 3
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:
  long:
    - cisd_ote_dir > 0
  short:
    - cisd_ote_dir < 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: cisd_ote_risk
  min_rr: 2
source: algoTraderBot/strategies/cisd_ote.py, cisd_ote_detect.py
---

# Strategy: CISD + OTE (`setup:cisd_ote`)

Source: `algoTraderBot/strategies/cisd_ote.py` and `cisd_ote_detect.py`
(cisd_tf=12 min, swing_period=3, tolerance=0.5, expiry_bars=9,
liquidity_lookback=5, fib 0.5–0.705, displacement body ratio ≥ 0.3 and close
strength ≥ 0.4, pivot stop). Zone tracking across bars is more than the
rules language can say, so the detector is a rules series: `cisd_ote_dir`
(1 long, -1 short, 0 none) and `cisd_ote_risk` (the stop distance to the
zone pivot), from `scripts/lib/trading/cisd-ote.js`, a line-for-line port
checked against the source's own output. The `rules` block above trades it,
and `risk.stop` uses its distance. Read the rest of this file to judge the
setup; the steps below are what the series computes.

## When to Use

- After a sweep of a liquidity pool (liquidity-concepts), when price displaces
  hard in the opposite direction.
- Any session (the source does not gate by time); prefer setups after a sweep.

## How It Works

1. **Potential CISD level.** On 12-minute bars, note the open of the first bar
   that reverses a run of bars (a bullish bar after bearish bars marks a
   bearish-CISD candidate at its open, and vice versa). Candidates expire after
   9 bars.
2. **Displacement.** A bar closes through the candidate level with a body ≥ 30%
   of its range and closing strength ≥ 40% (bearish: (high − close) ÷ range;
   bullish: (close − low) ÷ range), after price had moved at least 50% of the
   way back (tolerance 0.5).
3. **Sweep (preferred).** A swing high (for bearish) or low (for bullish) was
   wicked within the last 5 bars. Not required, but setups with a sweep are
   the cleaner variant.
4. **Zone (as backtested, not textbook OTE).** Measure the displacement leg
   and take the band between its 50% and 70.5% points *measured from the leg's
   origin*:
   - Bullish: leg low L (lowest low since the candidate) to the displacement
     bar's high H, d = H − L. Zone = [L + 0.5d, L + 0.705d].
   - Bearish: leg high H to the displacement bar's low L, d = H − L.
     Zone = [H − 0.705d, H − 0.5d].
   In retracement terms that is the 29.5%–50% pullback of the displacement.
   A 12-minute close beyond the zone's far side (below the bottom for bullish,
   above the top for bearish) invalidates it.
5. **Entry** (entry_mode "bot"): a 3-minute bar trades into the zone and
   reaches its bottom (a long's low at or below the zone bottom; a short's high
   at or above it), after the 12-minute zone bar has closed. The signal fires
   on the next 3-minute bar; enter at market on its close, as algoTraderBot
   does.
6. **Stop:** the leg's origin (L for longs, H for shorts). The stop distance
   is measured from that entry bar's open, as in the source, and applied from
   the fill.
7. **Exit:** hold the stop until the trade reaches +2R, then trail it 0.5R
   behind the best price (the `exit` block).

### Skip when (harness judgment: the source takes every signal)

- The 1-hour trend (EMA 9/21 on 60-minute) is strongly against the zone
  direction and there was no sweep.
- Risk to the origin is above the position-sizing budget at size 1.

**Known quirk (kept for parity with the source):** the detector runs on the
trailing window at each closed 3-minute bar and executes only a touch on the
first or second 3-minute bar of a 12-minute zone bin; touches on its third or
fourth bar never trade, live or in a backtest (half the bins' bars). Offline
statistics that scan the whole history see those touches and also read the
12-minute bar's close, which ends after the touch: they overstate what this
strategy trades. Judge it by the harness's own backtest.

## Examples

```text
12m: sweep of overnight high 21655 at 09:48 ET, then a bearish bar closes
21618 through the CISD level 21631 (body 0.62, close strength 0.71).
Leg high 21659.75, displacement low 21612.00, d = 47.75
→ zone 21626.09–21635.88 (rounded 21626.00–21635.75).
10:00 bar trades up to 21627.50 (into the zone, through its bottom); the scan
fires short on the 10:03 bar. 10:03 open 21624.00, close 21622.00.
Stop distance 21659.75 − 21624.00 = 35.75 (143 ticks); short at market
21622.00, stop 21657.75, risk 143 ticks = $71.50/MNQ. Trail starts at +2R
(21550.50); then the stop sits 0.5R (17.875, rounded up to the tick) above the best low.
Risk is large: size 1 only if the budget allows.
rationale: "setup:cisd_ote short OTE zone after sweep of ONH 21655, stop 21657.75, risk $71.50"
```
