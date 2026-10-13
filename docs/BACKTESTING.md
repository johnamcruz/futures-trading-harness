# Backtesting

`scripts/backtest.js` replays historical bars through the strategies the way
the original bot's backtester does. After every closed bar it does three things,
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

# Optional: download the broker's bars (through the broker adapter) to a file first, at the strategy's timeframe
node scripts/backtest.js fetch --contract MNQ --from 2025-03-03 --to 2025-03-15 --timeframe 3 --out data/MNQ-3m.jsonl
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
- **JSON lines** (`.jsonl`, `.ndjson`): one bar a line, as `backtest.js fetch`
  writes the broker's bars. Every field is kept, and a file of years of bars
  is read line by line, never as one huge string.

The Parquet and Excel readers trust the file: they are for your own data,
through the CLIs (backtests, replay labels). They bound what a file decompresses
to (512 MB), refuse malformed page and encoding headers, and reject cells
past column XFD, but a crafted file can still make them slow or large (the
sheet's regular expressions, a wide row or a long dictionary fanning out,
unbounded rows, cells and shared strings). The agents' tools (the `harness`
MCP server) read only JSON and CSV bars files.

The table needs a header with a time column (`time`, `timestamp`,
`datetime`, `date`, `ts`, `t`, or a pandas datetime index) and `open`,
`high`, `low`, `close`, and optionally `volume` (needed for `vol_sma`). Any
letter case works.

Fields a broker puts on its bars (read by the rules' `field("path")`, such
as the order flow the `ofi` strategies and `value_area` use) survive in a
backtest only on bars the broker built at the strategy's own timeframe. So to
backtest a strategy that reads broker fields, fetch its bars from the broker
at its timeframe:

```bash
# value_area (3 minutes, also inside prop_portfolio) and ofi (1 minute)
node scripts/backtest.js fetch --contract MNQ --from 2024-06-10 --to 2024-06-15 --timeframe 3 --out data/MNQ-3m.jsonl
node scripts/backtest.js --data data/MNQ-3m.jsonl --symbol MNQ --timeframe 3 --strategy value_area
node scripts/backtest.js --data data/MNQ-3m.jsonl --symbol MNQ --prop prop_portfolio
node scripts/backtest.js fetch --contract MNQ --from 2024-06-10 --to 2024-06-15 --timeframe 1 --out data/MNQ-1m.jsonl
node scripts/backtest.js --data data/MNQ-1m.jsonl --symbol MNQ --timeframe 1 --strategy ofi,ofi_absorption
```

`fetch` asks the broker's `get_bars` for bars of that size (`--timeframe`:
minutes, default 1, or a size up to a day such as `1h`), paging through a long
span (years are fine) 10,000 bars a call. A size in seconds (`30s`) is asked
for as second bars, which a broker may not serve: it then refuses the fetch,
and the backtester itself reads only bars on minute boundaries. A call that comes back short (a
server that caps its replies) is asked again from where it stopped. Exact
paging relies on the broker server honouring `get_bars`'s `startTime` (the
window's start in docs/BROKER-MCP-INTERFACE.md); the servers in
`mcp-configs/brokers.json` do. One that ignores it and keeps the oldest bars is
refused only when it caps at the interface's 20,000-bar limit; capped below
that, the bars past its cap are lost without a warning. One that ignores it
and keeps the newest bars up to `endTime` is refused at the end of its data
when it holds exactly 20,000 bars there (the safe side). It keeps the bars in
the span and writes each one as the broker's server
returned it, every field kept, with its own settings for those fields. Write
`.jsonl` (best for long spans) or `.json`; a `.csv` holds only time, prices
and volume, so `fetch` refuses it for bars that carry more.

