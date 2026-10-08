---
name: crt_4h
description: Candle Range Theory liquidity sweep on the 4-hour candle - the 06:00 or 10:00 ET candle raids the previous 4-hour high or low, reclaims the range, and a 3-minute structure shift confirms; target the far side of the previous 4-hour range. One setup per candle. Reversal setup for MNQ, MES, MYM, M2K.
version: 2
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["06:00-14:00@America/New_York"]
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:
  long:
    - crt_dir(240) > 0
  short:
    - crt_dir(240) < 0
params:
  crtSweepBars: 20      # the sweep extreme is at most 20 bars (1 hour) old at the shift
  crtShiftBars: 5       # the shift closes beyond the extreme of the 5 bars before it
  crtMaxDepth: 0.5      # the sweep goes at most half the previous 4-hour range past it
  crtMinRangeAtr: 6     # the previous 4-hour range is at least 6 x ATR(20) of 3-minute bars
  crtBufferAtr: 0.25    # the stop sits 0.25 x ATR(20) beyond the sweep extreme
  crtMinRR: 2           # the far side of the range is at least 2R away
risk:
  stop: crt_risk(240)
  min_rr: 2
exit:
  target: crt_target(240)   # the far side of the previous 4-hour range (the CRT target)
  max_bars: 80              # time stop: 4 hours, one candle
source: Candle Range Theory (CRT) / turtle-soup raid of the previous 4-hour candle, with the CME 4-hour key times (candles opening 02:00, 06:00, 10:00 ET), as taught in community CRT material (no published backtest); fixed here as a mechanical detector (scripts/lib/trading/crt.js) so it can be backtested. Parameters are starting values, not fitted on real data.
---

# Strategy: CRT 4-hour sweep (`setup:crt_4h`)

## The idea

The 4-hour version of Candle Range Theory, and the one most CRT traders
build their day around. A 4-hour candle is a session: its high and low hold
the session's resting liquidity. The next candle raids one side (the
manipulation) and, if the raid fails, delivers price to the other side (the
distribution). This is the "power of three" of the daily candle, seen one
candle at a time.

On CME index futures the 4-hour candles are aligned to the 18:00 ET open:
18:00, 22:00, 02:00, 06:00, 10:00 and 14:00 ET. These are the 1 / 5 / 9 AM
"key times" of forex CRT, one hour later for CME. The common model:

| C1 (the range) | C2 (the raid) | Story |
|---|---|---|
| 02:00-06:00 ET (London) | 06:00-10:00 ET | London builds the range; the pre-New York and New York open raid it |
| 06:00-10:00 ET | 10:00-14:00 ET | the New York morning raids the London-to-open range |

The `sessions` window (06:00-14:00 ET) trades exactly those two raid candles.

## When to Use

- 06:00-14:00 ET, when the 06:00 or 10:00 candle raids the previous 4-hour
  range.
- Best when the raided side is also the overnight or the prior day's high or
  low, so two pools are taken at once.
- When the daily candle hasn't made its range yet. The raid is the daily
  candle's manipulation leg.

## How It Works

The detector (`crt_dir(240)`, `crt_risk(240)`, `crt_target(240)`,
`scripts/lib/trading/crt.js`) runs on every closed 3-minute bar.

### Context filter (harness judgment)

- **Daily bias.** Mark the prior day's high and low and the daily trend.
  In a bullish daily context, a raid of the 4-hour low is the A setup (the
  daily candle making its low early), and the mirror for shorts. Against the
  daily bias, take it at half size, or wait for the daily range to show
  which side gives.
- **The C1 candle.** The 02:00 candle is the classic range: London builds
  both sides. If C1 already trended hard (one long body), it's a displacement
  candle, not a range. Skip it.
- **Raid quality.** A wick through the level that closes back inside on the
  same 3-minute bars (a wick soup) is the cleanest. A raid where 3-minute
  bodies close beyond the level for a while (a body soup) needs the full
  shift and is weaker.

### Trigger (all mechanical, on the closed 3-minute bar)

Long, a raid of the previous 4-hour candle's low (short is the mirror image):

