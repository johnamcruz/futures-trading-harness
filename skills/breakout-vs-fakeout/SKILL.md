---
name: breakout-vs-fakeout
description: Trader-process step 3, price through or at a level - accepted (closes hold, a retest holds) or a fakeout (a sweep closed back inside). A read, never a veto.
---

# Breakout vs Fakeout

## When to Use

- Trader-process step 3, price through or at a level
  (`levels-and-reactions`).

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`.

- **Fakeout (sweep), computed**: `m3.sweeps`, a level traded through from
  inside and closed back inside within 1-3 bars, in the last 10 bars:
  `m3.sweeps[].name`, `m3.sweeps[].price`, `m3.sweeps[].key` (prior RTH
  or overnight extreme), `m3.sweeps[].back`, `m3.sweeps[].bars`,
  `m3.sweeps[].wick` (the extreme), `m3.sweeps[].close`. Never by eye.
  Read: `swept <level>`.
- **A candle's sweep** is another fact: a completed candle that traded
  beyond its previous candle's high or low and closed back inside
  (`sweep` in `m3.candles`), read as its relation
  (`15m rejected previous 15m high down`; `rejection`).
- **Acceptance (breakout)**: closes beyond that hold (hypothesis: two or
  more). Shown as a 3m swing break (`m3.lastBreak.last.level`), a 15m or 1h
  swing with `brokenAt` set (`m3.htfLevels`), or a location that changed
  side (`m3.location.priorValue`, `m3.location.initialBalance`,
  `m3.location.priorRthRange`).
- **Retest**: after acceptance, a pullback whose closes stay beyond the
  level. Not computed: read the last 10 bars.
- **Undecided**: one close beyond, or a wick still inside its 3 bars:
  `unknown`. No call before the close.

**Evidence** (Train, docs/research/mtf-setup-catalog.md): fading every
sweep of the previous hour's high or low lost after costs (F1). The levels
in `m3.sweeps` differ and were not tested; read a sweep alone as no
reversal signal. A
first 3m close through the IB high on volume lost (F8A); its retest (F8B)
was positive on 38 trades, interval straddling zero; level retests (F9)
fired too rarely to say.

## Examples

```text
Take: prior RTH high 21615.00; closes 21619.25, 21622.50, 21621.75; retest low 21615.75 held.
  Read: acceptance. orb long. Priority order: room, aligned -> take.
Skip: m3.sweeps: prior RTH high 21625.00, key, wick 21629.50, back in 1 bar. orb long at 21616.50.
  candidate.inTheWay: the swept high at 0.6R. Priority order (step 3, room): skip.
Loser: read acceptance (closes 21618.50, 21620.25); orb long at 21620.25, stop 21615.75
  (4.50 pts = 18 ticks, $9.00 on 1 MNQ); low 21612.00, now a sweep (bars 3). -18 ticks, -$9.00.
```
