# Order flow: live and replay order-flow data for the OFI strategies

Status: design and work plan only, nothing built. It is scheduled after the
end-to-end trading and labeling pipeline works well (the owner's priority).
The strategies that use order flow stay `status: paper` until the steps below
are done and the owner promotes them:

- `strategies/ofi` and `strategies/ofi_absorption` (1m, `connectors:
  [order_flow]`), and `strategies/prop_flow_1m` through them;
- `strategies/value_area` (3m, `connectors: [order_flow]`): `ofi(3) >= 0.2` is
  one branch of an `any` confirmation, and the strategy is listed in
  `prop_portfolio`, the policy strategy the prop backtests and the
  learned-rulebook design (to come) score.

## What the strategies need

`ofi(n)` and `delta(n)` (`scripts/lib/trading/indicators.js`) are computed
from per-1-minute aggressor volume: buy volume `bv` and sell volume `sv` (or
`buy_volume`/`sell_volume`, `flowFields`). A bar's flow counts as real only
when `bv + sv >= 0.5 × v` (`hasFlow`); otherwise the indicators fall back to
an estimate from the bar's shape (`barDelta`). No depth, quotes or imbalance
levels are needed.

Today flow reaches bars only through recorded files
(`<FTH_HOME>/flow/<id>.csv`, `scripts/lib/trading/flow.js`), read by
`scripts/orderflow.js export` and by backtest CSV columns
(`scripts/lib/backtest/data.js` accepts `buy_volume`/`sell_volume`). The live
runner never attaches flow: `scripts/lib/runner.js` has a `flow.annotate`
hook that no caller passes. Bars from `get_bars` pass through the adapter
(`scripts/lib/broker/adapter.js`) unchanged, and `normalizeBars` keeps
`bv`/`sv`, so those two fields on a broker's bars would reach the evaluator.
Any other per-bar field (such as a coverage marker) is dropped by
`normalizeBars` today, which is why design step 5 changes it.

## The data (local, licensed, never published)

The order-book data set (its own README is the schema): NQ only, 2020-12 to 2025-11, about 58 GB.

- `l1/YYYYMM.parquet`: `ts` (UTC), `type` (0 bid, 1 ask, 2 trade, 3-9 session
  statistics), `price` (index points), `vol`. Top-of-book changes and trade
  prints.
- `l2/YYYYMM.parquet`: depth updates (`side`, `price`, `vol`, `depth`, `act`).
- Trades carry **no aggressor side**: it is inferred by the quote rule (at or
  above the ask a buy, at or below the bid a sell, else the tick rule).
- The stream switches contract at each roll (a price jump equal to the
  spread); those minutes are masked.
- Gaps: holidays plus about 15 unexplained weekdays in l1; about 40 days of
  missing l2 between 2024-08 and 2024-11.
- The bar data the replay broker serves
  (`<ROOT>_1min.csv` in `BACKTESTER_DATA_DIR`, from 2021-04-25) is
  back-adjusted and has no flow columns. Trade volumes match it within about
  0.3%; prices differ by the back-adjustment, so flow is joined by minute
  timestamp, never by price.
- Months with both bars and flow: 2021-05 to 2025-11. Replays of later months
  have no flow.

The original bot already has the pieces to port, all under its `scripts/`: `build_tick_orderflow.py` (per-minute quote-rule buy/sell
volume from l1), `record_orderflow.py` (records live trades), and
`orderflow_jsonl_to_bars.py`, plus a roll and gap mask.

## Live

Live order flow (its source, recording, gaps and warm-up) belongs to the live
broker server and is documented in its repo.

## Design

One addition to the broker interface, implemented by every broker server that
can supply it, so replay equals live.

1. **Interface** (`docs/BROKER-MCP-INTERFACE.md`,
   `scripts/lib/broker/interface.js` including the `get_bars` result fields,
   the conformance checks in `scripts/lib/broker/conformance.js`, run by
   `scripts/check-broker-mcp.js`):
   - `get_bars` gains an optional input `includeOrderFlow`. Each bar may then
     carry `bv`, `sv`, and `flow: "complete" | "partial" | "none"`.
   - For bars longer than one minute, the server sums `bv`/`sv` over the
     bar's minutes, and the bar is `complete` only if every one of its minutes
     is (the rule `flow.js` `withFlow` already applies to recorded files).
   - `get_server_config` gains an optional
     `orderFlow: { minuteBars, side: "exchange" | "quote-rule", coverageSince }`.
   - A broker without order flow omits both; nothing else changes.
   - Fields on `get_bars` rather than a separate tool, so flow stays aligned
     with the bars by construction.
2. **The live broker server** (its own repo): records live order flow and
   serves it on `get_bars`; how is documented in its repo.
3. **backtester-mcp** (its own repo): serves an optional
   `<ROOT>_1min_flow.csv` (`time,buy_volume,sell_volume`) from its data
   directory, joined to the bars by minute, for closed bars only (no
   lookahead). Gap days and roll minutes are `flow: "none"`. It reports
   `orderFlow.side: "quote-rule"`.
4. **Offline conversion**: a Python script the user runs, outside the harness
   (in the original bot's repository or a separate tools repository), porting
   `build_tick_orderflow.py`: Parquet in, per-minute CSV out, into the user's
   data directory. The same output serves the JS backtester, which reads
   CSVs through `scripts/lib/backtest/data.js`: either a bars-plus-flow CSV
   (`buy_volume`/`sell_volume` columns) or a join at load time, so offline
   backtests see the same flow as the replay broker. The harness never reads Parquet and needs no Python at runtime; no
   data is committed anywhere.
5. **Harness**:
   - Thread `includeOrderFlow` through `adapter.closedBars` (which builds the
     `get_bars` arguments) and its callers: the runner's bar fetch, the
     scan/fetch tool (`scripts/lib/bars-fetch.js`), and `adapter.history`
     (used by `orderflow.js export`). Decide whether the unused
     `flow.annotate` hook in `runner.js` is reused or removed.
   - `normalizeBars`/`flowFields` keep the `flow` marker and drop `bv`/`sv`
     from a bar whose `flow` is `partial` or `none` (recorded files, which
     have no marker, keep today's behaviour), so a partial minute never counts
     as real flow. `market-snapshot.js` reports flow as real by the same rule
     (today it checks only that `bv` and `sv` are numbers on the last 5 bars).
   - New evaluator rule: a branch of a rule that needs `ofi`/`delta` is not
     satisfied unless every bar in that indicator's lookback has real flow
     (reason "no real flow"), so `ofi(5)` never mixes real and estimated flow.
     A strategy's other branches still apply: `value_area`'s expansion branch,
     which needs no flow, keeps working. The bar-shape estimate stays for
     offline research only.
   - **Backtests equal live**: the same rule applies in the JS backtester, or
     `prop_portfolio`'s components would fire on the estimate in backtests
     and not live.
   - The recorded-flow path (`flow.js`, `orderflow.js`, `<FTH_HOME>/flow/`)
     stays as a fallback source for brokers without order flow; its text in
     `docs/BROKER-MCP-INTERFACE.md` ("Not in the interface") and
     `strategies/README.md` ("live these run on the estimate") is updated.
   - The skills that describe order-flow strategies say so (model-neutral),
     synced to every harness.

## Work plan (each its own PR, with the regression and review)

1. Interface and harness: the `get_bars`/`get_server_config` additions, the
   conformance checks, threading `includeOrderFlow`, the flow marker in
   `normalizeBars`, the "no real flow" rule in the evaluator and the
   backtester, skills and docs.
2. backtester-mcp: serve the flow file (summed for longer bars), mark gaps
   and rolls, conformance.
3. Offline conversion script (outside the harness), with a check that its
   volumes match the bar data's, writing both the replay broker's flow file
   and the backtester's CSV columns.
4. The live broker server (its own repo): live order flow on `get_bars`.
5. Validation before promotion:
   - record live flow for a period and compare it minute by minute with the
     quote-rule flow for the same minutes (the side rule differs: exchange
     aggressor live, quote rule in replay);
   - rules-only backtests of each order-flow strategy on the flow history;
   - reasoning-trader replays on months with flow (2021-05 to 2025-11).
6. The owner decides whether to promote each order-flow strategy to `active`.

## Risks

- **Side mismatch**: exchange aggressor live against the quote rule in
  replay. Measured in step 5 before any promotion.
- **Instruments**: the data is NQ only; strategies listing MES, MYM or M2K
  need their own data or stay paper for those.
- **Gaps and warm-up**: no history live; every reconnect needs a warm-up of
  the longest flow lookback, and partial minutes must never count as real
  flow.
- **Backtests versus live**: the "no real flow" rule changes which
  `prop_portfolio` components fire; backtests must apply it too.
- **Rolls**: a contract switch inside the flow data must never reach replay
  prices.
- **Licensing**: the order-book data is licensed vendor data; it is never
  published, and the repositories hold code only.
