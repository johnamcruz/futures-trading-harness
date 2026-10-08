---
name: topstepx-mcp
description: Reference for trading TopstepX through the projectx-mcp server - tool list, session loop, order mechanics, error codes, and the harness rationale convention. Use before calling any mcp__projectx__ tool or when an order behaves unexpectedly.
---

# TopstepX via projectx-mcp

## When to Use

- First trade of a session, or any time you're unsure how a tool behaves.
- An order was rejected, blocked, or filled unexpectedly.

## How It Works

The server must be registered under the name `projectx`, so tools are
`mcp__projectx__<tool>`. Read `projectx://guide` once per session.

### Session loop

1. `get_server_config`: trading enabled? limits?
2. `list_accounts`: pick `canTrade=true` and `mcpTradingAllowed=true`.
3. `journal_read {kind:"lesson"}` plus recent `review` entries.
4. `get_account_snapshot`: balance, positions, working orders, `remainingBeforeLimit`.
5. `search_contracts {searchText:"MNQ"}`: take `activeContract=true`; note `tickSize`, `tickValue`.
6. `get_bars` (+ `get_quote`) on several timeframes, then market-snapshot.
7. `journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>"]}`.
8. `place_order` only when the plan's trigger has happened.
9. Manage with `get_account_snapshot` / `get_quote` / `list_open_orders`.
10. After the exit: `get_performance`, `journal_add {kind:"review"}`.
11. End of session: at most 1–3 `lesson` entries.

### Tools

| Area | Tools |
|---|---|
| Session | `get_server_config`, `list_accounts`, `get_account_snapshot` |
| Contracts | `search_contracts`, `get_contract`, `list_available_contracts` |
| Market data | `get_bars` (50 req / 30 s), `get_quote` (SignalR) |
| Orders | `place_order`, `modify_order`, `cancel_order`, `close_position`, `partial_close_position` |
| History | `list_open_orders`, `search_orders`, `list_open_positions`, `search_trades`, `get_performance` |
| Memory | `journal_add`, `journal_read` |

### Order mechanics

- Types: `market`; `limit` (limitPrice); `stop` (stopPrice); `trailing_stop`
  (trailPrice = absolute price level); `join_bid` / `join_ask`.
- `buy` opens/adds long or closes short; `sell` the reverse.
- Brackets are in ticks and need Auto OCO Brackets on the account. Error
  "Brackets cannot be used with Position Brackets" → enter without brackets,
  then place a `[protect]` stop once `list_open_positions` shows the fill.
- `close_position` leaves resting stop/target orders: cancel them.
- `search_trades`: `profitAndLoss: null` marks an opening fill; fees separate.

### Harness rationale convention (the order gate reads it)

- Entry: `setup:<name> <side> <trigger>, stop <price>, target <price>, risk $<n>`.
- Exit / scale-out: `[exit] <why>`.
- Protective order for an existing fill: `[protect] <what it protects>`.

### Errors

| Message | Meaning | Do |
|---|---|---|
| `Blocked by risk guardrail:` | MCP server limit | Stand aside. Don't resize or reroute. |
| `Blocked by trading harness` | Order gate hook | Fix the listed cause or stand aside. |
| errorCode 4 `AccountViolation` / `canTrade=false` | Firm locked the account | Stop. Tell the user. |
| errorCode 5 `OutsideTradingHours` | Market closed | Don't retry in a loop. |
| "Live accounts not supported" on cancel/close | Endpoint limited to sim/eval | Tell the user. |

## Examples

```text
place_order {accountId, contractId:"CON.F.US.MNQ.Z26", side:"buy", type:"market", size:1,
  stopLossBracket:{ticks:40, type:"stop"}, takeProfitBracket:{ticks:80, type:"limit"},
  rationale:"setup:orb long close above OR high 21500.00, stop 21490.00, target 21520.00, risk $20"}

place_order {..., side:"sell", type:"stop", size:1, stopPrice:21490.00,
  rationale:"[protect] stop for ORB long filled at 21500.25"}
```
