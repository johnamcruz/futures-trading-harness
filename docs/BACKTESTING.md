# Backtesting

`scripts/backtest.js` replays historical bars through the strategies the way
algoTraderBot's backtester does. After every closed bar it does three things,
in order:

1. **Settle.** A simulated broker settles the open trade against the bar.
2. **Manage.** The stop is trailed, and the trade can time out or be closed
   at end of day.
3. **Look for an entry.** When flat, every strategy is checked for an entry
   on that bar.

The entry check is the same code the live scan runs
(`scripts/lib/trading/evaluator.js`). So a backtest trades exactly the
entries the live harness would see, with no model or API in the loop.

## When to Use

- Before setting a strategy to `status: active`, and after any change to it.
- To compare exit settings (fixed target vs trailing) or sizing on the same
  data.
- To check a new `rules` strategy fires where you expect.

## How It Works

```bash
# A quick run on one file
node scripts/backtest.js --data data/NQ_3min.parquet --symbol MNQ --start 2025-01-01 --end 2025-04-01

# A configured run
cp mcp-configs/backtest.example.json backtest.json
node scripts/backtest.js --config backtest.json

# Optional: download 1-minute bars from ProjectX to a file first
node scripts/backtest.js fetch --contract CON.F.US.MNQ.H25 --from 2025-03-03 --to 2025-03-15 --out data/MNQ-1m.csv
```

### Data

Bars come from files:

- **Parquet** (`.parquet`, `.pq`) as written by pandas/pyarrow, polars,
  fastparquet, DuckDB, and the like. Supported:
  - codecs: snappy, gzip, zstd, brotli, LZ4, none
  - dictionary and plain encodings
  - data pages v1 and v2
  - timestamps in ms, µs, ns, or INT96
- **Excel** (`.xlsx`, `.xlsm`): the first sheet, or `sheet` in the config.
- **CSV** and **JSON** (projectx `get_bars` output).

The table needs a header with a time column (`time`, `timestamp`,
`datetime`, `date`, `ts`, `t`, or a pandas datetime index) and `open`,
`high`, `low`, `close`, and optionally `volume`. Any letter case works.

- **Times:** ISO 8601, epoch seconds, ms, µs or ns, Parquet timestamps, or
  Excel dates.
- **Time zone:** times with no zone are UTC.
- **Bar times:** each bar is stamped with its open time.

Use bars at the trading timeframe, or finer bars that divide it (1-minute
data runs a 3-minute backtest). Micro contracts can use the full contract's
bars (`MNQ` on `NQ` data), as algoTraderBot does.

### Each bar

| Step | What happens |
|---|---|
| Broker | The resting stop and target are checked against the bar. The stop wins if both are touched. A stop fills at its price, or at the open if the bar gapped through it. A target fills at its price, or at a better open. |
| Manage | A bar that starts with a trade open only manages it (as in algoTraderBot): a trade closed here makes no new entry on the same bar. **Trailing exits:** the peak follows the bar's high (longs) or low (shorts). From `trail_activate_r` on, the stop sits `trail_giveback_r` behind the peak. It moves toward the market only and is rounded to the tick. If the bar already crossed the new stop, the trade closes at the bar's close, as algoTraderBot does. **Then, in order:** `max_bars`, and end of day at `eodAt` (with harness rules). |
| Entry | Strategies are checked in priority order. The first candidate enters at the bar's close (plus `slippageTicks`). The stop is the strategy's distance (`atr:k` × ATR(20), or cisd_ote's pivot) rounded to whole ticks. The target is set when the exit plan has one. |

**Harness rules** (`gate: true`, the default) apply what the live harness
enforces:

- The runner's `sessions` and `eodAt`.
- From the order gate, with the same `FTH_*` settings as live (read from
  the environment):
  - entry hours (`FTH_ENTRY_HOURS`) and no-entry windows
  - the loss-streak cooldown
  - the daily losing-trade count
  - the daily entry cap
- projectx-mcp's daily dollar loss limit (`maxDailyLoss`).

**`gate: false`** (`--no-gate`) trades around the clock without those
limits, the way algoTraderBot trades. Use it to compare with algoTraderBot.

### Exits

A strategy's `exit` block sets how its trades end. 1R is the initial stop
distance.

```yaml
exit:
  trail_activate_r: 2     # hold the initial stop until the trade is up 2R
  trail_giveback_r: 0.5   # then trail 0.5R behind the best price
  # target_r: 3           # optional fixed target (above trail_activate_r)
  # max_bars: 40          # optional time stop
```

The ported strategies use the 2R / 0.5R trail. Without an `exit` block, the
target is `risk.min_rr` (a bracket). The live runner trails stops with the
same rule (see the autonomous-trading skill).

### Settings

| Key | Default | Meaning |
|---|---|---|
| `symbols`, `timeframe` | `["MNQ"]`, 3 | Contracts and bar size (minutes) |
| `data` | required | `{ "MNQ": "file" }` or `{ "MNQ": { "file", "sheet", "tickSize", "tickValue", "feesPerSide" } }` |
| `start`, `end` | all data | ISO date or time; `end` exclusive |
| `strategies` | all mechanical ones on the timeframe | Names in priority order |
| `gate` | true | Harness rules, as above |
| `sessions`, `eodAt` | 09:35-15:00 ET, 15:50 ET | Runner schedule (with `gate`) |
| `size` / `riskPerTrade`, `maxContracts` | 1 / none, 5 | Fixed contracts, or size from the stop and a dollar risk |
| `slippageTicks` | 0 | Against you on entries and stop fills |
| `feesPerSide` | per contract (micros $0.37) | Dollars per contract per side |
| `maxDailyLoss` | 500 | Daily dollar loss that ends the day (0 = off) |
| `window` | 500 | Bars of history per evaluation (algoTraderBot's BARS_WINDOW) |
| `outDir` | `<FTH_HOME>/backtests/<run>` | Results |

### Results

Each run writes these files to the run directory:

- **`report.md` and `report.json`:**
  - **R statistics**, as algoTraderBot reports them: trades, win rate, mean
    and total R, profit factor, MFE, and capture (total R ÷ total MFE).
  - **Dollar figures** after fees: net P&L, profit factor, and max drawdown.
  - **Breakdowns** by strategy, exit reason, symbol, and month.
- **`trades.csv`:** every trade.

### Strategy correctness

`tests/lib/parity.test.js` runs the harness's detectors over algoTraderBot's
own NQ and RTY 3-minute data. It checks each of the six strategies against
the signals algoTraderBot's Python detectors produced on the same bars: same
bar, same direction, same stop.

We also ran the same check over 17,500 bars on NQ, ES, RTY, YM, and GC. All
3,623 signals matched.

## Examples

```text
$ node scripts/backtest.js --data ../algoTraderBot/data/NQ_3min.csv --symbol MNQ --start 2026-03-01 --end 2026-04-01
[backtest] bos, cisd_ote, ema_cross, keltner, orb, supertrend, vwap_reclaim on MNQ (2701 3m bars)
[backtest] 85 trades | win 24% | mean -0.281R | sum -23.92R | PF 0.64 | net $-1707.4 | max DD $1967.24 | 5.1 s
[backtest]   bos          n=42   win=24%  meanR=-0.215 sumR=-9.03
...
```

Without algoTraderBot's model filter (each signal graded by its Chronos +
XGBoost model, proba ≥ floor), the raw mechanical entries are not
profitable. That matches why algoTraderBot grades them. Here, the LLM's
analysis plays that grading role, so use the backtest for strategy
correctness and exit design. Judge the harness's edge from paper trading.
