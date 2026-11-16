---
name: trend-vs-range
description: Trader-process steps 1-2 - whether each timeframe trends, ranges, chops or is in transition, and whether the trend has declared itself. A read, never a veto.
---

# Trend vs Range

## When to Use

- Trader-process step 1 (HTF), and the regime in step 2.
- An entry: has the day's trend declared itself your way yet?

## How It Works

A read, never a veto: the count decides (`confluence-counting`). Code holds
the regime only by a policy's `entry` rule. A missing field is `unknown`.

Each timeframe's trend is its votes (`multi-timeframe-analysis`; read
`<15m|1h|4h> up|down|range`).

**The computed regime** (`m3.regime.primary`; 15m:
`m15.indicators.regime.primary`; read `regime <name>`):

- `trend-up`: ADX(14) at least 20 (`m3.regime.metrics.adx`), at most 3
  session-VWAP crosses in the last 30 bars (`m3.vwap.sessionCrossesLast30`),
  EMA(20) up at least 0.3 ATR(14) over 5 bars, the close above EMA(50).
- `trend-down`: the mirror.
- `range`: neither, and ADX under 18 or 5 or more crosses.
- `transition`: everything else.

**Structure**: swings and breaks per timeframe (`bos-vs-choch`). A stop
belongs behind structure (a swing), not at an arbitrary distance (`invalidation`).

**The read**, per timeframe:

- trend: regime `trend-up`/`trend-down`, swings HH/HL (LH/LL), the breaks
  a sequence of BOS that way;
- range (geometry): regime `range`, swings `mixed`, price rotating
  between a support and a resistance it keeps; a 15m setup the HTF way
  inside an HTF trend is the pullback ending (`pullback-vs-reversal`), not
  a range;
- transition: regime `transition`, or regime and structure disagree.

Trending: consistent BOS, directional displacement, follow-through. Chop:
alternating BOS/CHoCH, overlapping candles, failed continuation.

**Chop** (owner's definition; quality, not geometry): price swings back
and forth with no sustained control either way. The owner: "Use CHoCH as
structural evidence and overlap, displacement, and failed continuation as
behavioral evidence"; a CHoCH pair alone is not enough, and chop needs no
pair. Before calling it chop, his checklist:

- "Are the opposing CHoCHs breaking meaningful swing points?"
- "Is price overlapping and moving sideways?"
- "Has the existing trend failed to continue?"
- "Is price repeatedly reversing rather than making directional progress?"
- "If price continues making higher highs and higher lows, it may simply
  be a bullish trend with internal structure changes."

Behavioral evidence (owner): "Candle overlap. Lack of displacement.
Repeated rejection from the same boundaries. Lack of meaningful higher
highs or lower lows. Failure to make directional progress." The `chop:`
line names which were met. The class word is the Market state line's
(`trade-session`), never this definition's. One CHoCH warns. Structure
broken both ways with no continuation is chop, not a run of reversals.
Chop ends on displacement: a displaced 3m break or CISD, a displaced
close beyond the IB, or a transition.

**Chop is not range.** Chop needs no edges; a range can rotate cleanly.
A range travels edge to edge with displacement and clean rejections at
the edges; chop overlaps mid-range and fails before either edge. A range day inside the 4h + 1h side (the line prints
`range`) is catchable: the turn at the edge the side's way, or the
breakout with follow-through. The line prints `chop` → sit out, whatever
the geometry.

**The owner's classes** (the line's state words beside them):

| Classification | Meaning | Response |
|---|---|---|
| Trend (`trend`, `in the up leg`) | directional structure and continuation healthy | trend setups allowed |
| Weakening trend (`weakening`, `rotation`) | countertrend momentum increasing | reduce confidence; wait |
| Transitioning (`transition`) | original direction failing, new not confirmed | avoid premature entries |
| Chop (`chop`) | overlap and repeated failed continuation | avoid trend entries |
| Reversal (`reversal confirmed`) | meaningful structural shift confirmed | evaluate the new direction |

`CHoCH then BOS: transition confirmed` prints under `trend`, `in the
leg` or `weakening`, never the `transition` state: the new leg, its old protected level
unbroken; a reversal once a close goes through that level. A
reversal against the 4h + 1h side is never traded. Frames:
transitional (old trend weakening, new one unconfirmed) is the frame
`transition` in your STATE. The class word: the Market state line.

The 3m read sits inside `h1.h4.trend`, `h1.h1.trend` (prop: both its
way), `m15.frame.trend`;
`m3.trendRule` wins where they differ. Indicators confirm structure, never
override it. Side: `htf-to-ltf`.

**Declared yet?** (`Trend declared?` line; ATR, + your way; census
hypotheses):

- Declared (any one): regime `with`, overnight range broke out its way,
  RTH VWAP +1 to +2.5, day's move +3 or more.
- Not yet (false starts): RTH VWAP and EMA20 under 0 (EMA20 under -1
  worse), regime `against`, inside the overnight range (back third worst):
  wait for it, in the count; size is the verdict's.

## Examples

```text
Chop: the line prints `chop: the down leg's last break failed, LH 21440.25 holds (a failed break)` -> sit out.
  It prints `trend up: HL 21380.5 holds, BOS up 6 min ago (displaced)` -> trend-up.
Take: 4h, 1h, 15m up; m3 trend-up (adx 24.10); overnight broke out its way. Read: trend.
  Reads: 1h up, 15m bos up. Priority order: aligned; the count for -> take.
Skip: m3 transition (adx 19.20); CHoCH down, previous CHoCH up; 15m up. Read: transition.
  Reads: regime transition, read long mixed; the priority order's rule (contradicting facts) decided skip.
Loser: not yet declared (EMA20 -0.4); long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ);
  CHoCH down, stopped: -17 ticks, -$8.50. A right read gives odds, not a promise.
```
