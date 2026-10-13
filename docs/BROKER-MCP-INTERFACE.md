# Broker MCP Interface

One MCP interface that every prop firm and broker follows: the tools, inputs,
results, errors, journal, and guardrails below. A firm is supported when its
MCP server (its own repo: the firm's adapter) implements them. The harness has
no code for any firm.

The harness codes against this interface only: the agents, skills, order gate,
and gateway call these tools, whoever is behind them.

## Architecture

```text
harness (agents, skills, order gate, runner, CLIs)
        |  interface tools only (mcp__broker__<tool>)
   gateway + broker adapter   (scripts/mcp-gateway.js, scripts/lib/broker/)
        |  MCP stdio, the server named in the broker config
   <firm>-mcp                 (its own repo, one per broker or prop firm)
```

- **One repo per broker.** Each MCP server lives in its own GitHub repo and
  implements this interface. The harness holds no broker code.
- **Chosen in config.** `mcp-configs/brokers.json` holds the defaults;
  `~/.futures-trading-harness/brokers.json` adds brokers or overrides fields
  (`FTH_BROKERS_FILE` names another file); `FTH_BROKER` picks one:

  ```json
  {
    "broker": "<name>",
    "brokers": {
      "<name>": {
        "repo": "https://github.com/<owner>/<name>-mcp",
        "entryEnv": "<NAME>_MCP_ENTRY",
        "journal": "~/.<name>-mcp/journal.jsonl", "journalEnv": "<NAME>_JOURNAL_PATH",
        "env": ["<NAME>_USERNAME", "<NAME>_API_KEY", "..."],
        "paperEnv": { "<NAME>_TRADING_ENABLED": "false" }
      }
    }
  }
  ```

  | Field | Meaning |
  |---|---|
  | `repo` | Where the server lives |
  | `command` / `entry` / `entryEnv` | How to start it: an argv, a `.js` entry run with node, or the variable holding that entry |
  | `journal` / `journalEnv` | The journal file it writes (the variable wins) |
  | `env` | The variables it reads (credentials, guardrails), forwarded by harnesses |
  | `paperEnv` | What a paper run sets so the server refuses every order |
  | `replay` | `true` only for a simulated broker that replays history: the harness may then take its clock from `FTH_REPLAY_NOW`, if the broker shares no server or variables with a live one and its server's `get_server_config` confirms `replay: true` (see [HARNESS-DESIGN.md](HARNESS-DESIGN.md), Replay clock). A broker the defaults ship without it stays live whatever an override says |

  Switching brokers is a config change. Its settings go in
  `~/.futures-trading-harness/.env`, which the gateway loads.
- **Registered as `broker`.** Every harness registers the gateway
  (`node scripts/mcp-gateway.js`) as the MCP server named `broker`; the gateway
  starts the configured server and checks every order call.
- **One adapter.** Harness code reaches the broker only through
  `scripts/lib/broker/adapter.js`: reads straight to the server, order calls
  through the gateway. A live runner checks at startup that the server lists
  every interface tool, has trading enabled, and allows its account.

## Transport

- MCP over stdio (newline-delimited JSON-RPC). Log to stderr only.
- Every tool returns its payload as pretty-printed JSON text in `content[0].text`.
- A failure returns `isError: true` with the reason as plain text:
  - a guardrail refusal: `Blocked by risk guardrail: <reason>`;
  - a broker API error: the broker's message.
- A broker that answers but refuses (order not found, rejected) is not an error:
  the result carries `success: false` and its `errorCode` (see Outcomes).
  `place_order` is the exception: a refused order also sets `isError: true`.
- Request ids starting `fth-gw-` belong to the harness gateway.

## Common types

| Name | Type |
|---|---|
| `accountId` | integer, from `list_accounts` |
| `contractId` | the server's own id for a contract, any format. The harness never sees it: see Contract names |
| ISO time | ISO 8601 string with an offset, e.g. `2026-10-09T13:30:00Z` |
| trading day | starts 17:00 America/Chicago (the CME Globex day); daily figures and defaults use it |

## Contract names

The harness names contracts by standard names: the root for the front month
(`MNQ`, `NQ`, `ES`), or root and month for another (`NQ:2026-03`). Agents,
strategies, the journal, the gate, and the runner use only these. The contract
translator (`scripts/contract-translator.js`), which the harness always starts
in front of the selected server, maps them to the server's own ids and back,
by asking that same server:

- a name to an id: `search_contracts` with the root; the front month is the
  contract the server marks `activeContract`, fixed for the trading day;
- an id to a name: from those answers, else `get_contract`.

A contract's root and month come from its `name`, the exchange ticker: root +
month code + year (`NQZ5`, `MNQH26`). Its ids can be anything. Lookups are
cached per broker (`~/.futures-trading-harness/contracts-<broker>.json`).

## Tick specs

The harness takes every contract's tick size and tick value from the server:
`tickSize` and `tickValue` are required in every `search_contracts` and
`get_contract` reply. The translator records them per root in the same file
(`specs`) whenever the server describes a contract, and live and replay
trading use only those: the order gate checks prices on the tick and sizes
prop entries in dollars with them, and refuses an entry on a contract whose
specs it has none of (fetch the contract with `get_contract` or
`search_contracts` first). Exits and protective orders never need them. A
reply whose `tickSize` is not a number above 0, or whose `tickValue` is not a
number from 0.01 to 10,000 (USD per tick per contract), records nothing. A
server's spec that differs from the harness's static table (which backtests
and training use offline) is reported, since training would then not equal
live, and for a contract the table has, entries on it are refused until the
two agree (a units mix-up must not size a trade ten times too large).

## Tools

20 tools. **Bold** inputs are required; defaults in parentheses. Results list
every field a server returns; a server may add fields.

### Session and accounts

#### `get_server_config` (read)

Input: none.

Result: `{ apiUrl, username, tradingEnabled, allowedAccountIds (integer[] | "any"),
allowedSymbols (string[] | "any"), maxOrderSize, maxPositionSize,
maxDailyLoss (number | "off"), journalPath, tradingDayStartedAt, serverTime, replay? }`.
Never returns credentials. `replay` (optional boolean) is `true` only for a
replay server, which simulates history; its `serverTime` is then the replayed
time. Live servers omit it. The gateway honors `FTH_REPLAY_NOW` only when the
server reports `replay: true` and a `serverTime` within 5 minutes of it.
`maxOrderSize` is a whole number of contracts, 1 or more: the contract
translator records it from each successful answer (`server` in the same local file as
the tick specs), and the order gate refuses an entry larger than it, and
every entry until an answer with a valid one has been recorded. Exits and
protective orders are never held to it by the harness (the server applies
its own check to every order).

#### `list_accounts` (read)

Input: `onlyActiveAccounts` (true).

Result: list of `{ id, name, balance, canTrade, ..., mcpTradingAllowed }`;
`mcpTradingAllowed` = trading is enabled and the account is allowed.

#### `get_account_snapshot` (read)

Input: **`accountId`**.

Result:

```text
{ account: <list_accounts entry> | null,
  positions: <list_open_positions>,
  openOrders: <list_open_orders>,
  today: { tradingDayStartedAt, realizedNetPnL, dailyLossLimit | null,
           remainingBeforeLimit | null, ...<performance stats> } }
```

### Market data

#### `search_contracts` (read)

Input: **`searchText`** (non-empty, e.g. `MNQ`), `live` (false).

Result: up to 20 of `{ id, name (e.g. MNQZ6), description, tickSize
(required, above 0), tickValue (required, USD per tick per contract, 0.01 to
10,000), activeContract (the front month) }`. See Tick specs.

#### `get_contract` (read)

Input: **`contractId`**. Result: one contract, same fields.

#### `list_available_contracts` (read)

Input: `live` (false). Result: every tradable contract.

#### `get_bars` (read)

Input: **`contractId`**, `unit` (`second` | `minute` | `hour` | `day` | `week` |
`month`; minute), `unitNumber` (positive integer; 5), `limit` (1-20,000; 100),
`startTime`, `endTime` (ISO; default now), `includePartialBar` (false),
`live` (false). With no `startTime`, the window covers `limit` bars across
weekends and breaks.

Result: `{ contractId, barSize ("5 minute"), count, bars }`, bars oldest first,
each `{ t (bar open, UTC ISO), o, h, l, c, v }`.

A bar may carry extra fields of the server's own (and the result extra
keys). The harness passes them through untouched: it gives them no meaning,
and only a strategy document that names a field (the rules' `field("path")`)
reads it. A field that is missing or null reads as no value, so the
condition using it is false. Whether a server adds such fields, and which,
is the server's own setting (its environment, passed through by its
`mcp-configs/brokers.json` entry), never a `get_bars` argument the harness
sends.

