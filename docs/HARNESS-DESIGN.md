# Harness Design

How this repository runs an LLM-agnostic, autonomous futures trader through a
broker MCP server that implements the broker MCP interface
(`docs/BROKER-MCP-INTERFACE.md`).

## Principles

1. **One canonical tree, many harnesses** (the [ECC](https://github.com/affaan-m/ECC)
   architecture). `agents/`, `skills/`,
   `commands/`, `rules/`, `hooks/` are written once. Codex, Qwen and opencode adapters
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
7. **No broker code.** Every broker or prop firm runs its own MCP server (its
   own repo) implementing one interface, [BROKER-MCP-INTERFACE.md](BROKER-MCP-INTERFACE.md).

## Brokers

Which server is config: `mcp-configs/brokers.json` (the default is the broker it names),
overridden by `~/.futures-trading-harness/brokers.json` (`FTH_BROKERS_FILE`),
chosen by `FTH_BROKER` (`scripts/lib/broker/config.js`). A broker entry names
the server's entry point (`entryEnv`), its journal (`journalEnv`), the
variables it reads (`env`, which Codex forwards), and the variables paper
mode sets (`paperEnv`).

Every harness registers the MCP server `broker` as the gateway alone
(`node <repo>/scripts/mcp-gateway.js`); the gateway starts the configured
server, loading its settings from `~/.futures-trading-harness/.env`. Agents
see `mcp__broker__<tool>` whatever the firm.

Harness code reaches the broker only through the adapter
(`scripts/lib/broker/adapter.js`): the runner, `bars.js`, and `backtest.js
fetch`. Reads go straight to the server over MCP; order
calls go through the gateway, so they are gated and journaled.
`scripts/check-broker-mcp.js` checks a server against the interface with
read-only calls.

## Harness support

| Capability | Claude Code | Codex | Qwen Code | opencode | Other MCP clients |
|---|---|---|---|---|---|
| Package | `.claude-plugin/` | `.codex-plugin/` + `.agents/plugins/marketplace.json` | `qwen-extension/` (linked) | `workspace/opencode.json` (project config) | n/a |
| Skills | plugin `skills/` | plugin `skills/` | extension `skills/` | `skills.paths`: `{env:FTH_ROOT}/skills` | read `skills/*/SKILL.md` |
| Agent roles | `agents/*.md` | `.codex/agents/*.toml` + `[agents.*]` (installer) | `qwen-extension/agents/*.md` (tool ids translated) | `agent.<role>` in `workspace/opencode.json` (subagents, permission keys translated) | play roles from `agents/*.md` |
| Commands | `commands/` | (use skills) | `qwen-extension/commands/` (`{{args}}`) | (use skills) | n/a |
| Instructions | `workspace/CLAUDE.md` → `AGENTS.md` | `workspace/AGENTS.md` | `workspace/QWEN.md`, extension `QWEN.md` | `workspace/AGENTS.md` | `workspace/AGENTS.md` |
| Hooks | plugin `hooks/hooks.json` | plugin `hooks/hooks.json` (Codex sets CLAUDE_PLUGIN_ROOT; exit 2 blocks) | extension `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}` substituted) | none | none |
| Order gate | hook + gateway | hook + gateway | hook + gateway | gateway | gateway |
| Headless | `claude -p --plugin-dir`, tool allowlist | `codex exec`, workspace-write sandbox, broker tools pre-approved | `qwen -p --approval-mode default`, workspace allowlist | `opencode run --format json --dir <workspace>`, the project's permissions plus the runner's per-run config | custom argv |

### opencode

