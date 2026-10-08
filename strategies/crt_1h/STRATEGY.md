---
name: crt_1h
description: Candle Range Theory liquidity sweep on the 1-hour candle - the hour raids the previous hour's high or low, reclaims the range, and a 3-minute structure shift confirms; target the far side of the previous hour's range. One setup per hour. Reversal setup for MNQ, MES, MYM, M2K.
version: 2
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["08:00-15:30@America/New_York"]
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:
  long:
    - crt_dir(60) > 0
  short:
    - crt_dir(60) < 0
params:
  crtSweepBars: 10      # the sweep extreme is at most 10 bars (30 minutes) old at the shift
  crtShiftBars: 5       # the shift closes beyond the extreme of the 5 bars before it
  crtMaxDepth: 0.5      # the sweep goes at most half the previous hour's range past it
  crtMinRangeAtr: 3     # the previous hour's range is at least 3 x ATR(20) of 3-minute bars
  crtBufferAtr: 0.25    # the stop sits 0.25 x ATR(20) beyond the sweep extreme
  crtMinRR: 2           # the far side of the range is at least 2R away
risk:
  stop: crt_risk(60)
  min_rr: 2
exit:
  target: crt_target(60)   # the far side of the previous hour's range (the CRT target)
  max_bars: 40             # time stop: 2 hours; the distribution should come within the next candle
source: Candle Range Theory (CRT) / turtle-soup raid of the previous candle's high or low, as taught in community CRT material (no published backtest); fixed here as a mechanical detector (scripts/lib/trading/crt.js) so it can be backtested. Parameters are starting values, not fitted on real data.
---

# Strategy: CRT 1-hour sweep (`setup:crt_1h`)

## The idea

Every candle on a higher timeframe leaves a range: its high and its low.
Stops and breakout orders rest just beyond both. Candle Range Theory reads the
next candle as a sequence: accumulation (the previous candle's range),
manipulation (a raid beyond one side that runs those orders), and
distribution (the move back through the range to the other side). When price
pushes past the previous hour's low, takes the sell stops, and can't stay
there, the move beyond was liquidity being collected, not a breakout, and
the resting buy-side liquidity above the range is the draw.

The edge, if there is one, is order flow: the raid fills large passive orders
against trapped breakout traders. The detector only trades when the raid
fails on the lower timeframe too, and only when the far side of the range
pays at least 2R.

## When to Use

- New York hours, 08:00-15:30 ET (`sessions`), when hourly ranges are wide
  enough to give room to the far side.
- After an hour that built a clear two-sided range (C1), when the next hour
  (C2) pokes past one side and fails.
- Best when the swept level is also an obvious pool: the prior day's or the
  overnight high or low, equal highs or lows, a round number.
- Not on trend days (see Skip when).

## How It Works

The detector (`crt_dir(60)`, `crt_risk(60)`, `crt_target(60)`,
`scripts/lib/trading/crt.js`) runs on every closed 3-minute bar. 1-hour
candles open on the hour (ET).

### Context filter (harness judgment)

- **Draw on liquidity.** Ask where price is going on the 4-hour and daily
  chart. A raid of the hourly low while the 4-hour trend is up, or while
  price sits in the lower half (discount) of the day's range, is the A
  setup: the raid is the pullback, and the target is with the trend. A raid
  against a strong 4-hour trend is the B setup; take it at half size or skip
  it.
- **Which side was raided?** A raid of a level that is also a higher-
  timeframe pool (the prior day's low, the overnight low) is worth more than
  a raid of an arbitrary hourly low.
- **The C1 candle.** A balanced C1 (both wicks, closes mid-range) makes the
  best range. A C1 that is one long trend bar (a displacement candle) is not
  a range: price is more likely to continue than to reverse.

### Trigger (all mechanical, on the closed 3-minute bar)

Long, a raid of the previous hour's low (short is the mirror image):

1. **Sweep.** This hour (C2) has traded below the previous hour's (C1) low,
   and not above its high. If C2 takes both sides, it's an outside candle
   (expansion), and the hour is void.
2. **Depth.** The sweep goes no more than half of C1's range past the low
   (`crtMaxDepth`). A deeper move is acceptance: price is trading there, not
   raiding it.
3. **Range.** C1's range is at least 3 × ATR(20) on 3-minute bars
   (`crtMinRangeAtr`). A narrow hour has no room to the far side.
4. **Fresh.** The sweep low was made within the last 10 bars, 30 minutes
   (`crtSweepBars`). A new, deeper low restarts the clock.
5. **Reclaim and shift.** The 3-minute bar closes back above C1's low and
   above the high of the 5 bars before it (`crtShiftBars`). This is the
   lower-timeframe market structure shift: sellers who pushed through the
   low can't hold it. It can be the raid bar itself: one 3-minute bar that
   wicks through the low and closes above the 5 bars before (a wick soup).
6. **Room.** C1's high is at least 2R away (`crtMinRR`), with R measured to
   the sweep low plus the buffer.
7. **Once per hour.** After the setup fires, that hour is done. A second
   attempt after a stop-out is the raid failing, not a new raid.

### Entry, stop, targets

- **Entry:** at market on the close of the shift bar.
- **Stop:** below the sweep low by 0.25 × ATR(20) (`crt_risk`). A new low
  below the sweep means the raid became a breakout: the idea is wrong.
- **Target:** C1's high, the far side of the range (`crt_target`, a level,
  not an R multiple). By rule 6 it is always at least 2R.
- **Time stop:** close at market after 40 bars (2 hours) if neither the stop
  nor the target has filled (`max_bars`). CRT distribution should come in
  C2 or C3. The backtester and the live runner both apply it.
- **Management:** no trailing. Optionally take a third off at C1's midpoint
  (the equilibrium) and move the stop to breakeven. That's a judgment call,
  not part of the backtested rule.

### Skip when

- A tier-1 release (CPI, NFP, FOMC, GDP) is inside the C2 hour, or C2 is the
  09:30 open hour and the raid comes in the first 5 minutes of the cash open.
- It's a trend day: price has already broken and held beyond two or more
  hourly ranges in the same direction today. Sweeps on trend days are
  continuation, not reversal.
- The sweep stops a few ticks short of a more obvious pool (the prior day's
  low a few points lower). The real liquidity is there; wait for it.
- The stop at size 1 is over the position-sizing budget.
- The account is at a daily limit or in a loss-streak cooldown (the order
  gate refuses these anyway).

### Debugging a setup

- **Scan:** `node scripts/strategies.js scan <bars.json> --symbol MNQ --now <bar close>`
  shows `detail["crt(60)"]`: the previous candle's range (`c1High`,
  `c1Low`), the raid's `side`, `extreme`, `depth` and age
  (`barsSinceExtreme`), the `shiftLevel`, `risk`, `target`, `rr`, and the
  `reason`: `fired`, or what blocked it (`no_previous_candle`, `no_sweep`,
  `both_sides_swept`, `range_too_small`, `too_deep`, `stale`,
  `not_reclaimed`, `no_shift`, `no_room`, `fired_this_candle`).
