---
name: cisd
description: Read a CISD (change in state of delivery) from the briefing's m3.cisd - a completed candle closes through the open of the opposing run before it, stronger after a sweep of a key level - as an early reversal sign before a CHoCH, top-down by timeframe, then its OTE zone (fib-retracement) and the bounce. Confluence for trader-process step 4, never a veto.
---

# CISD

## When to Use

- Trader-process step 4, when price ran one way and turned: is delivery
  changing hands?
- Reading `m3.cisd` (the latest CISD per timeframe: 3m, 5m when the bars
  can build it, 15m, 1h) and its summary line.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses (`scripts/lib/trading/cisd.js`); a missing field is `unknown`.

**Bullish CISD** (bearish: the mirror, highs for lows):

1. A down run: at least 2 consecutive bearish completed candles (a doji
   ends the run).
2. The level: the OPEN of the run's first candle (`level`).
3. Confirmed when a completed candle CLOSES above that level, within 6
   candles of the run (`confirmedClose`). A wick is not a close, and the
   candle forming is not a candle.

**Only a strong displacement has a zone** (`displacement`, `engulfing`).
Strong: body at least 0.6 of the range, the close in the top third, and a
range of at least 1.0 x ATR(14) of that timeframe or a body engulfing the
prior one. A doji, a small body or a mid-range close is weak: no zone,
no fib (`status` `weak`).

**The sweep is confluence, never required.** A key low (prior RTH,
overnight in RTH, prior session) traded below and closed back above:
`sweep` names it (null: none; `levels-and-reactions`). A CISD after a
sweep of a key level is stronger confluence; one without is still a CISD.

Also: `leg` (`origin`, the run's extreme, to `extreme`), `ote`, `status`
(`waiting`, `touched`, `bounced`, `void`, `expired`, `weak`),
`priceInOte`, `retracement`.

**CISD vs CHoCH** (`bos-vs-choch`). A CISD rests on the run's open; a
CHoCH on swing points (`m3.lastBreak`). The CISD usually comes first: an
early sign, not yet a change of structure.

**Confluence only.** It is evidence for a fired strategy's side, never a
setup of its own. Check the higher-timeframe context (`trend-vs-range`).

**By timeframe** (the top-down logic of `pullback-vs-reversal`): a 3m or 5m
CISD in the 15m/1h trend's direction is the pullback ending; one against
it is noise until a higher timeframe agrees. A 15m or 1h CISD against the
HTF trend is a reversal attempt; a 1h one after a key sweep weighs most.

**Then the OTE and the bounce.** Measure a strong displacement's `leg`
with `fib-retracement`; `ote` is its golden zone. Wait: price trades into
the zone, then a completed candle closes back the CISD's way
(`candle-reading`). Never anticipate the bounce. A close through the
origin voids it. The paper strategy `cisd_ote` trades this (15m or 60m
CISD, 3m bounce).

**Evidence**: no edge on Train (docs/research/cisd-ote-textbook.md).

## Examples

```text
Take: 15m bullish CISD, level 21512.00, sweep overnight low 21480.50; 1h up;
  ote 21489.25-21498.00, a 3m close 21500.25 above it: bounced. crt_1h long
  fired; the CISD is FOR it. Priority order: aligned -> take.
Skip: 3m bearish CISD, level 21640.00, sweep null; 15m and 1h up: noise until
  a higher one agrees. No setup without a fired strategy: a CISD alone is a read.
Loser: 15m bullish CISD after the sweep of the prior RTH low 21402.25;
  crt_1h long at 21420.50, stop 21399.75 (20.75 pts = 83 ticks, $41.50 on 1 MNQ);
  a 3m close under the origin 21400.75, status void, stopped: -83 ticks, -$41.50.
  The read was early; the stop held it to 1R.
```
