# Futures Trading Harness

An LLM-agnostic agent harness that trades futures on **TopstepX** through the
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp) server. It runs on
**Claude Code, Codex, or Qwen Code** (any model those harnesses can drive,
including Qwen through DashScope, vLLM, or Ollama), and it can trade on its own
on a schedule.

Strategies are Markdown documents: drop a `STRATEGY.md` into `strategies/` and
the agents can trade it, and the order gate enforces its instruments, sessions,
and status in code.

The architecture follows [ECC](https://github.com/affaan-m/ECC): one canonical
tree of agents, skills, commands, rules, and profile-gated hooks, with native
adapters generated for each harness.

> [!WARNING]
> This software lets an AI place real orders on your account. Futures trading
> involves substantial risk of loss, and AI models make mistakes. Start with
> `PROJECTX_TRADING_ENABLED=false` and `"paper": true`, then a practice or
> evaluation account, micro contracts, and size 1. You are responsible for every
> order placed.

## How it fits together

```text
 scripts/autotrader.js  ──(schedule, kill switch)──▶  claude -p | codex exec | qwen -p
        or you, interactively                                   │
                                                                ▼
 skills: trade-session / premarket / end-of-day / autonomous-trading
        │
        ├─ parallel subagents ─────────────────────────────────────────────┐
        │  market-structure · trend-momentum · volume-liquidity · news      │
        │  risk-manager (account state, budget)                             │
        └───────────────────────────────────────────────────────────────────┘
        │
   head trader: strategies.js scan + STRATEGY.md rules → journal plan
        │
   risk-manager verdict → trade-executor (the only role with order tools)
        │
   order gate ── PreToolUse hook (Claude/Codex/Qwen)
        │     └─ MCP gateway (every MCP client) ──▶ projectx-mcp ──▶ TopstepX
        ▼
   trade-reviewer → journal reviews and lessons → next session's briefing
```

## Layers of protection

| Layer | Where | Enforces | Model can bypass? |
|---|---|---|---|
| Firm rules | Topstep | Daily loss, trailing drawdown, 15:10 CT flatten | No |
| Server guardrails | projectx-mcp | Trading enabled, accounts, symbols, size, daily $ loss | No |
| Order gate | `scripts/lib/trading/order-gate.js`, run by the hook **and** the MCP gateway | Kill switch, strategy (exists, `active`, instrument, session), setup tag, stop, plan first, no-entry windows, news blackouts, loss streak, daily losses, review before next entry, max entries | No (deterministic, fails closed) |
| Runner | `scripts/autotrader.js` | Schedule, cycle caps, timeouts, auto kill switch after repeated errors | No |
| Rules, skills, roles | This repo | Risk math, strategy rules, process | Soft |

The gateway exists because hooks differ between harnesses. Run as the
`projectx` MCP server, it applies the same gate to any MCP client.

## Strategies are Markdown

```text
strategies/
  orb/STRATEGY.md          opening range breakout       (signal: orb)
  ema_cross/STRATEGY.md    EMA 9/20 cross               (signal: ema_cross)
  keltner/STRATEGY.md      Keltner breakout             (signal: keltner)
  supertrend/STRATEGY.md   SuperTrend flip              (signal: supertrend)
  bos/STRATEGY.md          break of structure           (signal: bos)
  cisd_ote/STRATEGY.md     CISD + fib zone              (signal: manual)
  _template/STRATEGY.md    copy this to add a strategy
```

Each file has code-checked frontmatter and a body the agents follow:

```yaml
---
name: orb
description: Opening range breakout for equity index futures ...
status: active                     # paper | active | disabled
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:45-11:30@America/New_York"]
signal: orb                        # built-in detector, or manual
params:                           # optional market-snapshot overrides
  orbMinutes: 15
filters:
  adx_min: 18
risk:
  stop: atr:0.5
  min_rr: 2
---
## When to Use ... ## How It Works ... ## Examples ...
```

```bash
node scripts/strategies.js list
node scripts/strategies.js validate
node scripts/strategies.js scan bars.json --symbol MNQ   # candidates on the latest closed bar
```

To add a strategy, copy `_template/` (or use the `strategy-authoring` skill or
`/new-strategy`), keep `status: paper` until it has a record, validate, and
promote it to `active`. Private strategies can live outside the repo:
`FTH_STRATEGIES_DIRS=~/.futures-trading-harness/strategies`. The six bundled
strategies are ported from [algoTraderBot](https://github.com/johnamcruz/algoTraderBot).

## What's inside

| Path | Contents |
|---|---|
| `agents/` | 8 roles: 4 analysts, risk manager, executor, reviewer, strategy researcher (canonical, Claude format) |
| `skills/` | 19 skills: workflows (trade-session, premarket, end-of-day, autonomous-trading), strategy library and authoring, market analysis, risk, review |
| `strategies/` | Strategy documents and the template |
| `commands/` | Thin shims onto skills: `/trade-session`, `/premarket`, `/eod`, `/trade-review`, `/setup-scorecard`, `/new-strategy` |
| `rules/trading/` | Always-on rules |
| `hooks/hooks.json` | Order gate, session briefing, review reminder (Claude Code and Codex plugins; Qwen via installer) |
| `scripts/` | Hook runtime, MCP gateway, autonomous runner, strategy and snapshot CLIs, installer, harness sync |
| `workspace/` | Generated `AGENTS.md` / `CLAUDE.md` / `QWEN.md`: the operator instructions every harness reads |
| `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `qwen-extension.json` | Native manifests |
| `.codex/agents/`, `qwen/` | Generated Codex roles and Qwen agents and commands |

Generated files come from the canonical sources: `node scripts/sync-harness.js`
(CI runs `--check`).

## Setup

Requires Node.js 18+ and a built [projectx-mcp](https://github.com/johnamcruz/projectx-mcp)
(`npm install && npm run build`; note the path to `dist/index.js`).

```bash
git clone https://github.com/johnamcruz/futures-trading-harness ~/futures-trading-harness
cd ~/futures-trading-harness
node scripts/install.js --target qwen,codex,claude --projectx /abs/path/projectx-mcp/dist/index.js
```

The installer backs up and edits only what each harness can't get from its
plugin. It prints the remaining native commands:

| Harness | Installer writes | You run |
|---|---|---|
| Qwen Code | hooks + `projectx` MCP (via gateway) in `~/.qwen/settings.json` | `qwen extensions install <repo>` |
| Codex | marked block in `~/.codex/config.toml`: `projectx` MCP (via gateway) + agent roles | `codex plugin marketplace add <repo>` then `codex plugin add futures-trading-harness@futures-trading-harness`; trust hooks in `/hooks` |
| Claude Code | rules in `~/.claude/rules/trading/` | `/plugin marketplace add <repo>`, `/plugin install futures-trading-harness@futures-trading-harness`, and the printed `claude mcp add` command |

Credentials (`PROJECTX_USERNAME`, `PROJECTX_API_KEY`) and guardrails
(`PROJECTX_TRADING_ENABLED`, `PROJECTX_ALLOWED_SYMBOLS`, ...) go in the
environment that launches the harness, or in Qwen's extension settings. See
`mcp-configs/` for examples.

## Running it

Interactive, from `workspace/` so every harness reads the operator instructions:

```bash
cd workspace
qwen      # or: codex, claude
> /premarket MNQ
> /trade-session MNQ paper
```

Autonomous:

```bash
cp mcp-configs/autotrader.example.json autotrader.json   # pick harness, symbols, paper, schedule
node scripts/autotrader.js --config autotrader.json --dry-run      # show the next action and command
node scripts/autotrader.js --config autotrader.json                # run the schedule
touch ~/.futures-trading-harness/STOP                              # kill switch: no new entries
```

The runner starts one headless run per cycle (premarket at 09:00 ET, a trade
cycle every 3 minutes in session, end of day at 15:50 ET), logs everything to
`~/.futures-trading-harness/logs/`, and never runs two cycles at once. Each run
follows the `autonomous-trading` skill: one bounded cycle, positions first, no
questions, stand aside when unsure. Run it in a container or under a dedicated
user: headless harnesses auto-approve tool calls, so the order gate and server
guardrails are what protect the account.

### Order gate settings

| Variable | Default | Meaning |
|---|---|---|
| `FTH_KILL_SWITCH_FILE` | `~/.futures-trading-harness/STOP` | If it exists, no new entries |
| `FTH_STRATEGIES_DIRS` | (none) | Extra strategy folders |
| `FTH_PLAN_MAX_AGE_MIN` | 120 | Plan freshness |
| `FTH_MAX_CONSECUTIVE_LOSSES` / `FTH_LOSS_COOLDOWN_MIN` | 2 / 30 | Loss-streak cooldown |
| `FTH_MAX_DAILY_LOSSES` | 3 | Losing trades per trading day |
| `FTH_MAX_ENTRIES_PER_DAY` | 6 | Entries per trading day (0 = off) |
| `FTH_NO_ENTRY_WINDOWS` | `09:30-09:35@America/New_York,15:00-18:00@America/Chicago` | No new entries |
| `FTH_BLACKOUTS_FILE` | `~/.futures-trading-harness/blackouts.json` | News blackouts (written by premarket) |
| `FTH_ORDER_GATE_SKIP` | (none) | Checks to turn off |
| `FTH_GATE_LOG` | `~/.futures-trading-harness/gate-log.jsonl` | Gate decisions |
| `FTH_HOOK_PROFILE` / `FTH_DISABLED_HOOKS` | `standard` / (none) | Hook gating |
| `PROJECTX_JOURNAL_PATH` | `~/.projectx-mcp/journal.jsonl` | Must match the MCP server |

### The rationale convention

`place_order` rationales start with `setup:<strategy> ...` for entries,
`[exit] ...` to close or reduce, and `[protect] ...` for a protective stop or
target. Exits and protective orders are never gated, so risk can always be reduced.

## Development

```bash
npm install
npm test                         # node:test: gate, gateway, strategies, runner, installer, sync, content
npm run lint                     # eslint + markdownlint
node scripts/sync-harness.js     # regenerate Codex/Qwen/workspace files after editing agents, commands, rules, skills
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/HARNESS-DESIGN.md](docs/HARNESS-DESIGN.md).

## License

MIT. The hook runtime and plugin layout are derived from
[ECC](https://github.com/affaan-m/ECC) by Affaan Mustafa (MIT).