The harness never builds those fields itself: only the broker knows what they
mean over a longer bar. So it never combines them when it aggregates finer
bars into the run's timeframe. When the finer bars carry broker fields and a
strategy in the run (one that trades the market) reads any, the backtest
refuses, saying to fetch bars at the run's timeframe instead; when none of
them reads one, it builds the bars without the fields and says so in its log.
A CSV carries no such fields either, so a strategy that reads them never
fires on one: `value_area`'s order-flow branch on CSV bars. The same holds
inside a policy: a `prop_portfolio` run (`--prop`) on CSV or built bars leaves
out `value_area`'s flow branch (only its range expansion confirms), so it can
pick a different setup, or none, where live and replay would pick
`value_area`.

The backtester reports **field coverage**: for each `field(...)` path a traded
strategy reads, the share of the bars in range (from `start`) of each market
it trades that carry a value there (a number or a boolean, as the rules read
it; a null, as a broker serves past the data it has for a field, counts as
missing). It always logs each one, and warns for each one under 100%, naming
the strategy, the path, the markets and their shares. A plain or `--prop` run
puts it in the report too: `fieldCoverage` (every path) and `missingFields`
(those under 100%) in `report.json` or `combine.json`, and a coverage table
and a warnings section in `report.md` or `combine.md`; a walk-forward run only
logs it. In a `--prop` run only the strategies it trades are checked: a paper
strategy the policy leaves out, which still counts toward conflict, is not.

- **Times:** ISO 8601, epoch seconds, ms, µs or ns, Parquet timestamps, or
  Excel dates.
- **Time zone:** times with no zone are UTC.
- **Bar times:** each bar is stamped with its open time.

Use bars at the trading timeframe, or finer bars that divide it (1-minute
data runs a 3-minute backtest, unless the bars carry broker fields a strategy
reads: see above). Micro contracts can use the full contract's
bars (`MNQ` on `NQ` data), as the original bot does.

### Each bar

The fills (entries, stop and target, trail, time stop, P&L) are the simulated
broker's, `scripts/lib/backtest/sim-broker.js`, one per market; the engine
(`engine.js`) drives it bar by bar.

