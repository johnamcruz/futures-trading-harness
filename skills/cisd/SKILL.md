---
name: cisd
description: Trader-process step 4 - read the briefing's m3.cisd (a change in state of delivery) per timeframe, its OTE zone and bounce. Confluence, never a veto.
---

# CISD

## When to Use

- Trader-process step 4: is delivery changing hands? `m3.cisd` has the
  latest CISD per timeframe (3m, 5m, 15m, 1h).

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses (`scripts/lib/trading/cisd.js`); a missing field is `unknown`.

**Bullish CISD** (bearish: the mirror):

1. A down run: at least 2 consecutive bearish completed candles.
2. The level: the OPEN of the run's first candle (`level`).
3. Confirmed when a completed candle CLOSES above that level, within 6
   candles of the run (`confirmedClose`).

**Only a strong displacement has a zone** (`displacement`, `engulfing`).
Strong: body at least 0.6 of the range, the close in the top third, and a
range of at least 1.0 x ATR(14) of that timeframe or a body engulfing the
prior one. A doji, a small body or a mid-range close is weak: no zone,
no fib (`status` `weak`).

**Sweep** (`sweep`, `breakout-vs-fakeout`): A CISD after a sweep of a key
level is stronger confluence; one without is still a CISD.

Also: `leg` (`origin`, the run's extreme; `extreme`), `ote`, `status`
(`waiting`, `touched`, `bounced`, `void`, `expired`), `priceInOte`.

**Where it works**:

- **Trend pullback** (preferred; `trend-vs-range`): price pulls back to a level, then a CISD back in the trend's direction ends the pullback; the OTE bounce is the entry.
- **Range** (`range`): at an extreme (range high or low, value-area
  edge, prior day), a CISD back toward the middle, aiming at the other
  side. Mid-range is a skip.
- **Weaker**: against a strong HTF trend with no HTF break
  (`bos-vs-choch`).
- **Avoid: chop** (hypothesis): `m3.regime.primary` `transition`
  (neither trend nor range: the measured filter), or `m15.frame.swingPattern`
  `mixed` or `unclear` with overlapping small bars. A CISD there is
  usually noise.

**CISD vs CHoCH.** A CHoCH rests on swing points (`m3.lastBreak`). The
CISD usually comes first: an early sign, not yet a change of structure.
It is a setup read (`<tf> cisd up|down`), never a trade of its own. By
timeframe: a 3m or 5m CISD in the 15m/1h trend's direction is the
pullback ending; against it, noise until a higher one agrees.

**OTE and bounce** (`fib-retracement`): a strong CISD's `leg` gives
`ote`. Wait for a completed candle closing back the CISD's way in it
(`candle-reading`); `absorption` in the zone confirms. Never anticipate
the bounce.

## Examples

```text
Take: 1h up; pullback to the RTH VWAP 21520.50; 15m bullish CISD, strong; ote 21518.25-21522.50,
  a 3m close 21525.75 above it. Reads: 15m cisd up, 15m in ote, 3m close top. Priority order: aligned -> take.
Take: range 21480.00-21560.00; at the prior VAL 21480.00 a 15m bullish CISD, engulfing; into the ote
  V 2.1x with little progress (absorption), then a 3m bounce 21492.25. Reads: at prior val, 15m cisd up, in ote. Priority order -> take.
Skip: transition (ADX 19, 3 crosses, EMA20 flat), 15m mixed: chop; 3m bearish CISD at 21640.00.
  Reads: regime transition, 3m cisd down; the priority order (step 3, location) decided skip.
Loser: 15m bullish CISD after the sweep of the prior RTH low 21402.25;
  long at 21420.50, stop 21399.75 (20.75 pts = 83 ticks, $41.50 on 1 MNQ);
  a 3m close under the origin 21400.75, stopped: -83 ticks, -$41.50.
```
