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
the mirror). Open from the `Pullback` line (steps 6-7 outlive it). BOS the
side's way confirms, CHoCH against warns; a CISD reads as the same: the
side's way as a BOS, against as a CHoCH, earlier (`cisd`). Strong
(`displacement` strong; an engulfing confirming candle, `engulfing`, is
one: `cisd`) weighs more in the count: the CISD line's `strong` is its displacement's strength, not a pattern name
(`candle-reading`); weak (no zone) weighs less and is
never the composed setup read (`compose_check` takes a live strong one):

1. The 4h + 1h set the side (`htf-to-ltf`); never counter.
2. A 15m close breaks a level the side's way (`15m broke <level> up`,
   `m15.lastBreak.last` BOS up): old resistance, now support. The break
   itself is a `breakout` setup; the pullback to it after is this read.
3. Price pulls back toward it: small counter candles inside the impulse
   candle's range (`N in a row inside the <time> candle`: `compression`'s
   pennant), `Pullback` volume falling, its 15m swing holding. A 15m
   `range` or `transition` here is the pause, not chop. The label is no
   evidence of resumption either. The impulse (a 15m `displacement` the
   side's way, or the CISD's `leg`) sets the leg: measure the pullback on
   it (`fib-retracement`, the CISD's `ote`), depth and location only, never
   an entry or a reversal zone. Counter candles that don't engulf it: a
   pullback forming, not a reversal; a counter candle engulfing it reads
   as a CHoCH against: wait. A counter 15m close below the impulse's open
   (long; above it, short): the pullback failed (step 8), not a watch. "Engulfs it": a counter 15m close back
   through the impulse candle's body (long: below its open), whatever lies
   between; the `engulfing` label and the CISD's `engulfing` compare only
   the prior candle. Printed proxies: the printed `inside the <time> candle <low>-<high>`
   (the impulse candle's), the `Pullback` depth.
4. **The setup**: the 15m turn: a live 15m CISD, a 15m BOS or a 15m
   reaction at the level, the side's way → the pullback ended on the 15m;
   no 15m BOS to wait for after a strong CISD or a reaction. The level: the
   broken one or a level next to it (the RTH VWAP, a 15m swing).
   Composed as `15m cisd up` (true while live), or that 15m candle's read
   (`15m rejected <level> up`: long-wick, engulfing or confirmed,
   `candle-reading`; a BOS's breaking candle `15m broke <level> up`), true
   only while it is the last 15m candle; `15m bos up` is a bias read.
5. A 3m CHoCH back the side's way: the 3m counter-move ended; watch for
   the BOS or CISD; not the entry. No BOS or CISD after it: no setup, pass.
6. **Entry**: the first 3m BOS or 3m CISD the side's way, near value
   (the `Trend declared?` RTH VWAP or EMA20 within about ±0.5), the step
   4 read true now → compose on that bar: the setup `15m cisd up` (or the
   15m candle's read), `3m bos up` in the bias step or `3m cisd up` in the
   setup step (a 3m CISD is the entry as a 3m BOS is, no BOS to wait for
   after it); a limit at its close, filled within `valid_bars`
   (`trade-lifecycle`). Never a limit back at the broken or the CHoCH
   level. The step 4 read gone: no setup until a new 15m read. Unfilled
   or run away: no chase. Far past the level, no retest: late, not this
   read's entry; a 15m BOS far past value (no 3m BOS or CISD near it):
   late, not an entry; wait for the next pullback.
7. A 15m BOS the side's way after the entry: continuation confirmed →
   hold. After a failed pullback, a later 15m BOS is a new broken level:
   its own pullback and steps 4-6 are the entry, never the BOS bar itself.
8. A 15m CHoCH or CISD against → this pullback failed, a reversal
   attempt: wait for a new 15m turn the side's way (step 4); open: the
   Trade read (`manage-position`); never counter. A 3m CHoCH or CISD
   against inside it: the watch restarts. Most of the leg given back, or
   its 15m swing broken by a close: against in the count; a candle at the
   level is no confirmation alone. Past the leg origin: no with-side
   pullback read on it.

**Close to it is a read.** The sequence is the reference picture, not a
checklist: depth, the pause's shape, the exact touch of the level, the
candle type and the distance to value weigh in the count
(`confluence-counting`); no exact touch or no named candle alone is no
reason to wait (a live strong 15m CISD or a 15m BOS is the read then). Three lines hold, whatever the count: the 4h + 1h side; a 15m CHoCH
or CISD against → wait; the entry needs a 3m BOS or CISD the side's way
and a true 15m setup read the side's way (`compose_check` requires the
15m read; the 3m timing and the wait lines are yours).

**Top-down** (`bos-vs-choch`): a 3m CHoCH against the side inside an
intact 15m trend: a pullback starting, wait. A 15m CHoCH inside an intact
1h and 4h structure is a pullback. On the 1h, not an HTF reversal: the
leg's 15m pullback failed (step 8). CHoCHs stacking up the timeframes
(15m, then 1h) are a reversal developing; a 1h CHoCH against the trend
weighs most: a reversal attempt, context only (never counter).
The pullback ends with the setup (15m) the bias's way at a level
(`rejection`, `breakout`, `fair-value-gaps`, `cisd`); its entry: step 6.
A CISD (`cisd`) is an earlier sign than the CHoCH; depth in fib terms: `fib-retracement`.
**Premium and discount** (`fib-retracement`): within a trend, pullbacks into discount
(premium for shorts) are where continuation setups sit.

**An open trade** ("Trade read": 15m structure, never 3m swings):

- Under 2 weakening signs, no reversal: a pullback → hold.
- Weakening: 2+ signs, one per kind (`failed extreme`: a 15m lower high;
  `pushes fading`; `deep retrace`; `compression against`; `HTF flip`).
- Reversal: a 15m break against, or a 15m `displacement` through the swing.

**Evidence** (docs/research/mtf-setup-catalog.md, docs/research/pullback-read-evidence.md):
depth alone is no edge; buying a 50% or 62% retrace with the 4h trend lost
after costs (F5). In five years of strict-side pullbacks no candle,
retest or engulfing-at-the-level read separated resumption from range
or reversal beyond depth; the 15m label inside a pullback: AUC 0.44. A
limit back at the broken level earned less on both halves and missed the
best runners (docs/research/retest-entry-study.md). Entering at the 15m
break back (BOS or CHoCH): -0.20R, 79% into the leg; at the first 3m BOS or CHoCH near
value: +0.05R, n 69, interval spans 0. The 3m BOS or CISD alone, and
with the 15m CISD: unmeasured. Depth was the one fact that separated outcomes; counter candles not
engulfing the impulse: unmeasured. Taught as the read, no edge shown.

## Examples

```text
Take: long (4h, 1h up); 15m pullback to the broken prior RTH high 21500.00, inside candles, V
  falling, swing 21462.50 holds; 15m turn: CISD up, strong (a bullish engulfing); 3m: BOS up,
  RTH VWAP +0.3, near value -> strong setup: enter, a limit at the 3m close 21518.25.
Watch: long; 15m pullback to 21500.00; 15m turn: CISD up, weak; 3m: CHoCH up, no BOS -> watch.
Wait: long; 15m pullback to 21500.00; 15m turn: none, a 15m CHoCH down -> wait; no short.
Close: long; the pullback stopped at 21502.25 (no touch); 15m turn: rejected the RTH VWAP 21502.50
  up (long-wick, still the last 15m); 3m: CISD up, RTH VWAP +0.4 -> enter: the lines hold.
Pause: 4h, 1h up; after the 15m break up, 15m transition, inside candles, swing holds: the
  pause, not chop -> class trend-up.
Skip: 15m, then 1h CHoCH down, the 1h ranging; 15m swing low broken; wide down bars, rising V:
  reversal attempt. A long: the 1h CHoCH against is decisive -> pass.
Loser: long at 21502.25, stop 21493.75 (8.50 pts = 34 ticks, $17.00 on 1 MNQ); a 15m close
  back below 21500.00, then a 15m CHoCH down: failed, stopped: -34 ticks, -$17.00. Wait; no short.
Down: short (4h, 1h down); 15m pullback to the broken prior RTH low 21400.00; 15m turn: CISD
  down, strong; 3m: BOS down, EMA20 +0.4 -> strong setup: enter, a limit at its close.
Open: 15m push FAILED, pushes fading, no 15m break -> weakening.
```