| Step | What happens |
|---|---|
| Broker | The resting stop and target are checked against the bar. The stop wins if both are touched. A stop fills at its price, or at the open if the bar gapped through it. A target fills at its price, or at a better open. |
| Manage | A bar that starts with a trade open only manages it (as in the original bot): a trade closed here makes no new entry on the same bar. **Trailing exits:** the peak follows the bar's high (longs) or low (shorts). From `trail_activate_r` on, the stop sits `trail_giveback_r` behind the peak. It moves toward the market only and is rounded to the tick. If the bar already crossed the new stop, the trade closes at the bar's close, as the original bot does. **Then, in order:** `max_bars`, and end of day at `eodAt` (always). |
| Entry | Strategies are checked in priority order. The first candidate enters at the next bar's open (plus `slippageTicks`), or at the signal bar's close with `fill: close`. The stop is the strategy's distance (`atr:k` × ATR(20), or a distance expression such as cisd_ote's `cisd_ote_risk`) rounded to whole ticks. The target is set when the exit plan has one, in ticks from the unrounded distance (as the original bot). With `exit.target` (a distance expression, e.g. `crt_target(60)`), the target is a level instead: the signal bar's close plus that distance, rounded to the tick; an entry whose fill is already at or past it is skipped. |

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
Use it to compare with the original bot.

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
`crt_1h` setup traded through `prop_portfolio` has no CRT target.

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
| `fill` | `next-open` | `next-open`: an entry fills at the next bar's open (live, the order goes in after the cycle that read the closed bar); a setup whose fill bar opens through its stop or target, or falls after end of day or in a new day, expires (counted in the report). `close`: at the signal bar's close, as the original bot |
| `walkForward` | null | `{ grid, trainMonths, testMonths, minTrades }`: walk-forward test of one strategy (`--walk-forward --grid key=v1,v2`); see below |
| `feesPerSide` | per contract (micros $0.37) | Dollars per contract per side |
| `maxDailyLoss` | 500 | Daily dollar loss that ends the day (0 = off) |
| `window` | 500 | Bars of history per evaluation (the original bot's BARS_WINDOW) |
| `outDir` | `<FTH_HOME>/backtests/<run>` | Results |

### Results

Each run writes these files to the run directory:

- **`report.md` and `report.json`:**
  - **R statistics**, as the original bot reports them: trades, win rate, mean
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
minis (`contracts`). As live, an active policy takes setups only from its
`active` strategies: a `paper` one stays paper inside it and is left out
(logged, and listed in `combine.json`'s `leftOut`). A left-out strategy still
fires in the scan, as live, so it still counts as agreement or disagreement:
its signal against a traded setup voids that setup under `conflict`, and one
with it adds to the setup's confluence; it is only never the setup taken. A
policy that isn't active trades only in a paper run, so its run takes setups
from every non-disabled strategy. An attempt starts every `--every N` trading days (config
`every`, default 1), runs for the account's `sessions`, and ends on pass,
blow, or timeout. A stop that would reach the floor or the daily limit is
sized down, each contract's risk counting the stop's expected slippage
(`sizing.stop_slippage_ticks`, a tick by default, as live) and fees both
ways; the fills still slip by `slippageTicks` (the same tick by default), so
a larger `--slippage` tests the live sizing under worse fills. Equity at the
floor inside a bar is a blow, liquidated there.
Every setup the budget can fund is taken at its full size, and every trade
exits by the policy strategy's trail, as live. The run writes `combine.json`
and `combine.md`: pass, blow, and timeout rates, win rate, median days to
pass, and pass and blow rates by the month an attempt starts in. (The
retired PPO policy's `--bundle` option is gone; a config naming `bundle` is
refused.)

### No look-ahead

A decision at bar t reads only bars up to t. Every rules series (each name
and function, and `field()` at any look-back) and every shipped strategy's
evaluation at t is the same whether or not later bars exist. An entry
decided at t fills no sooner than bar t+1's open (`fill: next-open`, the
default); `fill: close` fills at t's own close. The labels' decision inputs
(the stop's ATR, the candidates, the position) read only what existed by the
decision time. Their outcomes and counterfactuals may look ahead, because
they record what came after. A replay sees no bar that closes after its
clock: the runner and `bars_fetch` drop such bars, and every harness tool that
reads a bars file refuses a file that holds one (`skills/replay`). The
no-look-ahead suite, `tests/e2e/no-look-ahead.test.js` with
`tests/lib/look-ahead.test.js` and `tests/lib/no-look-ahead-rules.test.js`,
proves this.

### Strategy correctness

`tests/lib/parity.test.js` runs the shipped strategies' rules over the original bot's
own NQ and RTY 3-minute data. It checks each of the six strategies against
the signals the original bot's Python detectors produced on the same bars: same
bar, same direction, same stop.

We also ran the same check over 17,500 bars on NQ, ES, RTY, YM, and GC. All
3,623 signals matched. When the ports moved from code detectors to rules,
the rules reproduced the detectors on another 20,000 bars: 4,158 signals,
same bar, direction, and stop.

## Examples

```text
$ node scripts/backtest.js --data data/NQ_3min.csv --symbol MNQ --start 2026-03-01 --end 2026-04-01
[backtest] bos, cisd_ote, ema_cross, keltner, orb, supertrend, vwap_reclaim on MNQ (2701 3m bars)
[backtest] 85 trades | win 24% | mean -0.281R | sum -23.92R | PF 0.64 | net $-1707.4 | max DD $1967.24 | 5.1 s
[backtest]   bos          n=42   win=24%  meanR=-0.215 sumR=-9.03
...
```

Without the original bot's model filter (each signal graded by its Chronos +
XGBoost model, proba ≥ floor), the raw mechanical entries are not
profitable. That matches why the original bot grades them. Here, the LLM's
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

## The field-forward study

Before a strategy's rules lean on a field the broker puts on its bars, ask
whether the field predicts anything: does its value at bar t line up with
the price move **after** t? `scripts/field-study.js` (logic in
`scripts/lib/field-study.js`) measures that and nothing else. It is
generic: a field is a dotted path read as `field("...")` reads it, with
`[n]` for the value n bars earlier; the harness computes nothing of its
own.

```bash
node scripts/field-study.js --data data/MNQ-1m/ --symbol MNQ \
  --fields a.b,a.c[1] --horizons 1,3,5,15 --by hour,session --out out/study
```

- **Predictive only.** The forward move is `close[t+k] - close[t]` in
  ticks (with the largest excursions up and down over bars t+1..t+k); the
  field is read from bar t's own data. The same bar's move is shown only as
  a labelled contemporaneous reference: a field that describes its own bar
  correlates with that bar's move whether or not it predicts the next.
- **No pair spans a break**: a new file, a new trading day, a time gap over
  twice the timeframe, or a change of a per-bar `contractId` (bars fetched
  through the broker interface carry none: the contract is on the reply, so
  a roll is caught by the file and trading-day breaks); skipped pairs are
  counted. Give a long span as one file per contract stretch (a directory
  of files, which must not overlap in time): each file is its own chunk.
- **Statistics** per field and horizon: Pearson and Spearman IC, deciles
  (mean and median move, hit rate, excursions), |field| thresholds (p80,
  p90, p95, p99 by default, or `--thresholds`) with the move signed by the
  field and the result net of the round-trip cost (`--cost-ticks`, default
  2), 95% block-bootstrap intervals (one trading day a block, seeded) for
  the IC (Spearman's on the full sample's ranks), the top and bottom
  deciles and each threshold (deciles are by rank, so equal values share
  one; a discrete field can leave deciles empty); a threshold clears the
  cost only when its whole interval does, and breakdowns by New York hour and
  by session (RTH 09:30-16:00 ET vs overnight). The tick comes from
  `--symbol`'s contract spec, or `--tick`.
- **The split rule.** The report states every month's role
  (`scripts/lib/prop/splits.js`). Only Train months run freely: a span with
  a Select, Out-of-sample, Recent, walk-forward or reserve month is refused
  unless `--held-out-look "<reason>"` is given, and that look must then be
  recorded in `RECORDED_LOOKS` and the ledger (`docs/LEARNED-RULEBOOK.md`,
  section 4 and R16). A study is a claim's first measurement, on Train;
  thresholds it suggests are judged on held-out months by calibration
  (R11-R13, R34), never by rerunning the study there.

## Trusting a result

Every report gives the mean R's 95% interval and an edge verdict
(anecdotal under 30 trades; unproven while the interval includes 0), the
Sharpe ratio of daily P&L, MAE, the longest losing streak, breakdowns by
entry hour (ET) and weekday, and a data audit (bars missing inside market
hours, opens that jump more than 8 x ATR from the previous close, as an
unadjusted roll does, and malformed bars).

## Comparing bar sources

`scripts/compare-bars.js` compares the bars two sources give for the same
span, field by field: the broker's own fields on them (any dotted path), as
two servers, two builds of a replay server's store, or recorded live minutes
and the replay server's same minutes return them. The harness gives the
fields no meaning: it reads them by path, as the rules' `field("path")` does
(a number, or a boolean as 1/0; a missing value, a null or a string is
missing), and says how far apart the sources are. It reads the network only
through the broker adapter, and only for a broker source.

```bash
node scripts/compare-bars.js --a <bars.jsonl|bars.json|broker:<name>> --b <...> \
  [--contract MNQ --from <ISO> --to <ISO> [--timeframe 1]] \
  [--fields a.b,c.d[1] | --prefix a] [--tol 0] [--rtol 0] [--ohlcv-tol 0] \
  [--by hour] [--worst 5] [--fail-below corr=0.95,within=0.99] [--out report.json]
```

- **Sources.** A `.jsonl` or `.json` bars file (as `backtest.js fetch` writes
  it, every field kept), or `broker:<name>`, a broker named in `brokers.json`,
  whose bars for `--contract`, `--from`, `--to` and `--timeframe` come
  through the broker adapter's `history()` (the same fetch as
  `backtest.js fetch`). `--from` and `--to`, when given, cut file sources to
  the same span; a file is not filtered by contract, so give each source one
  contract's bars.
