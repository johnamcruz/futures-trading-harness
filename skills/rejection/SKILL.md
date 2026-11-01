---
name: rejection
description: Use when a completed candle, on any timeframe, may have rejected a key level - the setup read. A read, never an entry by itself.
---

# Rejection

## When to Use

- Price is at a key level, and the plan asks whether a completed candle
  rejected it, on any timeframe (trader-process step 4).

## How It Works

**A setup read, not an entry by itself.** It is stated with the other
steps' reads and `compose_check` verifies them (`trade_lifecycle`).

A read, never a veto: the count decides (`confluence-counting`). Thresholds are
hypotheses; a missing field is `unknown`. Completed candles only, on 3m,
5m, 15m, 1h and 4h (`candle-reading`).

**By timeframe**, the same setup:

| Timeframe | What it reads | Weight |
|---|---|---|
| 3m, 5m | the entry timing only: never the setup | least |
| 15m | the working structure and the session levels | more |
| 1h, 4h | HTF levels (prior day, overnight, CRT) | most |

**The setup**: a 15m or 1h rejection the bias's way (step 1); it is
the entry, on the next 3m bar (step 6).

By PLAN step:

- **1 HTF**: the 1h and 15m bias (`h1.h1.trend`, `m15.frame.trend`) and
   `trend-vs-range`.
- **3 Location**: price at a key level (`levels-and-reactions`; the
   previous candle's high/low, a CRT range; `m3.candles` has them).
- **4 Setup**: a completed candle rejects the level: the briefing's
   relation `rejected` (traded through it, closed back; read
   `<tf> rejected <level> up|down`). The `rejected` relation is only the
   fact: it is a rejection only when its reaction (`candle-reading`, by
   its rule: the close, the wick, the body, the next candle) is a
   long-wick, engulfing or confirmed rejection; read its side, who took
   control, and context there. Context, never the setup alone: it needs other confirmation.
   A candle's sweep of its previous candle is one too
   (`breakout-vs-fakeout`). After
   an HTF BOS, at the level a pullback reaches (`pullback-vs-reversal`),
   it is a continuation. Against the bias (4h + 1h): the trend rule
   refuses it (never counter), whatever CHoCH.
- **5 Confluence**: volume or absorption at the level (`momentum-and-volume`,
   `absorption`), counted by `confluence-counting`.
- **6 Entry**: the 15m or 1h rejection is the entry, on the next 3m
   bar; no 3m turn or break to wait for. Never anticipate it.
- **7 Risk**: the idea is wrong beyond the rejection wick: the stop read
   names it (`invalidation`). The trail exits (`target trail`,
   `take-profit`); the first level ahead (`inTheWay`) is a read (step 3).
- **9 Manage**: invalidation is a close back through the level against the
   trade, or a CHoCH against it on its timeframe or higher (`bos-vs-choch`).

**Paired with `breakout`**: a failed breakout (a close back inside)
is the setup for a rejection the other way.

**Evidence**: not measured as a setup yet; candle patterns alone have weak
evidence in general.

## Examples

```text
Take: at the prior VAH 21535.00, 1h and 15m up: on the 15m close a wick to 21512.75, close 21538.50
  (top third), then the next 3m close. Reads: 1h up, at prior vah, 15m rejected prior vah up,
  3m close top, 3m momentum up, stop 15m low 21512.75, target trail. Priority order -> take.
Skip: at the prior RTH high 21588.25, 1h and 15m up: on the 3m close a shooting star (H 21590.75,
  C 21585.50): a 3m candle is no setup, and a short is against the 1h trend (the trend rule refuses it) -> pass.
Loser: at the prior VAH 21535.00: on the 15m close a rejection (L 21512.75, C 21538.50): long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ); the next 1h close went back below 21512.75. -111 ticks, -$55.50.
```
