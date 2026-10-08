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

1. **Find swings.** Use confirmed fractal swings from market-snapshot
   (`structure.lastSwingHigh/Low`, k=2: a pivot with 2 strictly lower highs or
   higher lows on each side, confirmed 2 bars later). Mark the last 3–4 of each.
2. **Classify the leg.**
   - Uptrend: higher highs (HH) and higher lows (HL).
   - Downtrend: lower highs (LH) and lower lows (LL).
   - Range: swings overlap; price rotates between a defined high and low.
3. **Events.**
   - **BOS (break of structure):** a close beyond the last swing *in the trend's
     direction*, a continuation signal.
   - **CHoCH (change of character):** the first close beyond the last swing
     *against* the trend (e.g. below the last HL in an uptrend). It's an early
     reversal warning, not a reversal by itself; wait for a lower high to form.
   - A wick through a swing that closes back inside is a **sweep**
     (liquidity-concepts), not a break.
4. **Location.** Split the current dealing range (last major swing low to
   high) at 50%. Above = premium (favour shorts / don't chase longs), below =
   discount (favour longs). Within a trend, buy pullbacks into discount and
   sell rallies into premium.
5. **Invalidation.** A long idea is wrong below the swing low that created it;
   a short idea above the swing high. The stop goes beyond that swing plus a
   buffer (≥ 2 ticks or 0.1 × ATR).
6. **Higher timeframe wins.** A 3-minute BOS against a 1-hour downtrend is a
   counter-trend trade: smaller target, stricter skip rules.

## Examples

```text
15m: HH 21620 → HL 21540 → HH 21655 → HL 21590 (uptrend)
3m:  close 21588 below the 21590 HL → CHoCH on 3m, 15m still up.
Read: pullback within an uptrend, not a reversal. Look for a 3m HL and BOS up
for a long; invalidation below 21540 (15m HL).
```

Report structure as facts with prices and times, then the bias, then what
would flip it.
