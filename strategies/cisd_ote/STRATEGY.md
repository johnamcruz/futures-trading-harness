---
name: cisd_ote
description: ICT-style change in state of delivery (CISD) plus optimal trade entry (OTE) pullback strategy - a displacement on the 12-minute zone timeframe defines a fib zone, limit entry on the pullback into it, pivot-based stop. Ported from algoTraderBot. Use after a liquidity sweep and displacement.
version: 1
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["08:00-16:00@America/New_York"]
regimes: [range, transition]
signal: manual
risk:
  stop: structure
  min_rr: 2
source: algoTraderBot/strategies/cisd_ote.py, cisd_ote_detect.py
---

# Strategy: CISD + OTE (`setup:cisd_ote`)

Source: `algoTraderBot/strategies/cisd_ote.py` and `cisd_ote_detect.py`
(cisd_tf=12 min, swing_period=3, tolerance=0.5, expiry_bars=9,
liquidity_lookback=5, fib 0.5–0.705, displacement body ratio ≥ 0.3 and close
strength ≥ 0.4, pivot stop, rr_target=5, NY session). market-snapshot does not
compute this pattern; work through it on 12-minute bars
(`get_bars unit:"minute", unitNumber:12`).

## When to Use

- After a sweep of a liquidity pool (liquidity-concepts), when price displaces
  hard in the opposite direction.
- NY session (08:00–16:00 ET).

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
5. **Entry:** a limit at the zone *bottom* (entry_mode "bot"): for longs that is
   the 50% retracement; for shorts the shallower 29.5% retracement. The backtest
   filled at the next 3-minute open after price touched the limit. The zone must
   be fully formed (the 12-minute bar closed) before entering.
6. **Stop:** the leg's origin (L for longs, H for shorts), plus 2 ticks.
7. **Target:** the backtest used 5R; take at least half at 2R or the next
   liquidity, and trail the rest behind 3-minute structure.

### Skip when

- The zone is older than 9 zone-bars without a fill.
- The 1-hour trend (EMA 9/21 on 60-minute) is strongly against the zone
  direction and there was no sweep.
- Risk to the origin is above the position-sizing budget at size 1.

## Examples

```text
12m: sweep of overnight high 21655 at 09:48 ET, then a bearish bar closes
21618 through the CISD level 21631 (body 0.62, close strength 0.71).
Leg high 21659.75, displacement low 21612.00, d = 47.75
→ zone 21626.09–21635.88 (rounded 21626.00–21635.75).
Short limit 21626.00, stop 21660.25, risk 137 ticks = $68.50/MNQ,
first target 21557.50 (2R). Risk is large: size 1 only if the budget allows.
rationale: "setup:cisd_ote short zone bottom after sweep of ONH 21655, stop 21660.25, target 21557.50, risk $68.50"
```