- **Live:** every scanned bar is in `<FTH_HOME>/logs/scans-<day>.jsonl` with
  the same detail, and the runner's decision.
- **Backtest:** `--debug crt_1h` writes the verdict on every bar to
  `decisions-crt_1h.jsonl`, and `trades.jsonl` has each trade's setup.

### Traded through a policy strategy

Listed in `prop_portfolio_3m`, a CRT setup exits by the policy strategy's own
trail (2R / 0.5R), not by the CRT target and time stop above, as in training.

## Examples

```text
MNQ long, 1-hour CRT.
C1 (10:00-11:00 ET): high 21540.00, low 21480.00, range 60.00. ATR(20) on
3 minutes is 8.00, so the range is 7.5 ATR (>= 3 ATR).
C2: at 11:12 price sweeps to 21472.25, 7.75 points below C1's low (under the
30.00 half-range limit). The 11:18 bar closes at 21486.50, back above 21480.00
and above the high of the five bars before it, 2 bars after the sweep low.

Stop distance: 21486.50 - 21472.25 + 0.25 x 8.00 = 16.25 points = 65 ticks
Stop: 21486.50 - 16.25 = 21470.25
Target: C1's high 21540.00, 53.50 points = 214 ticks away (3.3R; >= 2R, so it fires)
Risk per MNQ: 65 ticks x $0.50 = $32.50; reward 214 x $0.50 = $107.00
(plus $0.74 fees per round turn)
Time stop: at the close of the 13:18 bar (13:21 ET, 40 bars) if neither fills.

place_order rationale: "setup:crt_1h long, C1 21480.00-21540.00 swept to
21472.25, 3m shift close 21486.50, stop 21470.25, target 21540.00, risk $32.50"
```
