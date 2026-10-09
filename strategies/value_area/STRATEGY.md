---
name: value_area
description: Volume profile POC reaction on equity index micros - price rejects the prior RTH day's point of control or breaks through it, confirmed by order flow or a range expansion on volume; target the edge of the value area. Trend setup, from the prior day's bar-based volume profile.
version: 1
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["10:00-15:00@America/New_York"]
signal: rules
connectors: [order_flow]      # ofi(3): real aggressor buy/sell volume from the TopstepX market hub when recorded
rules:
  long:
    - minute_et >= 600                    # after the first 30 minutes of RTH
    - minute_et < 900                     # no new entries after 15:00 ET
    - any:                                # the setup at the POC
        - all:                            # rejection: came down from above, tested the POC, closed back up
            - close[1] > prior_poc
            - low <= prior_poc + 0.1 * atr(20)
            - close > prior_poc
            - 2 * close >= high + low     # closed in the upper half of its range
        - all:                            # breakout: a decisive close up through the POC
            - close crosses_above prior_poc
            - close > open
            - close - prior_poc >= 0.25 * atr(20)
    - any:                                # confirmation
        - ofi(3) >= 0.2                   # order flow: buyers in control over the last 3 bars
        - all:                            # expansion: a wide bar on heavy volume
            - high - low >= 1.5 * atr(20)
            - volume >= 1.5 * vol_sma(20)
    - prior_vah - close >= 2 * close - 2 * lowest(3) + 0.5 * atr(20)   # the value area high is at least 2R away
  short:
    - minute_et >= 600
    - minute_et < 900
    - any:
        - all:
            - close[1] < prior_poc
            - high >= prior_poc - 0.1 * atr(20)
            - close < prior_poc
            - 2 * close <= high + low
        - all:
            - close crosses_below prior_poc
            - close < open
            - prior_poc - close >= 0.25 * atr(20)
    - any:
        - ofi(3) <= -0.2
        - all:
            - high - low >= 1.5 * atr(20)
            - volume >= 1.5 * vol_sma(20)
    - close - prior_val >= 2 * highest(3) - 2 * close + 0.5 * atr(20)
params:                       # the volume profile (scripts/lib/trading/volume-profile.js); edit here to tune
  vpRows: 100                 # rows over the prior day's range ...
  vpRowSize: 0                # ... or rows of this many points instead (0.25 = one MNQ/MES tick, 1 = four ticks); 0 = use vpRows
  vpValueArea: 70             # % of the volume in the value area
  vpNodePct: 9                # a high volume node beats this % of the rows on each side
  vpTroughPct: 7              # a low volume node is under this % of the rows on each side
  vpThreshold: 1              # ignore rows under this % of the POC's volume
risk:
  stop:
    long: close - lowest(3) + 0.25 * atr(20)     # below the POC test or the breakout's base
    short: highest(3) - close + 0.25 * atr(20)
  min_rr: 2
exit:
  target:
    long: prior_vah - close                       # the edge of value
    short: close - prior_val
  max_bars: 40                                    # time stop: 2 hours
source: Market profile POC (Dalton, Mind Over Markets - the POC as the fairest price, where auctions turn or pass through) on a bar-based volume profile (scripts/lib/trading/volume-profile.js, the method of LuxAlgo's Volume Profile with Node Detection, re-implemented); order flow from the TopstepX market hub. Mechanical form and thresholds are starting values, not fitted on real data.
---

# Strategy: Value Area POC reaction (`setup:value_area`)

## The idea

The point of control (POC) is the price where the prior RTH day traded the
most volume: the price both sides agreed on most. When price comes back to
it, one of two things happens:

- **Rejection.** The market still accepts yesterday's fair price as a floor
  (or ceiling). Price tests the POC and turns away from it, and the move
  rotates to the edge of value.
- **Breakout.** The market no longer agrees. Price passes through the POC
  decisively, and with little volume to stop it inside value, travels to the
  other edge.

The level alone isn't enough: price touches the POC all day. The trade needs
proof that someone is acting there:

- **Order flow:** aggressive buyers (sellers) dominate the last 3 bars, `ofi(3)`
  beyond ±0.2. With the `order_flow` connector this is real aggressor volume
  from the market hub; without it, an estimate from where each bar closed in
  its range.
- **Expansion:** the bar's range is at least 1.5 × ATR(20) on at least 1.5 ×
  the 20-bar average volume: the market moved hard, with participation.

Either confirms. Both is the A setup.

## When to Use

- RTH, 10:00-15:00 ET, on MNQ, MES, MYM, M2K, when price is inside the prior
  day's value area and comes to its POC.
- `scan` reports `value_area` with `candidate: true` and a direction; its
  `rules` result shows which branch held (rejection or breakout, flow or
  expansion).
- It is a trend setup: the order gate refuses it against the prevailing
  4h/1h/15m trend (the `multi-timeframe-analysis` skill). A POC rejection long
  in an uptrend is the pullback; a POC breakout down in a downtrend is the
  continuation.

## How It Works

The prior RTH day's profile (`prior_poc`, `prior_vah`, `prior_val`,
`scripts/lib/trading/volume-profile.js`) is built from that day's 3-minute
bars, 100 rows over its range, each bar's volume spread over its range. It is
fixed for the day and known from the first bar after 16:00 ET, so the level
never repaints. The same module gives the developing session profile
(`session_poc`) and a rolling one (`vp_poc(n)`) to any other strategy.

