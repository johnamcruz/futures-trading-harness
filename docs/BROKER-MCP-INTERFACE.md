# Broker MCP Interface (design)

Status: design, for review before any code.

## Goal

One MCP tool contract that every broker or prop-firm MCP server implements.
The harness (agents, skills, the order gate, the gateway) already talks to its
broker only through MCP tools; this document writes those tools down as the
contract, so another firm's server plugs in the same way projectx-mcp does.

- [projectx-mcp](https://github.com/johnamcruz/projectx-mcp) (TopstepX) is the
  reference implementation. It conforms today, unchanged.
- Nothing else in the harness changes: same gateway, same order gate, same
  agents and skills, same runner, same prop rules.

## Non-goals

- No broker profiles or per-broker settings in the harness.
- No change to the autonomous runner or the data CLIs.
- No change to the order gate, the prop rules, or the account profiles.

## How a server plugs in

The installer already takes the server entry and registers it behind the gateway:

```bash
node scripts/install.js --target all --projectx /abs/<server>/dist/index.js
```

Any server that implements this interface goes in the same place. The agents
see its tools as `mcp__projectx__<tool>` (the registered server name; see Open
decisions).

## Transport

- MCP over stdio. A tool returns its payload as JSON text in `content[0].text`.
- A failure returns `isError: true` with the reason as text. A guardrail refusal
  starts with `Blocked by risk guardrail:`.
- Request ids starting `fth-gw-` belong to the gateway.

## Tools

The 20 tools projectx-mcp exposes, with the inputs the harness sends and the
result fields the harness reads. **Bold** inputs are required. A server may
return more fields.

### Session and accounts

| Tool | Input | Result |
|---|---|---|
| `get_server_config` | none | `tradingEnabled`, the guardrail limits, `allowedAccountIds`, `allowedSymbols` |
| `list_accounts` | `onlyActiveAccounts` | list of `id`, `name`, `balance`, `canTrade` |
| `get_account_snapshot` | **`accountId`** | `account` (or null), `positions`, `openOrders`, `today.realizedNetPnL` |

### Market data

| Tool | Input | Result |
|---|---|---|
| `search_contracts` | **`searchText`**, `live` | list of `id`, `name`, `tickSize`, `tickValue` (USD per tick per contract), `activeContract` |
| `get_contract` | **`contractId`** | `id`, `tickSize`, `tickValue`, `activeContract` |
| `list_available_contracts` | `live` | list of contracts |
| `get_bars` | **`contractId`**, `unit` (second…month), `unitNumber`, `limit` (≤ 20,000), `startTime`, `endTime`, `includePartialBar` | `bars`, oldest first: `t` (bar open, UTC ISO 8601), `o`, `h`, `l`, `c`, `v` |
| `get_quote` | **`contractId`**, `timeoutMs` | `contractId`, `quote` (null when the market is closed) |

### Positions, orders, fills (read)

| Tool | Input | Result |
|---|---|---|
| `list_open_positions` | **`accountId`** | list of `contractId`, `type` (1 long, 2 short), `size`, `averagePrice`, `creationTimestamp` |
| `list_open_orders` | **`accountId`** | list of `id`, `contractId`, `type`, `side` (0 buy, 1 sell), `size`, `stopPrice`, `limitPrice` |
| `search_orders` | **`accountId`**, **`startTimestamp`**, `endTimestamp` | list of orders |
| `search_trades` | **`accountId`**, `startTimestamp`, `endTimestamp` | list of fills: `contractId`, `creationTimestamp`, `price`, `side`, `size`, `profitAndLoss` (null on an opening fill), `fees`, `voided`. Default window: the current trading day (from 17:00 America/Chicago) |
| `get_performance` | **`accountId`**, `startTimestamp`, `endTimestamp` | statistics |

### Orders (write)

The gateway checks `place_order`, `modify_order`, and `cancel_order` before the
server sees them; the server applies its own guardrails as well.

| Tool | Input | Result |
|---|---|---|
| `place_order` | **`accountId`**, **`contractId`**, **`side`** (buy, sell), **`type`** (market, limit, stop, trailing_stop, join_bid, join_ask), **`size`**, `limitPrice`, `stopPrice`, `trailPrice` (a price level), `stopLossBracket` / `takeProfitBracket` (`{ ticks, type }`), **`rationale`** | `orderId`, `success`, `errorCode`, `errorName` |
| `modify_order` | **`accountId`**, **`orderId`**, `size`, `limitPrice`, `stopPrice`, `trailPrice`, `reason` | `success`, `errorCode` |
| `cancel_order` | **`accountId`**, **`orderId`** | `success`, `errorCode` |
| `close_position` | **`accountId`**, **`contractId`**, `reason` | `success`, `errorCode` |
| `partial_close_position` | **`accountId`**, **`contractId`**, **`size`**, `reason` | `success`, `errorCode` |

The order gate reads `rationale`: the `setup:<strategy>` tag first, the side,
`stop <price>` and `target <price>`; `[exit]` and `[protect]` mark orders that
reduce risk.

### Journal

| Tool | Input | Result |
|---|---|---|
| `journal_add` | **`kind`** (plan, entry, exit, review, lesson, note), **`text`**, `accountId`, `contractId`, `orderId`, `tags` | the entry |
| `journal_read` | `kind`, `tag`, `contractId`, `since`, `limit` | list of entries |

## Journal file

The order gate reads the journal from disk, so the server writes it to
`PROJECTX_JOURNAL_PATH` (default `~/.projectx-mcp/journal.jsonl`): JSONL, one
entry per line, `{ ts, kind, text, accountId?, contractId?, orderId?, tags?, data? }`.
The server writes `order_placed` for every `place_order` (`text` = the
rationale, `data.result` = the result) and `order_blocked` for a refused one.

## Enums

- Contract ids: `CON.F.US.<SYMBOL>.<MONTH><YEAR>`, e.g. `CON.F.US.MNQ.Z26`. A
  server with another native format maps to this one.
- Order type codes in results: 1 limit, 2 market, 3 stop limit, 4 stop,
  5 trailing stop, 6 join bid, 7 join ask.
- Side in results: 0 buy, 1 sell. Position type: 1 long, 2 short.

## Guardrails every server applies

- Trading is off unless enabled; every order tool refuses while it is off.
- Allowed accounts and symbols only.
- A maximum order size and a maximum net position per contract.
- A daily loss limit: once it's reached, orders that add exposure are refused.

## What the implementation adds

Small, and none of it changes existing behaviour:

1. `scripts/lib/broker-interface.js`: the tool list above as data.
2. `scripts/check-broker-mcp.js`: starts a server, lists its tools, makes
   read-only calls, and reports what doesn't match. It never places an order.
3. Tests: projectx-mcp's tool names match the interface, and this document
   names every tool in it.

## Open decisions

1. **Server name.** Keep `projectx` (no change to agents, skills, or existing
   installs), or rename it to a neutral `broker` (`mcp__broker__*`, touches every
   agent and the installer). Recommended: keep `projectx` for now.
2. **Environment names.** The journal path and the installer flag say
   `projectx` (`PROJECTX_JOURNAL_PATH`, `--projectx`). Keep them, or add
   neutral aliases (`FTH_JOURNAL_PATH`, `--broker-mcp`).
3. **Runner data.** The runner reads bars and positions through the ProjectX
   REST API, not MCP, so it runs only on TopstepX. Keep that, or move it onto
   these tools later in its own PR.
