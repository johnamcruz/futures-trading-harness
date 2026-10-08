# Harness Design

How this repository runs an LLM-agnostic, autonomous futures trader on TopstepX through
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp).

## Principles

1. **One canonical tree, many harnesses** (the [ECC](https://github.com/affaan-m/ECC)
   architecture). `agents/`, `skills/`,
   `commands/`, `rules/`, `hooks/` are written once. Codex and Qwen adapters
   are generated (`scripts/sync-harness.js`) and checked for drift in CI.
2. **Enforcement lives in code below the model.** Anything that protects the
   account is deterministic and fails closed: the order gate runs as a hook
   where the harness supports hooks, and as an MCP gateway everywhere.
3. **Strategies are documents.** A `STRATEGY.md` is read by the agents (body)
   and by code (frontmatter). Every mechanical trigger is written as rules;
   code only adds series the rules can use.
4. **Workflows are skills.** Every harness supports SKILL.md; commands are thin
   shims.
5. **Regime-aware strategy selection.** A deterministic regime label on every
   closed bar decides which strategies are in play (`regimes:` in STRATEGY.md);
   reviews tagged by regime feed the per-regime scorecard, which is how the
   lineup adapts over time.
6. **Autonomy is a scheduler, not a long-lived agent.** Each cycle is one
   short, headless run with a fresh context; state lives in the journal.

## Harness support

| Capability | Claude Code | Codex | Qwen Code | Other MCP clients |
|---|---|---|---|---|
| Package | `.claude-plugin/` | `.codex-plugin/` + `.agents/plugins/marketplace.json` | `qwen-extension/` (linked) | n/a |
| Skills | plugin `skills/` | plugin `skills/` | extension `skills/` | read `skills/*/SKILL.md` |
| Agent roles | `agents/*.md` | `.codex/agents/*.toml` + `[agents.*]` (installer) | `qwen-extension/agents/*.md` (tool ids translated) | play roles from `agents/*.md` |
| Commands | `commands/` | (use skills) | `qwen-extension/commands/` (`{{args}}`) | n/a |
| Instructions | `workspace/CLAUDE.md` → `AGENTS.md` | `workspace/AGENTS.md` | `workspace/QWEN.md`, extension `QWEN.md` | `workspace/AGENTS.md` |
| Hooks | plugin `hooks/hooks.json` | plugin `hooks/hooks.json` (Codex sets CLAUDE_PLUGIN_ROOT; exit 2 blocks) | extension `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}` substituted) | none |
| Order gate | hook + gateway | hook + gateway | hook + gateway | gateway |
| Headless | `claude -p --plugin-dir`, tool allowlist | `codex exec`, workspace-write sandbox, projectx tools pre-approved | `qwen -p --approval-mode default`, workspace allowlist | custom argv |

## Order gate

`scripts/lib/trading/order-gate.js` (pure) is called through
`scripts/lib/trading/check-order.js` by both the PreToolUse hook and the MCP
gateway. The gateway (`scripts/mcp-gateway.js`, a newline-delimited JSON-RPC
proxy in front of projectx-mcp) also calls the server itself for positions,
working orders, and today's fills (`scripts/lib/trading/account-gate.js`), so it
is the authoritative layer. A blocked call never reaches the server.

