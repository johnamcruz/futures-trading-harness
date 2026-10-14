---
name: mtf-breakout
description: The multi-timeframe breakout setup, step by step on the trader-process PLAN - an HTF bias with the break, a key level in the way, a completed 15m or 60m candle closing beyond it with acceptance, a completed 3m or 5m retest or displacement confirming. Today a read that supports or argues against a strategy that fired at the level, never an entry by itself.
---

# MTF Breakout

## When to Use

- A strategy fired at a key level, and the plan asks whether a higher
  timeframe accepted price beyond it.

## How It Works

**Today it is a read, not a trigger.** The order gate allows an entry
only when a strategy fired on the bar. This setup supports, or argues
against, a strategy that fired at the level (`orb`, `value_area_breakout`,
`crt_1h`, `crt_4h`); a dedicated detector strategy for it is coming. It
is never a reason to enter without a fired strategy.

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`. Completed candles only, on 3m,
5m, 15m and 60m (`candle-reading`).

By PLAN step:

- **1 HTF**: the 60m and 15m bias (`h1.h1.trend`, `m15.frame.trend`) agrees
   with the break, or the range is mature (`trend-vs-range`).
- **3 Location**: a key level in the way (`levels-and-reactions`:
   prior-day or overnight high/low, IB/OR, value-area edge, CRT range
   edge, swing, previous candle high/low).
- **4 Setup**: a completed 15m or 60m candle closes beyond the level with
   acceptance: a strong close in the extreme third, the body beyond the
   level, not just a wick (`breakout-vs-fakeout`, `candle-reading`). A
   close beyond a level that is also a BOS on that timeframe
   (`m15.lastBreak.last`, `h1.lastBreak.last`) is accepted structure
   (`bos-vs-choch`).
- **5 Confluence**: expanding range and volume (`momentum-and-volume`:
   `m3.bar.rangeAtr`, `m3.participation.relVolLast3VsPrior20`), no
   absorption against it (`absorption`); counted by `confluence-counting`.
- **6 Entry**: a completed 3m or 5m candle confirms: a retest of the broken
   level that holds, with a rejection candle there (preferred), or a
   continuation displacement. Never anticipate it.
- **7 Risk**: the idea is wrong back inside the level, beyond the retest's
   low (high for a short); the stop is the strategy's
   (`candidate.stopPoints`, `order_plan`): check it sits there
   (`invalidation`). Size: the priority order and the rulebook.
- **9 Manage**: a close back inside the level means the breakout failed:
   invalidation. A CHoCH against the trade on its timeframe or higher
   (`bos-vs-choch`) is one too.

**Paired with `mtf-rejection`**: a failed breakout (a close back inside)
is the setup for a rejection the other way.

**Evidence** (Train, docs/research/mtf-setup-catalog.md): a first 3m close
through the IB high lost after costs (F8A); its retest form (F8B) was
positive on 38 trades, interval straddling zero. Not a finding.

## Examples

```text
Take: at the prior RTH high 21615.00, 60m and 15m up: on the 15m close a body beyond, close 21624.75
  (top third); on the 3m close a retest low 21615.75 held with a hammer. orb long fired. Priority order -> take.
Skip: at the IB high 21560.00: on the 15m close only a wick beyond, close 21556.25 (no acceptance);
  value_area_breakout long fired; candidate.inTheWay session VAH at 0.5R. Priority order (step 3, room): skip.
Loser: at the overnight high 21614.75: on the 60m close a body beyond, close 21629.50; on the 3m close a
  retest held. orb long at 21622.25, stop 21613.75 (8.50 pts = 34 ticks, $17.00 on 1 MNQ);
  a 15m close back inside at 21611.00. -34 ticks, -$17.00.
```
