# Futures Trading Harness: Design Study

How to use the ECC harness architecture (this repo) to run a disciplined,
self-reviewing futures trader on TopstepX, through the
[`projectx-mcp`](https://github.com/johnamcruz/projectx-mcp) server.

Status: study and proposal. Nothing below is built yet.

## 1. What each piece already gives us

### ECC (this repo): the harness

ECC isn't an app. It's a Claude Code plugin that shapes how the model works,
using six kinds of building blocks:

| Block | Location | Format | How it loads |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | YAML frontmatter (`name`, `description`, `metadata`), then When to Use / How It Works / Examples | On demand, matched by `description` |
| Agents | `agents/<name>.md` | Frontmatter `name`, `description`, `tools`, `model` | Delegated subagents with a restricted toolset |
| Commands | `commands/<name>.md` | Frontmatter `description`, `argument-hint` | User-invoked `/name` workflows |
| Rules | `rules/<lang>/*.md` | Plain markdown | Always loaded; standing policy |
| Hooks | `hooks/hooks.json` → `scripts/hooks/*.js` | JSON matcher + Node command | Deterministic. Runs on PreToolUse, PostToolUse, SessionStart, Stop, PreCompact, SessionEnd |
| MCP configs | `mcp-configs/mcp-servers.json` | `mcpServers` map | Copied into the user's client config by the installer |

Mechanics that matter for trading:

- **Hooks are the only part that can't be talked out of a decision.** Every
  hook goes through `scripts/hooks/run-with-flags.js`, so
  `ECC_HOOK_PROFILE` (minimal/standard/strict) and `ECC_DISABLED_HOOKS` can turn
  it on or off. A PreToolUse hook that exits 2 blocks the tool call. A
  `^mcp__` matcher is already in use (`pre:mcp-health-check`, which fails
  closed).
- **Install is modular.** `manifests/install-modules.json` (38 modules) and
  `manifests/install-profiles.json` (minimal, core, developer, security, …)
  decide what reaches a user's `~/.claude`. A `trading` profile can ship only
  the trading pieces and leave out the other 290 skills.
- **Learning loop:** `continuous-learning-v2` (instincts), `/learn`,
  `/learn-eval`, and the session-persistence hooks
  (`hooks/memory-persistence`, `session-start.js`, `session-end.js`).
- **Trading skills that already exist:** `llm-trading-agent-security` (written
  for crypto wallets, but the layered-defense pattern carries over) and
  `prediction-market-risk-review` (an advice-boundary and data-quality gate).
- **Conventions:** CommonJS Node ≥18, hooks under 200 lines, hooks always
  `exit 0` on non-critical errors, a test in `tests/hooks/` for every new hook,
  and `node tests/run-all.js` plus markdownlint before committing.

### projectx-mcp: the broker connection

A TypeScript MCP server on the ProjectX Gateway API, which is the API behind
TopstepX.

- **Tools:** `get_server_config`, `list_accounts`, `get_account_snapshot`,
  `search_contracts`/`get_contract`/`list_available_contracts`, `get_bars`,
  `get_quote` (SignalR), `place_order`/`modify_order`/`cancel_order`,
  `close_position`/`partial_close_position`, `list_open_orders`,
  `search_orders`, `list_open_positions`, `search_trades`, `get_performance`,
  `journal_add`/`journal_read`.
- **Server-side guardrails the model can't override:** `TRADING_ENABLED`,
  allowed accounts and symbols, max order and position size, and max daily
  loss counted from 17:00 CT. Blocked orders are written to the journal as
  `order_blocked`.
- **Memory:** an append-only JSONL journal at `~/.projectx-mcp/journal.jsonl`
  with kinds `plan | entry | exit | review | lesson | note | order_placed |
  order_blocked`, plus `tags`. `place_order` requires a `rationale`.
- **Operating guide:** `AGENTS.md`, served as `projectx://guide`, and a
  `trading_session` prompt. The guide sets the session loop (plan → trade →
  review → lesson) and soft risk rules: risk ≤25% of the remaining daily
  allowance, a protective stop at the exchange, micros and size 1 until 30
  trades show positive expectancy, no trading 09:30–09:35 ET, stop after 2
  straight losses, flat by 15:10 CT.

### Strategy sources you already have

- `algoTraderBot/strategies/`: `orb`, `ema_cross`, `keltner`, `supertrend`,
  `bos`, `cisd_ote`, plus `jev` (a reasoning model as the strategy, with the
  others as its context).
- `PropEvolve`: the objective for a prop challenge (+$6k target, −$3k MLL
  floor that trails at the 17:00 CT boundary) and a simulator.

## 2. The core idea

> **projectx-mcp is the hands and the hard guardrails. ECC is the discipline.**

The MCP's soft rules in `AGENTS.md` ("stop after 2 losses", "write a plan
first", "no 09:30–09:35 entries") hold only while the model complies. ECC
hooks can make several of them **deterministic**, and they need no network
call: the journal is a local file, and the clock is local.

```text
            ┌──────────── ECC trading plugin ─────────────┐
 /session ─▶│ commands ─▶ agents ─▶ skills (playbooks)     │
            │                 │                            │
            │      PreToolUse hook (mcp__projectx__*)      │──▶ projectx-mcp ──▶ TopstepX
            │      reads journal.jsonl + clock + config    │    (hard guardrails,
            │      PostToolUse / Stop hooks: review gates  │     journal writer)
            └──────────────────────────────────────────────┘
```

Defense in depth, by layer:

| Layer | Owner | Enforces | Bypassable by model? |
|---|---|---|---|
| Firm rules | Topstep | Daily loss limit, MLL, 15:10 CT flatten | No |
| MCP guardrails | projectx-mcp `risk.ts` | Enabled flag, symbols, accounts, size, daily loss | No |
| Harness hooks | ECC `scripts/hooks/trading-*` | Plan-before-order, stop required, time windows, loss streak, review-after-exit | No (deterministic) |
| Rules | ECC `rules/trading/` | Risk math, prop-firm constraints, no averaging down | Soft |
| Skills / agents | ECC | Strategy playbooks, review method | Soft |

## 3. Proposed components

Names follow ECC conventions: lowercase with hyphens, and the trading pieces
kept together under one install module.

### Rules: `rules/trading/` (always loaded)

- `risk-management.md`: risk per trade = |entry − stop| / tickSize ×
  tickValue × size, ≤25% of `remainingBeforeLimit`; stop decided before
  entry; never widen a stop or average down.
- `prop-firm-constraints.md`: Topstep daily loss, trailing MLL, consistency
  rule, flat by 15:10 CT, trading day resets at 17:00 CT, what errorCodes 4
  and 5 mean.
- `execution-hygiene.md`: tick rounding, `trailPrice` is a price level not a
  distance, how brackets behave, `close_position` leaves resting orders.
- `advice-boundary.md`: the harness trades the user's own account under the
  user's own limits; it doesn't advise third parties.

### Skills: `skills/` (strategy playbooks and process)

Strategy playbooks, one per setup, all in the same shape: Context filter →
Trigger → Invalidation/stop → Target/management → Skip conditions → Journal
tag (`setup:<name>`). The tag must match the MCP's journal `tags`, so
`journal_read {tag}` and `get_performance` can score each setup.

- `futures-orb-playbook` (15-min opening range, ADX ≥18 filter)
- `futures-ema-cross-playbook`
- `futures-keltner-playbook`
- `futures-supertrend-playbook`
- `futures-bos-playbook` (break of structure)
- `futures-cisd-ote-playbook`

Process skills:

- `topstepx-session-loop`: the 11-step loop from the MCP guide, written as
  ECC "How It Works" steps with tool names.
- `multi-timeframe-read`: how to use `get_bars` across 1m/5m/15m/1h within
  the 50 req/30 s rate limit.
- `position-sizing-futures`: tick math for MNQ/MES/MYM/M2K/MGC/MCL and the
  minis (contract roots `ENQ`/`EP`).
- `trade-review-r-multiple`: grade the process, compute R, assign a setup tag.
- `setup-expectancy-audit`: use `get_performance` over a week or month, cut
  setups with negative expectancy, and promote evidence-backed `lesson`s.
- `prop-challenge-pacing`: pacing against the PropEvolve objective
  (target/MLL cushion, consistency rule).
- Reuse `llm-trading-agent-security`. Its injection and limits patterns apply
  to market-data text and news feeds too.

### Agents: `agents/`

Each agent gets the narrowest tool list that works. Only the executor can
write orders.

| Agent | Tools | Role |
|---|---|---|
| `market-analyst` | read-only `mcp__projectx__get_bars`, `get_quote`, `search_contracts`, `get_contract` | Reads market context across timeframes and names candidate setups. Never trades. |
| `trade-planner` | `journal_read`, `journal_add`, `get_account_snapshot`, read tools | Turns a candidate into a `plan` entry with stop, target, size, and $ risk |
| `risk-officer` | `get_server_config`, `get_account_snapshot`, `list_open_*`, `journal_read` | Independent go/no-go on a plan. Can veto. |
| `trade-executor` | `place_order`, `modify_order`, `cancel_order`, `close_*`, `list_open_*` | Executes an approved plan exactly. Doesn't change it. |
| `trade-reviewer` | `search_trades`, `get_performance`, `journal_*` | Writes `review` and `lesson` entries after each exit |
| `strategy-researcher` | `Read`, `Bash`, `get_bars` | Turns strategy code (algoTraderBot) or backtests into playbook skills |

This follows ECC's planner → implementer → reviewer split, with separation of
duties: the agent that finds a trade is never the one that approves it.

### Commands: `commands/`

- `/trade-session [symbol]`: the full loop. Config check → lessons →
  snapshot → analyst → planner → risk-officer → executor → monitor.
- `/premarket [symbol]`: read-only. Builds levels, a news window, and a plan
  of the day.
- `/trade-plan`: write a plan only. Trading stays disabled.
- `/trade-review`: review the last N closed trades.
- `/eod`: flatten, cancel leftover orders, write a review and lessons.
- `/setup-scorecard`: expectancy per `setup:*` tag.
- `/new-playbook <name>`: scaffold a playbook skill (built on
  `/skill-create`).

### Hooks: `scripts/hooks/trading-*.js` (the key part)

All of these use the `run-with-flags.js` wrapper and match
`^mcp__projectx__(place_order|modify_order)$`, unless noted. Each reads only
local state: `~/.projectx-mcp/journal.jsonl`, the clock, and the hook config.
They make no network calls, so they stay under 200 ms. Order-gating hooks
**fail closed** (they join `FAIL_CLOSED_ON_TRUNCATION_HOOKS`). Every other
hook keeps the ECC default of exit 0.

| Hook id | Event | Rule |
|---|---|---|
| `pre:trading:plan-required` | PreToolUse | Blocks an opening order unless a `plan` entry for the contract exists from the last N minutes |
| `pre:trading:stop-required` | PreToolUse | Blocks a market or limit entry with no `stopLossBracket`, unless a separate stop order for that contract was placed in this session |
| `pre:trading:time-window` | PreToolUse | Blocks new entries 09:30–09:35 ET, after 15:00 CT, and in user-set news blackouts (`~/.claude/trading/blackouts.json`) |
| `pre:trading:loss-streak` | PreToolUse | After 2 straight losing `exit`/`review` entries, blocks entries until a `review` newer than the last loss exists |
| `pre:trading:rationale-quality` | PreToolUse | Requires the `rationale` to name a `setup:*` and state the stop |
| `post:trading:journal-sync` | PostToolUse `^mcp__projectx__` | Records order results for the Stop gate |
| `stop:trading:flat-check` | Stop | Warns if positions or orders were opened this session but no `review` was written |
| `session-start:trading:lessons` | SessionStart | Puts the latest `lesson` entries and today's loss allowance into context |

Note the matcher name: in Claude Code, a tool from a server registered as
`projectx` is `mcp__projectx__place_order`. Document the server name as
`projectx` so every matcher lines up.

### MCP config

Add a `projectx` entry to `mcp-configs/mcp-servers.json` with
`TRADING_ENABLED=false`, `ALLOWED_SYMBOLS=MNQ,MES`, `MAX_ORDER_SIZE=1`, and
`MAX_DAILY_LOSS` below the firm limit. Credentials stay as placeholders. Never
commit them.

### Install manifest

Add a `trading` module in `install-modules.json` (rules/trading, the trading
skills, agents, commands, and hooks), and a `trading` profile:
`rules-core` + `hooks-runtime` + `platform-configs` + `trading`. Leave the
engineering-heavy modules out.

## 4. Decisions to make

1. **Fork shape.** Option A: keep all of ECC and add a `trading` profile
   (stays mergeable with upstream ECC; larger repo). Option B: strip the
   fork to the core runtime plus trading (lean, but upstream fixes have to be
   brought in by hand). Recommendation: A, because the profile system already
   handles the leaning out.
2. **Where soft rules become hard.** The hooks above duplicate some MCP
   behavior on purpose. Rules that need account state (daily P&L) stay in the
   MCP. Rules that need only the journal or the clock move to hooks.
3. **Live data.** Hooks can't call the API, so time and journal rules are
   enforceable but price-based rules (such as "the stop is on the correct
   side of price") aren't. Those belong in the MCP's `risk.ts` and could be
   upstreamed to projectx-mcp.
4. **Strategy source of truth.** Playbook skills describe a setup in prose
   for the model. The backtested code stays in algoTraderBot. A
   `strategy-researcher` agent keeps the two in sync, and each playbook
   records the backtest stats it was derived from.
5. **Learning.** Keep the MCP journal as the single trade memory. Use ECC's
   `continuous-learning-v2` only for *process* instincts (how the harness
   works), not trade outcomes, so there aren't two competing memories.

## 5. Phased plan

1. **Foundation (read-only):** `rules/trading/*`, the `projectx` MCP entry,
   `topstepx-session-loop`, `/premarket`, `/trade-plan`, `market-analyst`,
   `trade-planner`. Trading stays disabled.
2. **Deterministic gates:** the `pre:trading:*` hooks with tests in
   `tests/hooks/` (fixtures are fake journal files), plus the `trading`
   install profile.
3. **Playbooks:** the six strategy skills, ported from algoTraderBot with
   their backtest numbers, plus `/setup-scorecard`.
4. **Supervised execution:** `risk-officer`, `trade-executor`,
   `trade-reviewer`, `/trade-session`, `/eod`, on a practice account with
   micros, size 1, and manual approval of every order.
5. **Evaluation:** `setup-expectancy-audit` and `prop-challenge-pacing`.
   Loosen approvals only after 30+ trades with positive expectancy.
