---
name: value_area_reentry
description: Volume profile 80 percent rule on equity index micros - the RTH session opens outside the prior day's value area, two 3-minute closes back inside accept it, and the trade targets the far side of value. Reversal setup, from the prior RTH day's bar-based volume profile.
version: 1
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:30-15:00@America/New_York"]
signal: rules
mtf: reversal                 # trades back into value against the open's move, so it may fade the prevailing trend
rules:
  long:
    - minute_et >= 576                  # the opening bar is not judged
    - minute_et < 900                   # no new entries after 15:00 ET
    - rth_open < prior_val              # opened below value
    - close > prior_val                 # second close back inside...
    - close[1] > prior_val
    - close[2] <= prior_val             # ...after a close outside: fires once per acceptance
    - close < prior_vah
    - prior_vah - close >= 2 * close - 2 * lowest(10) + 0.5 * atr(20)   # the far side is at least 2R away
  short:
    - minute_et >= 576
    - minute_et < 900
    - rth_open > prior_vah              # opened above value
    - close < prior_vah
    - close[1] < prior_vah
    - close[2] >= prior_vah
    - close > prior_val
    - close - prior_val >= 2 * highest(10) - 2 * close + 0.5 * atr(20)
params:                       # the volume profile (scripts/lib/trading/volume-profile.js); edit here to tune
  vpRows: 100                 # rows over the prior day's range ...
  vpRowSize: 0                # ... or rows of this many points instead (0.25 = one MNQ/MES tick, 1 = four ticks); 0 = use vpRows
  vpValueArea: 70             # % of the volume in the value area
  vpNodePct: 9                # a high volume node beats this % of the rows on each side
  vpTroughPct: 7              # a low volume node is under this % of the rows on each side
  vpThreshold: 1              # ignore rows under this % of the POC's volume
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)     # below the excursion outside value
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
exit:
  target:
    long: prior_vah - close                        # the far side of the prior day's value area
    short: close - prior_val
  max_bars: 40                                     # time stop: 2 hours
source: The market-profile "80% rule" (Dalton, Mind Over Markets; CBOT Market Profile) on a bar-based volume profile (scripts/lib/trading/volume-profile.js, the method of LuxAlgo's Volume Profile with Node Detection, re-implemented). Mechanical form and parameters are starting values, not fitted on real data.
---

# Strategy: Value Area Re-entry, the 80% rule (`setup:value_area_reentry`)

## The idea

The prior RTH day's value area (VAL..VAH, where 70% of its volume traded) is
the price range the market last agreed was fair. When the next session opens
outside it, the market is testing whether that value still holds. If price
gets back inside and stays there, the test failed: the open was rejected, and
the market tends to rotate through the whole value area to the other side.
Market profile traders call this the 80% rule (the old claim: two half-hour
periods inside value fill the value area 80% of the time). Nobody should
trust the number; the backtest decides.

## When to Use

- RTH, 09:36-15:00 ET, on MNQ, MES, MYM, M2K, after an open outside the prior
  day's value area (`rth_open < prior_val` or `rth_open > prior_vah`).
- `scan` reports `value_area_reentry` with `candidate: true` and a direction
  (the `rules` block above).
- Best when the prior day was a balanced (rotational) day with a clear,
  single-peaked profile, and the open is a gap into a low-volume area.

## How It Works

The profile (`prior_poc`, `prior_vah`, `prior_val`) is computed from the
prior complete RTH day's bars (`scripts/lib/trading/volume-profile.js`):
100 rows over the day's range, each bar's volume spread over its range,
70% value area grown from the point of control. It is fixed for the day and
known from the first bar after 16:00 ET, so it can't repaint.

### Context filter (harness judgment)

- Read `volumeProfile.priorRth` in market-snapshot: a POC near the middle of
  value and a value area narrower than the day's range is a balanced day,
  the best case. A day that trended (POC at one end, value area the whole
  range) gives a weak reference.
- A gap that opens far outside value (over 2 × ATR(14) on 15 minutes) and
  drives away is a trend day; a re-entry then is unlikely, and if it comes
  late, there's less time to rotate.
- The `vwap-volume-profile` skill: rotation-day evidence (VWAP crosses,
  falling ADX) supports the trade; a strong one-way drive argues against it.

### Trigger (mechanical, on the closed 3-minute bar)

Long (short is the mirror image):

1. The session opened below the prior day's value area low (`rth_open < prior_val`).
2. This bar and the one before closed back inside value, and the bar before
   those closed outside (`close[2] <= prior_val`): acceptance, counted once.
3. Price is still below the value area high.
4. Room: the distance to the value area high is at least 2R, with R as the
   stop below.

### Entry, stop, target

- **Entry:** market on the close of the second bar inside value.
- **Stop:** below the lowest low of the last 10 bars (the excursion outside
  value) by 0.25 × ATR(20). A new low there means value was rejected again.
- **Target:** the prior day's value area high (a level; at least 2R by rule 4).
- **Time stop:** 40 bars (2 hours) if neither fills.
- **Management:** the POC is the halfway mark; taking a third off there and
  moving the stop to breakeven is a judgment call, not part of the
  backtested rule.

### Skip when

- A tier-1 release (CPI, NFP, FOMC) is due within 30 minutes.
- The open is outside value and the market is building a new value area out
  there (several 30-minute periods trading outside, overlapping): that is
  acceptance outside, the opposite of this setup (see `value_area_breakout`).
- The stop at size 1 is over the risk budget.

## Examples

```text
MNQ long, 80% rule. Prior RTH day's profile: VAL 21480.00, POC 21522.00,
VAH 21560.00 (levels rounded to the tick).
RTH open 21462.50, below VAL. The 10:06 bar closes 21486.00 (inside), the
10:09 bar closes 21490.25 (second close inside; the 10:03 bar closed 21478.75,
outside). Lowest low of the last 10 bars 21458.75; ATR(20) 8.00.

Stop distance: 21490.25 - 21458.75 + 0.25 x 8.00 = 33.50 points = 134 ticks
Stop: 21490.25 - 33.50 = 21456.75
Target: VAH 21560.00, 69.75 points = 279 ticks (2.08R; 2R would be 67.00, so it fires)
Risk per MNQ: 134 x $0.50 = $67.00; reward 279 x $0.50 = $139.50
Time stop: 40 bars, at the 12:09 bar's close.

place_order rationale: "setup:value_area_reentry long, opened 21462.50 below
VAL 21480.00, 2 closes inside, stop 21456.75, target VAH 21560.00, risk $67.00"
```
