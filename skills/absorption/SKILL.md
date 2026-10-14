---
name: absorption
description: Use when price pushes into a level on rising volume without progress, or a climax bar ends an extended move. A read for the confluence count, never a veto.
---

# Absorption

## When to Use

- Price pushes into a level on rising volume and stops progressing, or a
  very large bar ends an extended move.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`.

Effort is volume (the last 10 bars' `V`, `m3.participation`); result is
progress (`(c-o)`, `m3.bar.rangeAtr`, whether price got past the level).

- **Absorption**: at a level (`levels-and-reactions`), volume well above
  its neighbours (hypothesis: about 1.5 times) with little progress, or
  several bars pushing into it on rising volume with no close beyond. A
  push down absorbed at support favours longs; up at resistance, shorts.
- **Climax**: a very wide bar on very high volume after an extended move,
  often with a long wick: evidence against more of that move.
- **Not absorption**: high volume with large progress (momentum); low
  volume with little progress (no interest).

A bar's volume has no side: from bars, absorption is a guess at who
traded, never a measurement.

**Broker fields** a broker adds to its bars (the harness computes none of
them): `broker-bar-fields`. Never derive one from OHLCV; without them,
`unknown`.

**Evidence**: none measured on bars yet.

## Examples

```text
Take: three bars into prior VAL 21480.00 on V 2,400 / 2,650 / 2,900 (about 1,100 before);
  (c-o) -1.25 / +0.50 / +0.75, no close below. Read: absorption, longs. value_area_reentry long.
  Priority order: room -> take.
Skip: the same read, but no strategy fired. No setup without a fired strategy (trader-process): wait.
Loser: absorption at 21480.50; crt_1h long at 21480.75, stop 21474.25 (6.50 pts = 26 ticks,
  $13.00 on 1 MNQ); closes through on rising volume. -26 ticks, -$13.00.
```
