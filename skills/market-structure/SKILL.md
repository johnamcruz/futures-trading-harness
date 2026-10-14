---
name: market-structure
description: Read futures market structure - swing highs/lows, trend vs range, break of structure (BOS), change of character (CHoCH), premium/discount, and where a trade idea is invalidated. Use for any directional bias, entry location, or stop placement decision.
---

# Market Structure

## When to Use

- Forming a directional bias on any timeframe.
- Choosing where a stop belongs (behind structure, not at an arbitrary distance).
- Deciding whether a breakout is continuation or a reversal attempt.

## How It Works

In an autonomous cycle the bar briefing (`bar_briefing`, the
`bar-briefing` skill) holds this bar's structure (`m3`, `m15`, `h1`): use
it, and compute only what it doesn't hold.

1. **Swings**: how they are confirmed, the `bos-vs-choch` skill. Mark
   the last 3-4 of each.
2. **Trend, range or transition**: the `trend-vs-range` skill.
3. **Events**: BOS and CHoCH, and what each means by timeframe, the
   `bos-vs-choch` skill; a move against the trend, `pullback-vs-reversal`;
   a wick through a swing, `breakout-vs-fakeout`.
4. **Location.** Split the current dealing range (last major swing low to
   high) at 50%: above is premium, below is discount. Within a trend,
   pullbacks into discount (premium for shorts) are where continuation
   setups sit.
5. **Invalidation**: the `invalidation` skill (the stop stays the
   strategy's).
6. **Higher timeframe wins** (`bos-vs-choch`, by timeframe).

## Examples

```text
15m: HH 21620 → HL 21540 → HH 21655 → HL 21590 (uptrend)
3m:  close 21588 below the 21590 HL → CHoCH on 3m, 15m still up.
Read: a pullback inside an uptrend until the 15m breaks (pullback-vs-reversal);
the idea is wrong below 21540 (the 15m HL).
```

Report structure as facts with prices and times, then the bias, then what
would flip it.
