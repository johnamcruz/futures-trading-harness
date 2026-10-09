---
name: multi-timeframe-analysis
description: Top-down futures analysis across timeframes - daily and 4h for context, 1h for bias, 15m for the setup, the trigger timeframe (3m/1m) for the entry. A mechanical read (scripts/mtf.js) gives each timeframe's trend and labels a long or a short aligned, pullback, counter, or mixed. The trend rule is enforced in code - a trend strategy never enters against the prevailing 4h/1h/15m trend, only a reversal strategy (mtf: reversal) may fade it - by the scan, the backtester, and the order gate. Use for every bias, game plan, and trade plan, and whenever timeframes disagree.
---

# Multi-Timeframe Analysis

A trigger on 3-minute bars is worth more when the timeframes above it point
the same way, and it is a pullback (or a trap) when they don't. This skill
makes that read the same every time: one script reads the trend on each
higher timeframe from the bars you already have, and labels each side.

## When to Use

- Premarket: the bias per timeframe and the levels of the day.
- Every trade plan, before risk-manager phase 1: is this setup with the
  higher timeframes, a pullback inside them, or against them?
- Whenever the trigger timeframe and a higher timeframe disagree.

## How It Works

### 1. Get the bars (one request per timeframe at most)

`get_bars` allows 50 requests per 30 s across all agents. The higher
intraday timeframes are built from the trigger bars, so you rarely need more
than two requests:

| Role | Timeframe | Source |
|---|---|---|
| Context | daily | `node <root>/scripts/bars.js --symbol <SYMBOL> --daily` (60 bars to `/tmp/fth/<SYMBOL>-1d.json`) |
| Context | 4 hours | built from the trigger bars (its EMA50 vote needs 50 candles, about 4000 3m bars; with fewer it votes on two, and the line says so) |
| Bias | 1 hour | built from the trigger bars |
| Setup | 15 minutes | built from the trigger bars |
| Trigger | 3 minutes (1 minute for the flow strategies) | the runner's bars file (at least 2000 bars), or `node <root>/scripts/bars.js --symbol <SYMBOL> --timeframe 3 --record` (2000 bars to `/tmp/fth/<SYMBOL>-3m.json`, and the read recorded for the gate) |

Without `--daily` the highest timeframe is the 4-hour: the alignment is then
judged from it, and the plan says "no daily read". Fetch the daily bars once
a session (premarket) and reuse the file; if the fetch fails, go on without
them rather than retrying.

### 2. Run the read

```bash
node <root>/scripts/mtf.js <trigger bars> --daily=/tmp/fth/<SYMBOL>-1d.json
node <root>/scripts/mtf.js <trigger bars> --tf=15,60,240 --json    # every number
```

`<trigger bars>` is the runner's bars file (e.g.
`~/.futures-trading-harness/bars/MNQ-3m.json`), a `bars.js` file, or a
CSV / Parquet file. Candles align to the 18:00 ET open: 1-hour candles open
on the hour, 4-hour ones at 18:00, 22:00, 02:00, 06:00, 10:00, and 14:00 ET.
Only completed candles decide a trend; the one forming is reported apart.

Each timeframe's trend has three votes:

1. The close against EMA 20.
2. EMA 20 against EMA 50 (no vote with fewer than 50 candles, and the line
   says so).
3. Swing structure: higher highs and higher lows (HH/HL), lower highs and
   lower lows (LH/LL), or mixed.

Two votes the same way, and none against, set the trend (UP or DOWN);
anything else is RANGE. Each line also gives ADX, ATR, where the close sits
in the last 20 candles' range, and the swing high and low.

### 3. The trend rule (enforced, not advice)

The prevailing trend is the highest of 4h, 1h, and 15m (built from the
trigger bars) that has one: the 4h when it trends, else the 1h, else the 15m.

- **Trend strategies** (every strategy unless its STRATEGY.md says
  `mtf: reversal`): never enter against the prevailing trend, and wait while
  the 4h has fewer than 3 completed candles. With no trend on any of the three,
  both sides are open.
- **Reversal strategies** (`mtf: reversal`: `crt_1h`, `crt_4h`, `cisd_ote`,
  `ofi_absorption`): may fade it. That is their setup, a raid at a
  higher-timeframe level; plan them at half size and the nearest target when
  they do (the table below).

Where it is enforced:

- `strategies.js scan`: a trend strategy that fires against it is not a
  `candidate`; `filtersFailed` says `mtf: against the prevailing 4h down
  trend ...`. Every result has `mtf` (frames, `prevailing`, `longAllowed`,
  `shortAllowed`).
- The backtester and RL training use the same scan, so their trades obey it.
- The order gate (`mtf-trend`, hard: nothing switches it off) refuses a trend
  strategy's entry against the trend recorded in
  `<FTH_HOME>/mtf/<ROOT>.json`, or with no record or one more than 15 minutes
  (`FTH_MTF_MAX_AGE_MIN`) past its last bar's close. The autonomous runner
  records it every bar and puts its line in the cycle prompt. Interactively,
  record it yourself before any entry:
  `node <root>/scripts/mtf.js <bars> --record --symbol MNQ`.

