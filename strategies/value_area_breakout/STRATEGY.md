---
name: value_area_breakout
description: Volume profile acceptance breakout on equity index micros - two 3-minute closes beyond the prior RTH day's value area on above-average volume, trading with the prevailing trend, trailed like the other trend setups. From the prior day's bar-based volume profile.
version: 1
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:30-15:00@America/New_York"]
signal: rules
rules:
  long:
    - minute_et >= 600                  # after the first 30 minutes of RTH
    - minute_et < 900
    - close > prior_vah                 # second close above value...
    - close[1] > prior_vah
    - close[2] <= prior_vah             # ...after a close inside: fires once per acceptance
    - volume > vol_sma(20)              # with participation
  short:
    - minute_et >= 600
    - minute_et < 900
    - close < prior_val
    - close[1] < prior_val
    - close[2] >= prior_val
    - volume > vol_sma(20)
params:                       # the volume profile (scripts/lib/trading/volume-profile.js); edit here to tune
  vpRows: 100                 # rows over the prior day's range ...
  vpRowSize: 0                # ... or rows of this many points instead (0.25 = one MNQ/MES tick, 1 = four ticks); 0 = use vpRows
  vpValueArea: 70             # % of the volume in the value area
  vpNodePct: 9                # a high volume node beats this % of the rows on each side
  vpTroughPct: 7              # a low volume node is under this % of the rows on each side
  vpThreshold: 1              # ignore rows under this % of the POC's volume
risk:
  stop:
    long: close - prior_vah + 0.5 * atr(20)       # back inside value by half an ATR: the breakout failed
    short: prior_val - close + 0.5 * atr(20)
  min_rr: 2
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
source: Value area acceptance (Dalton, Mind Over Markets - initiative activity outside value) on a bar-based volume profile (scripts/lib/trading/volume-profile.js, the method of LuxAlgo's Volume Profile with Node Detection, re-implemented). Mechanical form and parameters are starting values, not fitted on real data.
---

# Strategy: Value Area Breakout (`setup:value_area_breakout`)

## The idea

The opposite case to the 80% rule. When price leaves the prior day's value
area and holds outside it with volume, buyers (or sellers) are accepting
prices the market called unfair yesterday: value is moving. The low-volume
areas beyond value offer little resistance, so price tends to travel to the
next high-volume node.

## When to Use

- RTH, 10:00-15:00 ET, on MNQ, MES, MYM, M2K, when price has closed twice
  beyond the prior day's VAH (long) or VAL (short) on above-average volume.
- `scan` reports `value_area_breakout` with `candidate: true` and a direction.
- It is a trend setup: the order gate refuses it against the prevailing
  4h/1h/15m trend (the `multi-timeframe-analysis` skill).

## How It Works

The prior RTH day's profile (`prior_vah`, `prior_val`) is fixed for the day
(`scripts/lib/trading/volume-profile.js`), so the trigger never repaints.

### Context filter (harness judgment)

- Market-snapshot `volumeProfile.priorRth`: `lvnAbove` (long) close above
  the entry with no high-volume node in between is open air: the A setup. A
  high-volume node (`hvnAbove`) within 1R is where the move likely stalls;
  skip or take it at half size.
- Participation: the `vwap-volume-profile` skill's relative volume; price on
  the right side of a rising (falling) RTH VWAP.
- A break in the first 30 minutes is not judged: the open often probes
  outside value and comes back (that's `value_area_reentry`).

### Trigger (mechanical, on the closed 3-minute bar)

Long (short is the mirror image):

1. This bar and the one before closed above the prior day's VAH, and the bar
   before those closed at or below it: acceptance, counted once.
2. This bar's volume is above its 20-bar average.

### Entry, stop, exit

- **Entry:** market on the close of the second bar above value.
- **Stop:** half an ATR(20) back inside value (below VAH). Back inside means
  the break failed.
- **Exit:** hold the initial stop until +2R, then trail 0.5R behind the best
  price, as the other trend setups.

### Skip when

- A tier-1 release is due within 30 minutes.
- The break comes after a long run and into the prior day's high or the
  overnight high: that's where breakouts often fail.
- The stop at size 1 is over the risk budget.

## Examples

```text
MNQ long, value area breakout. Prior RTH day's VAH 21560.00 (rounded to the tick).
The 10:30 bar closes 21558.50 (inside), the 10:33 bar 21563.25, and the 10:36
bar 21566.00 with volume 1,850 against a 20-bar average of 1,200. ATR(20) 8.00.

Stop distance: 21566.00 - 21560.00 + 0.5 x 8.00 = 10.00 points = 40 ticks
Stop: 21566.00 - 10.00 = 21556.00
Risk per MNQ: 40 x $0.50 = $20.00
Trail: from +2R (21586.00) the stop follows 0.5R (5.00 points = 20 ticks) behind the best price.

place_order rationale: "setup:value_area_breakout long, 2 closes above VAH
21560.00 on 1.5x volume, stop 21556.00, risk $20.00, trail from 2R"
```