`workspace/opencode.json` is generated from `agents/` (`scripts/lib/opencode.js`)
and names no provider or model: those stay in the user's own opencode config.
It registers `broker` (the gateway) and `harness` as local MCP servers started
from `{env:FTH_ROOT}` (unset, they don't start), which inherit opencode's
environment. Each role's prompt is its agent body followed by the skills its
`role-skills` frontmatter lists, in full (`agentPrompt`): the role has them
every call without a skill-load turn, as part of its fixed prompt prefix that
a local model server caches, and its "Load the skills" sentence says they are
below. A role's optional `role-index` (skills its "Load the skills" sentence
names with the core: Claude Code, Codex and Qwen Code load them all) is, by
default (`FTH_ROLE_SKILLS` unset or `index`, the committed file), one line per
skill (its description), which the role reads with the harness tool
`skill_lookup` only when the cycle needs it, and the prompt's load sentence
becomes two (the core below; "Look up as needed: ..." for the index). With
`FTH_ROLE_SKILLS=full` (generated with `FTH_ROLE_SKILLS=full node
scripts/sync-harness.js`; the runner's start check refuses a workspace
generated for another mode) the index is embedded in full too. The runner
passes opencode's mode to its run and `full` to every other harness's run,
whose roles load all their skills as their body says, so the gate never waits
on a lookup those roles don't make. Where a bar's briefing makes an indexed skill
necessary (`SITUATIONAL`, `scripts/lib/trading/skills-loaded.js`), the order
gate counts the role's report for an entry only if the role looked it up
during that call: the harness tool records each lookup with the role it names
(`scripts/lib/trading/skill-lookups.js`), since a subagent's own tool calls
are not in the session's transcript. With several lanes, the candidates of
each other lane whose bar closed this cycle count too (that lane's briefing on
its bar, else its signal record on its bar, with every trend rule; neither:
every lookup is required). Such a role is never served from the
report cache on that bar, and with no current briefing every situational
lookup of its index is required (fails closed). Exits are never held. Permissions follow opencode's rule (the last matching rule wins;
headless, anything not allowed is refused): the session denies everything,
then allows the broker and harness tools (orders through the gateway), skills,
the harness's roles by name (`task`), reading (never a `.env`), and web
search; `bash`, `edit` and `webfetch` (which opencode can't limit to the
calendar sites) are denied by name too. opencode evaluates an agent's own
rules after the top-level ones, so the session runs as the harness's own
primary agent, `fth-head-trader` (`--agent`, `default_agent`), with the same
permissions; opencode's agents (`build`, `general`, `explore`, `plan`) are
disabled, and a user's rules for them never apply. Each role denies
everything, then names every broker and harness tool (its own allowed, the
rest denied, so no user rule for the role grants one), then allows its other
tools (Claude names translated: `mcp__broker__x` → `broker_x`, `Read` →
`read` and `list`); a role's shell, edits, web fetch and delegation are never
granted, so only `trade-executor` holds order tools. Language servers,
formatters and snapshots are off. The roles live in the one file, not
in `.opencode/agents/`: opencode installs npm packages into every `.opencode/`
folder it loads (running its `package.json`), so the harness keeps none, and
the workspace guard fingerprints `.opencode/` whole (absent).

The runner passes per run (`OPENCODE_CONFIG_CONTENT`, merged last) every
permission again (the session's, the head trader's, each role's), so a run is
locked down without the project file, and the directories outside the project it may read (the harness root,
the bar directory, the runner's logs, the bars scratch directory), for the
session and every role. It names the workspace with `--dir` and `PWD`
(opencode takes its project from `PWD`, not the working directory), turns off
the update check, sharing, Claude Code and external skills, and language
server downloads, and drops `OPENCODE_PERMISSION`,
`OPENCODE_DISABLE_PROJECT_CONFIG` and `OPENCODE_CONFIG_DIR` from the
environment. `extraArgs` may only be `--variant`, `--thinking`,
`--print-logs` and `--log-level` (not `--auto` or its aliases, `--attach`,
`--dir`, `--agent`, or a session to continue). opencode also loads project
config (`opencode.json`, `.opencode/`) from the folders above the workspace up
to the repository's top: keep none in the repository (no autonomous run of
any harness can write there). The model is
opencode's default unless the runner config's `model` names one
(`<provider>/<model>`). opencode's JSON events carry the main session's own
calls only: a subagent's calls (the trade-executor's orders) are not in the
cycle log.

### Harness tools server

