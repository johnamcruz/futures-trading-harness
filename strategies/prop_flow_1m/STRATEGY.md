---
name: prop_flow_1m
description: Prop-challenge policy strategy over the 1-minute order-flow strategies (ofi, ofi_absorption) - a trained policy decides which flow setups to take, at what size in micros or minis, and when to bank a trade, on the Topstep 100K combine.
version: 1
status: paper                 # paper until a validated bundle is shipped and the user activates it
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
source: docs/RL-DESIGN.md; needs 1-minute bars with recorded buy/sell volume (scripts/orderflow.js export) to train
---

# Strategy: Prop Flow 1m (`setup:prop_flow_1m`)

The order-flow counterpart of `prop_portfolio_3m`: the same account, sizing,
and policy, over the 1-minute `ofi` and `ofi_absorption` setups. A policy
trades one timeframe, so the flow strategies get their own policy strategy.

## When to Use

- A `topstep_100k` attempt is running on 1-minute bars (`ofi` and
  `ofi_absorption` declare the order-flow connector).
- Training needs 1-minute bars with real buy/sell volume (recorded flow
  files, exported with `scripts/orderflow.js export`); bars without it fall
  back to an estimate.

## How It Works

As `prop_portfolio_3m`: the first flow strategy with a setup on the closed
1-minute bar is the setup, sized from the cushion in micros or minis, and the
trained policy (once shipped) takes it, halves it, or skips it, and may bank a
trade past +2R. Place exactly the verdict with `setup:prop_flow_1m`.

## Examples

```text
prop_flow_1m short setup from ofi_absorption: sizing says full (max 1 NQ, stop 30 ticks)
A $200 budget: 30 ticks on MNQ = $15 + $0.74 fees = $15.74 a micro, so 12 micros,
traded as 1 NQ (contracts: auto): 30 ticks on NQ = $150 + $2.80 fees = $152.80.
```
