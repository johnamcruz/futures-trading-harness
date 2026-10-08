---
name: my_strategy
description: One or two sentences - what the strategy trades, the edge it exploits, and when it applies (at least 40 characters).
version: 1
status: paper                 # paper | active | disabled. New strategies start as paper.
instruments: [MNQ, MES]       # contract roots the strategy may trade
timeframe: 3m                 # trigger timeframe: 1m, 3m, 5m, 15m, 1h ...
sessions: ["09:45-11:30@America/New_York"]   # optional; entries only inside these windows
signal: rules                 # rules (conditions below) | manual (agents judge the body) | orb | ema_cross | keltner | supertrend | bos
rules:                        # with signal: rules - every condition in a side must hold on the closed bar
  long:
    - close crosses_above highest(20)[1]
    - adx(14) >= 18
  short:
    - close crosses_below lowest(20)[1]
    - adx(14) >= 18
params:                       # optional market-snapshot overrides (see scripts/lib/trading/market-snapshot.js PARAMS)
  adxGate: 18
filters:                      # optional numeric gates checked by code
  adx_min: 18                 # adx_min | adx_max | adx_slope_min | max_vwap_distance_atr
risk:
  stop: atr:0.5               # atr:<multiple of ATR(20)> | structure | swing | manual
  min_rr: 2                   # minimum planned reward:risk
  max_risk_usd: 50            # optional per-trade cap for this strategy
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