`node scripts/harness-tools-mcp.js` is an MCP server named `harness` (stdio,
newline-delimited JSON-RPC) that offers the scripts agents run as tools, for
any MCP client: `strategies_list`, `strategies_show`, `strategies_validate`,
`strategies_scan`, `strategies_recent`, `market_snapshot`, `mtf_read`,
`blackouts_list`, `blackouts_add`, `bars_fetch`, `combine_status`, `lessons`,
`reconcile`. Each runs the same operation as its CLI
(`scripts/lib/harness-tools/index.js`) and returns the CLI's output: its stdout
with the operation's stderr notes appended, or on failure `isError` with
`[<script>] <message>`. Arguments are checked against strict schemas
(`registry.js`; unknown arguments refused), after a number or `true`/`false`
sent as a string is read as the number or boolean the schema takes
(`repair.js`); no tool takes an environment, a
working directory, an output path, or a time (the harness clock, read per call
from the server's environment, decides; a refused replay clock refuses as the
CLI does). The only paths are bars files: regular `.json` or `.csv` files (never
Parquet or Excel: those readers trust their file) of at most 50 MB under `FTH_BARS_DIR` (default
`<FTH_HOME>/bars`) or `<FTH_HOME>/bars-scratch` (where `bars_fetch` writes: each
harness home's own, so a replay's run home and the live runner never share
fetched bars), with no symlink and one hard link, in
directories only the user owns and can write (`paths.js`). Only `bars_fetch`
loads the user's `.env` (into a copy), as only `bars.js` does. `record` is never honoured in autonomous runs (`FTH_AUTONOMOUS=1`, which every
harness hands its MCP servers: Claude, Qwen and opencode pass their environment, Codex
forwards it): the call succeeds with its result and a `note: record ignored`
line, and writes no record (the runner writes the gate's records). It is
refused whenever a live runner holds its lock
(`<FTH_HOME>/autotrader.lock`, its pid an autotrader's), whatever the
server's environment; the scripts do the same. A reply over 256 KB is
refused with how to narrow it, never truncated. No tool places, modifies or
cancels an order, and the order-gate hook matches none of them. The installer
registers it as `harness` for every harness, as it registers `broker` (Claude:
`claude mcp add harness`; Codex: `[mcp_servers.harness]`, pre-approved, with
the clock, state, bars directory and calendar variables forwarded; Qwen: user
settings and the extension manifest; opencode: the generated
`workspace/opencode.json`). Autonomous runs allow `mcp__harness`; the
runner sets `FTH_BARS_DIR` to its bar directory and, at start, checks that this
checkout's server answers `tools/list` with the registry's tools (it can't see
which server a harness's own settings register as `harness`; the headless
check probes that). On a failure a manual trade or premarket run is refused, a
manual end of day only warns, and the live loop turns trading off with the kill
switch while end of day and housekeeping keep running. `node scripts/check-headless.js` runs
one real headless probe per harness (harness tools, a subagent by role, a shell
attempt, in paper mode with the broker narrowed to its read tools: no order
or journal-write tool on any harness) and reports what each reached; Qwen runs on the
runner's workspace allowlist (`--write-qwen-allowlist` writes it, with no
runner trading: a running runner treats the change as a workspace change).

## Order gate

`scripts/lib/trading/order-gate.js` (pure) is called through
`scripts/lib/trading/check-order.js` by both the PreToolUse hook and the MCP
gateway. The gateway (`scripts/mcp-gateway.js`, a newline-delimited JSON-RPC
proxy in front of the broker MCP server) also calls the server itself for positions,
working orders, and today's fills (`scripts/lib/trading/account-gate.js`), so it
is the authoritative layer. A blocked call never reaches the server.

| Check | Rule | Hook | Gateway |
|---|---|---|---|
| `paper-mode` | `FTH_PAPER=1` refuses entries | yes | yes |
| `journal-window` | The journal tail must reach back to the trading-day start | yes | yes |
| `kill-switch` | No `<FTH_HOME>/STOP` (default `~/.futures-trading-harness/STOP`) | yes | yes |
| `setup-tag` | Rationale starts with `setup:<strategy>` | yes | yes |
| `strategy` | Strategy exists, valid, `active`, trades this contract, inside its `sessions` | yes | yes |
| `stop-defined` | Every entry carries its stop as `stopLossBracket` (numeric whole ticks above 0, type `stop` or `trailing_stop`); a stop price only in the rationale is not one. A broker that can't attach the bracket refuses the entry; it is never sent again without one | yes | yes |
| `mtf-trend` | The multi-timeframe trend rule: a trend strategy (anything without `mtf: reversal`; a policy strategy is judged by the component its verdict trades) never enters against the prevailing trend (the highest of 4h, 1h, 15m with one) in `<FTH_HOME>/mtf/<ROOT>.json`, which the runner writes every bar and `mtf.js --record` interactively; a missing record, or one more than `FTH_MTF_MAX_AGE_MIN` (15) past its bar's close, refuses trend entries. Hard: not skippable. The scan and the backtester apply the same rule to candidates | yes | yes |
| `trigger-fired` | A rules strategy enters only on its own trigger: the signal record (`<FTH_HOME>/signals/<ROOT>-<minutes>m.json`, written by the runner every bar and by `strategies.js scan --record`) shows it fired on the ordered side, on a bar that closed at most `FTH_SIGNAL_MAX_AGE_BARS` (3) bars of the strategy's own timeframe ago, never more than 45 minutes (3 min on 1m, 9 min on 3m, 45 min on 15m and 1h; a timeframe it can't read counts as 1 minute, the strictest; `FTH_SIGNAL_MAX_AGE_MIN`, when set, only shortens it). A relabelled setup tag or a stale signal is refused. Hard | yes | yes |
| `combine`, `policy` | A strategy that trades an account (a policy strategy): a started attempt, a fresh account snapshot, the account's own blocks, one position at a time, and a size within the budget for the order's stop (`combine`); and a verdict the runner recorded at the setup for this contract (`<FTH_HOME>/policy-verdicts.jsonl`), unexpired, not used for an entry yet, on the bar the setup is on now (the verdict's `bar` is the last bar of the strategy's timeframe signal record, `<FTH_HOME>/signals/<ROOT>-<minutes>m.json`, compared as instants; a verdict that names no bar, one for an older or a newer bar, and a missing or unreadable record are refused), saying `full` with a multiplier above 0 and at most 1 (the rulebook's enforced items; the budget is checked at it; `skip` and any other action, `half` included, are refused, as is a missing or out-of-range multiplier), with the order's side, contract, stop ticks, and at most its size (`policy`). Hard: not skippable; `[exit]`/`[protect]` orders are never held by them | yes | yes |
| `skills-loaded` | The session transcript (the hook's `transcript_path`, and its main session's for a Claude subagent) shows the skill tool loaded `trade-session`, `multi-timeframe-analysis`, `strategy-library`, `strategy-scan`, and `strategy-gate-checks` before an entry: a Claude Code `Skill` call, or in Qwen Code's chat file a `skill` call that its answer shows loaded (a failed load doesn't count). opencode's `skill` events count too. The gateway reads the runner's live cycle transcript (`FTH_CYCLE_TRANSCRIPT`, a file per run) for Claude Code and opencode cycles. Codex passes no transcript: not applicable | yes | yes, autonomous Claude Code and opencode cycles |
| `roles-ran` | An autonomous cycle's entry (`FTH_CYCLE`: full or lean) waits for its roles: a full cycle's `market-structure-analyst`, `trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` phase 1, then phase 2 (a second risk-manager call started after phase 1 and the analysts returned); a lean cycle's risk-manager phase 1, then phase 2. Calls count when they returned in the foreground without an error, since the last `trade-executor` call (`roles-ran.js`), in the same transcripts as `skills-loaded`; a transcript the runner named that can't be read refuses. Codex and the custom harness: not applicable | yes | yes, autonomous Claude Code and opencode cycles |
| `phase2-facts` | An autonomous cycle's entry: the `FACTS:` line of the phase-2 report that approved it (`roles-ran.js` approvedPhase2), each claim in its closed form (window, entries, news, trend, read, 15m/1h/4h, vwap, value, room) checked in code against the cycle bar's briefing for the order's root (`fact-claims.js`; the learned-rulebook design's R29). A claim the briefing contradicts refuses the entry, naming it; stated claims it can't check (no current briefing for the cycle's bar, an unreadable transcript, the check failing) refuse too (fails closed). With a current briefing an approval must state at least 2 distinct claims it checks (owner's decision); a pinned cycle bar (`FTH_CYCLE_BARS`) whose briefing is missing, corrupt or another bar's refuses whatever was stated; with no bar pinned and no current briefing, no FACTS line or `FACTS: none` passes. More than 20 items refuse. A report naming another cycle symbol and not the order's is refused (one symbol per report). A claim in no known form, or about a fact the briefing doesn't hold, is unchecked and recorded, never guessed, and doesn't count. Never skippable; exits and protective orders never reach it. Every phase-2 report's check is recorded in the cycle log (`factCheck`) | yes | yes, autonomous Claude Code and opencode cycles |
| `order-consistency` | The order agrees with its rationale: the side named after the tag (`long`/`short`/`buy`/`sell`) is the order side; the stop and target sit on the right sides of a limit or stop entry's price and of each other; known-contract prices are on the tick; bracket ticks are whole and match the rationale's prices within a tick (a market order: stop + target ticks within two of the stop-to-target distance) | yes | yes |
| `plan-required` | A journal `plan` with this `contractId` within `FTH_PLAN_MAX_AGE_MIN` | yes | yes |
| `contract-specs` | An entry is checked and sized with the broker's tick size and value, as the contract translator recorded them from the broker's `search_contracts` / `get_contract` answers (`specs` in `<FTH_HOME>/contracts-<broker>.json`, one per replayed day under a replay clock; `scripts/lib/trading/broker-specs.js`). None recorded for the contract (a reply with a tick size not above 0 or a tick value outside $0.01-$10,000 records none) refuses the entry, saying to look the contract up first; so does, on a replayed day, a day file with no front month of the root yet (only a lookup by month succeeded); so does a recorded spec that differs from the static table for a contract the table has (training would not equal live, and a units mix-up would size the trade wrong); a prop entry also needs its micro/mini partner's. Exits and protective orders never need them. Hard: not skippable | yes | yes |
| `max-order-size` | An entry's size is a whole number of contracts, at most the broker server's `maxOrderSize`, as the contract translator recorded it from the server's last `get_server_config` answer (`server` in `<FTH_HOME>/contracts-<broker>.json`, one per replayed day under a replay clock; `brokerOrderLimit` in `broker-specs.js`). None recorded, or an answer without a whole number of 1 or more, refuses entries (fail closed, like `contract-specs`), saying to call `get_server_config`. The server still enforces its own on every order. Exits, protective orders, cancels, closes and stop moves are never checked. Hard: not skippable | yes | yes |
| `max-risk` | When the strategy the setup tag names sets `risk.max_risk_usd`, an entry's risk (size × stop ticks × the broker's tick value) is at most it. Stop ticks: `stopLossBracket.ticks`, or a limit or stop entry's price to the farthest losing-side stop price in the rationale, rounded up to whole ticks (with both, the larger). A risk it can't compute (a market entry with its stop only in the rationale, no usable tick specs, a malformed bracket or cap) refuses the entry. A policy strategy's entry is held to its own cap, if any, not its components' (prop sizing sizes it). `scripts/lib/trading/order-limits.js`. Hard: not skippable | yes | yes |
| `market-hours` | Entries only in the market session, 18:00-16:00 ET, Sunday evening to Friday (closed 16:00-18:00 ET), not on CME holidays, and before 13:00 ET on early-close days (the built-in calendar in `exchange-calendar.js`, plus `FTH_CLOSED_DATES` / `FTH_EARLY_CLOSE_DATES`, which the runner passes from its config), and not after the calendar's last day (its holidays are unknown). A hard rule: no setting widens it and it can't be skipped; the gateway checks it again after reading the account | yes | yes |
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
| `modify-entry` | Only orders working an open position (its stop or target) can be repriced; entries and leftovers are cancelled and re-placed through the gate. Recent orders count: right after a close (or a partial close that leaves no position) a stop isn't working a position, and is refused with `once recent orders fill (net X)` | no | yes |
| `partial-close` | `partial_close_position` needs a whole `size` of 1 or more, an open position in the contract, and a size no larger than it, counting recent orders (`close_position` always goes) | no | yes |
| `order-pending` | No new entry while an earlier order's outcome is unknown (no reply within 30 s, an error reply that isn't a sure refusal, or its gateway exited): every `place_order` goes out with a `customTag` and a record in `<FTH_HOME>/pending-orders/` (per account and tag), settled from the broker's `search_orders` (placed, or refused by its status) or after 2 min without it (not placed); survives restarts. Exits, stop moves and cancels are still checked as usual: for 2 min an unknown market order counts as filled and an unknown limit or stop as resting (an unknown entry's bracket stop can't be cancelled); `close_position` always goes | no | yes |
| `batch` | Order calls go one at a time: a JSON-RPC batch containing one is refused whole | no | yes |
| `regime` | With `regime_gate: true`: the live regime of the strategy's timeframe fits its `regimes` | no | yes |
| `replay-clock` | `FTH_REPLAY_NOW` set without a real replay broker, or not an ISO 8601 UTC time: no new entry; risk-reducing actions are judged as usual at the wall clock (Replay clock, below). Hard: not skippable | yes | yes |

