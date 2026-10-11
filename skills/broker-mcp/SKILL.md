---
name: broker-mcp
description: Reference for trading through the broker MCP server (any prop firm or broker that implements the broker MCP interface) - tool list, session loop, order mechanics, error codes, and the harness rationale convention. Use before calling any mcp__broker__ tool or when an order behaves unexpectedly.
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

1. `get_server_config`: trading enabled? limits?
2. `list_accounts`: pick `canTrade=true` and `mcpTradingAllowed=true`.
3. `journal_read {kind:"lesson"}` plus recent `review` entries.
4. `get_account_snapshot`: balance, positions, working orders, `remainingBeforeLimit`.
5. `search_contracts {searchText:"MNQ"}`: contracts come back by standard name: `MNQ` is the front month, `MNQ:2027-03` a later one. Note `tickSize`, `tickValue`: the harness takes every contract's tick specs from the broker's own answers (it records them as `search_contracts` or `get_contract` returns them), never from a table of its own. Use the name as `contractId` everywhere; the harness translates it to the broker's own id.
6. Bars to a file: the runner's bars file, or the harness tool `bars_fetch` `{symbol:"MNQ", timeframe:3, record:true}` (+ `get_quote`), then `market_snapshot`, `mtf_read`, and `strategies_scan` with `record` (the `harness-tools` skill).
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

### Order mechanics

- Types: `market`; `limit` (limitPrice); `stop` (stopPrice); `trailing_stop`
  (trailPrice = absolute price level); `join_bid` / `join_ask`.
- `buy` opens/adds long or closes short; `sell` the reverse.
- Brackets are in ticks and need Auto OCO Brackets on the account. Error
  "Brackets cannot be used with Position Brackets" → enter without brackets,
  then place a `[protect]` stop when the order's one status check shows the
  fill (still unfilled: cancel it, as "Check a new order once" below says).
- `close_position` leaves resting stop/target orders: cancel them.
- `search_trades`: `profitAndLoss: null` marks an opening fill; fees separate.

- **Partial fills**: a limit or a large market entry may fill in part.
  `get_account_snapshot` / `list_open_positions` give the filled size; a
  bracket covers the filled quantity. Cancel the unfilled rest when the plan
  no longer wants it, and size any `[protect]` stop to the position, not to
  the order.
- **Check a new order once; never wait for a fill**: after `place_order`,
  read its status once (`list_open_orders` and `list_open_positions`, or
  `get_account_snapshot`). Filled: carry on (its stop, its journal entry).
  Still working (a limit or stop entry not reached, or a market order the
  broker hasn't filled yet; a replayed broker fills market orders at the next
  bar, and live fills can lag) with its stop bracket attached: journal that
  it is working and end the cycle (the bracket protects it once it fills).
  Still working without a stop bracket (brackets rejected): don't leave it,
  since it would fill with no stop. `cancel_order` it (cancelling an entry
  only reduces risk), then read `list_open_orders` and `list_open_positions`
  once to confirm. Whatever else it shows, any quantity that filled is
  protected first: its `[protect]` stop, or close it. Gone and flat: journal
  a review tagged `result:nofill` and `setup:<name>` (the gate counts a
  placed entry until it is reviewed) and plan again next cycle. Filled before
  the cancel (in whole or part): it is a live, executed trade, protected as
  above. Still working (the cancel was refused, errored, or lost): cancel
  once more; if it is still working, journal a note naming it as an entry
  without a stop bracket and end the cycle as `error`, so the next cycle
  cancels it first (interactively, tell the user it is still working with no
  stop). The next cycle checks a
  working entry's fill and manages the position: the autonomous runner starts
  a cycle while an order is working or a position is open; interactively, the
  next check. Never wait or poll for a fill: no repeated `get_bars`,
  `get_quote`, `list_open_orders`, or snapshot reads to see it fill. A
  position you must leave (no working stop, end of day) is still closed with
  `close_position` and re-read as the steps for it say: closing is acting,
  not waiting.
- **Stop vs rationale**: the rationale's stop price and
  `stopLossBracket.ticks` must say the same stop (ticks =
  `ceil(|entry - stop| / tickSize)`). The harness tool `order_plan` works
  both out for the strategy and side you chose; send its arguments as given. After a market fill the bracket sits
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
- The gateway tracks such an order itself: every `place_order` goes out with
  a `customTag` (yours, or one it adds), and until the broker's orders
  (`search_orders`) show that tag, or 2 minutes pass without it, new entries
  are refused with `[order-pending]`. Exits, stop moves and cancels are still
  checked: an unknown market order counts as filled, an unknown limit or stop
  as resting. `close_position` always goes. If an exit's own `customTag` is
  already carried by an order of unknown outcome, the exit goes under a fresh
  tag: find it by the `orderId` in the reply, not by your tag.
