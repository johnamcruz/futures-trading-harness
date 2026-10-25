---
name: compression
description: Trader-process step 4 - a tight box (compression) turning into expansion, code-verified per timeframe in m3.compression; the setup that starts a trend leg.
---

# Compression

## When to Use

- Step 4 with the HTF bias set: is the trend resting in a box, and did a
  closed candle expand out of it? `m3.compression` per timeframe.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses (config/analysis.json `compression`); a missing field is `unknown`.

**Compression** (`box`), completed candles only, ATR(14) the one before the box:

- 5 to 30 back-to-back candles, width at most 3 x ATR (`widthAtr`),
  mean range at most 1 x ATR (`meanRangeAtr`).
- Not one: a single inside bar, wide drifting candles, a run wider than
  3 x ATR, a gap. `shape`: `converging`, `drifting up|down`, `flat`.
- `levels`: key levels the box sits at, `edge` `top`, `bottom`, `inside`.
- Signs, defined elsewhere: inside bars (`candle-reading`), the Keltner
  squeeze (`trend-momentum-indicators`), `volContract` under 1 (volume
  falling as it forms: `momentum-and-volume`).

**Expansion** (`break`): the first candle after the box CLOSES beyond it
by 0.1 x ATR or more (`beyondAtr`), its range at least 2 x the box's
candles (`rangeVsBox`) and 1 x ATR (`rangeAtr`). `state` `expanding` while
within 3 candles (`barsAgo`), no close back inside (`backInside`), price
still beyond it (`accepted`) and under 1 x ATR past its close (`late`).

**How to detect it**, the setup (`<tf> compression break up|down`):

1. `state` `compressing`: the box, its edges and `levels`.
2. The HTF bias (`trade-lifecycle` step bias) gives the side.
3. The expansion candle closes out of the box the bias's way.
4. Entry: a candle closed after it (`trade-lifecycle`). Never anticipate.
5. Stop beyond the box's far side: `stop <tf> box low|high <price>`, not
   just past the last candle (stops there get run; `invalidation`).
6. Runway: a named level at 2R or more past the box (`take-profit`), else
   the plan refuses.

**Strongest**: a box pressing a key level the bias's way, the expansion
closing through it: location `<tf> box at <level>`, setup the break.

**What fails**: closed back inside: fakeout (`breakout-vs-fakeout`); a
break against the HTF bias (the trend rule's); a small candle; late.

**Flag, pennant**: a displacement pole (`candle-reading`), then a box
drifting against it (flag) or `converging` (pennant), the break its way.

**Evidence** (practice-train halves, n 106/94): aligned 3m expansions
+0.11R/+0.15R net, intervals straddling zero; volume falling in the box
+0.34R/+0.30R (n 47/44). Not a finding.

## Examples

```text
Take: 4h up; 3m box 19316.25-19384.50 (9 candles, 2.59 ATR); 10:39 ET expansion closed 19413.25
  (2.22x, volume 2.39x); 10:42 close 19421.25 top. Reads: 3m compression break up, 3m close top,
  stop 3m box low 19316.25, target 1h swing high 19808.00 (3.67R): runway.
Skip: 15m up; 3m box 27066.75-27092.25; the 03:03 ET close 27092.75 is 2 ticks beyond (0.06 ATR):
  a poke, no expansion -> pass.
Skip: 1h up; 3m box 27363.75-27399.75; expansion 27403.00, close 27404.75; stop 27363.50 is 41.25 pts;
  1h swing high 27462.50 only 1.40R: no runway -> pass.
Loser: 4h down; 3m box 15707.75-15774.25 under the prior RTH low; 10:33 ET expansion 15675.50;
  short at 15647.00, stop 15774.50 (127.50 pts = 510 ticks, $255.00 on 1 MNQ), 2R 15392.00;
  reversed overnight: -510 ticks, -$255.00. Take, Loser: back-adjusted prices.
```
