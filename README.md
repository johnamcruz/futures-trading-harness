# Futures Trading Harness

An LLM-agnostic agent harness that trades futures on **TopstepX** through the
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp) server. It runs on
**Claude Code, Codex, or Qwen Code** (any model those harnesses can drive,
including Qwen through DashScope, vLLM, or Ollama), and it can trade on its own
on a schedule.

Strategies are Markdown documents: drop a `STRATEGY.md` into `strategies/` and
the agents can trade it, and the order gate enforces its instruments, sessions,
and status in code.

The architecture is based on [ECC](https://github.com/affaan-m/ECC): one
canonical tree of agents, skills, commands, rules, and profile-gated hooks, with
native adapters generated for each harness.

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
| **MCP gateway** (authoritative) | `scripts/mcp-gateway.js` in front of projectx-mcp | Everything the order gate checks, plus live account facts: `[exit]`/`[protect]` orders must really reduce the open position (resting stops and limits, including join orders, can't stack beyond it), no entries while a position in any month of the contract is open, loss streak and daily losses from real fills, working orders only shrink (never leaving part of a position without a stop) and only orders working an open position can be repriced, no cancelling the last protective stop, optional regime check. Order-changing calls go through one lane: each waits for the server's answer, and market orders not yet visible in positions are counted | Not through orders (deterministic, fails closed on missing or malformed account data). Limits: a fill the exchange reports more than 30 s late, and calls made outside the gateway |
| Order gate hook | PreToolUse on Claude Code, Codex, Qwen Code | Kill switch, paper mode, strategy (exists, `active`, instrument, session), setup tag first, numeric stop, plan with `contractId`, no-entry windows, news blackouts, journal loss streak, review before next entry, max entries | No (fails closed; locked in autonomous runs) |
| Autonomous lock-down | `scripts/autotrader.js` | `FTH_AUTONOMOUS=1` (gate can't be skipped or disabled), kill switch, caps, timeouts, end-of-day catch-up. Claude: allowlist (projectx, scoped reads, `/tmp/fth`, harness scripts, calendar sites) plus explicit denies on credentials and harness files. Qwen: the same rules in `workspace/.qwen/settings.json`. Codex: its `workspace-write` sandbox (writes only `workspace/`, `/tmp`, and the news-blackouts directory; the shell is available), plus a fingerprint check of the workspace instructions and settings after every run | Not through its own config |
| Rules, skills, roles | This repo | Risk math, strategy rules, process | Soft |

Always register projectx **through the gateway** (the installer does): it is
the one layer that works the same on every harness and sees the real account.

## Adapting to the market regime

Every closed bar gets a deterministic regime label
(`scripts/lib/trading/regime.js`): `trend-up`, `trend-down`, `range`, or
`transition`, plus high/normal/low volatility, from ADX, EMA slope, VWAP
crosses, and ATR versus its average. Strategies declare the regimes they fit
(`regimes: [trend, high-vol]`). The scan only offers in-regime strategies, so
the desk switches playbooks as the market changes, and `regime_gate: true` makes
the MCP gateway enforce it at order time. Plans and reviews carry a
`regime:<label>` tag, and the setup scorecard reports each strategy's results by
regime, so the strategy lineup is tuned from evidence: drop a regime where a
strategy loses, add one where it works.

## Strategies are Markdown

```text
strategies/
  orb/STRATEGY.md            opening range breakout
  ema_cross/STRATEGY.md      EMA 9/20 cross
  keltner/STRATEGY.md        Keltner breakout
  supertrend/STRATEGY.md     SuperTrend flip
  bos/STRATEGY.md            break of structure
  cisd_ote/STRATEGY.md       CISD + fib zone
  vwap_reclaim/STRATEGY.md   VWAP reclaim, paper
  ofi/STRATEGY.md            1m order-flow imbalance, on hold
  ofi_absorption/STRATEGY.md 1m absorption reversal, on hold
  _template/STRATEGY.md      copy this to add a strategy
```

Every strategy's trigger is written as rules in its frontmatter (`signal:
rules`); none is code. The six algoTraderBot ports reproduce its signals bar
for bar (`tests/lib/parity.test.js`).

Each file has code-checked frontmatter and a body the agents follow:

```yaml
---
name: orb
description: Opening range breakout for equity index futures ...
status: active                     # paper | active | disabled
regimes: [trend, transition, high-vol]   # regimes the strategy fits
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: ["09:45-11:30@America/New_York"]
signal: rules                      # rules (conditions below) or manual (agents judge the body)
rules:
  long:
    - close crosses_above or_high
    - adx(14) >= 18
  short:
    - close crosses_below or_low
    - adx(14) >= 18
params:                            # optional series settings
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

A mechanical trigger is written in Markdown too, as rules evaluated in code
on each closed bar; no JavaScript needed:

```yaml
signal: rules
rules:
  long:
    - close crosses_above vwap_rth
    - close > ema(50)
    - adx(14) >= 20
  short:
    - close crosses_below vwap_rth
    - close < ema(50)
    - adx(14) >= 20
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
| `hooks/hooks.json` | Order gate, session briefing, review reminder (Claude Code and Codex plugins, Qwen extension) |
| `scripts/` | Hook runtime, MCP gateway, autonomous runner, strategy/snapshot/blackout CLIs, installer, harness sync |
| `workspace/` | Generated `AGENTS.md` / `CLAUDE.md` / `QWEN.md`: the operator instructions every harness reads |
| `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/` | Claude Code and Codex plugin manifests |
| `qwen-extension/` | Qwen Code extension: generated manifest, `QWEN.md`, Qwen-format agents and commands, symlinks to the shared skills, scripts, strategies, hooks |
| `.codex/agents/` | Generated Codex agent roles |

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
| Qwen Code | `projectx` MCP (via gateway) in `~/.qwen/settings.json`; autonomous allowlist in `workspace/.qwen/settings.json` | `qwen extensions link <repo>/qwen-extension` (link, not install) |
| Codex | marked block in `~/.codex/config.toml`: `projectx` MCP (via gateway, tools pre-approved so `codex exec` can use them) + agent roles | `codex plugin marketplace add <repo>` then `codex plugin add futures-trading-harness@futures-trading-harness`; trust hooks in `/hooks` |
| Claude Code | rules in `~/.claude/rules/trading/` | `/plugin marketplace add <repo>`, `/plugin install futures-trading-harness@futures-trading-harness`, and the printed `claude mcp add` command |

Credentials (`PROJECTX_USERNAME`, `PROJECTX_API_KEY`) and guardrails
(`PROJECTX_TRADING_ENABLED`, `PROJECTX_ALLOWED_SYMBOLS`, ...) go in the
environment that launches the harness (Qwen's extension settings don't reach
MCP servers). See
`mcp-configs/` for examples.

## Running it

Interactive, from `workspace/` so every harness reads the operator instructions:

```bash
cd workspace
qwen      # or: codex, claude --plugin-dir ..
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

Premarket (09:00 ET) and end of day (15:50 ET) run on the clock. In session,
**a trade cycle starts after every closed bar** of the configured `timeframe`
(1 or 3 minutes, or any value up to 60):

1. The runner sleeps until the forming bar's close, waits `barDelaySeconds`,
   then polls ProjectX `retrieveBars` (closed bars only) every
   `barPollSeconds` until the new bar is published. Alignment is learned from
   the data, and after `barTimeoutSeconds` with no bar (daily break, halt) it
   resyncs.
2. It writes the closed bars to `<dataDir>/<SYMBOL>-<timeframe>m.json` and
   starts one headless run whose prompt names the bar and the file, so the
   agents start from fresh data without re-fetching it.
3. With `"trigger": "bar"` every closed bar runs the full process (analysts,
   strategy checks, risk, execution or management). With `"trigger": "signal"`
   (needs `account`) a bar starts a cycle only when a mechanical strategy of
   that timeframe fires or a position is open, which saves model calls.
4. A bar that closes while a cycle is still running is skipped, never queued.

Why polling and not a websocket: the ProjectX realtime hub streams quotes and
trades, not bars, so a websocket would mean building candles from ticks that
can disagree with the exchange's bars. Polling right after each close costs
about one request per symbol per bar (the limit is 50 per 30 s) and returns
the official candle.

The runner needs `PROJECTX_USERNAME` and `PROJECTX_API_KEY` in its
environment (read-only use: contracts, bars, positions). It logs everything to
`~/.futures-trading-harness/logs/` and never runs two cycles at once. Each run
follows the `autonomous-trading` skill: one bounded cycle, positions first, no
questions, stand aside when unsure. Runs are locked down per harness: Claude
Code gets an explicit tool allowlist (projectx, reading, `/tmp/fth`, and the
harness scripts by absolute path), Qwen Code runs in default approval mode
with the allowlist in `workspace/.qwen/settings.json`, and Codex runs in its
`workspace-write` sandbox. Start with `"paper": true` and tight server limits
(`PROJECTX_MAX_POSITION_SIZE=1`, a small `PROJECTX_MAX_DAILY_LOSS`, a practice
account in `PROJECTX_ALLOWED_ACCOUNT_IDS`).

For unattended Claude runs, remove any `ask` rules on projectx order tools
from your Claude settings (`mcp-configs/settings.example.json` has them for
interactive use): "ask" can't be answered without a user, so the runner
refuses to start while they're present.

More runner settings: `"cycle": "lean"` skips the parallel analysts unless a
strategy fires (use it for 1-minute bars so a cycle fits in one bar);
`maxCyclesPerDay` (400) switches to manage-only cycles once reached;
`cycleTimeoutMinutes` defaults to max(3, 2 x timeframe), and a cycle stopped
by the timeout makes the next one start by checking protective stops;
`earlyCloseDates` moves end of day to `earlyCloseEodAt` on CME early-close
sessions; bars go to `~/.futures-trading-harness/bars` (runner-owned) unless
`dataDir` is set. With several `symbols`, one cycle covers every symbol whose
bar closed, so none is starved.

### Backtesting

`scripts/backtest.js` replays historical bars from Parquet, Excel, CSV, or
JSON files the way algoTraderBot backtests. After every closed bar it:

1. settles the open trade against the bar;
2. trails its stop;
3. checks every strategy for an entry, with the same rules evaluation the
   live scan uses.

By default it applies the harness's own rules (sessions, end of day,
order-gate limits). `--no-gate` trades the way algoTraderBot does.

```bash
node scripts/backtest.js --data data/NQ_3min.parquet --symbol MNQ --start 2025-01-01 --end 2025-04-01
node scripts/backtest.js --config backtest.json    # see mcp-configs/backtest.example.json
```

Results are in R (as algoTraderBot reports them) and in dollars after fees,
broken down by strategy, exit, and month. See
[docs/BACKTESTING.md](docs/BACKTESTING.md).

### Order gate settings

| Variable | Default | Meaning |
|---|---|---|
| `FTH_KILL_SWITCH_FILE` | `~/.futures-trading-harness/STOP` | If it exists, no new entries |
| `FTH_STRATEGIES_DIRS` | (none) | Extra strategy folders |
| `FTH_PLAN_MAX_AGE_MIN` | 120 | Plan freshness |
| `FTH_MAX_CONSECUTIVE_LOSSES` / `FTH_LOSS_COOLDOWN_MIN` | 2 / 30 | Loss-streak cooldown |
| `FTH_MAX_DAILY_LOSSES` | 3 | Losing trades per trading day |
| `FTH_MAX_ENTRIES_PER_DAY` | 6 | Entries per trading day (0 = off) |
| `FTH_ENTRY_HOURS` | `09:35-15:00@America/New_York` | New entries only inside these windows (empty = any time) |
| `FTH_NO_ENTRY_WINDOWS` | `09:30-09:35@America/New_York,15:00-18:00@America/Chicago` | No new entries |
| `FTH_BLACKOUTS_FILE` | `~/.futures-trading-harness/blackouts/blackouts.json` | News blackouts (append-only via `scripts/blackouts.js`) |
| `FTH_PAPER` | (unset) | `1` refuses every entry (the runner sets it for `"paper": true`) |
| `FTH_AUTONOMOUS` | (unset) | `1` (set by the runner) ignores skip lists and hook disables for the gate |
| `FTH_ORDER_GATE_SKIP` | (none) | Checks to turn off |
| `FTH_GATE_LOG` | `~/.futures-trading-harness/gate-log.jsonl` | Gate decisions |
| `FTH_HOOK_PROFILE` / `FTH_DISABLED_HOOKS` | `standard` / (none) | Hook gating |
| `PROJECTX_JOURNAL_PATH` | `~/.projectx-mcp/journal.jsonl` | Must match the MCP server |

### The rationale convention

`place_order` rationales start with `setup:<strategy> ...` for entries,
`[exit] ...` to close or reduce, and `[protect] ...` for a protective stop or
target. Exits and protective orders skip the journal checks (plan, reviews, limits), so risk can always be
reduced; the gateway only checks that they really reduce the position.

## Development

```bash
npm install
npm test                         # node:test: gate, gateway, strategies, runner, installer, sync, content
npm run lint                     # eslint + markdownlint
node scripts/sync-harness.js     # regenerate Codex/Qwen/workspace files after editing agents, commands, rules, skills
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/HARNESS-DESIGN.md](docs/HARNESS-DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