- **Alignment.** By bar open time, and by contract too when both sources
  name one (`contract`, `contractId` or `symbol`) on every bar, compared as
  the same text; a look-back `[n]` stays on the bar's own contract. The report
  counts the bars only in one source and the bars whose open, high, low,
  close or volume differ by more than `--ohlcv-tol`; those are listed and
  left out of the field statistics, since their fields describe different
  bars. A duplicate time keeps the last bar.
- **Fields.** By default every numeric or boolean leaf path either source
  carries (arrays by index, `a.list.0`), prices and volume left out;
  `--prefix a.b` keeps one subtree, `--fields a.b,c.d[1]` names them.
  `[n]` reads each source's own bar n bars back, as `field("c.d")[1]` does.
- **Statistics per field**, over the bars both sources have with equal
  prices: coverage (the share of those bars where each source has a value),
  n (bars where both do), mean and max absolute difference, the share within
  tolerance (`|b - a| <= --tol`, or `<= --rtol` x the larger magnitude),
  Pearson correlation (undefined for fewer than two values or a constant
  series), sign agreement (of the bars where either value is non-zero, the
  share where both are and have the same sign; undefined when every pair is
  zero), and p5, p50 and p95 of each source's compared values. `--by hour`
  breaks them down by the bar's open hour in New York time. The worst N bars
  outside tolerance (`--worst`, default 5) are listed with both values.