### Context filter (harness judgment)

- Market-snapshot `volumeProfile.priorRth`: a single, clear POC near the
  middle of value is the best reference. A day with two high-volume nodes
  (`hvn`) far apart has two "fair" prices; the POC is less meaningful.
- Room: an HVN (`hvnAbove` for a long) between the entry and the target is
  where the move may stall; take a partial there.
- The `vwap-volume-profile` skill: RTH VWAP on the trade's side supports it.
- Order flow: the `order-flow-analysis` skill, if real flow is recorded.

### Trigger (mechanical, on the closed 3-minute bar)

Long (short is the mirror image), every line must hold:

1. **Time:** 10:00-15:00 ET.
2. **Setup, one of:**
   - *Rejection:* the previous bar closed above the POC; this bar's low
     reached the POC (within 0.1 × ATR(20)); it closed above the POC, in the
     upper half of its range.
   - *Breakout:* this bar closed up through the POC (the previous close was at
     or below it), as an up bar, at least 0.25 × ATR(20) beyond it.
3. **Confirmation, one of:** `ofi(3) >= 0.2`, or a range of 1.5 × ATR(20) on
   1.5 × average volume.
4. **Room:** the value area high is at least 2R away.

### Entry, stop, target

- **Entry:** market on the trigger bar's close.
- **Stop:** 0.25 × ATR(20) below the lowest low of the last 3 bars (the POC
  test, or the breakout's base). Back through there, the reaction failed.
- **Target:** the prior day's value area high (VAL for a short), a level; at
  least 2R by rule 4.
- **Time stop:** 40 bars (2 hours) if neither fills.

### Skip when

- Price is outside the prior value area: the POC is far away and the edges
  matter more (`value_area_reentry`, `value_area_breakout`).
- The POC has already been crossed back and forth several times today: it
  has become noise, not a level.
- A tier-1 release is due within 30 minutes.
- The stop at size 1 is over the risk budget.

### Debugging a setup

- **Scan:** `node scripts/strategies.js scan <bars.json> --symbol MNQ` lists
  each rule with `ok`; a group lists its `parts`, so you can see whether the
  rejection or the breakout held, and which confirmation.
- **Backtest:** `--debug value_area` writes every bar's verdict.

## Examples

```text
MNQ long, POC rejection. Prior RTH day: VAL 21480.00, POC 21522.00, VAH
21560.00 (rounded to the tick). ATR(20) 8.00.
10:42 bar closed 21530.50 (above the POC). The 10:45 bar: open 21527.00, high
21531.75, low 21521.25 (within 0.80 of the POC), close 21530.25 (upper half).
ofi(3) = +0.34: buyers.

Stop distance: 21530.25 - 21521.25 + 0.25 x 8.00 = 11.00 points = 44 ticks
Stop: 21530.25 - 11.00 = 21519.25
Target: VAH 21560.00, 29.75 points = 119 ticks (2.70R; 2R needs 22.00)
Risk per MNQ: 44 x $0.50 = $22.00; reward 119 x $0.50 = $59.50

MNQ short, POC breakout with expansion. The 13:12 bar closed 21524.00 (above
the POC). The 13:15 bar: open 21523.50, high 21524.25, low 21511.00, close
21512.50, 9.50 below the POC; range 13.25 (>= 12.00, 1.5 x ATR) on 2,100
contracts (>= 1,800, 1.5 x the 1,200 average). Highest high of 3 bars 21526.00.

Stop distance: 21526.00 - 21512.50 + 2.00 = 15.50 points = 62 ticks
Stop: 21512.50 + 15.50 = 21528.00
Target: VAL 21480.00, 32.50 points = 130 ticks (2.10R; 2R needs 31.00)
Risk per MNQ: 62 x $0.50 = $31.00; reward 130 x $0.50 = $65.00

place_order rationale: "setup:value_area long, POC 21522.00 rejection,
ofi(3) +0.34, stop 21519.25, target VAH 21560.00, risk $22.00"
```