Malformed or oversized input, unreadable state, invalid config, a failed
account query, a position whose size isn't a whole number of contracts, or a
crash blocks the order. In autonomous runs
(`FTH_AUTONOMOUS=1`) the gate can't be skipped, dry-run, or disabled.
Decisions go to `~/.futures-trading-harness/logs/gate-log.jsonl`.

### Replay clock

Replay runs the live harness (harness CLI, agents, skills, scripts, gate,
broker interface) on replayed history; only data, clock, and fills are
simulated, by a replay broker: an MCP server configured in `brokers.json` like
any other, with `"replay": true`, whose `get_server_config` reports
`replay: true` and the replayed `serverTime`. Its clock reaches the harness
through one variable, `FTH_REPLAY_NOW` (an ISO 8601 UTC time such as
`2026-03-02T15:30:00Z`), resolved in `scripts/lib/trading/harness-now.js`.
Everything that takes "now" for a trading decision takes it from there: the
gate in the hook and the gateway (market hours, windows, blackouts, plan and
record ages, the trading day's journal, prop snapshot ages, the gateway's
ledger and orders of unknown outcome), the session-start and stop hooks, the
scripts agents run (`strategies.js scan` without `--now`, `bars.js`, `mtf.js
--record`, `combine.js`, `blackouts.js`), and `autotrader.js --once` /
`--dry-run`. The contract translator dates its front-month lookups with the
same clock through `recordNow`, which never refuses. Unset, it is the wall
clock.

