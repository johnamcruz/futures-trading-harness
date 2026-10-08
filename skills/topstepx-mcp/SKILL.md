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

- **Partial fills**: a limit or a large market entry may fill in part.
  `get_account_snapshot` / `list_open_positions` give the filled size; a
  bracket covers the filled quantity. Cancel the unfilled rest when the plan
  no longer wants it, and size any `[protect]` stop to the position, not to
  the order.
- **Stop vs rationale**: the rationale's stop price and
  `stopLossBracket.ticks` must say the same stop (ticks =
  `ceil(|entry - stop| / tickSize)`). After a market fill the bracket sits
  that many ticks from the fill price, not from the planned entry: read the
  working stop's price in `list_open_orders` and journal it if it differs.

### Failures and limits

- `get_bars`: 50 requests per 30 s across all agents. Reuse the runner's bars
  file; one request per extra timeframe.
- A read times out or errors (429, 5xx): retry once after a few seconds, then
  stand aside for this cycle.
- An order call times out or errors without a clear rejection: **don't
  resend**. Read `list_open_orders` and `get_account_snapshot` first; the
  order may be working or filled. Only place it again when both show it
  isn't there, and the plan still holds.
- A position without a working protective stop (bracket rejected, partial
  fill, cancelled by mistake): place a `[protect]` stop at once, or close the
  position. Nothing else comes first.

### Journal

`journal_add` / `journal_read` keep the journal the gate reads, a JSON-lines
file at `PROJECTX_JOURNAL_PATH` (default `~/.projectx-mcp/journal.jsonl`):
one `{ ts, kind, contractId, tags, text }` per line (order entries also carry `data`). Kinds: `plan`, `note`,
`review`, `lesson`; every `place_order` writes an `order_placed` entry by
itself. Write through the tools only; never edit the file. The gate reads
plans (a plan for this contract within `FTH_PLAN_MAX_AGE_MIN`, 120) and
reviews (every entry reviewed before the next) from it. Which strategy fired
it reads from the signal record (`strategies.js scan --record`), not the
plan. Optional parameters the gate and reviews use: `journal_read {kind, tag}`
filters, `journal_add {orderId}` links a review to its order, and
`modify_order {reason}` labels a stop change (`[protect] ...`).

### Harness rationale convention (the order gate reads it)

- Entry: `setup:<name> <side> <trigger>, stop <price>, target <price>, risk $<n>`.
  The gate checks the order against it (`order-consistency`): `<side>`
  (long/short) must be the order's side, the prices on the tick and on the
  right sides, and the brackets the same distance (from `limitPrice` /
  `stopPrice`; for a market order, stop + target ticks = the stop-to-target
  span). Write a distance as a unit (`stop 40 ticks`) and it isn't read as a
  price.
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
