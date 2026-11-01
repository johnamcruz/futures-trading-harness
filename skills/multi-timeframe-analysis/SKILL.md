---
name: multi-timeframe-analysis
description: Use when reading each timeframe's trend and the trend rule the gate enforces (never counter).
---

# Multi-Timeframe Analysis

The bias (4h + 1h) sets the side, the setup (15m) is the entry, the entry
timing (3m) only times it. This skill makes the trend read the same every
time: one tool reads the trend on each higher timeframe from the bars you
already have, and labels each side.

Elsewhere: the bars and briefing fields per timeframe (`timeframe-sources`),
the day's bias (`daily-bias`), reading the labels from HTF to LTF
(`htf-to-ltf`), and the trend as a rules filter (`mtf-bias-filter`).

## When to Use

- Every trade plan, before risk-manager phase 1: each timeframe's trend, and
  whether the trend rule allows the side (with them, a pullback or against
  them: `htf-to-ltf`).

## How It Works

### 1. The trend per timeframe

Candles align to the 18:00 ET open: 1-hour candles open
on the hour, 4-hour ones at 18:00, 22:00, 02:00, 06:00, 10:00, and 14:00 ET.
Only completed candles decide a trend; the one forming is reported apart.

Each timeframe's trend has three votes:

1. The close against EMA 20.
2. EMA 20 against EMA 50 (no vote with fewer than 50 candles, and the line
   says so).
3. Swing structure: higher highs and higher lows (HH/HL), lower highs and
   lower lows (LH/LL), mixed, or unclear (fewer than two confirmed swing
   highs or lows: no structure vote).

Two votes the same way, and none against, set the trend (UP or DOWN);
anything else is RANGE. Each line also gives ADX, ATR, where the close sits
in the last 20 candles' range, and the swing high and low.

### 2. The trend rule (enforced, not advice)

The prevailing trend is the highest of 4h, 1h, and 15m (built from the
trigger bars) that has one: the 4h when it trends, else the 1h, else the 15m.

- **Every entry**, long or short, every setup and strategy (`mtf:
  reversal` too): never counter: no entry against a trending 4h or 1h,
  whatever CHoCH; both ranging, none against the 15m; none while the 4h has
  fewer than 3 completed candles.
- **In an attempt**: the side rule (`htf-to-ltf`), or no trade.
- **Not in a prop attempt**: nothing trending, both sides are open.

Where it is enforced:

- `strategies_scan` (rules strategies): one that fires against it is not a
  candidate; its why-not (`filtersFailed` in its full result) says `mtf:
  against the 4h down trend ...`. The summary names the frames
  and the prevailing trend; every full result has `mtf` (frames,
  `prevailing`, `longAllowed`, `shortAllowed`).
- The backtester uses the same scan, so its trades obey it.
- The order gate (`mtf-trend`, hard: nothing switches it off) refuses an
  entry against the trend recorded in
  `<FTH_HOME>/mtf/<ROOT>.json`, or with no record or one more than 15 minutes
  (`FTH_MTF_MAX_AGE_MIN`) past its last bar's close. The autonomous runner
  records it every bar and puts its line in the cycle prompt. Interactively,
  record it yourself before any entry:
  `mtf_read` with `{"bars": "<bars>", "record": true, "symbol": "MNQ"}`.
  While the autonomous runner is running, `record` is refused (the runner
  records the symbols it trades): don't trade interactively next to it.

The last line of the read states it, the allowed side first: `Trend rule:
LONG allowed (prevailing 4h up); no short against it.`
The daily (`daily`) is context for your judgment; the rule reads the
intraday frames.

### 3. Write it down

One line per timeframe and the verdict, in the plan entry and the premarket
note, so reviews can grade it:

```text
Daily UP (HH/HL). 4h UP. 1h UP, ADX 26. 15m DOWN (pullback to the 1h EMA20).
Long: pullback (the 15m setup is the entry). Short: counter (no entry).
```

## Examples

```text
mtf_read {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "daily": "/home/u/.futures-trading-harness/bars-scratch/MNQ-1d.json"}
daily: UP (close 21650 vs EMA20 21402.5, EMA20 vs EMA50 21180.25, structure HH/HL), ADX 24.1, ...
4h: UP (close 21652.25 vs EMA20 21590.75, EMA20 vs EMA50 21470.5, structure HH/HL), ADX 21.3, ...
1h: UP (close 21652.25 vs EMA20 21630.5, EMA20 vs EMA50 21588, structure HH/HL), ADX 26.0, ...
15m: DOWN (close 21652.25 vs EMA20 21661, EMA20 vs EMA50 21664.5, structure LH/LL), ADX 18.2, ...
Alignment: long pullback, short counter; bias long (score 8 of ±10).
Trend rule: LONG allowed (prevailing 4h up); no short against it.

-> Longs are a pullback: the 15m setup up is the entry, on the next 3m bar;
   the trail exits. Shorts are counter: refused (scan and gate), whatever CHoCH.

mtf_read {"bars": "/home/u/.futures-trading-harness/bars/NQ-3m.csv"}    (the parity fixture tests/fixtures/parity/NQ-3m.csv, copied to the bar directory by the user)
4h: UP (... structure HH/HL), ... (18 candles: no EMA50 vote, needs 50)
1h: RANGE (... structure mixed), ADX 14.14, ...
15m: DOWN (... structure LH/LL), ADX 22.59, ...
Alignment: long mixed, short counter; bias long (score 2 of ±6).
Trend rule: LONG allowed (prevailing 4h up); no short against it.

-> Longs: mixed (the priority order's step 4). Shorts: against the 4-hour trend, refused.
```
