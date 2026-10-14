---
name: candle-reading
description: Read completed candles as a stack (3m, 5m, 15m, 60m) from OHLC - body, wicks, close location, range against ATR - and a few patterns (doji, pin bar, engulfing, inside, outside, displacement) as confirmation only, at a level, never on a candle still forming. A read, never a veto; trader-process steps 3 and 6.
---

# Candle Reading

## When to Use

- A completed candle at a level (trader-process step 3), and the trigger
  bar's timing (step 6).

## How It Works

**Confirmation only, at a level.** A candle counts only AT a level: the
`levels-and-reactions` skill's list, plus the previous candle's high and
low and a CRT range (the previous higher-timeframe candle's high and low;
`m3.candles` lists both).
A pattern away from a level is not evidence.

**Completed candles only.** Judge a pattern at its candle's close, on
every timeframe. Never judge the in-progress candle: a 15m pin bar half
formed is not a pin bar. In strategy rules `htfc_*` is the candle in
progress: never judge a pattern on it.

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`.

**The stack**: each timeframe's last completed candle, named with its
timeframe. 15m and 60m weigh more at a higher-timeframe level (a 60m
rejection of the prior day's high outweighs a 3m one: `rejection`,
`breakout`); 3m and 5m time the entry.

- 3m, 5m, 15m and 60m: `m3.candles` and a summary line each: the last
  completed candle (OHLCV, close time, body and wick shares, close third,
  range in ATR, volume against its average, `pattern`) and the levels it
  met (`rejected`, `broke`, `touched`), only levels that existed before it
  opened. `unavailable` or missing (5m without 1m bars) is `unknown`.
- The targets: `m3.swingTargets`, the next swing each side.
- In strategy rules the same candle is `htfd_*` (strategy-rules).

**Anatomy** (range = h - l; h = l is `unknown`): body share |c - o| /
range; wick shares (h - max(o, c)) / range and (min(o, c) - l) / range;
close location (c - l) / range, in the top, middle or bottom third; size
against ATR (`m3.bar.rangeAtr`: small under about 0.5, large over about
1.5).

**Patterns** (hypotheses):

- doji: body share under about 0.1, indecision;
- pin bar (hammer, shooting star): one wick at least about 0.6 of the
  range, the close in the opposite third;
- engulfing: the body covers the prior body, the opposite colour;
- inside bar: within the prior bar's high and low, compression;
- outside bar: beyond both;
- displacement: large, the close in the extreme third.

**Context decides**: with the HTF read (`trend-vs-range`,
`pullback-vs-reversal`) and volume (`momentum-and-volume`, `absorption`).
The stack counts once (`confluence-counting`, item 4).

**Evidence**: standalone candlestick patterns have weak evidence in
general, none measured in our data yet. Confirmation only.

## Examples

```text
Take: at the prior RTH high 21615.00: on the 15m close a shooting star (H 21621.50, C 21608.25),
  on the 60m close (`m3.candles`) a rejection wick, then on the 3m close a bearish engulfing. Stack agrees.
  crt_1h short. Priority order -> take.
Skip: at the session POC 21522.00, on the 3m close a doji (body 0.25, range 5.50); the 15m still forming.
  orb long; candidate.inTheWay session VAH at 0.4R. Priority order (step 3, room): skip.
Loser: at the prior VAL 21480.00, on the 15m close a hammer (L 21474.50, C 21483.75).
  value_area_reentry long at 21483.75, stop 21474.25 (9.50 pts = 38 ticks, $19.00 on 1 MNQ);
  closes below the VAL. -38 ticks, -$19.00.
```
