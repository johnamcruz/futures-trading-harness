---
name: multi-timeframe-analysis
description: Use when reading each timeframe's trend and the trend rule the gate enforces (mtf trend|reversal).
---

# Multi-Timeframe Analysis

Elsewhere: bars and briefing fields per timeframe (`timeframe-sources`),
the day's bias (`daily-bias`), labels HTF to LTF (`htf-to-ltf`), the trend
as a rules filter (`mtf-bias-filter`).

## When to Use

- Every trade plan, before risk-manager phase 1: each timeframe's trend
  and whether the trend rule allows the side (with, pullback, against:
  `htf-to-ltf`).

## How It Works

### 1. The trend per timeframe

- Candles open from 18:00 ET: 1h on the hour; 4h at 18:00, 22:00, 02:00,
  06:00, 10:00, 14:00 ET. Only completed candles count; the forming one is
  reported apart.
- Votes: close vs EMA 20; EMA 20 vs EMA 50 (no vote under 50 candles, the
  line says so); structure HH/HL, LH/LL, mixed, or unclear (under two
  confirmed swing highs or lows: no vote).
- Two votes one way, none against: UP or DOWN; else RANGE.
- Also per line: ADX, ATR, the close's place in the last 20 candles'
  range, the swing high and low.

### 2. The trend rule (enforced, not advice)

Prevailing trend: the 4h if trending, else 1h, else 15m (from the trigger
bars).

- **Trend strategies** (STRATEGY.md without `mtf: reversal`): never
  against the prevailing trend; wait while the 4h has fewer than 3
  completed candles. None of the three trends: both sides open.
- **Reversal strategies** (`mtf: reversal`): may fade it (a raid at a
  higher-timeframe level); the priority order (strategy-library, step 2)
  decides level, size, target.

Enforced:

- `strategies_scan`: against it, a trend strategy is no candidate; why-not
  (`filtersFailed`, full result): `mtf: against the prevailing 4h down trend ...`.
  The summary names frames and prevailing trend; each full result has
  `mtf` (frames, `prevailing`, `longAllowed`, `shortAllowed`).
- The backtester: the same scan.
- The order gate (`mtf-trend`, hard, never off) refuses a trend strategy's
  entry against the trend in `<FTH_HOME>/mtf/<ROOT>.json`, with no record,
  or one over 15 min (`FTH_MTF_MAX_AGE_MIN`) past its last bar's close.
- The runner records it every bar; its line is in the cycle prompt.
  Interactive: record before any entry, `mtf_read`
  `{"bars": "<bars>", "record": true, "symbol": "MNQ"}`. While the runner
  runs, `record` is refused: don't trade interactively beside it.
- The read's last line states it (`Trend rule: ...`). The daily (`daily`)
  is judgment context; the rule reads intraday frames.

### 3. Write it down

One line per timeframe plus the verdict, in the plan and premarket note:

```text
Daily UP (HH/HL). 4h UP. 1h UP, ADX 26. 15m DOWN (pullback to the 1h EMA20).
Long: pullback (wait for a 3m shift up). Short: counter.
```

## Examples

```text
mtf_read {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "daily": "/home/u/.futures-trading-harness/bars-scratch/MNQ-1d.json"}
daily: UP (close 21650 vs EMA20 21402.5, EMA20 vs EMA50 21180.25, structure HH/HL), ADX 24.1, ...
4h: UP (close 21652.25 vs EMA20 21590.75, EMA20 vs EMA50 21470.5, structure HH/HL), ADX 21.3, ...
1h: UP (close 21652.25 vs EMA20 21630.5, EMA20 vs EMA50 21588, structure HH/HL), ADX 26.0, ...
15m: DOWN (close 21652.25 vs EMA20 21661, EMA20 vs EMA50 21664.5, structure LH/LL), ADX 18.2, ...
Alignment: long pullback, short counter; bias long (score 8 of ±10).
Trend rule: prevailing trend 4h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.
-> Long: pullback; wait for a 3m shift up (3m bos up), target the 1h swing high.
   Short: counter; a trend strategy's is refused (scan and gate); a composed
   one needs a 1h CHoCH down and a 4h rejection (`trade-lifecycle`).

mtf_read {"bars": "/home/u/.futures-trading-harness/bars/NQ-3m.csv"}
4h: UP (... structure HH/HL), ... (18 candles: no EMA50 vote, needs 50)
1h: RANGE (... structure mixed), ...
Alignment: long mixed, short counter; bias long (score 2 of ±6).
-> Long: mixed (step 4 sizes it). Short: against the 4h, refused for trend strategies.
```
