---
name: crt_1h
description: Candle Range Theory liquidity sweep on the 1-hour candle - the hour sweeps the previous hour's high or low, closes back inside its range, and a 3-minute shift confirms; trade back toward the other side of that range. Reversal setup for MNQ, MES, MYM, M2K.
version: 1
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["08:00-15:30@America/New_York"]
signal: rules
rules:
  long:
    - htfc_low(60) < htf_low(60)
    - htfc_high(60) <= htf_high(60)
    - lowest(10) < htf_low(60)
    - close > htf_low(60)
    - close crosses_above highest(5)[1]
    - htf_low(60) - htfc_low(60) <= 0.5 * htf_high(60) - 0.5 * htf_low(60)
    - htf_high(60) + 2 * htfc_low(60) >= 3 * close + 0.5 * atr(20)
  short:
    - htfc_high(60) > htf_high(60)
    - htfc_low(60) >= htf_low(60)
    - highest(10) > htf_high(60)
    - close < htf_high(60)
    - close crosses_below lowest(5)[1]
    - htfc_high(60) - htf_high(60) <= 0.5 * htf_high(60) - 0.5 * htf_low(60)
    - 3 * close - 0.5 * atr(20) >= htf_low(60) + 2 * htfc_high(60)
risk:
  stop:
    long: close - htfc_low(60) + 0.25 * atr(20)
    short: htfc_high(60) - close + 0.25 * atr(20)
  min_rr: 2
source: Candle Range Theory (CRT) / turtle-soup sweep of the previous candle's high or low, as described in community CRT guides (no published backtest); rules fixed here so it can be backtested. Starting values, not yet tested on real data.
---

# Strategy: CRT 1-hour sweep (`setup:crt_1h`)

Candle Range Theory treats the previous higher-timeframe candle as a range
(the CRT high and low). Stops rest just beyond it. When the next candle
runs those stops (the sweep, or "turtle soup") and then closes back inside,
the move beyond was liquidity being taken, not a breakout, and price tends
to travel back toward the other side of the range. This version uses the
1-hour candle as the range and 3-minute bars to time the entry, inside the
candle that made the sweep.

The 1-hour candles open on the hour (ET). The rules read them with
`htf_high(60)` / `htf_low(60)` (the previous hour) and `htfc_high(60)` /
`htfc_low(60)` (this hour so far).

## When to Use

- New York hours (08:00-15:30 ET, the `sessions` window), when 1-hour ranges
  are wide enough to give room to the other side.
- After an hour that built a clear range, when the next hour pokes past one
  side and fails.
- Not on trend days that keep breaking range after range (see Skip when).

## How It Works

### Context filter (harness judgment)

- Note the 4-hour and daily direction. A sweep of a low inside a higher-
  timeframe uptrend (a sweep into discount) is the cleaner long, and the
  mirror for shorts. The rules don't require it; record it in the plan.
- Prefer sweeps of levels that also matter on their own: the prior day's
  high or low, the overnight high or low, an equal-highs or equal-lows pool.

### Trigger (the `rules` block, on each closed 3-minute bar)

Long (a sweep of the previous hour's low):

1. This hour has traded below the previous hour's low (`htfc_low(60) <
   htf_low(60)`), and not above its high (only one side swept; an outside
   candle isn't a CRT).
2. The sweep is fresh: the low of the last 10 bars (30 minutes) is below the
   previous hour's low.
3. The 3-minute close is back inside the range (above the previous hour's
   low).
4. A 3-minute shift: the close crosses above the high of the 5 bars before
   it.
5. The sweep is no deeper than half the previous hour's range (deeper looks
   like a breakout, not a raid).
6. The previous hour's high is at least 2R away, with the risk measured to
   the sweep low plus a 0.25 × ATR(20) buffer. The other side of the range is
   the CRT target, so the room has to be there before entering.

Short is the mirror: a sweep of the previous hour's high, a close back below
it, and a close below the low of the 5 bars before.

### Entry, stop, targets

- **Entry:** at market on the close of the trigger bar.
- **Stop:** beyond the sweep extreme plus 0.25 × ATR(20)
  (`risk.stop.long` / `risk.stop.short`). A new extreme past the sweep means
  the raid became a breakout, so the idea is wrong.
- **Target:** a 2R bracket (`min_rr: 2`, no `exit` block). Rule 6 keeps it
  at or inside the far side of the previous hour's range, the CRT target.
  When the plan has room, the far side itself (the CRT high for a long, the
  CRT low for a short) is the stretch target for a runner.

### Skip when

- The sweep candle is the first hour after a big news release (CPI, FOMC,
  NFP): those hours break ranges.
- Price has already broken and held beyond several hourly ranges in the same
  direction today (a trend day: sweeps there are continuation).
- The previous hour's range is tiny (under about 1 × the 1-hour ATR), so the
  2R target sits in noise. Rule 6 catches most of these.
- The sweep runs into a higher-timeframe level that's still intact a few
  ticks further (the real liquidity is there; wait for it).

## Examples

```text
MNQ long, 1-hour CRT. The 10:00-11:00 ET hour: high 21540.00, low 21480.00.
At 11:12 the 11:00 hour sweeps to 21472.25 (7.75 points below the low,
under half the 60-point range). The 11:18 bar closes at 21486.50, back above
21480.00 and above the high of the five bars before it. ATR(20) on 3 minutes
is 8.00, so the buffer is 2.00.

Stop distance: 21486.50 - 21472.25 + 2.00 = 16.25 points = 65 ticks
Stop: 21486.50 - 16.25 = 21470.25
Room to the CRT high: 21540.00 - 21486.50 = 53.50 >= 2 x 16.25 = 32.50, so it fires.
Target (2R): 21486.50 + 32.50 = 21519.00
Risk per MNQ: 65 ticks x $0.50 = $32.50 (plus $0.74 fees per round turn)

place_order rationale: "setup:crt_1h long, swept 1h low 21480.00 to 21472.25,
3m shift close 21486.50, stop 21470.25, target 21519.00, risk $32.50"
```