- A position without a working protective stop (bracket rejected, partial
  fill, cancelled by mistake): place a `[protect]` stop at once, or close the
  position. Nothing else comes first. (Right after a close whose reply was an
  error, the gate refuses the `[protect]`: `close_position` again; see Errors.)

### Journal

`journal_add` / `journal_read` keep the journal the gate reads, a JSON-lines
file at the broker's journal path in the broker config (`get_server_config`: `journalPath`):
one `{ ts, kind, contractId, tags, text }` per line (order entries also carry `data`). Kinds: `plan`, `note`,
`review`, `lesson`; every `place_order` writes an `order_placed` entry by
itself. Write through the tools only; never edit the file. The gate reads
plans (a plan for this contract within `FTH_PLAN_MAX_AGE_MIN`, 120) and
reviews (every entry reviewed before the next) from it. Which strategy fired
it reads from the signal record (`strategies_scan` with `record`), not the
plan. Optional parameters the gate and reviews use: `journal_read {kind, tag}`
filters, `journal_add {orderId}` links a review to its order, and
`modify_order {reason}` labels a stop change (`[protect] ...`).
Don't filter `journal_read` by `contractId`: the server stores its own
`order_placed` entries under the broker's contract id, so a filter on `MNQ`
drops them. Filter by `kind` / `tag` and read `contractId` in the results.

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
| `[order-pending] customTag "…" is in use by an order of unknown outcome` | Your entry reuses the tag of an order still unsettled | Send it with another `customTag`, or none. |
| `[replay-clock]` | `FTH_REPLAY_NOW` (a replayed time) is set but the broker isn't a real replay broker, or the value isn't an ISO 8601 UTC time: no new entry | Don't retry. Exits, `[protect]` stops, stop moves, cancels and `close_position` still go. Tell the user to unset `FTH_REPLAY_NOW` or select a real replay broker. |
| `[account-required]` | `place_order` without `accountId` | Send it with the account's id. |
| `[contract-specs] <ROOT>: the broker's tick spec (…) differs from the static table` | The broker's tick size or value for that contract disagrees with the harness's own table (which training used): no entry is sized on numbers that can't both be right | Don't retry. Exits and stops still go. Tell the user: the table (`scripts/lib/trading/contracts.js`) or the broker is wrong. |
| `[contract-specs] no tick specs from the broker for <ROOT> yet` | The harness has no tick size and value from the broker for that contract (or, for a prop entry, for the other contract of its micro/mini family, e.g. NQ for MNQ): no entry is checked or sized without them | `search_contracts {searchText:"<ROOT>"}` (or `get_contract`) for the contract it names, then send the entry again. Exits, `[protect]` stops, stop moves, cancels and `close_position` never need them. |
| `[order-pending] The outcome of an order is unknown` | An earlier order got no clear answer | No new entry. Read `search_orders` / `list_open_orders`; manage what's there. It clears when the broker lists the order or after 2 min; while `search_orders` fails it holds (tell the user), and an unreadable record named in the message is deleted by hand after checking the broker's orders. |
| `[partial-close]` | `partial_close_position` with no open position in the contract, a size that isn't a whole number of 1 or more, or more than the position (counting orders sent moments ago) | Re-read `list_open_positions`; close at most what is open, or `close_position`. |
| `... once recent orders fill` after a `close_position` / `partial_close_position` whose reply was an error | The close's outcome is unknown (the broker may have filled it): for 30 s the gate counts it, so a `[protect]` or `[exit]` for that position, or a stop move, is refused. Its stop can't be cancelled while the account still shows the position | Re-read `list_open_positions`. Still open: `close_position` again (it always goes). Gone: cancel the leftover orders. Don't cancel the stop of a position that is still open. |
| `[modify-entry] ... once recent orders fill` | The position this stop or target worked was just closed (or is about to be) by a recent order | Don't move it; cancel the leftover order once the account reads flat. |
| `order gate could not run (position … has no valid size …)` | The broker returned a position without a whole-number size: the account can't be read | No orders but `close_position` (never gated). Tell the user; it holds until the broker reports a size. |
| errorCode 4 `AccountViolation` / `canTrade=false` | Firm locked the account | Stop. Tell the user. |
| errorCode 5 `OutsideTradingHours` | Market closed | Don't retry in a loop. |
| "Live accounts not supported" on cancel/close | The broker limits the endpoint to sim/eval | Tell the user. |

## Examples

```text
place_order {accountId, contractId:"MNQ", side:"buy", type:"market", size:1,
  stopLossBracket:{ticks:40, type:"stop"}, takeProfitBracket:{ticks:80, type:"limit"},
  rationale:"setup:orb long close above OR high 21500.00, stop 21490.00, target 21520.00, risk $20"}

place_order {..., side:"sell", type:"stop", size:1, stopPrice:21490.00,
  rationale:"[protect] stop for ORB long filled at 21500.25"}
```