- **Output.** Markdown on stdout; `--out x.json` also writes the JSON report
  and the Markdown next to it (`x.md`).
- **Exit codes.** 0 when every field meets the `--fail-below` thresholds (or
  none are set); 1 when a field missed a threshold, or nothing was compared; 2 on a
  usage error; 3 when a source can't be read or fetched, or `--out` can't be
  written. Thresholds: `corr`, `within`, `sign`, `coverage`
  (the lower of the two sources'), per field, and `bars` (the share of all
  bar times that are in both sources with equal prices). An undefined
  correlation passes only where two or more values were compared and every
  one is within tolerance (a constant field equal in both); an undefined
  sign agreement (all zeros) passes; a field with nothing compared fails.
  A run where no bar is in both sources with equal prices fails, thresholds
  or not.

Two builds of the replay server's store, the same week of a subtree of its
fields (fetch it once from each build, or name both in `brokers.json` and
compare them directly):

```bash
node scripts/backtest.js fetch --contract MNQ --from 2024-06-03 --to 2024-06-08 --timeframe 1 --out data/store-old.jsonl
# ...point the replay server at the new build, then:
node scripts/backtest.js fetch --contract MNQ --from 2024-06-03 --to 2024-06-08 --timeframe 1 --out data/store-new.jsonl
node scripts/compare-bars.js --a data/store-old.jsonl --b data/store-new.jsonl --prefix <subtree> --by hour \
  --fail-below corr=0.99,within=0.99 --out reports/store-diff.json
# or, both builds configured as brokers:
node scripts/compare-bars.js --a broker:<old-build> --b broker:<new-build> --contract MNQ \
  --from 2024-06-03T00:00:00Z --to 2024-06-08T00:00:00Z --prefix <subtree> --fail-below corr=0.99,within=0.99
```

Recorded live minutes against the replay server's same minutes (live is the
reference, so it is `--a`; the replay server matches live, never the
reverse):

```bash
node scripts/compare-bars.js --a data/live-recorded.jsonl --b broker:<replay-broker> --contract MNQ \
  --from <first bar> --to <last bar> --fail-below bars=1,coverage=1,corr=0.99,within=0.99 \
  --out reports/live-vs-replay.json
```
