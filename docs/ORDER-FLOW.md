# Order flow: a broker capability

The harness computes no order flow and has no code that knows what it is.
Order flow belongs to the broker MCP servers (CLAUDE.md, "Separation of
work"): the live server computes it from its market data and is the
reference; the replay server reproduces the same fields from history.

## How it reaches a strategy

1. **The server puts it on its bars.** A bar from `get_bars` may carry extra
   fields of the server's own (`docs/BROKER-MCP-INTERFACE.md`, `get_bars`).
   Whether it adds them is the server's own setting, in its environment; the
   server's entry in `mcp-configs/brokers.json` lists those variables in its
   `env`, and your `.env` sets them. The harness never asks for them in a
   `get_bars` call.
2. **The harness passes them through untouched.** The adapter, the bars
   files the runner and `bars.js` write, the scan, and the backtester (for a
   JSON file of the broker's bars at the strategy's timeframe) keep every
   field a bar carries. Bars the harness builds itself (the backtester's
   longer bars from 1-minute ones, CSV files) carry none.
3. **A strategy document reads them.** The rules' `field("path")` reads a
   number on the bar by dotted path, `field("path")[n]` on the bar n back. A
   missing field, a null, or anything not a number has no value, so the
   condition is false. On a bar without the fields `ofi_absorption` gives
   no signal, and `value_area` can confirm only
   through its other branch (a range expansion on volume). Nothing estimates
   them.

Only strategy documents name the fields, as data:
`strategies/ofi_absorption` (and `strategies/prop_flow_1m` through it), and
`strategies/value_area`, whose order-flow branch is one of two confirmations.
Each says which fields it reads, what they mean, and how they differ from the
harness's former bar-shape `ofi(n)`. The owner activated them (`status:
active`, with `prop_flow_1m`) for replay and live once the flow came from the
broker servers' bars; the replay smoke and a fresh replay verify them before
any live session.

## What the server's contract defines

The fields' definitions, completeness rules, and windows are in the live
server's own design document (its repo); the replay server is checked
against the same definitions. The harness repeats none of it.
