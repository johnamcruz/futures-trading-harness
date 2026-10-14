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

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. Thresholds are
hypotheses; a missing field is `unknown`. Completed candles only, on 3m,
5m, 15m, 1h and 4h (`candle-reading`).

**By timeframe**, the same setup:

| Timeframe | What it reads | Weight |
|---|---|---|
| 3m, 5m | entry timing at an HTF level; alone, a minor level | least |
| 15m | the working structure and the session levels | more |
| 1h, 4h | HTF levels (prior day, overnight, CRT) | most |

**Strongest**: a 15m or 1h rejection confirmed on 3m or 5m (step 6),
with the HTF bias (step 1); a lone 3m or 5m one against it is counter-trend.

By PLAN step:

- **1 HTF**: the 1h and 15m bias (`h1.h1.trend`, `m15.frame.trend`) and
   `trend-vs-range`.
- **3 Location**: price at a key level (`levels-and-reactions`; the
   previous candle's high/low, a CRT range; `m3.candles` has them).
- **4 Setup**: a completed candle rejects the level: the briefing's
   relation `rejected` (traded through it, closed back; read
   `<tf> rejected <level> up|down`). A long wick, the close in the
   opposite third or an engulfing grade its strength (`candle-reading`); a
   candle's sweep of its previous candle is one too
   (`breakout-vs-fakeout`). After
   an HTF BOS, at the level a pullback reaches (`pullback-vs-reversal`),
   it is a continuation. Against the HTF, whether a structure break went its way
   (`m15.lastBreak.last` or `h1.lastBreak.last` a CHoCH) is read in item 1
   of `confluence-counting`; the priority order decides. A reversal rejection
   reads strongest with an HTF CHoCH its way (`bos-vs-choch`).
- **5 Confluence**: volume or absorption at the level (`momentum-and-volume`,
   `absorption`), counted by `confluence-counting`.
- **6 Entry**: after a 15m or 1h rejection, a completed 3m or 5m candle
   confirms the same way: a displacement candle, or a break of the small
   pullback structure (`m3.lastBreak.last`). Never anticipate it.
- **7 Risk**: the idea is wrong beyond the rejection wick: the stop read
   names it (`invalidation`). Aim for the next swing (`m3.swingTargets`);
   the room to the next level (`inTheWay`) is step 3's.
- **9 Manage**: invalidation is a close back through the level against the
   trade, or a CHoCH against it on its timeframe or higher (`bos-vs-choch`).

**Paired with `breakout`**: a failed breakout (a close back inside)
is the setup for a rejection the other way.

**Evidence**: not measured as a setup yet; candle patterns alone have weak
evidence in general.

## Examples

```text
Take: at the prior VAH 21535.00, 1h and 15m up: on the 15m close a wick to 21512.75, close 21538.50
  (top third), then on the 3m close a momentum bar. Reads: 1h up, at prior vah, 15m rejected prior vah up,
  3m close top, 3m momentum up, stop 15m low 21512.75, target 1h swing 21598.00. Priority order -> take.
Skip: at the swing high 21588.25 (3m, a minor level), 1h and 15m up: on the 3m close a shooting star
  (H 21590.75, C 21585.50): 3m rejected 3m swing high down, against the 1h trend, no 15m or 1h CHoCH
  down. Priority order (step 2, the trend rule): skip.
Loser: at the prior VAH 21535.00: on the 15m close a rejection (L 21512.75, C 21538.50): long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ); the next 1h close went back below 21512.75. -111 ticks, -$55.50.
```
