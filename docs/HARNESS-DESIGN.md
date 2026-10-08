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
   and by code (frontmatter). New strategies need no code unless they need a
   new mechanical detector.
4. **Workflows are skills.** Every harness supports SKILL.md; commands are thin
   shims.
5. **Autonomy is a scheduler, not a long-lived agent.** Each cycle is one
   short, headless run with a fresh context; state lives in the journal.

## Harness support

| Capability | Claude Code | Codex | Qwen Code | Other MCP clients |
|---|---|---|---|---|
| Package | `.claude-plugin/` | `.codex-plugin/` + `.agents/plugins/marketplace.json` | `qwen-extension.json` | n/a |
| Skills | plugin `skills/` | plugin `skills/` | extension `skills/` | read `skills/*/SKILL.md` |
| Agent roles | `agents/*.md` | `.codex/agents/*.toml` + `[agents.*]` (installer) | `qwen/agents/*.md` (tool ids translated) | play roles from `agents/*.md` |
| Commands | `commands/` | (use skills) | `qwen/commands/` (`{{args}}`) | n/a |
| Instructions | `workspace/CLAUDE.md` → `AGENTS.md` | `workspace/AGENTS.md` | `workspace/QWEN.md` | `workspace/AGENTS.md` |
| Hooks | plugin `hooks/hooks.json` | plugin `hooks/hooks.json` (CLAUDE_PLUGIN_ROOT and exit 2 are compatible) | `~/.qwen/settings.json` (installer) | none |
| Order gate | hook + gateway | hook + gateway | hook + gateway | gateway |
| Headless | `claude -p --plugin-dir` | `codex exec` | `qwen -p` | custom argv |

## Order gate

`scripts/lib/trading/order-gate.js` (pure) is called through
`scripts/lib/trading/check-order.js` by both the PreToolUse hook and the MCP
gateway (`scripts/mcp-gateway.js`, a newline-delimited JSON-RPC proxy in front of
projectx-mcp). A blocked `place_order` never reaches the server.

Orders are classified by `rationale`: `[exit]` and `[protect]` pass (the MCP
still applies its limits). Entries must pass:

| Check | Rule |
|---|---|
| `kill-switch` | No `~/.futures-trading-harness/STOP` |
| `setup-tag` | Rationale names `setup:<strategy>` |
| `strategy` | The strategy exists, is valid, `status: active`, trades this contract, and it is inside its `sessions` |
| `stop-defined` | `stopLossBracket`, or a stop price in the rationale |
| `plan-required` | A journal `plan` for the contract within `FTH_PLAN_MAX_AGE_MIN`, this trading day |
| `time-window` | Outside `FTH_NO_ENTRY_WINDOWS` |
| `blackout` | Outside news blackouts |
| `loss-streak` | Cooldown after consecutive losing reviews |
| `daily-loss-count` | Fewer than `FTH_MAX_DAILY_LOSSES` losses this trading day |
| `review-before-next-entry` | Every earlier entry today has a review |
| `max-entries` | Fewer than `FTH_MAX_ENTRIES_PER_DAY` entries |

Malformed or oversized input, unreadable state, invalid config, or a crash
blocks the order. Decisions go to `~/.futures-trading-harness/gate-log.jsonl`.

## Autonomous runner

`scripts/autotrader.js` keeps a per-day state (premarket done, cycles, end of
day done) and starts one headless run at a time: premarket at `premarketAt`,
a trade cycle every `cycleMinutes` inside `sessions`, end of day at `eodAt`
(retried until it succeeds). The kill switch stops new cycles but not end of
day. After `maxConsecutiveErrors` failed runs the runner creates the kill
switch itself. Runs execute in `workspace/` with `FTH_ROOT` set, so every
harness picks up the operator instructions.

## Known limits

- Hooks and the gateway can't see live prices or positions. Price-side checks
  (a stop on the correct side, an `[exit]` that actually reduces exposure) stay
  in projectx-mcp and the risk-manager role. Upstreaming an exposure check for
  `[exit]`/`[protect]` to projectx-mcp would close the self-labelling gap.
- Codex agent roles can't be restricted to specific MCP tools in config; the
  executor-only rule is an instruction there. The order gate still applies.
- Headless harnesses auto-approve tool calls. Run the autonomous runner in a
  container or as a user that can't modify the harness files.
- The cisd_ote strategy mirrors algoTraderBot's zone math (shorts enter at the
  29.5% retracement), which differs from textbook OTE. Confirm it's intended.