#### `get_quote` (read)

Input: **`contractId`**, `timeoutMs` (500-15,000; 5,000).

Result: `{ contractId, ageMs, quote: { lastPrice, bestBid, bestAsk, change,
changePercent, open, high, low, volume, lastUpdated, timestamp } }`, or
`{ contractId, quote: null, note }` when none arrives (market closed).

### Positions, orders, fills (read)

#### `list_open_positions`

Input: **`accountId`**.

Result: list of `{ id, accountId, contractId, creationTimestamp, type (1 long,
2 short), size, averagePrice (entry), direction ("long" | "short") }`.
`size` is a whole number of contracts (0 or more); the harness never reads a
missing or malformed size as flat: its order gate refuses orders on that
account, and its runner treats the position as open.

#### `list_open_orders`

Input: **`accountId`**. Working orders, bracket legs included.

Result: list of `{ id, accountId, contractId, creationTimestamp, updateTimestamp,
status, type, side, size, limitPrice, stopPrice, fillVolume, filledPrice,
customTag, statusName, typeName, sideName }`.

#### `search_orders`

Input: **`accountId`**, **`startTimestamp`**, `endTimestamp`. Result: orders of
any status in the window, same fields. For a trailing stop, `trailPrice` here
is the trail distance, not a level.

#### `search_trades`

