---
name: pullback-vs-reversal
description: Trader-process step 4 and an open trade - price moving against the trend or the trade - a pullback, the trend weakening, or a reversal. A read, never a veto.
---

# Pullback vs Reversal

## When to Use

- Step 4, price against the higher-frame trend
  (`trend-vs-range`). Side: `htf-to-ltf`'s.
- An open trade ("Trade read"); `manage-position` acts.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses; a missing field is `unknown`. "Last 10 bars": the prompt's `V`, `(c-o)`.

| Sign | Pullback | Reversal | Field |
|---|---|---|---|
| HTF break | with the trend | a CHoCH against it | `m15.lastBreak.last`, `h1.lastBreak.last` |
| Depth | up to about 50-62% of the leg (hypothesis) | past the impulse origin | `m15.frame.range` |
| Swing | the leg's 15m/1h swing holds | a 3m close broke it | `m3.htfLevels` `brokenAt` |
| Volume, bars | falling, shrinking | rising, wide against it | last 10 bars |

**Read the breaks top-down** (`bos-vs-choch`). A lower-timeframe CHoCH
inside an intact higher-timeframe structure is a pullback. CHoCHs
stacking up the timeframes (3m, then 15m, then 1h) are a reversal
developing. A 15m or 1h CHoCH against the trend weighs most: then the
read is a reversal attempt. The pullback ends when its own minor
structure breaks back: `m3.lastBreak.last` turns the trend's way (the
shift or reclaim of `htf-to-ltf`; leg turned: `3m choch up`, `3m bos up`, `3m compression break up`):
a lower-timeframe CHoCH
back the HTF way at a level times the entry; the setup there: `rejection`,
`breakout`, `fair-value-gaps`. A CISD (`cisd`) is an earlier
sign than the CHoCH; depth in fib terms: `fib-retracement`.
**Premium and discount** (`fib-retracement`): within a trend, pullbacks into discount
(premium for shorts) are where continuation setups sit.

**An open trade** ("Trade read": 15m structure, never 3m swings):

- Under 2 weakening signs, no reversal: a pullback → hold.
- Weakening: 2+ signs, one per kind (`failed extreme`: a 15m lower high;
  `pushes fading`; `deep retrace`; `compression against`; `HTF flip`).
- Reversal: a 15m break against, or a 15m `displacement` through the swing.

**Evidence** (docs/research/mtf-setup-catalog.md): depth alone is no
edge; buying a 50% or 62% retrace with the 4h trend lost after costs (F5).
The RTH VWAP pullback alone (F3A, F3B): no finding.

## Examples

```text
Take: 15m up, BOS up; 48% retrace; V 1,840 -> 960; m3 CHoCH up 0 bars ago: pullback ended.
  Reads: 15m up, 3m choch up. Priority order: aligned -> take.
Skip: m3, then 15m CHoCH down; 15m swing low broken; wide down bars, rising V: reversal attempt.
  A long: read long counter; the priority order (step 4) decided skip.
Loser: read pullback; long at 21522.75, stop 21514.25 (8.50 pts = 34 ticks, $17.00 on 1 MNQ);
  15m CHoCH down, stopped: -34 ticks, -$17.00.
Open: 15m push FAILED, pushes fading, no 15m break -> weakening.
```
