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
   | `sessions` | Optional `"HH:MM-HH:MM@Zone"` windows; entries only inside |
   | `signal` | `rules` (trigger written in `rules`, checked by code), `manual` (agents judge the body), or a built-in detector ported from algoTraderBot: `orb`, `ema_cross`, `keltner`, `supertrend`, `bos`, `cisd_ote` |
   | `regimes` | Optional list of regimes the strategy fits: `trend-up`, `trend-down`, `trend`, `range`, `transition`, `high-vol`, `normal-vol`, `low-vol` (any match fits). Out-of-regime strategies are never scan candidates |
   | `regime_gate` | Optional `true`: the MCP gateway also refuses entries when the live regime (from that strategy's timeframe bars) doesn't fit |
   | `rules` | With `signal: rules`: `long:` and/or `short:` lists of conditions, all of which must hold on the closed bar |
   | `params` | Optional overrides of the snapshot and rules series (e.g. `orbMinutes: 30`); periods must be whole numbers |
   | `filters` | Optional `adx_min`, `adx_max`, `adx_slope_min`, `max_vwap_distance_atr`; checked by the scan only, not at order time |
   | `exit` | Optional: `trail_activate_r` + `trail_giveback_r` (trail the stop from +NR, giving back MR; trend setups use 2 / 0.5), `target_r` (fixed target), `max_bars`. Without it the target is `risk.min_rr`. The backtester and the live runner apply it |
   | `risk` | `stop` (`atr:<k>`, `structure`, `swing`, `manual`), `min_rr`, optional `max_risk_usd`. The order gate checks that a stop exists; `min_rr` and `max_risk_usd` are applied by the agents (risk-manager), not by code |
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
   `prior_high prior_low prior_close overnight_high overnight_low`, `minute_et`.
   `[n]` looks back n bars: `highest(20)[1]` is the 20-bar high before this
   bar (without it the current bar is included, so a close can never cross
   above it). `minute_et` is the bar's open time in New York minutes (9:45 =
   585). `prior_*` is the last completed RTH day and `overnight_*` this Globex
   session before 9:30 ET up to the previous bar, as each bar saw them; a
   session the bars start mid-way through has none. The live scan sees the
   runner's last `bars` (500), so on 1-minute bars `prior_*` stays missing
   unless `bars` covers the prior RTH day. `ofi(n)` is order-flow imbalance
   over n bars, from -1 (all selling) to +1 (all buying): each bar's volume
   signed by where it closed in its range. `delta(n)` is that signed volume
   summed, `vol_sma(n)` the average volume per bar. A value
   that doesn't exist yet (indicator warm-up, no opening range yet) makes the
   condition false and the scan marks it `missing`. At most 12 conditions per
   side. A rules strategy with only `long` rules can't be used to sell into an
   entry. `validate` reports typos, unknown keys and series. Only a pattern the
   rules can't express (multi-bar zone logic like cisd_ote) needs `manual` or
   a new detector in code.
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
