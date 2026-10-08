---
name: strategy-authoring
description: Write a new trading strategy as a STRATEGY.md document - frontmatter schema, required sections, validation, and promotion from paper to active. Use when the user describes a strategy idea, ports one from code or a backtest, or edits an existing strategy.
---

# Strategy Authoring

## When to Use

- "Add a strategy that ..." or porting a strategy from code or a backtest.
- Changing an existing strategy's rules or status.

## How It Works

1. Copy `strategies/_template/STRATEGY.md` to `strategies/<name>/STRATEGY.md`
   (or to a folder in `FTH_STRATEGIES_DIRS` for private strategies). `<name>`
   is lowercase with `_` or `-`; it becomes the journal tag `setup:<name>`.
2. Frontmatter (checked by code):

   | Field | Meaning |
   |---|---|
   | `name`, `description` | Folder name; what/when, ≥ 40 chars |
   | `status` | `paper` (new), `active` (live entries allowed), `disabled` |
   | `instruments` | Contract roots, e.g. `[MNQ, MES]` |
   | `timeframe` | Trigger timeframe, e.g. `3m` |
   | `sessions` | Optional windows, entries only inside: named sessions `asia` (18:00-03:00 ET), `london` (03:00-09:30 ET), `ny` (09:30-16:00 ET), or `"HH:MM-HH:MM@Zone"`. Without it the strategy trades the whole market session, 18:00-16:00 ET (closed 16:00-18:00 ET and weekends; no position is carried past 16:00 ET) |
   | `signal` | `rules` (trigger written in `rules`, checked by code) or `manual` (agents judge the body). Every shipped strategy, the algoTraderBot ports included, is `rules` |
   | `connectors` | Optional data the strategy needs beyond bars, like a skill's tools: `order_flow` (aggressor buy/sell volume from the TopstepX market hub, for `ofi`/`delta`). Required when the rules use that data; the runner turns on every connector an active strategy declares |
   | `regimes` | Optional list of regimes the strategy fits: `trend-up`, `trend-down`, `trend`, `range`, `transition`, `high-vol`, `normal-vol`, `low-vol` (any match fits). Out-of-regime strategies are never scan candidates |
   | `regime_gate` | Optional `true`: the MCP gateway also refuses entries when the live regime (from that strategy's timeframe bars) doesn't fit |
   | `rules` | With `signal: rules`: `long:` and/or `short:` lists of conditions, all of which must hold on the closed bar |
   | `params` | Optional overrides of the snapshot and rules series (e.g. `orbMinutes: 30`); periods must be whole numbers |
   | `filters` | Optional `adx_min`, `adx_max`, `adx_slope_min`, `max_vwap_distance_atr`; checked by the scan only, not at order time |
   | `exit` | Optional: `trail_activate_r` + `trail_giveback_r` (trail the stop from +NR, giving back MR; trend setups use 2 / 0.5), `target_r` (fixed target), `max_bars`. Without it the target is `risk.min_rr`. The backtester and the live runner apply it |
   | `signal: policy` | A policy strategy: the prop challenge as a strategy (see `strategies/prop_portfolio_3m`). `strategies` lists the rules strategies whose setups it trades, in priority order, all on its timeframe; `account` names `accounts/<name>/ACCOUNT.md` (the gate enforces its floor, daily limits, and size budget); `sizing` sets risk per trade from the cushion (`cushion_frac` ≤ 1, `cap_usd`, `clock_k`, `r_per_session`, `min_size_guard`); `contracts` is `micro`, `mini`, or `auto` (minis once the size reaches one mini); `exit` needs a trail (the policy may bank a trade past it); `risk.stop: strategy` keeps each setup's own stop; `policy: { bundle }` names a trained policy (see the `policy-training` skill), or is left out to take every setup as sized. Only policy strategies have these keys |
   | `risk` | `stop` (`atr:<k>`, a distance expression such as `0.5 * atr(20)` or `cisd_ote_risk`, a map `{ long: <expr>, short: <expr> }` when each side's stop sits somewhere else (beyond a swept low or high, as in `crt_1h`), `structure`, `swing`, `manual`), `min_rr`, optional `max_risk_usd`. The order gate checks that a stop exists; `min_rr` and `max_risk_usd` are applied by the agents (risk-manager), not by code |
   | `source`, `version` | Where it came from; bump version on rule changes |

3. Body (read by the agents): `## When to Use`, `## How It Works` (context
   filter, trigger, entry/stop/targets, skip when), `## Examples` with
   tick-correct numbers and a sample rationale.
4. Port faithfully. When porting code, copy the exact rules and parameters and
   flag suspected bugs to the user instead of silently fixing them.
5. Validate: `node <root>/scripts/strategies.js validate`.
6. Promote only on evidence: paper-trade it (reviews tagged `paper`), run
   setup-expectancy, and set `status: active` only with the user's approval.
7. Write mechanical triggers as `rules`, not code. A condition is
   `<expr> <op> <expr>` with `>`, `>=`, `<`, `<=`, `crosses_above`,
   `crosses_below`. Expressions use series and numbers joined by `+`, `-`, and
   `number *`: `open high low close volume`, `ema(n) sma(n) atr(n) adx(n)
   highest(n) lowest(n)` (n up to 500; adx up to 250), order flow
   `ofi(n) delta(n) vol_sma(n)`, `supertrend supertrend_dir`, `keltner_upper/mid/lower`,
   `vwap_session vwap_rth or_high or_low swing_high swing_low`,
   `prior_high prior_low prior_close overnight_high overnight_low`, `minute_et`,
   `cisd_ote_dir cisd_ote_risk` (algoTraderBot's CISD + OTE detector), and
   higher-timeframe candles `htf_open(m) htf_high(m) htf_low(m) htf_close(m)`
   (the previous m-minute candle) and `htfc_open(m) htfc_high(m) htfc_low(m)`
   (the one in progress, up to this bar); m divides a day (60 = 1 hour, 240 =
   4 hours, candles aligned to the 18:00 ET open: 18, 22, 02, 06, 10, 14 ET).
   `htfc_low(60) < htf_low(60)` says this hour swept the last hour's low
   (see `crt_1h`).
   `[n]` looks back n bars: `highest(20)[1]` is the 20-bar high before this
   bar (without it the current bar is included, so a close can never cross
   above it). `minute_et` is the bar's open time in New York minutes (9:45 =
   585). `prior_*` is the last completed RTH day and `overnight_*` this Globex
   session before 9:30 ET up to the previous bar, as each bar saw them; a
   session the bars start mid-way through has none (likewise `vwap_session`
   and `vwap_rth`). The runner scans three trading days of bars, enough
   for these and for long indicators to match a backtest. `ofi(n)` is order-flow imbalance
   over n bars, from -1 (all selling) to +1 (all buying): real buy and sell
   volume recorded from the TopstepX market hub, or, for a bar without it,
   volume signed by where the bar closed in its range. `delta(n)` is that signed volume
   summed, `vol_sma(n)` the average volume per bar. A value
   that doesn't exist yet (indicator warm-up, no opening range yet) makes the
   condition false and the scan marks it `missing`. At most 12 conditions per
   side. A rules strategy with only `long` rules can't be used to sell into an
   entry. `validate` reports typos, unknown keys and series. Only a pattern the
   rules can't express (multi-bar zone logic like cisd_ote) needs `manual` or
   a new series in `scripts/lib/trading/rules.js` (with tests), used from the
   rules like `cisd_ote_dir`.
8. Backtest it before paper trading:
   `node <root>/scripts/backtest.js --data <bars.parquet|.xlsx|.csv> --symbol MNQ --strategy <name>`
   (docs/BACKTESTING.md). Check that it fires where you expect (`trades.csv`)
   and that its R statistics hold up with harness rules on.

## Examples

```yaml
---
name: donchian_break
description: 20-bar Donchian breakout on MNQ/MES 3-minute bars with an ADX trend filter, written entirely as rules.
version: 1
status: paper
instruments: [MNQ, MES]
timeframe: 3m
sessions: ["09:45-15:00@America/New_York"]
signal: rules
rules:
  long:
    - close crosses_above highest(20)[1]
    - adx(14) >= 20
    - close > vwap_rth
  short:
    - close crosses_below lowest(20)[1]
    - adx(14) >= 20
    - close < vwap_rth
risk:
  stop: atr:1
  min_rr: 2
source: user idea, 2026-10-08
---
```

See `strategies/vwap_reclaim/STRATEGY.md` for a complete rules strategy.