1. **Sweep.** This candle (C2) has traded below C1's low, and not above its
   high. If C2 takes both sides it's an outside candle, and the candle is
   void.
2. **Depth.** At most half of C1's range past the low (`crtMaxDepth`).
3. **Range.** C1's range is at least 6 × ATR(20) on 3-minute bars
   (`crtMinRangeAtr`).
4. **Fresh.** The sweep low is at most 20 bars (1 hour) old (`crtSweepBars`).
   A deeper low restarts the clock.
5. **Reclaim and shift.** A 3-minute close back above C1's low and above
   the high of the 5 bars before it.
6. **Room.** C1's high is at least 2R away.
7. **Once per candle.** One setup per C2 candle.

### Entry, stop, targets

- **Entry:** at market on the close of the shift bar.
- **Stop:** below the sweep low by 0.25 × ATR(20) (`crt_risk`).
- **Target:** C1's high, the far side of the range (`crt_target`), at least
  2R by rule 6.
- **Time stop:** close at market after 80 bars (4 hours, one candle) if
  neither has filled (`max_bars`). The backtester and the live runner both
  apply it. End of day (15:50 ET) closes
  anything still open in any case.
- **Management:** no trailing. Optionally take a third off at C1's
  equilibrium (the midpoint) and move the stop to breakeven. That's a
  judgment call, not part of the backtested rule.

### Skip when

- A tier-1 release (CPI, NFP, FOMC) lands inside C2. The 08:30 ET releases
  fall inside the 06:00 candle: wait for the release before trusting a raid.
- The daily candle has already made its range in the raid's direction
  (a late raid is more often continuation).
- The stop at size 1 is over the position-sizing budget. 4-hour raids can be
  deep.
- The account is at a daily limit or in a loss-streak cooldown.

### Debugging a setup

- **Scan:** `node scripts/strategies.js scan <bars.json> --symbol MNQ --now <bar close>`
  shows `detail["crt(240)"]`: the previous candle's range (`c1High`,
  `c1Low`), the raid's `side`, `extreme`, `depth` and age
  (`barsSinceExtreme`), the `shiftLevel`, `risk`, `target`, `rr`, and the
  `reason`: `fired`, or what blocked it (`no_previous_candle`, `no_sweep`,
  `both_sides_swept`, `range_too_small`, `too_deep`, `stale`,
  `not_reclaimed`, `no_shift`, `no_room`, `fired_this_candle`).
- **Live:** every scanned bar is in `<FTH_HOME>/logs/scans-<day>.jsonl` with
  the same detail, and the runner's decision.
- **Backtest:** `--debug crt_4h` writes the verdict on every bar to
  `decisions-crt_4h.jsonl`, and `trades.jsonl` has each trade's setup.

### Traded through a policy strategy

Listed in `prop_portfolio_3m`, a CRT setup exits by the policy strategy's own
trail (2R / 0.5R), not by the CRT target and time stop above, as in training.

## Examples

```text
MNQ short, 4-hour CRT.
C1 (06:00-10:00 ET): high 21620.00, low 21500.00, range 120.00. ATR(20) on
3 minutes is 10.00, so the range is 12 ATR (>= 6 ATR).
C2 (10:00-14:00 ET): at 10:24 price raids to 21631.50, 11.50 points above C1's
high (under the 60.00 half-range limit). The 10:39 bar closes at 21612.25,
back below 21620.00 and below the low of the five bars before it, 5 bars
after the raid high.

Stop distance: 21631.50 - 21612.25 + 0.25 x 10.00 = 21.75 points = 87 ticks
Stop: 21612.25 + 21.75 = 21634.00
Target: C1's low 21500.00, 112.25 points = 449 ticks away (5.2R; >= 2R, so it fires)
Risk per MNQ: 87 ticks x $0.50 = $43.50; reward 449 x $0.50 = $224.50
(plus $0.74 fees per round turn)
Time stop: at the close of the 14:39 bar (14:42 ET, 80 bars) if neither fills.

place_order rationale: "setup:crt_4h short, C1 21500.00-21620.00 raided to
21631.50, 3m shift close 21612.25, stop 21634.00, target 21500.00, risk $43.50"
```
