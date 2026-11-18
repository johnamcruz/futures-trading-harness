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
  CHoCH then BOS the same way: a confirmed transition; a reversal once a
  close goes through the old leg's protected level.

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
- A CHoCH fails one way only (owner): a CLOSE through its ORIGIN, the
  swing its move started from (CHoCH up: the low under it; CHoCH down:
  the high above it). Two levels, never mix them:
  - a close back through the level the CHoCH BROKE -> early warning
    only; the CHoCH still stands;
  - a close through its ORIGIN -> the CHoCH is invalidated; the old
    structure stands as before.
  - a wick through either -> nothing.
- Behavior: `behavior` (rotation/weakening/transition), 15m words.
- A BOS stays labelled BOS after its protected swing breaks; the Market
  state line's status (`holds` or `broken by a close`) decides what it
  means now: a broken protected swing ends that BOS's trend read.
  - `LH X broken by a close`, `range: no leg holds` or `transition` ->
    the new side's swing is `new protected low Y`.
  - `LH X broken by a close ..., closed back below`, any state -> a close
    went through X, then one came back: X no longer protects; `the
    break's high` is the swing above. In a leg state the break failed
    within 3 bars and the line keeps the leg's read.
- Momentum (owner: "Displacement detects emerging pressure. Failed
  continuation detects loss of directional control."): the line's
  warnings (`displacement down 2 bars ago broke internal low ...`, `no
  new high for 30 min`) never end the leg; only its level does.

**Multi-timeframe structure** (the two `MTF structure` lines under
the `Market state` line, the runner's briefing). `1h > 15m` (primary,
timed on the 3m; the only `Entry:` clause) and `below: 15m > 3m`
(context; no frame under it, so no `POTENTIAL`, `WEAKENING`,
`REVERSING`). The 4h is the Bias line's; no line prints a 4h stage.
Each `stage` word is computed: copy it from its own line, never infer
it, never carry it to another level. Primary with the 1h up; mirror
for down:

| stage | printed when | means |
|---|---|---|
| `NONE` | no pullback open | nothing to read |
| `POTENTIAL` | a 3m CHoCH down, the 1h protected low holding | a pullback may start: monitor |
| `DEVELOPING` | a 15m CHoCH down | a 15m pullback forming: track its low; `Entry: none` |
| `ESTABLISHED` | then a 15m BOS down | the 15m has turned against the 1h (CHoCH then BOS): a pullback only while the 1h protected low holds; says nothing about which way it resolves; watch the 3m; `Entry: none yet` |
| `WEAKENING` | then a 3m CHoCH or CISD up | the first 3m sign back UP with the 1h (may fail: Reset): the aggressive model's condition met |
| `REVERSING` | then a 3m BOS up | the 3m turn up confirmed: the balanced model's condition met (the default) |
| `CONFIRMED REVERSAL` | a 15m close above the pullback's protected high | the pullback is over on the 15m; conservative: a fresh 3m CHoCH down, then a 3m BOS up |
| `COMPLETED` | a 15m close above the 1h impulse high | the 1h trend continued: this pullback is finished |
| `INVALIDATED` | a 1h close below the 1h protected low | that line's parent structure is broken: setup cancelled |

- Reading direction: every level prints two words, never one for the
  other: `<parent> structure UP|DOWN` (the parent's way) and `<frame>
  pullback against the <parent>: UP|DOWN|NONE` (the pullback's way:
  always opposite to that structure word; `NONE` = not pulling back).
  Take each pair from its own line: 1h and 15m from the primary, 15m
  and 3m from `below:`, whose phrase names its frame (`below 15m > 3m:
  3m pullback against the 15m:`). `15m structure UP ... below 15m >
  3m: 3m pullback against the 15m: DOWN` -> the 3m pullback runs down.
- No stage predicts the outcome: a stage is where the structure is, not
  where it goes.
- Direction: the pullback runs AGAINST the parent. Price has turned back
  WITH the parent only at `WEAKENING`, `REVERSING`, `CONFIRMED
  REVERSAL`; not at `POTENTIAL`, `DEVELOPING`, `ESTABLISHED`. None is a
  reversal of the parent; only `INVALIDATED` is, on its own line only.
- Order: a 3m CHoCH or CISD up before `ESTABLISHED` is a 3m fact, not
  `WEAKENING`. A 15m break up printed while `ESTABLISHED` is the minor
  high (`early weakening`) unless the line says `CONFIRMED REVERSAL`.
- Reset: a 3m close below the pullback low after `WEAKENING` or
  `REVERSING` -> `ESTABLISHED` again; the 3m turn is void.
- `Entry:` (a fact, never an order, a wait or a filter; other setups
  stand): `ready` names the model whose condition is met, since when,
  and the structural stop: the structure's level, a fact, never an
  order's stop (flat or not, an order's stop is the STOP line's). `Entry: none: <why>` -> context only
  (against the side, no side, a warning, the stop already traded).
- `1h structure` is the 1h break record; the Bias line's 1h is the
  trend read; they can differ, and the line says so: the side is the
  Bias line's. The `Pullback` line measures the trend rule's leg and
  its own swings: a swing can be broken there and hold here; neither
  changes the class word or the side.
- Depth (`shallow` < 0.30, `moderate` < 0.75, `deep`, `breached`) is
  context.

**Fields**: `m3.lastBreak.last` and `m3.lastBreak.previous`; the same
under `m15.lastBreak` and `h1.lastBreak` (`knownAt`: the candle's close);
a 5m lane's briefing has it in its `bar` part. Each: `kind` (`BOS` or
`CHoCH`), `direction` (`up` or `down`), `level`, `barsAgo` (that
timeframe's candles); the 3m ones and the 15m `last` also `protected`
(`level`, `brokenAt`); the 3m and 15m `last` also `quality`, its
strength (`displacement`). The 4h has swings only (`h1.h4.swingPattern`).

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
