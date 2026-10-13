---
name: prop_flow_1m
description: Prop-challenge policy strategy over the 1-minute order-flow strategies (ofi, ofi_absorption) - it sizes each flow setup from the attempt's budget in the selected contract (or skips it), and trails every trade, on its account's combine.
version: 1
status: active                # the owner activated it after order flow moved to the broker servers (replay and live)
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
source: harness design (prop_portfolio's counterpart); its strategies read order flow from the broker's 1-minute bars, so backtests need the broker's bars as JSON (backtest.js fetch --out <file.json>)
---

# Strategy: Prop Flow 1m (`setup:prop_flow_1m`)

The order-flow counterpart of `prop_portfolio`: the same account and
sizing, over the 1-minute `ofi` and `ofi_absorption` setups. A policy
strategy trades one timeframe, so the flow strategies get their own.

## When to Use

- An attempt on its account is running on 1-minute bars.
- `ofi` and `ofi_absorption` read order flow the broker MCP server puts on
  its bars (`field(...)`); bars without it give no setup, so neither does
  this strategy. Backtests need the broker's 1-minute bars as JSON
  (`backtest.js fetch --out <file.json>`); a CSV has no flow.

## How It Works

It covers MNQ and NQ only (`instruments`). `ofi` and `ofi_absorption` list
MES, MYM and M2K too, but while an attempt runs on the account only a policy
strategy that trades it may enter: their setups on those indexes have no
policy to go through, so the gate refuses them (fails closed).

As `prop_portfolio`: the first flow strategy with a setup on the closed
1-minute bar is the setup, sized from the cushion in the selected contract
(full, or a skip when the budget can't fund it), and the trail exits the
trade. A verdict is a ceiling: take it with `setup:prop_flow_1m`, exactly as given
and at most its size, when the priority order (the strategy-library skill) says so.

### Status

Active, for replay and live: the owner activated it, with `ofi` and
`ofi_absorption`, after order flow moved to the broker MCP servers' bars
(live from the live server, history from the replay server's local L1/L2
store). The replay smoke and a fresh replay are its verification before any
live session. On a bar without the flow fields the flow conditions are
false, so `ofi` and `ofi_absorption` give no signal and this strategy has
no setup. It trades the same account's attempt as
`prop_portfolio`; the runner trades one timeframe, so a 1-minute run's
setups come here and a 3-minute run's go to `prop_portfolio`.

## Examples

```text
prop_flow_1m short setup from ofi_absorption: sizing says full (max 1 NQ, stop 30 ticks)
NQ selected. A $200 budget: 30 ticks plus a tick of expected slippage on MNQ = 31 x $0.50
= $15.50 + $0.74 fees = $16.24 a micro, so 12 micros, traded as 1 NQ: 31 x $5 = $155
+ $2.80 fees = $157.80.
With MNQ selected, the same setup is 12 MNQ.
```
