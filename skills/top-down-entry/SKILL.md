---
name: top-down-entry
description: Use when reading a setup top down - the HTF side and level, the 15m setup there, the 3m/5m trigger, where the idea is wrong and where it aims.
---

# Top-Down Entry

The fractal read: the higher timeframes give the side and the level, the
15m the setup, the 3m or 5m the trigger (how the timeframes align:
`htf-to-ltf`).

## When to Use

- Price is coming into a key level and a setup may form there.
- Checking a composed setup's reads against the higher timeframes.

## How It Works

Completed candles only, on every timeframe. The steps run in order; each
points to the read it uses.

1. **HTF: side and level.** The side the trend rule allows
   (`m3.trendRule`); today's bias (`daily-bias`) sets the confidence, never
   a side the rule refuses. The level price comes into
   (`levels-and-reactions`) is the point of interest.
2. **15m: the setup there.** A rejection or a breakout with acceptance
   (`rejection`, `breakout`), a CISD (`cisd`), a pullback or a
   reversal (`pullback-vs-reversal`, `bos-vs-choch`).
3. **3m/5m: the trigger.** A completed candle closing the setup's way, with
   momentum (`candle-reading`, `momentum-and-volume`): the entry reads.
4. **Where the idea is wrong.** Beyond the reaction's LTF structure
   (`invalidation`): check that the strategy's stop sits beyond it.
5. **Where it aims.** The next HTF swing (`m3.swingTargets`);
   `candidate.inTheWay` is the first level in the way: check that the room
   to it allows the trade.

When the timeframes disagree, the alignment label (`htf-to-ltf`) names it:
the HTF gives the side, the LTF only the timing.

A read: the trend rule (`multi-timeframe-analysis`) and the priority order
(strategy-library) decide entries. Against the prevailing trend, trend
strategies wait. The stop and exit stay the strategy's (the priority order,
step 2: a reversal takes the nearest target).

## Examples

NQ, back-adjusted CSV prices:

```text
2022-06-22, trend rule 4h up, long aligned. 15m 12:45 candle rejects the prior
POC 14942.75; the 3m 13:03 candle rejects it too and closes in its top third:
long 14960.00, stop 14938.50 under the 15m low (21.50 pts = 86 ticks, $43.00 per MNQ);
target the 15m swing high 15040.25 (80.25 pts, 3.73R), reached 14:15.
2022-08-12, trend rule 4h up. 15m shooting star at the prior VAH 16809.25, 3m
bearish engulfing: short 16789.25, stop 16814.00 (24.75 pts = 99 ticks, $49.50 per MNQ).
Step 1: shorts are not the side the rule allows; only a reversal strategy may
fade it, and step 2 of the priority order decides. The stop was hit 12:12.
```
