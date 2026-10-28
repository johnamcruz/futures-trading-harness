---
name: broker-mcp
description: The broker MCP server - its tools (mcp__broker__<tool>), what each is for, and the session loop that calls them. Use before calling any mcp__broker__ tool.
---

# Trading through the broker MCP server

## When to Use

- First trade of a session, or any time you're unsure how a tool behaves.
- An order was rejected, blocked, or filled unexpectedly.

## How It Works

Every broker or prop firm runs its own MCP server (its own repo) that
implements the broker MCP interface (`<root>/docs/BROKER-MCP-INTERFACE.md`);
the broker config picks which one. It is registered under the name `broker`,
so tools are `mcp__broker__<tool>` whatever the firm. Read the server's own
guide resource once per session if it has one.

### Session loop

1. `get_server_config`: trading enabled? limits? The harness records `maxOrderSize` from this answer; the gate refuses entries until it has.
2. `list_accounts`: pick `canTrade=true` and `mcpTradingAllowed=true`.
3. `journal_read {kind:"lesson", since}` and recent `review`s.
4. `get_account_snapshot`: balance, positions, working orders, `remainingBeforeLimit`.
5. `search_contracts {searchText:"MNQ"}`: contracts come back by standard name: `MNQ` is the front month, `MNQ:2027-03` a later one. Note `tickSize`, `tickValue`: the harness takes every contract's tick specs from the broker's own answers (it records them as `search_contracts` or `get_contract` returns them), never from a table of its own. Use the name as `contractId` everywhere; the harness translates it to the broker's own id.
6. The bar's facts: the bar briefing; without one, `bars_fetch` `{symbol:"MNQ", timeframe:3, record:true}` (`bar-briefing`).
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
| Market data | `get_bars` (50 req / 30 s), `get_quote` (latest quote; `quote: null` when the market is closed) |
| Orders | `place_order`, `modify_order`, `cancel_order`, `close_position`, `partial_close_position` |
| History | `list_open_orders`, `search_orders`, `list_open_positions`, `search_trades`, `get_performance` |
| Memory | `journal_add`, `journal_read` |

### Where the rest is

- An order's type, side and stop bracket: the `order-types` skill; its
  reply (refused or unknown outcome, partial fills, checking it once): the `order-mechanics` skill.
- An order or read call that errored or timed out: the `order-failures` skill.
- An order's rationale: the `order-rationale` skill.
- The journal: the `trade-journal` skill.
- A `[code]` or `Blocked by trading harness` refusal: the `gate-refusals` skill.
- The broker's own refusal or error reply: the `broker-refusals` skill.

## Examples

```text
get_server_config                    -> tradingEnabled, maxOrderSize (the gate needs it)
list_accounts                        -> the account with canTrade=true and mcpTradingAllowed=true
search_contracts {searchText:"MNQ"}  -> contractId "MNQ", tickSize 0.25, tickValue 0.5
```
