---
name: displacement
description: Use when a Break quality line or a CISD prints - read how strongly a BOS, CHoCH, CISD or protected-swing break moved (displaced or weak). A read, never a setup.
---

# Displacement

## When to Use

- The `Break quality` line prints (a 3m or 15m break is recent).
- A CISD prints `strong` or `weak`; a protected swing prints `broken by a ... close`.

## How It Works

The owner's framework (verbatim), the core definition:

> **Displacement — Confirmation and Invalidation Framework.** Displacement
> strength is used to assess the quality and conviction of BOS, CHoCH and
> CISD events. Strong directional displacement increases confidence that the
> associated structural or delivery shift is meaningful. Displacement against
> the prevailing trend acts as an early warning of potential weakening or
> transition. However, displacement alone does not invalidate the prevailing
> trend. Structural invalidation occurs when the predefined protected swing
> or invalidation level is breached according to the model's confirmation
> rules.

The separation (the owner): "Displacement measures strength. Structure
determines confirmation. Protected swings determine structural
invalidation."

| Question | Answered by | Words |
|---|---|---|
| How strong? | displacement | `displaced` or `weak (why)` |
| Confirmed? | structure (`bos-vs-choch`) | a BOS confirms continuation; a CHoCH then a BOS the same way confirms the transition |
| Invalidated? | the protected swing | a close through it; a wick is not |

**Three rules.**

1. Displacement is a read, never a setup and never a wait. The entry is
   the setup skill's (`breakout`, `top-down-entry`,
   `pullback-vs-reversal`), unchanged.
2. A big candle that breaks no swing is a candle (`candle-reading`), not a
   structure change.
3. An FVG marks a past displacement. It does not make the current move
   displaced; the break's own word does.

An invalidating close reads its displacement too: the close decides,
displacement tells how strongly. Displacement alone never invalidates.
By timeframe the break's own weight is `bos-vs-choch`'s (a 3m break is a
candle fact; a 15m break is the working structure); its strength reads the
same on every timeframe.

**One definition.** A candle is `displaced` when it closes the break's
way, its body is at least 0.6 of its range, its close is in the extreme
third, and its range is at least 1.0 x ATR(14) of its timeframe or its
body engulfs the prior candle's. Otherwise it is `weak`, with why:
`opposite colour`, `wicks` (body under 0.6 of the range), `closed mid`,
`small` (range under 1.0 x ATR, no engulfing). BOS, CHoCH, CISD and the
invalidating close each read strength by this one rule. The CISD line's
`strong` is `displaced`; the Market state's `(displaced)` is the same
word for the same break. The candle line's `displacement` label is the
large tier of the same rule.

**The line** (`m3.lastBreak.last.quality`, `m15.lastBreak.last.quality`):

```text
Break quality (strength, not a forecast; `displacement`): 3m BOS up 21412.25
6 min ago: displaced, holding; cleared 0.6 ATR; FVG 21405.5-21409 open;
from protected low 21380.5 (a sweep of overnight low 21381): holds;
body 2.1x prior; leg 4 bars, efficiency 0.74, overlap 0.31.
```

- `holding`: no close back through the broken level since the break.
  `closed back below X`: the latest close back through it (`, back above it
  since` when the last close is past it again). For a breakout trade that
  close is `breakout`'s failure; the break's structure ends only at its
  protected swing.
- `cleared`: how far the break's close went past the level, in ATR.
- FVG: `open` (not traded into), `filled to Z` (traded into, not
  through: the `fair-value-gaps` partly filled), `traded through` (the gap
  is gone: the `fair-value-gaps` filled), `no FVG` (the move left none), `no FVG yet` (the break
  candle's own gap needs the next candle).
- `from protected low Y`: this break's own protected swing, where its move
  started (`a sweep of` a key level when the leg swept one; each break has
  one: `bos-vs-choch`). `broken by a displaced close` or `broken by a weak
  close (why)`: broken either way; the close decides, not its strength.
  `holds`: not broken (`holds (tested, a tie)`: a close only at the level,
  within the tie). A BOS's broken swing
  ends that BOS's read; a CHoCH's means the shift failed. The Market
  state's leg level is its own (the Market state line).
- `body` (against the prior 10 candles) and `leg` (efficiency 1 = no
  hesitation; overlap): the owner's candle strength and momentum, printed
  when the line has room.
- A 15m clause gives its candle closes: `15m CHoCH up 21390 (closed
  10:15): weak (wicks), closed back below 21390 at 10:45; ...`.

Confirmation before an entry is the setup's own reads (`compose_check`);
a retrace into the gap is observed (`filled to`), never waited for.

**Read** (condition -> read; one word for strength: displaced or weak):

- `displaced` BOS -> continuation by structure; displaced strength.
- `weak` BOS -> still a BOS: continuation by structure; weak strength.
- `displaced` CHoCH -> a potential reversal, displaced strength; only
  structure confirms: a BOS the same way confirms the transition, a close
  through the old leg's protected level the reversal (`bos-vs-choch`).
- `weak` CHoCH -> still a CHoCH, a potential reversal; weak strength.
- `strong` CISD -> a delivery shift, displaced strength (its zone:
  `cisd`); `weak` -> a delivery shift, weak strength, no zone.
- The Market state's momentum warning (`displacement down ...` against an
  up leg) -> an early warning: weakening or transition. The trend stands
  while its protected swing holds.
- `broken by a weak close` -> broken; the strength was weak.

**Evidence** (NQ 3m breaks, 09:30-12:00 ET, 2021-05 to 2024-06, no
model): not shown to predict. +1 ATR before -1 ATR from the break's
close, hold-out 2023-24: displaced 50.1%, weak 50.7%. With the 4h + 1h
side a lean in both halves (hold-out 55.4% vs 47.4%), not proven. It
describes: displaced breaks closed back through their level within 10
candles less often (63% vs 72%), mostly because the close cleared it
further. About 73% of gaps were traded back into within 10 candles. A
big candle that broke nothing read the same afterwards (48.8% vs 48.7%).
No threshold, lean or gate rests on it: it is a read.

## Examples

```text
BOS: 15m BOS up 21412.25 (closed 10:15): displaced, holding; cleared 0.6 ATR.
  Read: continuation by structure; displaced strength.
Weak BOS: 15m BOS up 21412.25 (closed 10:15): weak (closed mid, small), holding.
  Read: still a BOS, continuation by structure; weak strength.
CHoCH: 15m CHoCH down 21350.5 (closed 10:30): displaced, holding; from
  protected high 21372.25: holds.
  Read: a potential reversal down, displaced strength; a BOS down would
  confirm the transition. Against the 4h + 1h it is context (never counter).
CISD: 15m bullish at 21430 (closed 10:15, weak), a weak displacement: no zone.
  Read: a delivery shift up, weak strength; no zone (`cisd`).
Invalidation: 3m BOS up 21412.25 15 min ago: ...; from protected low
  21380.5: broken by a weak close (wicks) 3 min ago.
  Read: the protected low is broken (the close decides); weak strength.
Closed back: 3m BOS up 21412.25 12 min ago: displaced, closed back below
  21412.25 3 min ago; ...; from protected low 21380.5: holds.
  Read: a displaced break, now back under its level; its protected low holds.
Trap 1: the 3m candle line says `displacement up`; no Break quality line.
  Read: a big candle, no structure change.
Trap 2: 15m FVG 21405.5-21409 open near price; 3m BOS up: weak (wicks).
  Read: the gap marks an earlier displacement; this break is weak.
```
