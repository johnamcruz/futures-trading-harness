---
name: breakout
description: Use when a completed candle, on any timeframe, may have closed beyond a key level - the setup read. A read, never an entry by itself.
---

# Breakout

## When to Use

- Price is at a key level, and the plan asks whether a completed candle
  accepted price beyond it, on any timeframe (trader-process step 4).

## How It Works

**A setup read, not an entry by itself.** It is stated with the other
steps' reads and `compose_check` verifies them (`trade_lifecycle`).

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses; a missing field is `unknown`. Completed candles only, on 3m,
5m, 15m, 1h and 4h (`candle-reading`).

**By timeframe**:

| Timeframe | What it reads | Weight |
|---|---|---|
| 3m, 5m | the entry timing only: never the setup | least |
| 15m | the working structure and the session levels | more |
| 1h, 4h | HTF levels (prior day, overnight, CRT) | most |

**The setup**: a 15m or 1h breakout the bias's way (step 1); it is
the entry (step 6).

By PLAN step:

- **1 HTF**: the 1h and 15m bias (`h1.h1.trend`, `m15.frame.trend`) agrees
   with the break, or the range is mature (`trend-vs-range`).
- **3 Location**: a key level in the way (`levels-and-reactions`; the
   previous candle's high/low, a CRT range; `m3.candles` has them).
- **4 Setup**: a completed candle closes beyond the level with
   acceptance (the briefing's `broke`: `<tf> broke <level> up|down`): a strong close in the extreme third, the body beyond the
   level, not just a wick (`breakout-vs-fakeout`). Read its reaction
   with `candle-reading`: its side, who took control, and context; a
   `breakout` one → the breaking side in control, not a sweep. Context,
   never the setup alone: it needs other confirmation. A
   close beyond a level that is also a BOS on that timeframe
   (`m15.lastBreak.last`, `h1.lastBreak.last`) is accepted structure
   (`bos-vs-choch`).
- **5 Confluence**: expanding range and volume (`momentum-and-volume`),
   no absorption against it (`absorption`).
- **6 Entry**: the 15m or 1h close beyond is the entry: a limit at the last close when you compose (the setup's own close when you compose on its bar), filled within `valid_bars`;
   a retest that holds (a pullback: `pullback-vs-reversal`) is support,
   never a wait. Never anticipate it.
- **7 Risk**: the idea is wrong back inside the level, beyond the retest's
   low (high for a short): the stop read names it (`invalidation`). The
   trail exits (`target trail`, `take-profit`); the first level ahead
   (`inTheWay`) is a read.
- **9 Manage**: a close back inside the level means the breakout failed:
   invalidation. A CHoCH against the trade on its timeframe or higher
   (`bos-vs-choch`) is one too.

**Paired with `rejection`**: a failed breakout (a close back inside)
is the setup for a rejection the other way.
Out of a tight box: `compression`.

**Evidence** (Train, docs/research/mtf-setup-catalog.md): a first 3m close
through the IB high lost after costs (F8A); its retest (F8B): no finding.
Waiting for a retest (docs/research/retest-entry-study.md): every retest
entry earned less than the setup; the breakouts that never retest were the
best.

## Examples

```text
Take: at the prior RTH low 21385.00, 1h and 15m down: on the 15m close a body beyond, close 21375.25
  (bottom third): the setup and the entry. Reads: 1h down, below prior rth low, at prior rth low,
  15m broke prior rth low down, stop 3m high 21386.50, target trail.
  short limit 21375.25, stop 21386.75 (46 ticks, $23.00/MNQ); the 2R mark 21352.25 arms the trail -> take.
Skip: at the IB high 21560.00: on the 15m close only a wick beyond, close 21556.25 (touched, no broke
  read): no setup read -> pass. The session VAH 0.5R ahead is a read, not the reason.
Loser: at the overnight high 21614.75: on the 1h close a body beyond, close 21629.50:
  long at 21629.50 (a limit at its close), stop 21613.75 (15.75 pts = 63 ticks, $31.50 on 1 MNQ);
  a 15m close back inside at 21611.00. -63 ticks, -$31.50.
```
