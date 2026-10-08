---
name: vwap-volume-profile
description: Use session and RTH VWAP and volume to judge trend quality, fair value, and participation in futures, including relative volume on breakouts. Use when evaluating mean-reversion vs trend days or whether a breakout has participation.
---

# VWAP and Volume

## When to Use

- Deciding trend day vs rotation day.
- Grading a breakout's participation.
- Choosing pullback entry areas.

## How It Works

1. **VWAP** from market-snapshot: `vwapSession` (anchored 18:00 ET, Globex) and
   `vwapRth` (anchored 09:30 ET).
   - Price above a rising RTH VWAP, with pullbacks holding it → buyers in
     control; buy pullbacks to VWAP.
   - Price crossing VWAP repeatedly → rotation day; fade extremes, small
     targets, or stand aside.
   - Distance from VWAP in ATRs: beyond ~2 × ATR(14) on the trigger timeframe
     is stretched; don't chase.
2. **Relative volume.** Compare the trigger bar's `v` with the average of the
   same time-of-day bars over recent sessions (or the opening-range bars). A
   breakout bar with ≥ 1.5× relative volume has participation; below 1×, treat
   it as suspect.
3. **Volume profile (approximation).** From the session's bars, bucket volume
   by price (bucket = 4–8 ticks). The highest bucket is the point of control
   (POC); the range holding ~70% of volume is the value area (VAH/VAL).
   Opening above value and holding → trend up; opening inside value → rotation
   is likely. Say clearly that this is a bar-based approximation, not
   tick-level profile.
4. **Volume climax.** A very large bar after an extended move, with a long wick,
   often marks exhaustion. Don't enter in its direction.

## Examples

```text
09:52 ET: 3m close above OR high, v = 2,140 vs OR average 1,180 (1.8×), price
0.6 ATR above rising RTH VWAP → participation confirmed for playbook-orb.

11:30 ET: 6 crosses of RTH VWAP in 90 min, ADX 14 → rotation; trend playbooks
off until a range break.
```