Input: **`accountId`**, `startTimestamp` (default: the trading day start),
`endTimestamp`. A `startTimestamp` in a past trading day must be honoured (the
fills since then, not only today's): after a day the runner missed, it
records that day's close from the fills since it ended.

Result: list of fills `{ id, contractId, creationTimestamp, price,
profitAndLoss (null on the opening half of a round turn), fees (number | null),
side, size, voided, orderId, sideName, halfTurn }`. A server whose broker
reports commissions apart from fees adds `commissions` (number | null): a cost
on top of `fees`, never a part of them. The harness checks the prop attempt's
balance against the fills' P&L less both.

#### `get_performance`

Input: **`accountId`**, `startTimestamp` (default: the trading day start),
`endTimestamp`.

Result: `{ window: { start, end }, overall, byContract: { <contractId>: stats } }`,
where stats = `{ fills, closingFills, wins, losses, scratches, winRate, grossPnL,
fees, netPnL, avgWin, avgLoss, largestWin, largestLoss, profitFactor,
expectancyPerClose }` (net of fees; voided fills ignored; null when undefined).

### Orders (write)

#### `place_order`

Input: **`accountId`**, **`contractId`**, **`side`** (`buy` | `sell`),
**`type`** (`market` | `limit` | `stop` | `trailing_stop` | `join_bid` |
`join_ask`), **`size`** (positive integer), `limitPrice` (required for limit),
`stopPrice` (required for stop), `trailPrice` (required for trailing_stop; an
absolute price level, not a distance), `stopLossBracket` / `takeProfitBracket`
(`{ ticks, type }`: `ticks` a whole number above 0 from the fill, `type`
`stop` for the stop leg and `limit` for the target; the harness sends every
entry with its `stopLossBracket`), `customTag` (≤ 100 chars, unique per account), **`rationale`**
(≥ 20 chars: setup, stop and why, target, $ risk).

Result: `{ orderId (number | null), success, errorCode, errorName, errorMessage }`.
`isError` is set when `success` is false.

Brackets: given a `stopLossBracket`, the server either attaches the stop leg
to the entry as its broker requires; or refuses the entry (`success: false`
with an `errorCode`: nothing opened); or, if it opened a position whose stop
it can't confirm, flattens it and says so in its reply. If it can't confirm
that flatten either, it returns an error reply saying a position may be
open: that reply is not a refusal, and the harness treats its outcome as
unknown. A server never leaves an entry open without the stop leg it was
given.

The harness's gateway sends every `place_order` with a `customTag` (the
client's, or one it adds) and, when a reply never comes, looks the order up by
that tag in `search_orders`. A server must pass `customTag` to the broker and
return it on each order in `search_orders`; without it, an order whose reply
was lost blocks new entries until the 2-minute grace period passes.

The harness's order gate reads the `rationale`: the `setup:<strategy>` tag
first, the side, `stop <price>`, `target <price>`; `[exit]` and `[protect]` mark
orders that reduce risk.

#### `modify_order`

Input: **`accountId`**, **`orderId`**, `size`, `limitPrice`, `stopPrice`,
`trailPrice` (absolute level), `reason` (journaled as a `note`).

Result: outcome (edit codes).

#### `cancel_order`

Input: **`accountId`**, **`orderId`**. Result: outcome (edit codes).

#### `close_position`

Flattens the whole position at market. It does not cancel resting stop or
target orders.

Input: **`accountId`**, **`contractId`**, `reason`. Result: outcome (close codes).

#### `partial_close_position`

Input: **`accountId`**, **`contractId`**, **`size`** (positive integer),
`reason`. Result: outcome (close codes). The harness's gateway checks it
against the account (an open position, a size no larger than it); the
server should refuse a size larger than the position too.

### Outcomes

Order tools return `{ success, errorCode, errorName, errorMessage }`:

| Codes | Values |
|---|---|
| place | 0 Success, 1 AccountNotFound, 2 OrderRejected, 3 InsufficientFunds, 4 AccountViolation, 5 OutsideTradingHours, 6 OrderPending, 7 UnknownError, 8 ContractNotFound, 9 ContractNotActive, 10 AccountRejected |
| edit (modify, cancel) | 0 Success, 1 AccountNotFound, 2 OrderNotFound, 3 Rejected, 4 Pending, 5 UnknownError, 6 AccountRejected |
| close | 0 Success, 1 AccountNotFound, 2 PositionNotFound, 3 ContractNotFound, 4 ContractNotActive, 5 InvalidCloseSize, 6 OrderRejected, 7 OrderPending, 8 UnknownError, 9 AccountRejected |

### Journal

#### `journal_add`

Input: **`kind`** (`plan` | `entry` | `exit` | `review` | `lesson` | `note`),
**`text`** (non-empty), `accountId`, `contractId`, `orderId`, `tags` (string[]).

Result: the entry written, `{ ts, kind, text, ... }`.

#### `journal_read`

Input: `kind` (any journal kind), `tag`, `contractId`, `since` (ISO),
`limit` (1-500; 50). Result: matching entries, newest last.

## Journal file

The order gate reads the journal from disk, so the server keeps it as a file:
JSONL, append-only, one entry per line,
`{ ts, kind, text, accountId?, contractId?, orderId?, tags?, data? }`.
The server writes these kinds itself:

| Kind | Written by | `text` / `data` |
|---|---|---|
| `order_placed` | every `place_order` the broker answered | the rationale / `{ request, result }` |
| `order_blocked` | a `place_order` a guardrail refused | the reason and the rationale |
| `exit` | `close_position`, `partial_close_position` | the reason / the outcome |
| `note` | `modify_order` with a `reason` | the reason |

## Guardrails

Every server applies these to its order tools:

| Check | Applies to |
|---|---|
| Trading enabled (off by default) | every order tool |
| Account allowed (empty list = any) | every order tool |
| Symbol allowed (empty list = any) | `place_order` |
| Size ≤ max order size (default 1) | `place_order`, `modify_order` with a size |
| Net position ≤ max position (default 2), counting resting same-side entry orders | `place_order` that adds exposure |
| Today's realized net loss < max daily loss (default 500; 0 = off) | `place_order` that adds exposure |

Orders that reduce exposure pass the position and daily loss checks.

## Enums

- Order type codes: 1 limit, 2 market, 3 stop limit, 4 stop, 5 trailing stop,
  6 join bid, 7 join ask.
- Side: 0 buy, 1 sell. Position type: 1 long, 2 short.
- Order status: 0 none, 1 open, 2 filled, 3 cancelled, 4 expired, 5 rejected,
  6 pending.
- Bar units: second, minute, hour, day, week, month.

## Server settings

Each server has its own credentials and settings (its `env` in the broker
config): at least the trading switch, allowed accounts and symbols, the size
and position limits, the daily loss limit, and the journal path.

## Checking a server

```bash
node scripts/check-broker-mcp.js [--account <id>] [--symbol MNQ] -- <server command> [args...]
```

Lists the tools and makes read-only calls, checking each result against the
interface. It never places, changes, or cancels an order, or writes the journal.

## Not in the interface

- Market data beyond OHLCV bars and quotes. A server may add fields to its
  bars (`get_bars`, above); the harness computes nothing of the kind itself.

## In the harness

| File | Role |
|---|---|
| `scripts/lib/broker/interface.js` | This document as data |
| `scripts/lib/broker/config.js` | The broker config: which server, its journal and variables |
| `scripts/lib/broker/mcp-client.js` | A minimal MCP stdio client |
| `scripts/lib/broker/adapter.js` | The adapter the runner and CLIs use |
| `scripts/lib/broker/conformance.js`, `scripts/check-broker-mcp.js` | The conformance checker |
