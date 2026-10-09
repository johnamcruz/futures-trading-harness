# Tech Debt

Known gaps, with the goal each one blocks. Add an item when you find one;
remove it in the PR that fixes it.

## Goal: swap the broker MCP server for any prop firm or brokerage

Switching brokers should be one line of config (`FTH_BROKER`, `brokers.json`)
plus a server that implements [the interface](BROKER-MCP-INTERFACE.md). Today
the interface still carries conventions of its first server (projectx-mcp,
TopstepX), so a new server has more to translate than it should. Highest
impact first.

### 1. Contract ids follow ProjectX's format

- **Today:** ids must look like `CON.F.US.<SYMBOL>.<MONTH><YY>`. The harness
  reads the root and the month out of the id (`contractRoot` in
  `scripts/lib/trading/journal.js`), and maps NQ, ES, and GC to ProjectX's id
  symbols ENQ, EP, and GCE (`ID_SYMBOL` in `scripts/lib/trading/contracts.js`,
  used by `activeContract` in `scripts/lib/broker/adapter.js`).
- **Cost:** every other broker's server has to rewrite its own ids into
  ProjectX's shape and copy ProjectX's symbol quirks.
- **Fix:** make ids opaque. Add `symbol` (root, e.g. `MNQ`) and `expiry` to
  `search_contracts` and `get_contract` results; the harness keys on those and
  passes ids back unread. Drop `ID_SYMBOL`.

### 2. Outcome codes are ProjectX's tables

- **Today:** `errorCode` values for place, edit, and close are ProjectX's
  numbers (`OUTCOMES` in `scripts/lib/broker/interface.js`). Agents and skills
  act on them (4 = account locked: stop; 5 = outside hours: don't retry).
- **Cost:** a server must map its broker's errors onto another broker's numbers.
- **Fix:** make `errorName` the contract, from a short neutral set
  (`AccountLocked`, `OutsideTradingHours`, `Rejected`, `NotFound`, `Pending`,
  `Unknown`); keep `errorCode` as broker detail. Update the broker-mcp skill.

### 3. Order types include ProjectX-only ones

- **Today:** `place_order` types include `join_bid` and `join_ask`, and the
  numeric `type` codes in results are ProjectX's.
- **Fix:** keep `market`, `limit`, `stop`, `trailing_stop` required; make
  `join_bid` / `join_ask` optional, listed in `get_server_config` capabilities.
  Return a `typeName` in results and key on it, not the code.

### 4. Every server must write the journal file the gate reads

- **Today:** the order gate reads the journal from disk, so each server must
  write JSONL at the configured path, including `order_placed` entries
  (rationale plus result) for every `place_order`.
- **Cost:** every new server rebuilds the same journal, and a server that
  gets it slightly wrong weakens the gate.
- **Fix:** the gateway writes the journal itself: it already sees every
  `place_order` request and its result. Servers then only need
  `journal_add` / `journal_read`, or the gateway serves those too.

### 5. Order flow isn't in the interface

- **Today:** live order flow (aggressor buy/sell volume) has no tool, so live
  order-flow strategies fall back to the bar-shape estimate while backtests
  use recorded flow files.
- **Fix:** an optional `get_order_flow` tool (per-minute buy/sell volume for a
  contract and window), listed in `get_server_config` capabilities; the
  adapter uses it when present. Build it first in projectx-mcp (its own repo).

### 6. No way to test a server's order path

- **Today:** `scripts/check-broker-mcp.js` is read-only by design, so the
  order tools of a new server are first exercised on a real account.
- **Fix:** a `--sim` mode for a practice account: place and cancel a far
  limit order, move it, close nothing, and check every result shape against
  the interface.

### 7. Optional capabilities aren't declared

- **Today:** the harness assumes every server has every tool and limit
  (`get_bars` up to 20,000 bars, `get_quote`, partial closes).
- **Fix:** a `capabilities` object in `get_server_config` (max bars per
  request, rate limit, optional tools); the adapter and checker read it
  instead of hard-coded limits (`BAR_LIMIT` in `adapter.js`,
  `historyBars` in `scripts/lib/autotrader.js`).

### 8. One broker at a time

- **Today:** the gateway runs one server, so one session trades one broker.
- **Fix (only if needed):** route by account: `brokers.json` maps account ids
  to brokers, and the gateway starts one server per broker. Not needed while
  each attempt runs in its own session.

### 9. Server settings are each server's own

- **Today:** each server names its own variables (trading switch, allowed
  accounts, limits), so `brokers.json` lists them per broker (`env`,
  `paperEnv`).
- **Fix:** acceptable as is. Optionally, the interface could recommend
  standard names (`BROKER_TRADING_ENABLED`, ...) for new servers.

## Other

- Skills added to `skills/` reach Codex and Qwen only after
  `node scripts/sync-harness.js`; CI fails until then (`npm run sync:check`).