| Check | Rule | Hook | Gateway |
|---|---|---|---|
| `paper-mode` | `FTH_PAPER=1` refuses entries | yes | yes |
| `journal-window` | The journal tail must reach back to the trading-day start | yes | yes |
| `kill-switch` | No `<FTH_HOME>/STOP` (default `~/.futures-trading-harness/STOP`) | yes | yes |
| `setup-tag` | Rationale starts with `setup:<strategy>` | yes | yes |
| `strategy` | Strategy exists, valid, `active`, trades this contract, inside its `sessions` | yes | yes |
| `stop-defined` | `stopLossBracket`, or `stop <price>` in the rationale | yes | yes |
| `order-consistency` | The order agrees with its rationale: the side named after the tag (`long`/`short`/`buy`/`sell`) is the order side; the stop and target sit on the right sides of a limit or stop entry's price and of each other; known-contract prices are on the tick; bracket ticks are whole and match the rationale's prices within a tick (a market order: stop + target ticks within two of the stop-to-target distance) | yes | yes |
| `plan-required` | A journal `plan` with this `contractId` within `FTH_PLAN_MAX_AGE_MIN` | yes | yes |
| `market-hours` | Entries only in the market session, 18:00-16:00 ET, Sunday evening to Friday (closed 16:00-18:00 ET), not on `FTH_CLOSED_DATES` holidays, and before 13:00 ET on `FTH_EARLY_CLOSE_DATES` (the runner passes both from its config). A hard rule: no setting widens it and it can't be skipped; the gateway checks it again after reading the account | yes | yes |
| `time-window`, `blackout` | Inside `FTH_ENTRY_HOURS` (default: the whole session), outside no-entry windows (09:30-09:35 and 15:45-16:00 ET) and news blackouts | yes | yes |
| `loss-streak`, `daily-loss-count` | From graded journal reviews (hook) and from real closing fills (gateway) | yes | yes |
| `review-before-next-entry` | Earlier entries in this contract have graded reviews | yes | yes |
| `max-entries` | Under `FTH_MAX_ENTRIES_PER_DAY` | yes | yes |
| `exposure` | `[exit]`/`[protect]` must be opposite the open position, within its size, without stacking resting stops or limits beyond it, and without bracket legs | no | yes |
| `position-open` | No new entry while the contract has a position, or one about to show (a recent order of any type that filled but isn't in the account yet) | no | yes |
| `working-orders` | No new entry while orders are working in the contract and it is flat (leftovers, a pending entry) | no | yes |
| `cancel-protection` | `cancel_order` may not remove the last protective stop of an open position | no | yes |
| `modify-size` | `modify_order` may change prices, not size | yes | yes |
| `modify-protection` | A protective stop may only move toward the market | no | yes |
| `modify-entry` | Only orders working an open position (its stop or target) can be repriced; entries and leftovers are cancelled and re-placed through the gate | no | yes |
| `order-pending` | No order call while an earlier one's result is unknown (no reply within 30 s) | no | yes |
| `batch` | Order calls go one at a time: a JSON-RPC batch containing one is refused whole | no | yes |
| `regime` | With `regime_gate: true`: the live regime of the strategy's timeframe fits its `regimes` | no | yes |

Malformed or oversized input, unreadable state, invalid config, a failed
account query, or a crash blocks the order. In autonomous runs
(`FTH_AUTONOMOUS=1`) the gate can't be skipped, dry-run, or disabled.
Decisions go to `~/.futures-trading-harness/gate-log.jsonl`.

## Autonomous runner

`scripts/autotrader.js` holds an exclusive lock, keeps a per-day state
(written atomically), and starts one headless run at a time in its own
process group: premarket at `premarketAt`, a trade cycle after every closed
`timeframe`-minute bar inside `sessions` (bar closes detected by polling
`retrieveBars` right after each scheduled close, see `scripts/lib/bar-clock.js`;
bars that close during a run are skipped), end of day at `eodAt` (retried until it
succeeds, and run first thing if a previous day never finished). The kill
switch stops new cycles but not end of day; after `maxConsecutiveErrors`
failed runs the runner creates it. An unreadable state file turns trade
cycles off for the day. Runs execute in `workspace/` with `FTH_ROOT`,
`FTH_AUTONOMOUS=1`, and, in paper mode, `FTH_PAPER=1` and
`PROJECTX_TRADING_ENABLED=false`.

Further safeguards:

- **Workspace fingerprint.** The runner fingerprints the workspace's
  instructions and project settings (`AGENTS.md`, `CLAUDE.md`, `QWEN.md`,
  `.qwen/`, `.claude/`, `.codex/`) before and after every run. A change
  creates the kill switch, because a Codex run can write its working
  directory.
- **Qwen allowlist.** For Qwen the runner rewrites the
  `workspace/.qwen/settings.json` allowlist at start, so it matches the
  configured bar and state directories.
- **Codex blackouts.** Codex runs may also write the news-blackouts
  directory (`<FTH_HOME>/blackouts`), and nothing else of the harness state.
- **Leftover orders.** Before each bar's cycle, the runner cancels working
  orders on a flat contract that are not pending entries recorded by the
  gateway.
- **No cycles.** With the kill switch on or outside the sessions, after the
  day has traded, the runner keeps housekeeping until end of day. It cancels
  every working order on a flat contract, including pending entries, because
  no cycle would manage their fill. It closes at market any position, in
  any month of the root, whose stops don't add up to its size (none, too
  few, or enough to flip it), then cancels the orders left behind. It keeps
  trailing protected positions.
