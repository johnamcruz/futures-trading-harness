---
name: crt_4h
description: Candle Range Theory liquidity sweep on the 4-hour candle - the 06:00 or 10:00 ET 4-hour candle sweeps the previous 4-hour candle's high or low, closes back inside its range, and a 3-minute shift confirms; trade back toward the other side. Reversal setup for MNQ, MES, MYM, M2K.
version: 1
status: paper
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["06:00-14:00@America/New_York"]
signal: rules
rules:
  long:
    - htfc_low(240) < htf_low(240)
    - htfc_high(240) <= htf_high(240)
    - lowest(20) < htf_low(240)
    - close > htf_low(240)
    - close crosses_above highest(5)[1]
    - htf_low(240) - htfc_low(240) <= 0.5 * htf_high(240) - 0.5 * htf_low(240)
    - htf_high(240) + 2 * htfc_low(240) >= 3 * close + 0.5 * atr(20)
  short:
    - htfc_high(240) > htf_high(240)
    - htfc_low(240) >= htf_low(240)
    - highest(20) > htf_high(240)
    - close < htf_high(240)
    - close crosses_below lowest(5)[1]
    - htfc_high(240) - htf_high(240) <= 0.5 * htf_high(240) - 0.5 * htf_low(240)
    - 3 * close - 0.5 * atr(20) >= htf_low(240) + 2 * htfc_high(240)
risk:
  stop:
    long: close - htfc_low(240) + 0.25 * atr(20)
    short: htfc_high(240) - close + 0.25 * atr(20)
  min_rr: 2
source: Candle Range Theory (CRT) / turtle-soup sweep of the previous 4-hour candle, with the CME 4-hour key times (candles at 02:00, 06:00, 10:00 ET), as described in community CRT guides (no published backtest); rules fixed here so it can be backtested. Starting values, not yet tested on real data.
---

# Strategy: CRT 4-hour sweep (`setup:crt_4h`)

The 4-hour version of Candle Range Theory. The previous 4-hour candle is the
range. The next one sweeps one side and closes back inside, and price
travels back toward the other side. On CME index futures the 4-hour candles
are aligned to the 18:00 ET open: 18:00, 22:00, 02:00, 06:00, 10:00 and
14:00 ET. These are the 1/5/9 AM "key times" of forex CRT, shifted an hour
for CME. The common model is the 02:00 candle as the range (London), with the
06:00 or 10:00 candle sweeping it (the London-to-New York handover and the
New York open). The `sessions` window (06:00-14:00 ET) trades exactly those
two sweep candles.

The rules read the candles with `htf_high(240)` / `htf_low(240)` (the
previous 4-hour candle) and `htfc_high(240)` / `htfc_low(240)` (this one so
far), and time the entry on 3-minute bars.

## When to Use

- 06:00-14:00 ET, when the 06:00 or 10:00 candle raids the previous 4-hour
  range.
- Best when the swept level is also the overnight or prior-day high or low.
- Not when the 4-hour range is so wide that the far side is a full day's move
  away (rule 6 needs 2R of room; this keeps most of those out).

## How It Works

### Context filter (harness judgment)

- Daily direction: a raid of the 4-hour low in a daily uptrend (the daily
  candle making its low early, the "power of three") is the cleaner long,
  and the mirror for shorts. Record it in the plan; the rules don't check
  it.
- Note whether the 02:00 candle formed a clean range (a quiet London session)
  or already trended. A trending range candle makes a weaker CRT.

### Trigger (the `rules` block, on each closed 3-minute bar)

Long (a sweep of the previous 4-hour low):

1. This 4-hour candle has traded below the previous one's low, and not above
   its high.
2. The sweep is fresh: the low of the last 20 bars (one hour) is below the
   previous 4-hour low.
3. The 3-minute close is back inside the range.
4. A 3-minute shift: the close crosses above the high of the 5 bars before
   it.
5. The sweep is no deeper than half the previous 4-hour range.
6. The previous 4-hour high is at least 2R away, with the risk measured to the
   sweep low plus 0.25 × ATR(20).

Short is the mirror: a sweep of the previous 4-hour high, a close back below
it, and a close below the low of the 5 bars before.

### Entry, stop, targets

- **Entry:** at market on the close of the trigger bar.
- **Stop:** beyond the sweep extreme plus 0.25 × ATR(20). Price making a new
  extreme past the sweep invalidates the raid.
- **Target:** a 2R bracket (`min_rr: 2`). Rule 6 keeps it inside the range.
  The CRT target proper is the far side of the previous 4-hour candle; a
  runner can aim there when the plan allows.

### Skip when

- A tier-1 release (CPI, NFP, FOMC) is inside the sweep candle.
- The sweep comes after the daily candle has already made its range in the
  direction of the sweep (late-day raids trend more often).
- The stop at size 1 is over the position-sizing budget (4-hour sweeps can
  be deep).

## Examples

```text
MNQ short, 4-hour CRT. The 06:00-10:00 ET candle: high 21620.00, low 21500.00.
At 10:24 the 10:00 candle sweeps to 21631.50 (11.50 points above the high,
under half the 120-point range). The 10:39 bar closes at 21612.25, back below
21620.00 and below the low of the five bars before it. ATR(20) on 3 minutes is
10.00, so the buffer is 2.50.

Stop distance: 21631.50 - 21612.25 + 2.50 = 21.75 points = 87 ticks
Stop: 21612.25 + 21.75 = 21634.00
Room to the CRT low: 21612.25 - 21500.00 = 112.25 >= 2 x 21.75 = 43.50, so it fires.
Target (2R): 21612.25 - 43.50 = 21568.75
Risk per MNQ: 87 ticks x $0.50 = $43.50 (plus $0.74 fees per round turn)

place_order rationale: "setup:crt_4h short, swept 4h high 21620.00 to 21631.50,
3m shift close 21612.25, stop 21634.00, target 21568.75, risk $43.50"
```
