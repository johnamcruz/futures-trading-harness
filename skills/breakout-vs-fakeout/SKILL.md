---
name: breakout-vs-fakeout
description: Trader-process step 3, price through or at a level - accepted (closes hold, a retest holds) or a fakeout (a sweep closed back inside). A read, never a veto.
---

# Breakout vs Fakeout

## When to Use

- Trader-process step 3, price through or at a level
  (`levels-and-reactions`).

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses; a missing field is `unknown`.

- **Fakeout (sweep), computed**: `m3.sweeps`, a level traded through from
  inside and closed back inside within 1-3 bars, in the last 10 bars:
  `m3.sweeps[].name`, `m3.sweeps[].price`, `m3.sweeps[].key` (prior RTH
  or overnight extreme), `m3.sweeps[].back`, `m3.sweeps[].bars`,
  `m3.sweeps[].wick` (the extreme), `m3.sweeps[].close`,
  `m3.sweeps[].wickShare` (the share of its range beyond the level). Never by
  eye.
  Read: `swept <level>`.
- **A candle's sweep** is another fact: a completed candle that traded
  beyond its previous candle's high or low and closed back inside
  (`sweep` in `m3.candles`), read as its relation
  (`15m rejected previous 15m high down`; `rejection`). Read its reaction
  with `candle-reading`: its side, who took control, and context; a
  `breakout` one is a breakout attempt, not a sweep. Context, never
  decided on alone.
- **Acceptance (breakout)**: closes beyond that hold (hypothesis: two or
  more). Shown as a 15m or 1h swing with `brokenAt` set
  (`m3.htfLevels`), or a location that changed
  side (`m3.location.priorValue`, `m3.location.initialBalance`,
  `m3.location.priorRthRange`).
- **Retest**: after acceptance, a pullback whose closes stay beyond the
  level. Not computed: read the last 10 bars.
- **Undecided**: one close beyond, or a wick still inside its 3 bars:
  `unknown`. No call before the close.

**Evidence**: fading every sweep of the previous hour's high or low lost
after costs (Train, F1, docs/research/mtf-setup-catalog.md). Separately, on
5,002 `m3.sweeps` events in real NQ 3m bars (tuned 2021-05 to 2022-12, checked
2023-01 to 2024-06; mean R per event): faded, -0.05R; with the trend at a key
level, +0.08R then +0.13R over about 168 events a half (interval holds zero);
against it, -0.10R. `wickShare` and `m3.participation` did not separate them; a
re-entry or a flip after a stop-out made 0R. Read a sweep alone as no reversal
signal. A sweep is context. A reversal read against the sweep's 3m leg needs a change of character first (a 3m CHoCH, an early sign: `bos-vs-choch`), then price back at the CHoCH level, with the 4h and 1h both trending the reversal's way. A sweep with the 4h and 1h trend at a key level is unchanged. Sweep, CHoCH, retest of the CHoCH level entries (no 4h or 1h filter; 09:30-12:00 ET, 2R target, 2021-04 to 2024-06) made -0.17R then +0.24R, about 110 a half, intervals hold zero: context. A first 3m close through the IB high on volume
lost (F8A); its retest (F8B) was positive on 38 trades, interval straddling
zero; level retests (F9) fired too rarely to say.

## Examples

```text
Take: prior RTH high 21615.00; closes 21619.25, 21622.50, 21621.75; retest low 21615.75 held.
  Read: acceptance, 3m broke prior rth high up; aligned, for outweighs against -> take.
Skip: m3.sweeps: prior RTH high 21625.00, key, wick 21629.50, back in 1 bar. Long at 21616.50:
  a fakeout against the long, no acceptance read -> pass. The swept high 0.6R ahead is a read.
Loser: read acceptance (closes 21618.50, 21620.25); long at 21620.25, stop 21615.75
  (4.50 pts = 18 ticks, $9.00 on 1 MNQ); low 21612.00, now a sweep (bars 3). -18 ticks, -$9.00.
```