- **Market session.** Sessions must lie inside 18:00-16:00 ET (the trading
  day runs from the 18:00 ET open to the 16:00 ET close) and `eodAt`
  (required) can't be later than 16:00 ET. Outside the session (16:00-18:00
  ET, weekends), or after the day's end of day, the runner reads the account
  once a minute and closes any position in its symbols. No position is
  carried past the close.
- **Deadlines.** No run outlasts end of day: each gets at most the time left
  until `eodAt` (end of day itself, until the 16:00 ET close), and a premarket
  run never delays end of day.
- **End-of-day backstop.** Before and after the end-of-day run, the runner
  reads the account and closes any position still open in its symbols,
  cancelling their orders, so neither a failed run nor one that exits
  cleanly without flattening can leave a position past the close.
- **Workspace guard.** When a run changes the workspace's instructions or
  settings, the runner appends the change to the kill-switch file, even if
  the file is already there for another reason.
- **No crash exits.** A pass that throws is logged and counted toward the
  kill switch, and the loop carries on.

Backtests (`scripts/backtest.js`, see [BACKTESTING.md](BACKTESTING.md)) replay
bar files through the same strategy evaluator the live scan uses.

## Known limits

- Live trailing counts the fill bar only when the fill came within 30 s of
  its open. A fill later in the bar skips the rest of that bar, which the
  backtest counts toward the peak. Live can therefore arm the trail one bar
  later than a backtest.
- Rules are evaluated over the whole series in a backtest. Live, they see
  the runner's `bars`: by default three trading days (at least 2000 bars),
  so prior-day and overnight levels, session VWAP and long indicators match
  the backtest. A level or VWAP for a session the bars start in the middle
  of is missing rather than wrong. A manual scan on fewer bars (e.g. a
  500-bar `get_bars`) can show those as missing.
- Order flow (`ofi`, `delta`) is real only where it was recorded from the
  TopstepX market hub (the runner with `orderFlow`, or
  `scripts/orderflow.js record`). The hub keeps no history, and minutes
  while it was disconnected have none; those bars use an estimate from the
  bar's shape and volume. Each print's side is the hub's trade `type`
  (0 buy-, 1 sell-initiated); a print without one
  is judged against the quote.
- The hook can't see positions; only the gateway checks that `[exit]` and
  `[protect]` orders really reduce exposure. Use the gateway on every harness.
- projectx-mcp itself: a position flip skips its daily-loss check, resting stop
  orders aren't counted toward its position limit, and `modify_order` only
  checks order size. The gateway covers these for harness traffic; fixing them
  in projectx-mcp would protect direct callers too.
- Journal reviews are self-graded. The gateway counts losses from real fills;
  the journal-based checks remain a second, softer layer.
- Codex agent roles can't be restricted to specific MCP tools in config; the
  executor-only rule is an instruction there. The gateway still applies.
- The cisd_ote strategy mirrors algoTraderBot's zone math (shorts enter at the
  29.5% retracement), which differs from textbook OTE. Confirm it's intended.
