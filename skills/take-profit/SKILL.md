---
name: take-profit
description: Use when choosing where to take profit - swing highs and lows per timeframe, the prior 1h and 4h candle's high, low and mid, FVG edges, room in R.
---

# Take Profit

## When to Use

- Trader-process step 7: where the trade's target sits and whether the
  room to it pays for the stop.

## How It Works

A read of where price may stop, never a veto: the priority order
(strategy-library) decides take, skip and size. The trail exits (read
forms below): these levels are context, never the exit.

**Target levels**, on the winning side of the entry, completed candles
only:

- **Pivot highs and lows**: the next untaken confirmed swing per
  timeframe, `m3.swingTargets.above` and `m3.swingTargets.below` (15m,
  1h and 4h; `frame`, `price`, `points`, `ticks`, `R`).
  Stops rest beyond a swing (`levels-and-reactions`).
- **The prior 1h and 4h candle's high, low and midpoint**:
  `m3.rangeTargets`, per frame its `high`, `mid` and `low`: where that candle's buyers and sellers
  stopped, and its balance, where a move back into the range often
  pauses. The mid is exact ((high + low) / 2) and may sit between ticks;
  its `points`, `ticks` and `R` are to the tick toward price. A side the
  candle forming has already taken (`taken`) is spent as a target; the
  far side remains.
- **Fair value gap edges**: the near edge of an open gap ahead of price;
  a partly filled gap, its unfilled part only (`fair-value-gaps`).
- **The candle forming**: its midpoint moves until it closes, so it is a
  target only once completed.

**Read forms** (the target step): `target trail` (the 2R mark arms it),
every entry the side rule gives; a level ahead is context, never a
requirement. Not in a prop attempt, on a side the side rule doesn't give:
`target <tf> swing high|low <price>`, `target prior 1h|4h high|mid|low
<price>` (a taken side reads false), `target <15m|1h> fvg high|low
<price>`; none named: `target 2r`. A key level within 1R in front caps the first
push: evidence; prefer the turn after it.

**Timeframe weight** (hypothesis, not measured): a higher timeframe's
level holds more orders and reacts more often; levels a few ticks apart
are one zone.

**Room in R.** The briefing's `R` is against the reference stop
(`m3.oneR`). Against the trade's own stop (`order_plan`'s distance, the
trade's 1R), a target's R is its points over the stop's points. The first
level ahead (`inTheWay`) is a read, not a cap: price often trades through it.
A target under the strategy's `risk.min_rr` doesn't pay for the stop.
Round a target toward the entry (`trade-plan`).

**After the entry**: partial exits, runners and trailing are management's
(`manage-position`); what ends the idea before the target is
`invalidation`; the exit the plan states is `trade-plan`'s.

## Examples

MNQ (tick 0.25, $0.50 a tick), prices illustrative:

```text
Long 21540.25, stop 21528.75 (11.50 pts = 46 ticks, $23.00 per MNQ).
15m swing high 21556.00: 15.75 pts = 63 ticks, $31.50, 1.37R (nearest).
Prior 1h high 21562.75: 22.50 pts = 90 ticks, $45.00, 1.96R.
1h swing high 21575.50: 35.25 pts = 141 ticks, $70.50, 3.07R (extended).

Long 21545.50, stop 21537.25 (8.25 pts = 33 ticks, $16.50 per MNQ).
Prior 1h high 21580.00, low 21540.25: mid 21560.125, between ticks;
toward the entry: 21560.00 = 14.50 pts = 58 ticks, $29.00, 1.76R.

Short 21490.00, stop 21501.25 (11.25 pts = 45 ticks, $22.50 per MNQ).
Prior 1h low 21471.75: 18.25 pts = 73 ticks, $36.50, 1.62R.
Prior 4h low 21440.50: 49.50 pts = 198 ticks, $99.00, 4.40R (extended).
```
