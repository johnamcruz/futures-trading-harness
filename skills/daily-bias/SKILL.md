---
name: daily-bias
description: Use when setting today's bias - long, short or neutral, with confidence, reasons and what flips it - from the prior day, the open, 1h/4h structure.
---

# Daily Bias

Whether price is more likely up or down today, from the higher timeframes
(the trend per timeframe: `multi-timeframe-analysis`).

## When to Use

- Premarket: the bias per timeframe and the levels of the day.
- At the open and each 1h close: today's bias, step by step.

## How It Works

### The daily read

Without `daily` the highest timeframe is the 4-hour: the alignment is then
judged from it, and the plan says "no daily read". Fetch the daily bars once
a session (premarket) and reuse the file; if the fetch fails, go on without
them rather than retrying.

### The bias

The `bias` (long, short, or neutral) weights the higher timeframes more
(score out of ±max): use it for the game plan's headline.

### The levels

The prior RTH day's high and low are in the briefing (`timeframe-sources`).
The daily and 4-hour swing highs and
lows are not in it: take them from `mtf_read` (premarket's daily read).

### Today's bias, step by step

1. **Prior day's candle.** `day.priorRthCandle`: `dir`, `closeLocation`
   (top third: buyers held it), `closeVsDayBefore` (beyond its high or low:
   accepted that way; inside: no lean). A holiday or early-close prior day
   is a weak read.
2. **Price against the prior day.** `m3.location.priorRthRange`,
   `m3.location.priorRthClose` (`above`, `below`, `at`),
   `m3.location.priorValue`: above leans long, below short, inside value
   two-sided. Acceptance beyond the prior high or low is closes holding
   there (`breakout`), not a wick (`breakout-vs-fakeout`).
3. **The open.** `m3.today.openVs`, `m3.today.openType` (a drive leans its
   way, an open-auction is two-sided), and the overnight range
   (`m3.overnight.high`, `m3.overnight.low`): the first levels accepted or
   rejected.
4. **1h and 4h structure.** `h1.lastBreak.last` (`bos-vs-choch`),
   `h1.h1.swingPattern`, `h1.h4.swingPattern`. The higher one sets the
   side; the 1h against it lowers the confidence.
5. **Regime.** `m3.regime.primary`: a trend backs its side; range or
   transition does not.
6. **Write it.** Long, short or neutral; high when steps 1-5 all back it,
   medium when one does not, low when two or more do not; the reasons by
   step; the level that flips it.

**Flips intraday**: a 1h CHoCH against it, or closes back inside the prior
range after a breakout of it.

**Neutral**: expect two-sided trade; the range's extremes (prior range,
value, overnight) are the better locations.

The bias is a read: the trend rule (`multi-timeframe-analysis`) and the
priority order (strategy-library) decide entries. Against the prevailing
trend, trend strategies wait; it never points at a side the rule refuses.

## Examples

```text
Daily UP, 4h UP, 1h UP, 15m DOWN; bias long (score 8 of ±10).
-> Game plan headline: bias long. The daily swing high 21720.50 is the target above,
   69.50 points (278 ticks, $139.00 per MNQ) over 21651.00.
```

NQ, back-adjusted CSV prices:

```text
2023-04-28 09:30, trend rule 4h up: 1 prior day up, top third, above its day
before's high; 2 inside prior value, under the prior close 16230.25; 3 inside the
overnight 16168.00-16235.00; 4 4h HH/HL, 1h CHoCH down at 16188.00; 5 range.
-> Long, low: the 4h sets the side; 2-5 do not back it.
12:00: 2 above the prior range; 3 the overnight high 16235.00 accepted; 4 1h CHoCH
up at 16235.00. -> Long, medium (5 range). Flips on closes back under 16252.25.
```
