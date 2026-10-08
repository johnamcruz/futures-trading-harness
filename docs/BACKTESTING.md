# Backtesting

The backtester replays historical bars through the real autonomous loop. The
runner, prompts, agents, skills, strategies, order gate, MCP gateway, and
projectx-mcp are the live ones. Only two pieces are simulated:

- **The broker.** A ProjectX Gateway API on `127.0.0.1` answers the same REST
  endpoints as `api.topstepx.com` (accounts, contracts, bars, orders,
  positions, trades) from historical 1-minute bars. The runner's REST client
  and projectx-mcp talk to it exactly as they talk to TopstepX.
- **The clock.** Every harness process (hooks, the gateway, projectx-mcp
  behind it, the strategy and snapshot scripts) reads the simulated time, so
  sessions, the trading day, journal timestamps, and the order gate's time
  checks all follow the replay.

So the harness can't tell a backtest from the market, and what you measure is
the system you will run live.

## When to Use

- Before promoting a strategy from `paper` to `active`.
- After changing a strategy, a skill, or the model, to compare runs on the
  same days.
- To see how the agents behave on a specific day (trend, chop, news spike).

## How It Works

```bash
# 1. Get 1-minute bars (the backtest never calls the real API; fetch does)
node scripts/backtest.js fetch --contract CON.F.US.MNQ.H25 \
  --from 2025-03-03 --to 2025-03-15 --out data/MNQ-1m.json

# 2. Configure: an autotrader config plus a "backtest" block
cp mcp-configs/backtest.example.json backtest.json

# 3. Run
node scripts/backtest.js --config backtest.json
```

Data is a JSON array of `{t,o,h,l,c,v}` 1-minute bars (projectx `get_bars`
format, or the output of `fetch`), or a CSV with `time,open,high,low,close`
and optionally `volume` (ISO or epoch times, UTC unless an offset is given).
Bars before `start` are visible as history, so include a few days of warm-up.

`backtest` settings:

| Key | Default | Meaning |
|---|---|---|
| `start`, `end` | required | Replay window (ISO) |
| `instruments.<SYMBOL>.data` | required | 1-minute bar file, relative to the config file |
| `instruments.<SYMBOL>.contractId` | `CON.F.US.<SYMBOL>.BT` | Contract id the agents see |
| `instruments.<SYMBOL>.tickSize`, `tickValue`, `feesPerSide` | known for MNQ MES MYM M2K NQ ES YM RTY | Contract specs |
| `startingBalance` | 50000 | Account balance |
| `slippageTicks` | 1 | Against you on market and stop fills |
| `dailyLossLimit` | none | Flatten and lock until the next trading day (17:00 CT) |
| `maxLossLimit` | none | Trailing from the end-of-day balance high, capped at the start balance; flatten and lock for good |
| `latency` | `real` | `real`: the market moves while the agents think, as live. `none`: frozen during a cycle (optimistic) |
| `outDir` | `~/.futures-trading-harness/backtests/<run>` | Results and isolated state |

The rest of the config is the autotrader's (`harness`, `model`, `symbols`,
`timeframe`, `trigger`, `cycle`, `sessions`, `premarketAt`, `eodAt`, ...).
`paper` and `dataDir` are ignored; the account is the simulated one.

### Fill model

Conservative on purpose:

- Only bars that have closed by the simulated time are visible.
- Market orders fill at the last closed 1-minute close plus slippage.
  Marketable limits fill at that close.
- Resting stops trigger on a touch and fill at the worse of the stop and the
  bar's open, plus slippage. Resting limits need the price to trade through
  (or open beyond) them.
- When one 1-minute bar touches both a stop and a target, the stop fills.
- Brackets become an OCO pair at the entry fill. `close_position` leaves
  resting orders, as on TopstepX.
- Orders are refused while the market is closed (17:00-18:00 ET, weekends) or
  when the data has no bar for 30 minutes (holidays).
- `get_quote` has no simulated feed: it reports no quote and the agents use
  bars.

### Isolation

Each run has its own state directory (`FTH_HOME`): journal, gate log, kill
switch, bar files, runner state, and harness output (`cycles.log`). Real
credentials are replaced before any process starts, and the gateway points
projectx-mcp at the simulator whatever the MCP client config says. The
simulated clock only switches on with `FTH_BACKTEST=1` and a loopback
simulator URL, so a live process never has its clock moved.

### Results

`report.md` and `report.json` in the run directory:

- **Summary:** net P&L after fees, trades, win rate, profit factor,
  expectancy, max drawdown, harness cycles, and account locks.
- **Breakdowns:** by setup (from the `setup:<name>` of the order that opened
  each round trip) and by day.
- **Trade list:** every round trip.

## Examples

A week of MNQ on 3-minute bars with the lean cycle at real latency runs about
600 cycles, roughly one per bar. Each cycle is one model session, so the run
takes as long as the market did during trading hours. Ways to make it
cheaper:

- `"trigger": "signal"` only starts a cycle when a mechanical strategy fires or
  a position is open.
- A shorter `sessions` window.
- `"latency": "none"` for a first pass. It is optimistic because the market
  waits for the model, so confirm with `real` before trusting a result.

```text
[backtest] done: 14 trades, net 212.5, win rate 57%, PF 1.6, max DD 96.25
[backtest] report: ~/.futures-trading-harness/backtests/2026-10-08T.../report.md
```
