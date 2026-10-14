---
name: daily-bias
description: Use when setting today's bias - up, down or neutral, with confidence, reasons and what flips it - from the prior day, the open, 1h/4h structure and levels.
---

# Daily Bias

Whether price is more likely up or down today, from the higher timeframes
(the trend per timeframe: `multi-timeframe-analysis`).

## When to Use

- Premarket: the bias per timeframe and the levels of the day.
- At the open and at each 1h close: today's bias, by the procedure below.

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

Each step is a briefing fact; one it lacks is `unknown`.

1. **Prior day's candle.** `day.priorRthCandle`: `dir`, `closeLocation`
   (top third: buyers held it; bottom: sellers), `closeVsDayBefore` (above
   its high or below its low: accepted that way; inside: no lean).
2. **Price against the prior day.** `m3.location.priorRthRange`,
   `m3.location.priorRthClose`, `m3.location.priorValue`: above and holding
   leans up, below down, inside value two-sided. Acceptance beyond the prior
   high or low is completed closes holding there (`mtf-breakout`), not a wick
   (`breakout-vs-fakeout`).
3. **The open.** `m3.today.openVs`, `m3.today.openType` (a drive leans its
   way, an open-auction is two-sided), and the overnight range
   (`m3.overnight.high`, `m3.overnight.low`): the first levels to accept or
   reject.
4. **1h and 4h structure.** `h1.lastBreak.last` (`bos-vs-choch`),
   `h1.h1.swingPattern`, `h1.h4.swingPattern`. It weighs most: steps 1-3
   lean, structure decides.
5. **Regime.** `m3.regime.primary`: a trend backs its side; range or
   transition lowers the confidence.
6. **Write it.** Up, down or neutral; confidence high when 1-5 agree,
   medium when one disagrees, low when structure and the day disagree; the
   reasons by step; the level that flips it.

**Flips intraday**: a 1h CHoCH against it, or closes back inside the prior
range after a breakout of it. Restate the bias then.

**Neutral**: only the range's extremes (prior range, value, overnight)
toward the other side, or nothing. A read: the trend rule and the priority
order (strategy-library) decide entries.

## Examples

```text
Daily UP, 4h UP, 1h UP, 15m DOWN; bias long (score 8 of ±10).
-> Game plan headline: bias long. The daily swing high 21720.50 is the target above,
   69.50 points (278 ticks, $139.00 per MNQ) over 21651.00.
```

NQ, back-adjusted CSV prices (local history, read by the harness):

```text
2023-04-28 09:30: 1 prior day up, top third, above its day before's high; 2 inside
prior value, under the prior close 16230.25; 3 overnight 16168.00-16235.00; 4 1h
CHoCH down at 16188.00, 4h HH/HL; 5 range. -> Up, medium (1h against).
12:00: 1h CHoCH up at 16235.00, price above the prior range -> up, high.
```
