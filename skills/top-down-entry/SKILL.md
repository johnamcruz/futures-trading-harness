---
name: top-down-entry
description: Use when reading a setup top down - the bias (4h + 1h) and level, the 15m setup there, the 3m entry timing, the stop and the trail.
---

# Top-Down Entry

The fractal read: the bias (4h + 1h) gives the side, the levels come from
the 1h and up, the session, the VWAP and the 15m swings, the setup (15m)
is the entry, the entry timing (3m) only times it (how the timeframes
align: `htf-to-ltf`).

## When to Use

- Price is coming into a key level and a setup may form there.
- Checking a composed setup's reads against the higher timeframes.

## How It Works

Completed candles only, on every timeframe. The steps run in order; each
points to the read it uses.

1. **Bias: side and level.** The bias (4h + 1h): the side rule's side (`htf-to-ltf`,
   `m3.trendRule`; never counter); today's bias (`daily-bias`) sets the
   confidence, never a side the rule refuses. The level price comes into
   (`levels-and-reactions`) is the point of interest.
2. **15m: the setup there.** A rejection or a breakout with acceptance
   (`rejection`, `breakout`), a CISD (`cisd`), a pullback or a
   reversal (`pullback-vs-reversal`, `bos-vs-choch`).
3. **3m: the entry timing.** The setup is the entry, on the next 3m bar:
   no confirming close, no 3m turn or break to wait for; a 3m read
   (`candle-reading`, `momentum-and-volume`) is timing context.
4. **Stop: compose's.** One tick beyond the setup's invalidation, as
   a rule its candle's extreme (`invalidation`); never tighter.
5. **Exit: the trail.** `target trail`: the 2R mark that arms the trail, not the exit (`take-profit`;
   `m3.swingTargets` are context); `candidate.inTheWay` is the first level
   ahead: a read to weigh, not a pass.
   Hard: R:R at least `risk.min_rr` (compose_check's).

When the timeframes disagree, the alignment label (`htf-to-ltf`) names it:
the bias gives the side, the 3m only the timing.

A read: the trend rule (`multi-timeframe-analysis`) and the priority order
(strategy-library) decide entries. Against a trending 4h or 1h: no entry
(never counter); the stop is compose's, the exit the trail.

## Examples

NQ, back-adjusted CSV prices:

```text
2022-06-22, trend rule 4h up, long aligned. The 15m 12:45 candle rejects the prior
POC 14942.75 (the setup and the entry), composed at the 13:03 close, inside `valid_bars`:
long 14960.00, stop 14938.50 under the 15m low (21.50 pts = 86 ticks, $43.00 per MNQ), a limit at that close;
target trail: the 2R mark 15003.00 armed it; the 15m swing high 15040.25 was reached 14:15.
2022-08-12, trend rule 4h up. A 15m shooting star at the prior VAH 16809.25: a short is
against the 4h: no entry (never counter). Taken, short 16789.25, stop 16814.00 (24.75 pts
= 99 ticks, $49.50 per MNQ): the stop was hit 12:12.
```
