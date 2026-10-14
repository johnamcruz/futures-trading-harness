---
name: pullback-vs-reversal
description: Read a move against the higher-timeframe trend as a pullback (trend intact, a shallow retrace, the swing holding, volume falling) or a reversal (a higher-frame CHoCH, past the impulse origin, displacement against the trend) from the briefing's breaks, swings and the last 10 bars. A read for trader-process step 4, never a veto.
---

# Pullback vs Reversal

## When to Use

- Trader-process step 4, when price moves against the higher-frame trend
  (`trend-vs-range`). The step's label stays the strategy's own `mtf`.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`. "Last 10 bars" is the cycle
prompt's line (`V` and the `(c-o)` per bar).

| Sign | Pullback | Reversal | Field |
|---|---|---|---|
| HTF break | still with the trend | a CHoCH against it | `m15.lastBreak.last`, `h1.lastBreak.last` |
| Depth | up to about 50-62% of the leg (hypothesis) | past the impulse origin | `m15.frame.range` (`high`, `low`, `mid`: last 20 15m candles) |
| Swing | the leg's 15m/1h swing holds | a 3m close broke it | `m3.htfLevels` (`brokenAt`) |
| Volume | falling | expanding against the trend | last 10 bars `V`, `m3.participation.relVolLast3VsPrior20` |
| Bars | shrinking | wide bars closing at their extreme against the trend | last 10 bars, `m3.bar.rangeAtr` |
| Absorption | against the pullback (`absorption`) | none | last 10 bars |

**Read the breaks top-down** (`bos-vs-choch`). A lower-timeframe CHoCH
inside an intact higher-timeframe structure is a pullback. CHoCHs
stacking up the timeframes (3m, then 15m, then 1h) are a reversal
developing. A 15m or 1h CHoCH against the trend weighs most: then the
read is a reversal attempt. The pullback ends when its own minor
structure breaks back: `m3.lastBreak.last` turns the trend's way (the
shift or reclaim of multi-timeframe-analysis): a lower-timeframe CHoCH
back the HTF way at a level times the entry. A CISD (`cisd`) is an earlier
sign than the CHoCH; depth in fib terms: `fib-retracement`.

**Evidence** (Train, docs/research/mtf-setup-catalog.md): depth alone is no
edge; buying a 50% or 62% retrace with the 4h trend lost after costs (F5).
The RTH VWAP pullback (F3A, F3B) was slightly positive, interval straddling
zero: not a finding.

## Examples

```text
Take: 15m up, BOS up; range 21480.00-21560.00, price 21521.50 = 48% retrace; V 1,840 -> 960;
  m3 CHoCH up 0 bars ago: pullback ended. vwap_reclaim long. Priority order: aligned -> take.
Skip: m3, then 15m CHoCH down; 15m swing low 21480.00 brokenAt set; wide down bars on rising V.
  Read: reversal attempt. vwap_reclaim long; the priority order (step 4, counter) decided skip.
Loser: read pullback; vwap_reclaim long at 21522.75, stop 21514.25 (8.50 pts = 34 ticks, $17.00 on 1 MNQ);
  15m CHoCH down, stopped: -34 ticks, -$17.00. The stop held it to 1R; the read never widens it.
```
