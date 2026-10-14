---
name: vwap-volume-profile
description: Use session and RTH VWAP, the volume profile (POC, value area, high and low volume nodes), the day so far (open type, initial balance, day type), and relative volume to judge trend quality, fair value, and participation in futures. Use when evaluating mean-reversion vs trend days, where price sits against value, targets at volume nodes, or whether a breakout has participation.
---

# VWAP and Volume

## When to Use

- Deciding trend day vs rotation day.
- Grading a breakout's participation.
- Choosing pullback entry areas.
- Placing targets and judging room: the next high or low volume node.
- The value area strategies (`value_area_reentry`, `value_area_breakout`).

## How It Works

In an autonomous cycle the bar briefing (`bar_briefing`, the
`harness-tools` skill) holds this bar's VWAP, participation and profiles
(`m3`, `day`): use it, and compute only what it doesn't hold.

1. **VWAP** from market-snapshot: `vwapSession` (anchored 18:00 ET, Globex) and
   `vwapRth` (anchored 09:30 ET). `vwapRth` is null before today's 09:30 ET
   open and after 16:00 ET: use `vwapSession` then, as the strategy filters
   do. The briefing's `m3.vwap`: which VWAP applies now (`applies`: `rth`
   or `session`), the distance in ATR(14) (`distanceAtr`), and the closes
   crossing each VWAP in the last 30 bars (`rthCrossesLast30`,
   `sessionCrossesLast30`; read the one that applies).
   - Price above a rising RTH VWAP, with pullbacks holding it → buyers in
     control; buy pullbacks to VWAP.
   - Price crossing VWAP repeatedly → rotation day; fade extremes, small
     targets, or stand aside.
   - Distance from VWAP in ATRs: beyond ~2 × ATR(14) on the trigger timeframe
     is stretched; don't chase.
2. **Relative volume**: the participation fields, as computed, are the
   `momentum-and-volume` skill's.
3. **Volume profile.** Don't estimate it by hand: market-snapshot's
   `volumeProfile` has three, computed from closed bars
   (`scripts/lib/trading/volume-profile.js`):
   - `priorRth`: the last complete RTH day. The reference for the day; fixed.
   - `session`: this Globex session from 18:00 ET, developing.
   - `rolling`: the last 360 bars (`vpLookback`).

   Each has `poc` (point of control: the most-traded price), `vah`/`val`
   (the value area: 70% of the volume around the POC), `price` (above,
   inside, or below value, from the exact levels: a shown VAH a tick under
   price can still read inside), `fromPocAtr` ((price - POC) / ATR(14)),
   and the nodes: `hvn` (high volume:
   acceptance, where moves stall and rotate) and `lvn` (low volume:
   rejection, where price moves fast), with the nearest above and below
   (`hvnAbove`, `lvnBelow`, ...). Strategies read the same levels as
   `prior_poc prior_vah prior_val`, `session_*`, `vp_*(n)`, and the nodes.
   - Open outside the prior value area, then back inside for two closes →
     rotation to the far side is likely (the 80% rule, `value_area_reentry`).
   - Two closes outside value on above-average volume → value is moving
     (`value_area_breakout`); the next HVN is the likely stall, an LVN
     beyond the entry is open air.
   - Inside value with VWAP flat → rotation: fade VAH/VAL toward the POC,
     small targets.
   - A POC at one end of a wide value area means the day trended: a weak
     reference for the next day.
   - Levels are computed on a 100-row grid over the day's range, and shown
     on the contract's tick (as in the briefing) for a harness bars file or
     with `symbol`; otherwise to two decimals, between ticks: round to
     `tickSize` before using one as an order price.

   It is a bar-based approximation (each bar's volume spread evenly over its
   range), not a tick-level profile. Say so when you cite it.
4. **Volume climax**: the `absorption` skill.
5. **The day so far** (`m3.today`, from the 09:30 ET open; the prompt's
   "day:" line says the same): the open against the prior RTH day
   (`openVs`: inside the prior value area, outside value inside the range,
   or outside the range), the `gap` from the prior close, the `openType`
   (open-drive, open-test-drive, open-rejection-reverse, open-auction, from
   the first 30 minutes), the initial balance (`ibHigh`, `ibLow`, the first
   hour) and how far the day has gone past it (`extUp`, `extDown`), the
   `dayType` so far (inside the initial balance; normal variation: one side
   extended, under 2 IBs; trend: 2 IBs or more, or 1 from a narrow IB under
   0.35 ADR; neutral: both sides), and the range against the average daily
   range (`rangeVsAdr`, over 10 days).

## Examples

```text
10:09 ET: MNQ opened 21462.50, below the prior day's VAL 21480.00
(volumeProfile.priorRth: POC 21522.00, VAH 21560.00). Two 3m closes back
inside, 21486.00 and 21490.25 → value_area_reentry long, target VAH
21560.00, 69.75 points away; the POC at 21522.00 is the halfway mark.

09:52 ET: 3m close above OR high, v = 2,140 vs OR average 1,180 (1.8×), price
0.6 ATR above rising RTH VWAP → participation confirmed for the orb strategy.

11:30 ET: 6 crosses of RTH VWAP in 90 min, ADX 14 → rotation; trend strategies
off until a range break.
```
