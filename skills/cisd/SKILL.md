---
name: cisd
description: Read a CISD (change in state of delivery) from the briefing's m3.cisd - a strong completed candle closes through the open of the opposing run before it - where it works (a trend pullback ending, a range extreme), top-down by timeframe, then its OTE zone (fib-retracement) and the bounce. Confluence for trader-process step 4, never a veto.
---

# CISD

## When to Use

- Trader-process step 4: is delivery changing hands?
- Reading `m3.cisd` (the latest CISD per timeframe: 3m, 5m when the bars
  can build it, 15m, 1h) and its summary line.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses (`scripts/lib/trading/cisd.js`); a missing field is `unknown`.

**Bullish CISD** (bearish: the mirror):

1. A down run: at least 2 consecutive bearish completed candles.
2. The level: the OPEN of the run's first candle (`level`).
3. Confirmed when a completed candle CLOSES above that level, within 6
   candles of the run (`confirmedClose`). A wick is not a close.

**Only a strong displacement has a zone** (`displacement`, `engulfing`).
Strong: body at least 0.6 of the range, the close in the top third, and a
range of at least 1.0 x ATR(14) of that timeframe or a body engulfing the
prior one. A doji, a small body or a mid-range close is weak: no zone,
no fib (`status` `weak`).

**Sweep**: confluence, never required (`sweep`: a key level traded through
and closed back; `levels-and-reactions`). A CISD after a sweep of a key
level is stronger confluence; one without is still a CISD.

Also: `leg` (`origin`, the run's extreme; `extreme`), `ote`, `status`
(`waiting`, `touched`, `bounced`, `void`, `expired`), `priceInOte`,
`retracement`.

**Where it works**:

- **Trend pullback** (preferred): in an HTF trend (`trend-vs-range`),
  price pulls back to a level, then a CISD back in the trend's direction
  ends the pullback; the OTE bounce is the entry.
- **Range**: at a range extreme (range high or low, value-area edge,
  prior-day high or low), a CISD back toward the middle, aiming at the
  other side.
- **Weaker**: mid-range with no level, or against a strong HTF trend with
  no HTF break: a counter-trend attempt (`bos-vs-choch`).

**CISD vs CHoCH.** A CISD rests on the run's open; a CHoCH on swing points
(`m3.lastBreak`). The CISD usually comes first: an early sign, not yet a
change of structure. It is evidence for a fired strategy's side, never a
setup of its own.

**By timeframe**: a 3m or 5m CISD in the 15m/1h trend's direction is the
pullback ending; one against it is noise until a higher one agrees.

**OTE and bounce.** Measure a strong CISD's `leg` with `fib-retracement`;
`ote` is its zone. Wait for a completed candle closing back the CISD's
way in it (`candle-reading`). Never anticipate the bounce. Paper strategy:
`cisd_ote`.

**Evidence**: no edge on Train (docs/research/cisd-ote-textbook.md).

## Examples

```text
Take: 1h up; pullback to the RTH VWAP 21520.50; 15m bullish CISD, strong, level 21524.00;
  ote 21518.25-21522.50, a 3m close 21525.75 above it. vwap_reclaim long; Priority order: aligned -> take.
Take: range 21480.00-21560.00; at the prior VAL 21480.00 a 15m bullish CISD, strong, engulfing;
  a 3m bounce 21492.25 off the ote. value_area_reentry long, target the range high. Priority order -> take.
Skip: 3m bearish CISD, level 21640.00, sweep null; 15m and 1h up, no 1h break.
  No setup without a fired strategy: a CISD alone is a read.
Loser: 15m bullish CISD after the sweep of the prior RTH low 21402.25;
  crt_1h long at 21420.50, stop 21399.75 (20.75 pts = 83 ticks, $41.50 on 1 MNQ);
  a 3m close under the origin 21400.75, stopped: -83 ticks, -$41.50.
```
