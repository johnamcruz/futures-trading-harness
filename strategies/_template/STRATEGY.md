---
name: my_strategy
description: One or two sentences - what the strategy trades, the edge it exploits, and when it applies (at least 40 characters).
version: 1
status: paper                 # paper | active | disabled. New strategies start as paper.
instruments: [MNQ, MES]       # contract roots the strategy may trade
timeframe: 3m                 # trigger timeframe: 1m, 3m, 5m, 15m, 1h ...
sessions: [ny]                # optional; asia (18:00-03:00 ET), london (03:00-09:30 ET), ny (09:30-16:00 ET), or "HH:MM-HH:MM@Zone". Omit for the whole 18:00-16:00 ET session
regimes: [trend, transition]  # optional; any of: trend-up trend-down trend range transition high-vol normal-vol low-vol
regime_gate: false            # true = the MCP gateway refuses entries when the live regime doesn't fit
signal: rules                 # rules (conditions below) | manual (agents judge the body)
# connectors: [order_flow]   # data the strategy needs beyond bars (order_flow: aggressor buy/sell volume for ofi/delta, from recorded flow files)
rules:                        # with signal: rules - every condition in a side must hold on the closed bar
  long:
    - close crosses_above highest(20)[1]
    - adx(14) >= 18
  short:
    - close crosses_below lowest(20)[1]
    - adx(14) >= 18
params:                       # optional overrides (see scripts/lib/trading/market-snapshot.js PARAMS), e.g. opening-range length
  orbMinutes: 15
filters:                      # optional numeric gates checked by the scan (not by the order gate)
  adx_min: 18                 # adx_min | adx_max | adx_slope_min | max_vwap_distance_atr
exit:                         # optional; without it the target is risk.min_rr (a bracket)
  trail_activate_r: 2         # trend setups: hold the initial stop until +2R ...
  trail_giveback_r: 0.5       # ... then trail 0.5R behind the best price
  # target_r: 3               # optional fixed target in R (above trail_activate_r)
  # target: crt_target(60)    # or a target level: a distance expression from the signal close
  # max_bars: 40              # optional time stop in bars
risk:
  stop: atr:0.5               # atr:<multiple of ATR(20)> | a distance expression (0.5 * atr(20)) | { long: <expr>, short: <expr> } | structure | swing | manual
  min_rr: 2                   # minimum planned reward:risk (the agents plan to it; not checked at order time)
  max_risk_usd: 50            # optional per-trade cap the risk-manager applies (not checked at order time)
# To trade a prop account (account, sizing, contracts, policy), list this strategy
# in a policy strategy (signal: policy, e.g. strategies/prop_portfolio_3m) instead.
source: where the rules came from (code path, backtest, book, idea)
---

# Strategy: My Strategy (`setup:my_strategy`)

Copy this folder to `strategies/<name>/` (or to a folder listed in
`FTH_STRATEGIES_DIRS`), rename `name` to match the folder, and fill in every
section. Run `node scripts/strategies.js validate` until it passes.

## When to Use

- Market conditions, instruments, and time of day where the edge exists.
- The signal or pattern that makes the strategy worth evaluating.

## How It Works

### Context filter

- Higher-timeframe conditions that must hold (trend, regime, levels).

### Trigger

- The exact, closed-bar condition that fires the entry. With `signal: rules`
  the `rules` block is the trigger (restate it here in words); with
  `signal: manual` describe it precisely enough that two traders would agree
  whether it fired.

### Entry, stop, targets

- Entry order type and price.
- Stop placement and why it invalidates the idea.
- Targets and trade management (breakeven, trailing, scale-outs).

### Skip when

- Conditions that cancel the trade even when the trigger fires.

## Examples

```text
A worked example with tick-correct prices, $ risk, and the place_order
rationale: "setup:my_strategy long <trigger>, stop <price>, target <price>, risk $<n>"
```
