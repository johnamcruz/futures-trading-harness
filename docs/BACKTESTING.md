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

# Optional: download 1-minute bars from the broker (through the broker adapter) to a file first
node scripts/backtest.js fetch --contract MNQ:2025-03 --from 2025-03-03 --to 2025-03-15 --out data/MNQ-1m.csv
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
- **CSV** and **JSON** (the broker's `get_bars` output).

The table needs a header with a time column (`time`, `timestamp`,
`datetime`, `date`, `ts`, `t`, or a pandas datetime index) and `open`,
`high`, `low`, `close`, and optionally `volume` (needed for the order-flow
strategies and the `ofi`, `delta`, and `vol_sma` series). Real order flow
comes as `buy_volume` and `sell_volume` columns (aggressive buys and sells;
`ask_volume`/`bid_volume` and `bv`/`sv` work too), or a `delta` column. A
bar without them falls back to the bar-shape estimate. Any letter case
works.

Live order flow is not part of the broker MCP interface, so the harness
doesn't record it. Flow files recorded earlier (`<FTH_HOME>/flow/`) can be
exported with the bars:

```bash
node scripts/orderflow.js status
node scripts/orderflow.js export --contract MNQ --from 2026-10-01 --to 2026-10-08 --out data/MNQ-1m-flow.csv
node scripts/backtest.js --data data/MNQ-1m-flow.csv --symbol MNQ --timeframe 1 --strategy ofi,ofi_absorption
```

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
| Manage | A bar that starts with a trade open only manages it (as in algoTraderBot): a trade closed here makes no new entry on the same bar. **Trailing exits:** the peak follows the bar's high (longs) or low (shorts). From `trail_activate_r` on, the stop sits `trail_giveback_r` behind the peak. It moves toward the market only and is rounded to the tick. If the bar already crossed the new stop, the trade closes at the bar's close, as algoTraderBot does. **Then, in order:** `max_bars`, and end of day at `eodAt` (always). |
| Entry | Strategies are checked in priority order. The first candidate enters at the next bar's open (plus `slippageTicks`), or at the signal bar's close with `fill: close`. The stop is the strategy's distance (`atr:k` × ATR(20), or a distance expression such as cisd_ote's `cisd_ote_risk`) rounded to whole ticks. The target is set when the exit plan has one, in ticks from the unrounded distance (as algoTraderBot). With `exit.target` (a distance expression, e.g. `crt_target(60)`), the target is a level instead: the signal bar's close plus that distance, rounded to the tick; an entry whose fill is already at or past it is skipped. |

**The market session** always applies, as it does live: entries only from
18:00 to 16:00 ET (Sunday evening to Friday) and before `eodAt`, and every
trade is closed at end of day (`eodAt`, required, no later than the 16:00 ET
close). A trade is never carried into the next trading day, even when the
data has no bar between the close and the next session (it closes at the
day's last bar).

**Harness rules** (`gate: true`, the default) apply what the live harness
enforces:

- The runner's `sessions`.
- From the order gate, with the same `FTH_*` settings as live (read from
  the environment):
  - entry hours (`FTH_ENTRY_HOURS`) and no-entry windows
  - the loss-streak cooldown
  - the daily losing-trade count (both count losses before fees, from
    P&L as the broker reports it; a scratch neither adds to nor ends a streak)
  - the daily entry cap
- The broker MCP server's daily dollar loss limit (`maxDailyLoss`).

**`gate: false`** (`--no-gate`) drops those limits (not the market session).
Use it to compare with algoTraderBot.

### Exits

A strategy's `exit` block sets how its trades end. 1R is the initial stop
distance.

```yaml
exit:
  trail_activate_r: 2     # hold the initial stop until the trade is up 2R
  trail_giveback_r: 0.5   # then trail 0.5R behind the best price
  # target_r: 3           # optional fixed target (above trail_activate_r)
  # target: crt_target(60)  # or a target level: a distance from the signal close
  # max_bars: 40          # optional time stop, in the strategy's own bars
```

The ported strategies use the 2R / 0.5R trail. Without an `exit` block, the
target is `risk.min_rr` (a bracket). The live runner trails stops with the
same rule and closes a trade at its `max_bars` time stop, scaled from the
strategy's bars to the runner's (see the autonomous-trading skill). A
`target` with a trail is allowed, but the trail can close the trade before the
target fills.

A policy strategy's trades exit by the policy strategy's own `exit` (its
trail, and `max_bars` if set), whichever rules strategy found the setup: a
`crt_1h` setup traded through `prop_portfolio_3m` has no CRT target.

### Settings

| Key | Default | Meaning |
|---|---|---|
| `symbols`, `timeframe` | `["MNQ"]`, 3 | Contracts and bar size (minutes) |
| `data` | required | `{ "MNQ": "file" }` or `{ "MNQ": { "file", "sheet", "tickSize", "tickValue", "feesPerSide" } }` |
| `start`, `end` | all data | ISO date or time; `end` exclusive |
| `strategies` | all mechanical ones on the timeframe | Names in priority order |
| `gate` | true | Harness rules, as above |
| `sessions`, `eodAt` | 18:00-15:50 ET, 15:50 ET | Runner schedule: sessions inside the 18:00-16:00 ET session (with `gate`; `asia`, `london`, `ny` work); `eodAt` required, no later than 16:00 ET |
| `size` / `riskPerTrade`, `maxContracts` | 1 / none, 5 | Fixed contracts, or size from the stop and a dollar risk |
| `slippageTicks` | 1 | Against you on entries and stop fills |
| `fill` | `next-open` | `next-open`: an entry fills at the next bar's open (live, the order goes in after the cycle that read the closed bar); a setup whose fill bar opens through its stop or target, or falls after end of day or in a new day, expires (counted in the report). `close`: at the signal bar's close, as algoTraderBot |
| `walkForward` | null | `{ grid, trainMonths, testMonths, minTrades }`: walk-forward test of one strategy (`--walk-forward --grid key=v1,v2`); see below |
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
  - **Breakdowns** by strategy, exit reason, symbol, month, hour (ET),
    weekday, confluence, and regime (on the signal bar, as the scan read it).
- **`trades.csv`:** every trade.
- **`trades.jsonl`:** every trade with its target level and the setup behind
  it: the stop and target distances and its detectors' state on the signal
  bar (for a CRT trade: the previous candle's range, the sweep extreme,
  depth, shift level, risk, and R:R).
- **`decisions-<strategy>.jsonl`** (with `--debug <strategy>`): that
  strategy's verdict on every bar: whether it fired, the rules that failed
  (or had no value yet), the filters that failed, whether it was in session,
  and its detectors' state and reason (for CRT: `no_sweep`, `too_deep`,
  `stale`, `not_reclaimed`, `no_shift`, `no_room`, `fired`, ...). Bars
  before the backtest's window are marked `warmup`. Use it to see why a setup
  you expected didn't trade:

  ```bash
  node scripts/backtest.js --data NQ_3min.csv --symbol MNQ --strategy crt_1h --debug crt_1h
  grep '"reason":"fired"' ~/.futures-trading-harness/backtests/<run>/decisions-crt_1h.jsonl
  ```

