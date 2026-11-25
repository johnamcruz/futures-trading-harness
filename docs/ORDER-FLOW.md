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
3. **A strategy document may read them.** The rules' `field("path")` reads a
   number on the bar by dotted path, `field("path")[n]` on the bar n back. A
   missing field, a null, or anything not a number has no value, so the
   condition is false. Nothing estimates them.

Only a strategy document names the fields, as data. The strategies that read
them (`ofi`, `ofi_absorption`, `prop_flow_1m` and `value_area`'s flow branch)
were all retired on 2026-10-14 (`strategies/retired.json`; `strategies/README.md`,
"Retired strategies"): no active strategy reads a bar field today, and none
lists in `strategies/`. A new strategy may read one with `field("path")`.

## How it reaches the model

The model never reads a field through a strategy now. The runner's bar
briefing carries the last three bars' extra fields (`m3.brokerFields`) and one
summary line of them. A server may publish its own words for its fields
(`get_server_config` `barFields`: a meaning, an optional divisor and the
digits to show; `docs/BROKER-MCP-INTERFACE.md`): the line then prints the
fields the server described, each as a value (a ratio to the bar's volume
where the server says so, rounded) with the server's meaning verbatim. With
none given the line shows the raw values and the agents treat each field as
unknown (`skills/broker-bar-fields`): the harness states no meaning and
never works one out. What the servers add:
[ORDER-FLOW-BAR-FIELDS-HANDOFF.md](ORDER-FLOW-BAR-FIELDS-HANDOFF.md).
Nothing in the gate, sizing, exits or entry check reads a flow field; the
model reads one only as context and confirmation, at a mapped level
(`skills/vwap-volume-profile`).

## What the server's contract defines

The fields' definitions, completeness rules, and windows are in the live
server's own design document (its repo); the replay server is checked
against the same definitions. The harness repeats none of it.
