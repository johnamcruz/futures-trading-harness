---
name: bos-vs-choch
description: Structure breaks as computed - confirmed swings, BOS (continuation), CHoCH (a possible reversal) - and what each means by timeframe, for PLAN steps 1, 4 and 9.
---

# BOS vs CHoCH

## When to Use

- Trader-process steps 1 (HTF), 4 (Setup) and 9 (Manage): whenever a read
  rests on a structure break.

## How It Works

A read, never a veto: the count decides (`confluence-counting`). A missing field
or a null break is `unknown`.

The bar briefing holds the breaks. The latest BOS or CHoCH (`lastBreak`)
is computed there from confirmed swings: never call it by eye.

**Swings.** Confirmed fractal swings (k=2: a pivot with 2 strictly lower
highs or higher lows on each side, confirmed 2 bars later). The same on
3m bars and completed 15m and 1h candles (structure-events.js). Fields:
`m3.swings.high`, `m3.swings.low`, `m3.htfLevels` (15m and 1h swings),
`m15.frame.swingPattern`, `h1.h1.swingPattern`.

**Breaks.** A close strictly beyond the last confirmed swing not yet
broken; each swing breaks once. Only closes count, on completed candles.
A wick through a swing that closes back inside is a sweep, not a break
(the `breakout-vs-fakeout` skill).

- BOS: a close beyond the last swing in the trend's direction. In the
  code, that is the previous break's direction (the first break too): a
  continuation.
- CHoCH: the first close beyond the last swing against it, an early
  warning, not a reversal by itself (the `pullback-vs-reversal` skill).
  CHoCH then BOS the same way: a confirmed transition, not yet a reversal.

**Three layers** (owner): "1. Internal structure: Small swings inside the
larger market structure. These can change without invalidating the main
trend. 2. Protected structure: The meaningful swing level protecting the
current directional trend. A break of this level carries greater
structural significance. 3. Price behavior: Whether price is trending,
overlapping, consolidating, or repeatedly failing to continue."

- Internal: the 3m k=2 swings and their BOS/CHoCH. An internal CHoCH
  against the leg while its protected level holds is pullback or
  consolidation evidence, never a trend change.
- Protected: the origin of the move that made the leg's last break its way
  (the line's `HL` up, `LH` down); a close through it, past a tie, is the
  only invalidation of the leg. A CHoCH then BOS against it confirms a
  transition (`CHoCH then BOS: transition confirmed`), the level unbroken;
  a close through it makes the reversal (`reversal confirmed`).
- Each break has a protected swing: a BOS holds until the leg's higher
  low (lower high) breaks; a CHoCH holds until the low (high) that started
  the shift breaks. Only a close through it counts; a wick is not.
- Behavior: `behavior` (rotation/weakening/transition), 15m words.
- A BOS stays labelled BOS after its protected swing breaks; the Market
  state line's status (`holds` or `broken by a close`) decides what it
  means now: a broken protected swing ends that BOS's trend read.
- Momentum (owner: "Displacement detects emerging pressure. Failed
  continuation detects loss of directional control."): the line's
  warnings (`displacement down 2 bars ago broke internal low ...`, `no
  new high for 30 min`) never end the leg; only its level does.

**Fields**: `m3.lastBreak.last` and `m3.lastBreak.previous`; the same
under `m15.lastBreak` and `h1.lastBreak` (`knownAt`: the candle's close);
a 5m lane's briefing has it in its `bar` part. Each: `kind` (`BOS` or
`CHoCH`), `direction` (`up` or `down`), `level`, `barsAgo` (that
timeframe's candles); the 3m ones also `protected` (`level`, `brokenAt`). The 4h has swings only (`h1.h4.swingPattern`).

**By timeframe.** No one timeframe is the signal; read them top-down.

| Timeframe | BOS | CHoCH |
|---|---|---|
| 3m, 5m | a candle fact only: never the setup, never a wait (unless a `Pullback` line is printed: `pullback-vs-reversal`) | a candle fact only (its swings are the stop's) |
| 15m | the working structure continues | the working structure shifting: a deeper pullback, or a reversal starting |
| 1h (4h swings) | the HTF trend continues | the strongest sign of an HTF trend change, not a reversal by itself: a BOS the new way confirms it |

No single BOS or CHoCH classifies the market.

A break against a trending 4h or 1h: the trend rule refuses it (never counter).
CHoCHs stacking up the timeframes (15m, then 1h) are a reversal
developing; a 1h CHoCH while the 4h and 1h agree is context.

**In the PLAN.**

- **1 HTF**: a 1h break is the side rule's, a 15m one structure
  (`confluence-counting`).
- **4 Setup**: a 15m (or higher) BOS the bias's way, or a pullback to a
  level ending in the 15m turn the bias's way; never a 3m break.
- **9 Manage**: a CHoCH against an open trade on its timeframe or higher
  (15m, 1h) is significant (`invalidation`); a 3m one is noise.
  The exit stays the trail.

## Examples

```text
Take: 4h, 1h up, 1h and 15m BOS up; pullback to the RTH VWAP 21520.50; the 15m rejected it up.
  Reads: 1h bos up, at vwap rth, 15m rejected vwap rth up, 3m close top. Priority order: aligned -> take.
Skip: 1h trending up; a 15m CHoCH down through 21512.50: a 15m pullback. A short: against the 1h
  trend (the trend rule refuses it, whatever CHoCH) -> pass.
Loser: 4h up, 1h ranging; a 15m CHoCH down through 21560.00, then a 15m BOS down: against the 4h
  (the trend rule refuses it). A short at 21548.75 anyway, stop 21557.25 (8.50 pts = 34 ticks, $17.00 on 1 MNQ):
  a 15m CHoCH up through 21562.50, price resumed up. -34 ticks, -$17.00.
```