### Track records for the cycle prompt

`--record` writes each strategy's track record to
`<FTH_HOME>/track-record/<strategy>.json`: its trades, win rate, mean R with
its 95% interval, the edge verdict, the same by regime and by hour, and its
excursions (how far winners ran, how deep 80% of them dipped, how often +1R
was given back; the prompt's open-trade line compares a live trade with
them). A record from an edited STRATEGY.md is flagged stale. Each
strategy is backtested on its own for it (in a joint run they compete for one
position). The autonomous runner shows the record, with the journal's
reviewed live trades, next to every strategy that fires, so the model weighs
the signal by evidence. Re-record after changing a strategy or adding data;
plain runs only (not with `--prop` or `--walk-forward`).

```bash
node scripts/backtest.js --data data/MNQ-3m.parquet --symbol MNQ --strategy orb,value_area --record
```

### Prop challenges

With `--prop <policy strategy>` (config `prop`), the run is a set of
prop-challenge attempts of that policy strategy instead of one long backtest:
its strategies' setups, on its account, sized by its `sizing` in micros or
minis (`contracts`). An attempt starts every `--every N` trading days (config
`every`, default 1), runs for the account's `sessions`, and ends on pass,
blow, or timeout. A stop that would reach the floor or the daily limit is
sized down, and equity at the floor inside a bar is a blow, liquidated there.
The policy strategy's own bundle adds its decisions; `--bundle <name>` (config
`bundle`) tries another, and a bundle that hasn't passed the gate can be
loaded here for research. The run writes
`combine.json` and `combine.md`: pass, blow, and timeout rates, median days to
pass, and the same by month, for the rules alone and with the policy.

### Strategy correctness

`tests/lib/parity.test.js` runs the shipped strategies' rules over algoTraderBot's
own NQ and RTY 3-minute data. It checks each of the six strategies against
the signals algoTraderBot's Python detectors produced on the same bars: same
bar, same direction, same stop.

We also ran the same check over 17,500 bars on NQ, ES, RTY, YM, and GC. All
3,623 signals matched. When the ports moved from code detectors to rules,
the rules reproduced the detectors on another 20,000 bars: 4,158 signals,
same bar, direction, and stop.

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

## Walk-forward (rules strategies)

A strategy whose parameters were picked by looking at backtests is overfit
until shown otherwise. `--walk-forward` tunes a grid on rolling in-sample
months and trades the winner, untouched, on the months after; only those
out-of-sample trades count, next to the strategy's own parameters on the
same months:

```bash
node scripts/backtest.js --data data/MNQ-3m.parquet --symbol MNQ --strategy crt_1h \
  --walk-forward --grid crtMinRR=1.5,2,2.5 --grid exit.max_bars=20,40 --train-months 6 --test-months 1
```

`walk-forward.md` reports the out-of-sample mean R with its 95% interval,
the retention (out-of-sample over in-sample mean R), how many folds were
positive, and how often the same point won. Keep the defaults unless the
tuned run beats them out of sample.

## Trusting a result

Every report gives the mean R's 95% interval and an edge verdict
(anecdotal under 30 trades; unproven while the interval includes 0), the
Sharpe ratio of daily P&L, MAE, the longest losing streak, breakdowns by
entry hour (ET) and weekday, and a data audit (bars missing inside market
hours, opens that jump more than 8 x ATR from the previous close, as an
unadjusted roll does, and malformed bars).
