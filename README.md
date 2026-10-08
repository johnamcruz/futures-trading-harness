# Futures Trading Harness

A Claude Code plugin that turns Claude into a disciplined futures trading desk
on **TopstepX**. Parallel analyst agents read the market, a risk manager
approves or vetoes, a single executor places orders through the
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp) server, and
fail-closed hooks enforce the trading rules in code.

It reuses the [ECC](https://github.com/affaan-m/ECC) harness architecture
(agents, skills, commands, rules, profile-gated hooks), with the ECC
engineering content removed and replaced with trading content.

> [!WARNING]
> This software helps an AI place real orders on your account. Futures trading
> involves substantial risk of loss, and AI models make mistakes. Start with
> `PROJECTX_TRADING_ENABLED=false`, then a practice or evaluation account,
> micro contracts, size 1, and manual approval of every order. You are
> responsible for every order placed.

## How it fits together

```text
/premarket, /trade-session
        │
        ├─ parallel (one message) ─────────────────────────────────────┐
        │  market-structure-analyst   trend-momentum-analyst           │
        │  volume-liquidity-analyst   news-calendar-analyst            │
        │  risk-manager (phase 1: account state and risk budget)       │
        └───────────────────────────────────────────────────────────────┘
        │
   head trader (main session): synthesis → playbook check → journal plan
        │
   risk-manager (phase 2): APPROVE / VETO
        │
   trade-executor ── PreToolUse order gate (hook) ── projectx-mcp ── TopstepX
        │                                              (server guardrails)
   trade-reviewer → review / lesson entries → SessionStart briefing next time
```

| Layer | Where | Enforces | Can the model bypass it? |
|---|---|---|---|
| Firm rules | Topstep | Daily loss, trailing drawdown, 15:10 CT flatten | No |
| Server guardrails | projectx-mcp | Trading enabled, accounts, symbols, size, daily $ loss | No |
| Order gate | `hooks/` (this repo) | Plan first, stop defined, setup tag, time windows, news blackouts, loss streak, review before next entry, max entries | No (deterministic, fails closed) |
| Permissions | Claude Code settings | Ask before each order tool | No |
| Rules, skills, agents | This repo | Risk math, playbooks, process | Soft |

## What's inside

| Path | Contents |
|---|---|
| `agents/` | 8 agents: 4 analysts, risk manager, executor (the only one with order tools), reviewer, strategy researcher |
| `skills/` | 19 skills: market structure, multi-timeframe, liquidity, VWAP/volume, indicators, session timing, sizing, prop pacing, review, expectancy, security, TopstepX reference, market snapshot, and 6 strategy playbooks |
| `commands/` | `/premarket`, `/trade-session`, `/trade-plan`, `/trade-review`, `/eod`, `/setup-scorecard`, `/new-playbook` |
| `rules/trading/` | Always-on rules: risk, prop firm, execution, journaling, agent conduct |
| `hooks/hooks.json` | Order gate (PreToolUse), session briefing (SessionStart), review reminder (Stop) |
| `scripts/` | Hook runtime, `market-snapshot.js` indicator CLI, rules installer |
| `mcp-configs/` | Example projectx MCP config and Claude Code settings |
| `docs/` | Design notes |

### Strategy playbooks

Ported from [algoTraderBot](https://github.com/johnamcruz/algoTraderBot) with
its parameters. `scripts/market-snapshot.js` computes the mechanical triggers so
agents never do indicator math by hand.

| Skill | Tag | Trigger |
|---|---|---|
| `playbook-orb` | `setup:orb` | 3m close beyond the 15-min opening range, ADX ≥ 18 |
| `playbook-ema-cross` | `setup:ema_cross` | EMA 9/20 cross, ADX ≥ 18 |
| `playbook-keltner-breakout` | `setup:keltner` | Close outside Keltner(20, 1.5), ADX ≥ 20 |
| `playbook-supertrend-flip` | `setup:supertrend` | SuperTrend(10, 3) flip |
| `playbook-break-of-structure` | `setup:bos` | Close through the last confirmed swing |
| `playbook-cisd-ote` | `setup:cisd_ote` | 12m CISD displacement, pullback into the fib zone |

## Setup

Requires Node.js 18+ (20+ for development tooling) and Claude Code.

### 1. Install and configure projectx-mcp

Follow the [projectx-mcp README](https://github.com/johnamcruz/projectx-mcp).
Register it under the name **`projectx`**: the agents and hooks match
`mcp__projectx__*` tool names.

```bash
claude mcp add projectx --scope user \
  --env PROJECTX_USERNAME=your-username \
  --env PROJECTX_API_KEY=your-api-key \
  --env PROJECTX_TRADING_ENABLED=false \
  --env PROJECTX_ALLOWED_SYMBOLS=MNQ,MES \
  --env PROJECTX_MAX_ORDER_SIZE=1 \
  --env PROJECTX_MAX_POSITION_SIZE=1 \
  --env PROJECTX_MAX_DAILY_LOSS=300 \
  -- node /absolute/path/to/projectx-mcp/dist/index.js
```

See `mcp-configs/projectx.example.json` for the JSON form.

### 2. Install the plugin

```text
/plugin marketplace add johnamcruz/futures-trading-harness
/plugin install futures-trading-harness@futures-trading-harness
```

### 3. Install the always-on rules

Plugins can't ship always-on rules, so copy them once:

```bash
git clone https://github.com/johnamcruz/futures-trading-harness
cd futures-trading-harness
node scripts/install-rules.js          # → ~/.claude/rules/trading/
```

### 4. Permissions and harness settings

Merge `mcp-configs/settings.example.json` into `~/.claude/settings.json`. It keeps
every order tool on **ask** and sets the order gate limits:

| Variable | Default | Meaning |
|---|---|---|
| `FTH_PLAN_MAX_AGE_MIN` | 120 | A journal plan for the contract must be this fresh |
| `FTH_MAX_CONSECUTIVE_LOSSES` | 2 | Loss streak that starts a cooldown |
| `FTH_LOSS_COOLDOWN_MIN` | 30 | Cooldown after the streak |
| `FTH_MAX_DAILY_LOSSES` | 3 | Losing trades per trading day before stopping |
| `FTH_MAX_ENTRIES_PER_DAY` | 6 | Entries per trading day (0 = off) |
| `FTH_NO_ENTRY_WINDOWS` | `09:30-09:35@America/New_York,15:00-18:00@America/Chicago` | No new entries |
| `FTH_BLACKOUTS_FILE` | `~/.futures-trading-harness/blackouts.json` | News blackouts written by `/premarket` |
| `FTH_ORDER_GATE_SKIP` | (none) | Comma list of gate checks to turn off |
| `FTH_HOOK_PROFILE` | `standard` | `minimal`, `standard`, or `strict` |
| `FTH_DISABLED_HOOKS` | (none) | Hook ids to disable, e.g. `stop:trading:review-reminder` |
| `PROJECTX_JOURNAL_PATH` | `~/.projectx-mcp/journal.jsonl` | Must match the MCP server's journal path |

## Using it

```text
/premarket MNQ            read-only game plan, levels, blackouts, risk budget
/trade-session MNQ        one cycle: analysts → plan → risk verdict → execution
/trade-plan MNQ orb       plan and verdict only (paper)
/trade-review             review closed trades (unblocks the next entry)
/eod                      flatten, cancel leftovers, review, lessons
/setup-scorecard month    expectancy per setup
/new-playbook <name> <source>
```

### The rationale convention

The order gate classifies `place_order` calls by their `rationale`:

- `setup:<name> ... stop <price> ...` is a new entry and goes through every check.
- `[exit] ...` closes or reduces a position.
- `[protect] ...` places a protective stop or target for an existing fill.

Exits and protective orders are never gated, so the agent can always reduce
risk. The projectx-mcp server still applies its own limits to every order.

### Recommended rollout

1. **Read-only.** `PROJECTX_TRADING_ENABLED=false`. Use `/premarket` and
   `/trade-plan`, and review paper trades.
2. **Practice account.** Enable trading on a practice or combine account only
   (`PROJECTX_ALLOWED_ACCOUNT_IDS`), micros, size 1, approve every order.
3. **Supervised autonomy.** Relax approvals only after `/setup-scorecard` shows
   30+ reviewed trades with positive expectancy and few rule breaks.

## Development

```bash
npm install
npm test          # node:test suite: gate rules, hooks end to end, indicators, content checks
npm run lint      # eslint + markdownlint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/HARNESS-DESIGN.md](docs/HARNESS-DESIGN.md).

## License

MIT. The hook runtime and plugin layout are derived from
[ECC](https://github.com/affaan-m/ECC) by Affaan Mustafa (MIT).