The label alone is not trusted. The hook and the scripts, which can't ask the
server, also refuse a replay broker that starts the same server as a live
broker or reads a shipped live broker's variables (credentials, entry,
journal). The gateway, which runs the server, honors the override only if the
broker it started (never a server given on its command line) is a replay
broker and the server's `get_server_config` reports `replay: true` and a
`serverTime` within 5 minutes of `FTH_REPLAY_NOW`. The broker is the one
resolved when the gateway starts; the decision is taken at the first order call
(gated, or a `close_position`) and kept for the gateway's lifetime, so editing
`brokers.json` after that changes nothing.

It fails closed and is replay-only: when the override is refused (no real
replay broker, an unparseable value, an unreadable broker config) the gate
refuses every new entry (`replay-clock`, also with `FTH_AUTONOMOUS=1`) and
judges exits, `[protect]` stops, stop moves, cancels and partial closes as
usual at the wall clock (a refused override means a live broker);
`close_position` always goes. The scripts and the runner exit with the error
(`autotrader.js --once eod` still runs, at the wall clock), and the stop hook
says why it couldn't remind. The override never relaxes a
check; it only moves the time checks run at.

A process's environment is fixed when it starts, so replay drives one cycle per
process: a fresh harness run (or `autotrader.js --once`) per cycle, with the
time set by the replay driver. Within one process the replayed time stands
still (the gateway's 30 s ledger and its 2-minute grace for orders of unknown
outcome don't elapse), so don't hold a long interactive session on one
`FTH_REPLAY_NOW`. Replay runs in a harness home of its own (`FTH_HOME`), never
the live one: the scripts write records, blackouts and attempts there at the
replayed time. The runner's long-running loop refuses to start
with `FTH_REPLAY_NOW` set, and never takes the test suite's `FTH_TEST_NOW`.
Pure log timestamps (cycle logs, the gate log, heartbeats) stay on the wall
clock.

Under an honored replay clock, `autotrader.js --once` (not `--dry-run`) runs
one pass of the live loop (`runner.step()`, wired as the long-running loop by
`scripts/lib/runner-wiring.js`) at the replayed time, with the home's runner
state: the bars, records, scan, verdicts, account and prompt are built as live,
and the runner's own schedule decides whether that pass is premarket, a bar's
cycle, or end of day. Without one, `--once` is the manual run it always was.
The replay driver (`scripts/replay.js`, `scripts/lib/replay/`, the `replay`
skill) runs it once per decision time in a fresh home of its own, moving the
replay broker's clock between them (docs/REASONING-TRADER-DESIGN.md).

## Autonomous runner

`scripts/autotrader.js` holds an exclusive lock, keeps a per-day state
(written atomically), and starts one headless run at a time in its own
process group: premarket at `premarketAt`, a trade cycle after every closed
`timeframe`-minute bar inside `sessions` (bar closes detected by polling
`get_bars` through the broker adapter right after each scheduled close, see `scripts/lib/bar-clock.js`;
bars that close during a run are skipped), end of day at `eodAt` (retried until it
succeeds, and run first thing if a previous day never finished). End of day
succeeds only once the account reads flat: each pass closes what is open and
cancels what is working, then re-reads; a close the broker accepted but that
didn't fill is closed again on the next pass (`flatten_unverified` in the
event log; never within 10 s of its last close, so two closes in flight can't
reverse the position), and the agents' review runs once. Waiting for fills
counts as a failed run (toward the kill switch) only after 2 minutes. The prop close is recorded only
after that. The kill
switch stops new cycles but not end of day; after `maxConsecutiveErrors`
failed runs the runner creates it. An unreadable state file turns trade
cycles off for the day. Runs execute in `workspace/` with `FTH_ROOT`,
`FTH_AUTONOMOUS=1`, and, in paper mode, `FTH_PAPER=1` and the broker's
`paperEnv` (the server's trading switch off). A live runner
refuses to start unless the server lists every interface tool, has trading
enabled, and allows the account.

Further safeguards:

- **Workspace fingerprint.** The runner fingerprints the workspace's
  instructions and project settings (`AGENTS.md`, `CLAUDE.md`, `QWEN.md`,
  `.qwen/`, `.claude/`, `.codex/`, `opencode.json`, and any `.opencode/`
  folder, whole) before and after every run. A change
  creates the kill switch, because a Codex run can write its working
  directory.
- **Qwen allowlist.** For Qwen the runner rewrites the
  `workspace/.qwen/settings.json` allowlist at start, so it matches the
  configured bar and state directories. It allows `mcp__broker` and
  `mcp__harness`, and subagents only by name: one `Agent(<role>)` rule per
  role in `agents/` (Qwen's subagent tool is `agent`, aliases `Agent` and
  `Task`; the name in brackets must equal the call's `subagent_type`), so
  Qwen's built-in agents (fork, general-purpose, Explore, claude-code, codex)
  stay unapproved headless. A rule approves whichever agent Qwen resolves for
  that name: keep no session, project or user agent named like a harness role,
  in any letter case. The generated roles (`qwen-extension/agents/*.md`) carry
  `approvalMode: default`, so a role asks (and headless, is refused) for any
  tool the allowlist doesn't allow, and `background: false`: Qwen runs a named
  subagent in the background unless the call or its definition says
  otherwise, and the head trader must wait for each role's result. A
  permissive parent mode (yolo, auto, auto-edit, e.g. through the runner
  config's `extraArgs`) overrides a role's `approvalMode`: the runner passes
  `--approval-mode default`, and the allowlist holds only in that mode. The extension's `QWEN.md` embeds every
  `rules/trading/*.md`, so the rules are not linked into the extension.
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
  ET, weekends, exchange holidays), or after the day's end of day, the runner reads the account
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
- Order flow is the broker server's: it puts it on its bars as extra
  fields, which the harness passes through untouched and the strategies
  read with `field("path")` (`docs/ORDER-FLOW.md`). On a bar without them
  those conditions are false (the order-flow pair gives no signal;
  `value_area` can still confirm by range expansion); the harness estimates
  nothing.
- The hook can't see positions; only the gateway checks that `[exit]` and
  `[protect]` orders really reduce exposure. Use the gateway on every harness.
- A broker MCP server's own guardrails may have gaps (a position flip that
  skips its daily-loss check, resting stops not counted toward its position
  limit, `modify_order` checking only size). The gateway covers these for
  harness traffic; fixing them in the server protects direct callers too.
- Journal reviews are self-graded. The gateway counts losses from real fills;
  the journal-based checks remain a second, softer layer.
- Codex agent roles can't be restricted to specific MCP tools in config; the
  executor-only rule is an instruction there. The gateway still applies.
- The cisd_ote strategy mirrored the original bot's zone math (a 29.5%-50%
  retracement, the same limit for both sides) until version 4, the owner's
  textbook rewrite (OTE of the displacement leg, symmetric; paper).