The last line of `mtf.js` states it: `Trend rule: prevailing trend 4h up;
trend strategies may not go short, reversal strategies (mtf: reversal) may.`
The daily (`--daily`) is context for your judgment; the rule reads the
intraday frames.

### 4. Read the alignment

From the highest timeframe down, for each side:

| Label | Means | What to do |
|---|---|---|
| `aligned` | no timeframe against it, most with it | Trade the strategy's setup at its normal size (position-sizing) and its full target |
| `pullback` | every timeframe above the lowest is with it; the lowest is against it | The setup timeframe is pulling back. Wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then enter. Do not enter while it is still moving against you |
| `mixed` | timeframes disagree without a clear pullback | Half size, `floor(size / 2)` (skip if that is 0), or the nearest opposing level as the target; skip in a quiet session |
| `counter` | the highest timeframe is against it | Skip, unless the strategy is a reversal at a higher-timeframe level (CRT raids, absorption) and the plan says why; then half size (`floor(size / 2)`, skip if 0) and the nearest target |

A policy strategy's verdict is already sized by its policy: the read goes in
the plan, but it doesn't halve the verdict.

The `bias` (long, short, or neutral) weights the higher timeframes more
(score out of ±max): use it for the game plan's headline.

Reversal strategies (`crt_1h`, `crt_4h`, `ofi_absorption`, `cisd_ote`) trade
against the lower timeframes by design, and the trend rule lets them fade
the prevailing trend. Judge the setup against the timeframe above its range
candle (for `crt_1h`, the 4-hour trend; for `crt_4h`, the daily): against
that one too, it is a `counter` reversal (half size, nearest target).

### 5. Levels flow down

Take levels from the higher timeframes (the daily and 4-hour swing highs and
lows, the previous candle's high and low on each, the prior day's high and
low) and treat them as targets on the trigger timeframe, or as reasons to
skip a setup that runs straight into one.

### 6. Write it down

One line per timeframe and the verdict, in the plan entry and the premarket
note, so reviews can grade it:

```text
Daily UP (HH/HL). 4h UP. 1h UP, ADX 26. 15m DOWN (pullback to the 1h EMA20).
Long: pullback (wait for a 3m shift up). Short: counter.
```

### 7. In rules (mechanical strategies)

`mtf_bias(m)` is the same trend per bar, causal (each bar sees only candles
completed before it): 1 up, -1 down, 0 range. Add it to a strategy's rules
to keep its trades with the higher timeframe, and backtest both versions:

```yaml
rules:
  long:
    - close crosses_above ema(20)
    - mtf_bias(60) > 0          # the 1-hour trend is up
    - mtf_bias(240) >= 0        # and the 4-hour isn't down
```

The ported strategies keep their source's rules (parity); try a filter in a
copy (e.g. `strategies/ema_cross_mtf/`) and compare the two with
`scripts/backtest.js`.

## Examples

```text
$ node <root>/scripts/mtf.js ~/.futures-trading-harness/bars/MNQ-3m.json --daily=/tmp/fth/MNQ-1d.json
daily: UP (close 21650 vs EMA20 21402.5, EMA20 vs EMA50 21180.25, structure HH/HL), ADX 24.1, ...
4h: UP (close 21652.25 vs EMA20 21590.75, EMA20 vs EMA50 21470.5, structure HH/HL), ADX 21.3, ...
1h: UP (close 21652.25 vs EMA20 21630.5, EMA20 vs EMA50 21588, structure HH/HL), ADX 26.0, ...
15m: DOWN (close 21652.25 vs EMA20 21661, EMA20 vs EMA50 21664.5, structure LH/LL), ADX 18.2, ...
Alignment: long pullback, short counter; bias long (score 8 of ±10).
Trend rule: prevailing trend 4h up; trend strategies may not go short, reversal strategies (mtf: reversal) may.

-> Longs are a pullback: wait for a 3m shift up (ema_cross or bos long), target the 1h swing high.
   Shorts are counter: a 3m keltner short is refused (scan and gate); only a
   crt_1h raid of the 1h high could short, at half size.

$ node <root>/scripts/mtf.js <root>/tests/fixtures/parity/NQ-3m.csv
4h: UP (... structure HH/HL), ... (18 candles: no EMA50 vote, needs 50)
1h: RANGE (... structure mixed), ADX 14.14, ...
15m: DOWN (... structure LH/LL), ADX 22.59, ...
Alignment: long mixed, short counter; bias long (score 2 of ±6).
Trend rule: prevailing trend 4h up; trend strategies may not go short, reversal strategies (mtf: reversal) may.

-> Longs: mixed (half size or nearest target). Shorts: against the 4-hour trend, refused for trend strategies.
```
