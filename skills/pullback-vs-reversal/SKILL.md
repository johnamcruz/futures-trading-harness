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
| HTF break | with the trend | a CHoCH against it | `m15.lastBreak.last`, `h1.lastBreak.last`; `Pullback` breaks |
| Depth | up to about 50-62% of the leg (hypothesis) | past the impulse origin | flat: `Pullback` depth; open: Trade read |
| Swing | the leg's 15m/1h swing holds | a 3m close broke it | `Pullback` swings (closes since the extreme); `m3.htfLevels` `brokenAt` (since the swing formed) |
| Volume, bars | falling, shrinking | rising, wide against it | `Pullback` volume, range vs the leg; last 10 bars |

**Flat**: the `Pullback` line (price against the prevailing side on the
15m) holds these pieces; weigh them with the confirmation at a level. A
trade open: the Trade read governs.

**The pullback to a broken level** (15m read, 3m entry; up shown, down
the mirror; BOS confirms, CHoCH warns, against the side):

1. The 4h + 1h set the side (`htf-to-ltf`); never counter.
2. A 15m close breaks a level the side's way (`15m broke <level> up`;
   `m3.htfLevels` `brokenAt`): old resistance, now support.
3. Price pulls back toward it: small counter candles inside the impulse
   candle's range (`N in a row inside the <time> candle`: `compression`'s
   pennant), `Pullback` volume falling, its 15m swing holding. A 15m
   `range` or `transition` here is the pause, not chop. The label is no
   evidence of resumption either.
4. At the level, a 15m reaction closing back the side's way
   (`15m rejected <level> up`: a long-wick, engulfing or confirmed one,
   `candle-reading`) → pullback ending.
5. A 3m CHoCH back the side's way: the 3m counter-move ended; watch for
   the BOS; not the entry. No BOS after it: no setup, pass.
6. **Entry**: the first 3m BOS the side's way (`m3.lastBreak.last`),
   near value (Trend declared? RTH VWAP or EMA20 within about ±0.5),
   inside or just out of the pullback: the pullback is over → compose on
   that bar: a limit at its close, filled within `valid_bars`
   (`trade-lifecycle`), on the next 3m bar; never a limit back at the
   broken or the CHoCH level (`breakout`: a retest is support, never a
   wait). Unfilled or run away: no chase. Far past the level, no retest:
   late, pass.
7. A 15m BOS the side's way after it: continuation confirmed → hold.
8. A 15m close back through the level, most of the leg given back, its
   15m swing broken by a close, or a 15m CHoCH against → this pullback
   failed, a reversal attempt: a candle at a level is no confirmation;
   wait for a 15m BOS the side's way (open: the stop as set handles it);
   never counter. Past the leg origin: no with-side pullback read on it.

**Close to it is a read.** The sequence is the reference picture, not a
checklist: depth, the pause's shape, the exact touch of the level, the
candle type and the distance to value weigh in the count
(`confluence-counting`). Three lines hold: the 4h + 1h side; a CHoCH
against → wait; no 3m BOS the side's way → no setup.

**Top-down** (`bos-vs-choch`): a 3m CHoCH against the side inside an
intact 15m trend: a pullback starting, wait. A 15m CHoCH inside an intact
1h and 4h structure is a pullback. On the 15m itself it is step 8.
CHoCHs stacking up the timeframes (15m, then 1h) are a reversal
developing; a 1h CHoCH against the trend weighs most: a reversal attempt,
context only (never counter).
The pullback ends with the setup (15m) the bias's way at a level
(`rejection`, `breakout`, `fair-value-gaps`); its entry: step 6.
A CISD (`cisd`) is an earlier sign than the CHoCH; depth in fib terms: `fib-retracement`.
**Premium and discount** (`fib-retracement`): within a trend, pullbacks into discount
(premium for shorts) are where continuation setups sit.

**An open trade** ("Trade read": 15m structure, never 3m swings):

- Under 2 weakening signs, no reversal: a pullback → hold.
- Weakening: 2+ signs, one per kind (`failed extreme`: a 15m lower high;
  `pushes fading`; `deep retrace`; `compression against`; `HTF flip`).
- Reversal: a 15m break against, or a 15m `displacement` through the swing.

**Evidence** (docs/research/mtf-setup-catalog.md; local studies, 2026-11):
depth alone is no edge; buying a 50% or 62% retrace with the 4h trend lost
after costs (F5). In five years of strict-side pullbacks no candle, retest
or engulfing-at-the-level read separated resumption from range or
reversal beyond depth; the 15m label inside a pullback read worse than
chance. A limit back at the broken level earned less on both halves and
missed the best runners (docs/research/retest-entry-study.md). The 15m
BOS back: -0.20R, 79% into the leg; the first 3m BOS or CHoCH near
value: +0.05R, n 69, interval spans 0; BOS-only timing unmeasured.
Taught as the read, no edge shown.

## Examples

```text
Take: 4h, 1h up; the 15m broke the prior RTH high 21500.00 up; inside candles, Pullback volume
  0.6x (falling), swing 21462.50 holds; the 15m rejected 21500.00 up (long-wick); 3m CHoCH up:
  watch; 3m BOS up, RTH VWAP +0.3 -> long, a limit at its close.
Close: 4h, 1h up; the pullback stopped at 21503.25, above 21500.00 (no touch); a plain 15m close
  back up; 3m BOS up, RTH VWAP +0.4 -> long: the three lines hold, the soft pieces are close.
Pause: 4h, 1h up; after the 15m break up, 15m transition, inside candles, swing holds: the
  pause, not chop -> class trend-up.
Skip: 15m, then 1h CHoCH down, the 1h ranging; 15m swing low broken; wide down bars, rising V:
  reversal attempt. A long: the 1h CHoCH against is decisive -> pass.
Loser: long at 21502.25, stop 21493.75 (8.50 pts = 34 ticks, $17.00 on 1 MNQ); a 15m close
  back below 21500.00, then a 15m CHoCH down: failed, stopped: -34 ticks, -$17.00. Wait; no short.
Down: 4h, 1h down; the 15m broke the prior RTH low 21400.00 down, then rejected it down
  (long-wick); 3m CHoCH down: watch; 3m BOS down, EMA20 +0.4 -> short, a limit at its close.
Open: 15m push FAILED, pushes fading, no 15m break -> weakening.
```
