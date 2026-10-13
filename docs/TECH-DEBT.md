# Tech Debt

Known gaps, with the goal each one blocks. Add an item when you find one;
remove it in the PR that fixes it.

## Goal: swap the broker MCP server for any prop firm or brokerage

Switching brokers should be one line of config (`FTH_BROKER`, `brokers.json`)
plus a server that implements [the interface](BROKER-MCP-INTERFACE.md). Today
the interface still carries conventions of the interface's first server, so a
new server has more to translate than it should. Highest
impact first.

### 1. Outcome codes are the first server's tables

- **Today:** `errorCode` values for place, edit, and close are the first
  server's numbers (`OUTCOMES` in `scripts/lib/broker/interface.js`). Agents and skills
  act on them (4 = account locked: stop; 5 = outside hours: don't retry).
- **Cost:** a server must map its broker's errors onto another broker's numbers.
- **Fix:** make `errorName` the contract, from a short neutral set
  (`AccountLocked`, `OutsideTradingHours`, `Rejected`, `NotFound`, `Pending`,
  `Unknown`); keep `errorCode` as broker detail. Update the broker-mcp skill.

### 2. Order types include the first server's own ones

- **Today:** `place_order` types include `join_bid` and `join_ask`, and the
  numeric `type` codes in results are the first server's.
- **Fix:** keep `market`, `limit`, `stop`, `trailing_stop` required; make
  `join_bid` / `join_ask` optional, listed in `get_server_config` capabilities.
  Return a `typeName` in results and key on it, not the code.

### 3. Every server must write the journal file the gate reads

- **Today:** the order gate reads the journal from disk, so each server must
  write JSONL at the configured path, including `order_placed` entries
  (rationale plus result) for every `place_order`.
- **Cost:** every new server rebuilds the same journal, and a server that
  gets it slightly wrong weakens the gate.
- **Fix:** the gateway writes the journal itself: it already sees every
  `place_order` request and its result. Servers then only need
  `journal_add` / `journal_read`, or the gateway serves those too.

### 4. Extra bar fields are switched on by server settings

- **Today:** order flow is not a tool: a server that has it puts it on its
  `get_bars` bars as extra fields, which the harness passes through and the
  strategies read with `field("path")`. Whether the fields are there is the
  server's own environment setting (listed in its `brokers.json` entry's
  `env`), so a strategy that reads them gets no signal, silently, when the
  setting is off.
- **Fix:** if it bites, a server could list the extra bar fields it serves
  in `get_server_config`, for `check-broker-mcp.js` to report.

### 5. No way to test a server's order path

- **Today:** `scripts/check-broker-mcp.js` is read-only by design, so the
  order tools of a new server are first exercised on a real account.
- **Fix:** a `--sim` mode for a practice account: place and cancel a far
  limit order, move it, close nothing, and check every result shape against
  the interface.

### 6. Optional capabilities aren't declared

- **Today:** the harness assumes every server has every tool and limit
  (`get_bars` up to 20,000 bars, `get_quote`, partial closes).
- **Fix:** a `capabilities` object in `get_server_config` (max bars per
  request, rate limit, optional tools); the adapter and checker read it
  instead of hard-coded limits (`BAR_LIMIT` in `adapter.js`,
  `historyBars` in `scripts/lib/autotrader.js`).

### 7. One broker at a time

- **Today:** the gateway runs one server, so one session trades one broker.
- **Fix (only if needed):** route by account: `brokers.json` maps account ids
  to brokers, and the gateway starts one server per broker. Not needed while
  each attempt runs in its own session.

### 8. Server settings are each server's own

- **Today:** each server names its own variables (trading switch, allowed
  accounts, limits), so `brokers.json` lists them per broker (`env`,
  `paperEnv`).
- **Fix:** acceptable as is. Optionally, the interface could recommend
  standard names (`BROKER_TRADING_ENABLED`, ...) for new servers.

## Goal: every module follows the ECC architecture

`tests/plugin/ecc-architecture.test.js` lists what predates its rules; each
item is removed from the list in the PR that fixes it.

- **scripts/lib modules without a test of their own:** `backtest/parquet`,
  `paths`, `trading/cisd-ote`,
  `trading/contracts` (exercised only through other modules' tests).
- **CLIs over 200 lines, pinned at their size:** `scripts/autotrader.js` (401)
  and `scripts/mcp-gateway.js` (306): move logic to `scripts/lib/`.

## Other

- Skills added to `skills/` reach Codex and Qwen only after
  `node scripts/sync-harness.js`; CI fails until then (`npm run sync:check`).
