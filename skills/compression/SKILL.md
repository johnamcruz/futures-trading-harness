---
name: compression
description: Trader-process step 4 - a narrow candle (NR7, inside) as a box turning into expansion, code-verified in m3.compression; the setup that starts a leg.
---

# Compression

## When to Use

- Step 4 with the HTF bias set: is the trend resting on a narrow candle, and
  did a closed candle expand out of it? `m3.compression` per timeframe.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses (config/analysis.json `compression`); a missing field is `unknown`.

**The box** (`box`), completed candles only, ATR(14) the one before the box:

- `inside`: a candle inside its mother (`candle-reading`, `insideStack`
  in a row); the box is the mother's range. A displacement mother is a
  pole, never a box: then the narrow candle's own range.
- `nr7`: the narrowest range of the last 7 back-to-back candles (ties
  count); the box is its range.
- Narrow: at most 2 x ATR wide, back-to-back candles, none a displacement.
- `flavor` the box's, `flavors` all that hold; `levels` the key levels it
  sits at, `edge` `top`, `bottom`, `inside`.
- `pole`: a displacement candle (`candle-reading`) in the 3 candles just
  before the box, outside it.

**Expansion** (`break`): the next candle CLOSES beyond the box by 0.1 x ATR
or more (`beyondAtr`: a poke of a tick or two is none), its range 1 x ATR
or more (`rangeAtr`); `withPole` the pole its way, `volVsBox` support only
(`momentum-and-volume`). `state` `expanding` while within 3 candles
(`barsAgo`), no close back inside (`backInside`), price still beyond
(`beyondNow`; acceptance by closes: `breakout-vs-fakeout`) and under 1 x
ATR past its close (`late`).

**How to detect it**, the setup (`<tf> compression break up|down`):

1. `state` `compressing`: the narrow candle, its box and `levels`.
2. The expansion candle closes out of the box the HTF bias's way.
3. Side, entry and runway: `trade-lifecycle`, `take-profit`. Never anticipate.
4. Stop: the box's far side, `stop <tf> box low|high <price>` (`invalidation`).

**Strongest**: a box pressing a key level the bias's way, the expansion
closing through it: location `<tf> box at <level>`, setup the break.

**What fails**: closed back inside: fakeout (`breakout-vs-fakeout`); a
break against the HTF bias (the trend rule's); a small candle; late.

**Flag, pennant**: a displacement pole, then a narrow candle (flag) or an
inside stack (pennant), the break the pole's way (`withPole`).

**Evidence** (practice-train halves, 3m, with the HTF, n 452/406): +0.26R
and +0.18R net, 90% intervals above zero; against it -0.05R/+0.09R; a pole
added nothing measured. A census, not a finding: the count still decides.

## Examples

```text
Take: 1h up; 3m inside box 27413.00-27422.00 on the prior POC; 04:39 ET expansion closed 27428.50
  (1.13 ATR, 0.54 beyond, volume 2.69x); 04:42 close 27428.00 top. Reads: 3m compression break up,
  3m close top, stop 3m box low 27413.00, target prior rth high 27462.50 (2.26R); hit at 05:51.
Skip: pennant: a 20:09 ET pole up, then 2 candles inside 27102.50-27116.25; expansion 27118.50;
  stop 27102.25, the 15m swing high 27155.75 only 1.35R: no runway -> pass.
Skip: 4h up; 3m inside box 27475.00-27484.50; expansion down 27446.00: against the bias -> pass.
Loser: 15m up; 3m inside x3 box 27066.75-27079.75 (prior VAH inside); 03:03 ET expansion 27092.75;
  long at 27096.25, stop 27066.50 (29.75 pts = 119 ticks, $59.50 on 1 MNQ), 4h swing high 27155.75
  (2.00R); back into the box, stopped 05:21 ET: -119 ticks, -$59.50.
```
