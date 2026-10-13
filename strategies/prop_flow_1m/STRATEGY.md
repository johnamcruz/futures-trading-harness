---
name: prop_flow_1m
description: Prop-challenge policy strategy over the 1-minute order-flow strategies (ofi, ofi_absorption) - it sizes each flow setup from the attempt's budget in the selected contract (or skips it), and trails every trade, on the Topstep 100K combine.
version: 1
status: paper                 # paper until the user activates it
instruments: [MNQ, NQ]
timeframe: 1m
signal: policy
strategies: [ofi, ofi_absorption]
account: topstep_100k
sizing:
  cushion_frac: 0.2
  min_size_guard: 1.5
contracts: auto
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: strategy
  min_rr: 2
source: harness design (prop_portfolio's counterpart); backtests need 1-minute bars with recorded buy/sell volume (scripts/orderflow.js export)
---

# Strategy: Prop Flow 1m (`setup:prop_flow_1m`)

The order-flow counterpart of `prop_portfolio`: the same account and
sizing, over the 1-minute `ofi` and `ofi_absorption` setups. A policy
strategy trades one timeframe, so the flow strategies get their own.

## When to Use

- A `topstep_100k` attempt is running on 1-minute bars (`ofi` and
  `ofi_absorption` declare the order-flow connector).
- Backtests need 1-minute bars with real buy/sell volume (recorded flow
  files, exported with `scripts/orderflow.js export`); bars without it fall
  back to an estimate.

## How It Works

As `prop_portfolio`: the first flow strategy with a setup on the closed
1-minute bar is the setup, sized from the cushion in the selected contract
(full, or a skip when the budget can't fund it), and the trail exits the
trade. A verdict is a ceiling: take it with `setup:prop_flow_1m`, exactly as given
and at most its size, when the priority order (the strategy-library skill) says so.

## Examples

```text
prop_flow_1m short setup from ofi_absorption: sizing says full (max 1 NQ, stop 30 ticks)
NQ selected. A $200 budget: 30 ticks plus a tick of expected slippage on MNQ = 31 x $0.50
= $15.50 + $0.74 fees = $16.24 a micro, so 12 micros, traded as 1 NQ: 31 x $5 = $155
+ $2.80 fees = $157.80.
With MNQ selected, the same setup is 12 MNQ.
```
