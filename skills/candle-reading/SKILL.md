---
name: candle-reading
description: Trader-process steps 3 and 6 - completed candles at a level (body, wicks, close, a few patterns) and the trigger bar's timing. Confirmation only, never a veto.
---

# Candle Reading

## When to Use

- A completed candle at a level (trader-process step 3), and the trigger
  bar's timing (step 6).

## How It Works

**Confirmation only, at a level.** A candle counts only AT a level: the
`levels-and-reactions` skill's list, plus the previous candle's high and
low and a CRT range (`m3.candles` lists both).
A pattern away from a level is not evidence.

**Completed candles only.** Judge a pattern at its candle's close, on
every timeframe. Never judge the in-progress candle: a 15m hammer half
formed is not a hammer. In strategy rules `htfc_*` is the candle in
progress: never judge a pattern on it.

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses; a missing field is `unknown`.

**The stack**: each timeframe's last completed candle, named with its
timeframe. 15m, 1h and 4h weigh more at a higher-timeframe level (a 1h
rejection of the prior day's high outweighs a 3m one: `rejection`,
`breakout`); 3m and 5m time the entry.

- 3m, 5m, 15m, 1h and 4h: `m3.candles` (fields: `bar-briefing`), its
  `pattern` and the levels it
  met (`rejected`, `broke`, `touched`: `rejection`, `breakout`), only
  levels that existed before it opened. 5m, `unavailable` without a 1m
  lane, is `unknown`.
- The targets: `m3.swingTargets`, the next swing each side (base,
  15m, 1h, 4h).
- In strategy rules the same candle is `htfd_*` (strategy-rules).

**Anatomy** (range = h - l; h = l is `unknown`): body and wick shares of
the range; close location (c - l) / range: top third at least 2/3, bottom at most
1/3, else middle (read `<tf> close top|middle|bottom`); size against ATR (`rangeAtr`).

**Patterns**, as the code labels them (`pattern`, `patterns`; read
`<tf> pattern <name>`; hypotheses; R range, B body, U and D the upper and lower wicks, prev the
prior candle, ATR(14) as of prev):

- doji: B at most 0.1 R;
- hammer: D at least 2 B and 0.6 R, U at most 0.15 R; shooting star: the
  mirror (the pin bars);
- bullish engulfing: a bullish candle after a bearish one, its body
  covering prev's and larger; bearish engulfing: the mirror;
- inside: within prev's high and low, a smaller range; outside: beyond
  both, a larger range;
- displacement: B at least 0.7 R and R at least 1.5 x ATR, `dir` its
  close vs its open.

A CISD's strong displacement: `cisd`. **Context decides**: with the HTF
read (`trend-vs-range`, `pullback-vs-reversal`) and momentum and volume
(`momentum-and-volume`, `absorption`).
The stack counts once (`confluence-counting`, item 4).

**Evidence**: standalone candlestick patterns have weak evidence in
general, none measured in our data yet.

## Examples

```text
Take: at the prior RTH high 21615.00: on the 15m close a shooting star (H 21621.50, C 21608.25),
  on the 1h close a rejection wick, then on the 3m close a bearish engulfing. Stack agrees.
  Reads: 1h rejected prior rth high down, 3m pattern bearish engulfing. Priority order -> take.
Skip: at the session POC 21522.00, on the 3m close a doji (body 0.25, range 5.50); 15m forming:
  the entry read not in yet -> pass. The session VAH 0.4R ahead is a read, not the reason.
Loser: at the prior VAL 21480.00, on the 15m close a hammer (L 21474.50, C 21483.75).
  long at 21483.75, stop 21474.25 (9.50 pts = 38 ticks, $19.00 on 1 MNQ);
  closes below the VAL. -38 ticks, -$19.00.
```
