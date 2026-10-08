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

It also trains a reinforcement-learning policy to **pass prop-firm combines**
(Topstep 100K by default: $6,000 target, $3,000 trailing max loss, $2,000
daily limit) across all the strategies, in micros or minis; see
[Passing prop challenges](#passing-prop-challenges).

## ECC in brief

ECC keeps everything an agent needs as plain documents in one tree, and
generates each harness's own format from it:

| Slot | What it is | Here |
|---|---|---|
| `agents/` | Roles: a name, a description, the tools it may use | analysts, risk manager, executor (the only role with order tools), reviewer |
| `skills/<name>/SKILL.md` | Workflows and know-how: When to Use, How It Works, Examples | trade-session, premarket, end-of-day, prop-challenge-pacing, policy-training, ... |
| `commands/` | Thin shims that start a skill | `/trade-session`, `/combine-status`, `/train-policy`, ... |
| `rules/` | Always-on rules | risk, the order rationale, market hours |
| `hooks/` | Code that runs on harness events | the order gate (PreToolUse), briefings, review reminders |
| Domain documents | The harness's own documents in the same style | `strategies/<name>/STRATEGY.md`, `accounts/<name>/ACCOUNT.md` |

Code reads each document's frontmatter; agents read its body. Adapters for
Codex, Qwen Code, and the shared workspace are generated
(`node scripts/sync-harness.js`) and never edited by hand. Logic lives in
`scripts/lib/` (pure, tested), CLIs and hooks stay thin, and anything that
must hold (the gate, the account rules, a policy's promotion gate) is
enforced in code, not left to the prompt. The RL fits the same way: the prop
challenge is a strategy document (`signal: policy`), its account is an
account document, and its workflows are skills.

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

## Trading hours

Trading follows the Topstep session of CME futures: **18:00 ET to 16:00 ET
the next day, Sunday evening to Friday afternoon** (about 22 hours a day).
Nothing is traded from 16:00 to 18:00 ET or over the weekend, and every
position is flat by end of day (`eodAt`, default 15:50 ET, never later than
the 16:00 ET close). This is a hard rule: the order gate refuses entries
outside the session whatever the settings say, and the runner closes any
position it finds outside it. Exits are always allowed.

A trading day runs from the 18:00 ET open to the 16:00 ET close (Sunday
evening and Monday are Monday's trading day). Strategies narrow their own
hours with `sessions`, using named sessions or explicit windows:

| Session | New York time |
|---|---|
| `asia` | 18:00-03:00 |
| `london` | 03:00-09:30 |
| `ny` | 09:30-16:00 |

A strategy without `sessions` trades the whole session; `orb` trades only
`ny`, since its range forms at the 09:30 ET open.

## Layers of protection

| Layer | Where | Enforces | Model can bypass? |
|---|---|---|---|
| Firm rules | Topstep | Daily loss, trailing drawdown, 15:10 CT (16:10 ET) flatten | No |
| Server guardrails | projectx-mcp | Trading enabled, accounts, symbols, size, daily $ loss | No |
| **MCP gateway** (authoritative) | `scripts/mcp-gateway.js` in front of projectx-mcp | Everything the order gate checks, plus live account facts: `[exit]`/`[protect]` orders must really reduce the open position (resting stops and limits, including join orders, can't stack beyond it), no entries while a position in any month of the contract is open, loss streak and daily losses from real fills, working orders only shrink (never leaving part of a position without a stop) and only orders working an open position can be repriced, no cancelling the last protective stop, optional regime check. Order-changing calls go through one lane, one at a time (no batches): each waits for the server's answer, and orders that filled but aren't in positions yet are counted | Not through orders (deterministic, fails closed on missing or malformed account data). Limits: a fill the exchange reports more than 30 s late, and calls made outside the gateway |
| Order gate hook | PreToolUse on Claude Code, Codex, Qwen Code | Market session (18:00-16:00 ET, can't be skipped), prop challenge for strategies with an `account` (started attempt, fresh balance snapshot, daily limits, size budget for the stop, the policy's verdict; can't be skipped), kill switch, paper mode, strategy (exists, `active`, instrument, session), setup tag first, numeric stop, plan with `contractId`, no-entry windows, news blackouts, journal loss streak, review before next entry, max entries | No (fails closed; locked in autonomous runs) |
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
  ofi/STRATEGY.md            1m order-flow imbalance, paper
  ofi_absorption/STRATEGY.md 1m absorption reversal, paper
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
sessions: [ny]                     # asia, london, ny, or "HH:MM-HH:MM@Zone"; omit for the whole session
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
| `skills/` | 20 skills: workflows (trade-session, premarket, end-of-day, autonomous-trading), strategy library and authoring, market analysis, risk, review |
| `strategies/` | Strategy documents and the template |
| `accounts/` | Prop account profiles (`ACCOUNT.md`): Topstep 50K, 100K, 150K combines |
| `models/` | Promoted policy bundles (trained prop-challenge policies) |
| `rl/` | Python trainer for prop-challenge policies: MaskablePPO on the harness's own backtester, Optuna sweep → retrain → ship with JSON config families |
| `commands/` | Thin shims onto skills: `/trade-session`, `/premarket`, `/eod`, `/trade-review`, `/setup-scorecard`, `/new-strategy`, `/combine-status`, `/train-policy`, `/mtf` |
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

Requires Node.js 22+ and a built [projectx-mcp](https://github.com/johnamcruz/projectx-mcp)
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
MCP servers), or in a `.env` file. See
`mcp-configs/` for examples.

**`.env` files.** The autotrader, the MCP gateway, `backtest.js fetch`, and
`orderflow.js` read, in order: `$FTH_ENV_FILE` (if set),
`~/.futures-trading-harness/.env` (preferred: outside the repo), and a
`.env` in the repo root. The first value found wins, a variable already set
in the environment wins over all of them, and only key names are logged.
Start from `.env.example`:

```bash
cp .env.example ~/.futures-trading-harness/.env && chmod 600 ~/.futures-trading-harness/.env
```

The repo's `.gitignore` ignores `.env` and `.env.*` (not `.env.example`).
`npm run check:secrets` (also in CI) fails on any env file or credential
value in tracked files, and `npm run hooks:install` adds a git pre-commit
hook that checks every commit's staged files the same way.

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

The runner trades the session from the 18:00 ET open to end of day (15:50
ET), runs a premarket briefing at 18:05 ET (the start of the trading day,
ahead of the next morning's 08:30 ET data) and end of day on the clock, and
idles through the 16:00-18:00 ET break, weekends, and holidays. In session, **a
trade cycle starts after every closed bar** of the configured `timeframe`
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
`~/.futures-trading-harness/logs/` and never runs two cycles at once:
`autotrader-<day>.log` holds every runner line (timestamped, `INFO` or
`ERROR`: each bar's close and whether a cycle ran and why, stops trailed,
time stops, verdicts, account reads) and each cycle's output, and
`scans-<day>.jsonl` holds one record per scanned bar with every strategy's
verdict and why (the rules that failed, session, its detectors' state, such
as a CRT sweep's range and reason), and `events-<day>.jsonl` one record per
thing that happens: start and stop, each cycle (start, end, duration, result
line, timeout), the account read for it (balance, positions, prop attempt),
positions picked up for management, stops moved, closes (why, R at close,
best and worst R, bars held), end-of-day flattens and closes recorded, the
kill switch, and errors. `cycles-<day>.jsonl` has one line per cycle with
what the model saw and did (its prompt's size, the skills it loaded, its tool
calls by name, the orders it sent, and skills an entry needed but it never
loaded), and `cycles/<day>/<time>-<action>.json` the whole cycle: the prompt
(with the last 10 bars and the model's last 10 results), the transcript, and
the summary. `gate-log.jsonl` has every order the gate refused and why;
`alerts-<day>.jsonl` every alert.

Training logs go next to each run's outputs, in `logs/`: `<stage>.log`
(every line, timestamped: per seed, steps, steps/s, ETA, pass / blow /
timeout, win rate, trades and profit per attempt, episode reward, and PPO's
entropy, KL, clip fraction, explained variance, and losses),
`<stage>.jsonl` (every attempt, progress line, evaluation, and sweep trial
with its params, score, and state: complete, infeasible and why, pruned at
which checkpoint, or failed with its traceback), and a run manifest
(`run.json`: config, git commit, library versions, start, end, status).
Each sweep trial also writes `trial_NNN/train.log` and `summary.json`. Each run
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

More runner settings:

- `sessions` (default `18:00-15:50@America/New_York`, the whole session up
  to end of day) must lie inside the 18:00-16:00 ET session; `asia`,
  `london`, and `ny` work here too.
- `eodAt` is required and no later than 16:00 ET. After it, and outside the
  session, the runner checks the account once a minute and closes anything
  open. `earlyCloseDates` moves end of day to `earlyCloseEodAt` on CME
  early-close days.
- `"cycle": "lean"` skips the parallel analysts unless a strategy fires (use
  it for 1-minute bars so a cycle fits in one bar).
- `maxCyclesPerDay` (default: one per bar of the 22-hour session, plus 10)
  switches to manage-only cycles once reached.
- `closedDates` (CME holidays) and `earlyCloseDates` (13:00 ET closes, end
  of day at `earlyCloseEodAt`) are passed to the order gate too: no entries
  on a closed day or after an early close.
- No run outlasts end of day: each gets at most the time left until
  `eodAt`, and end of day closes positions directly before the agents'
  review run.
- `cycleTimeoutMinutes` defaults to max(3, 2 x timeframe); a cycle stopped by
  the timeout makes the next one start by checking protective stops.
- Bars go to `~/.futures-trading-harness/bars` (runner-owned) unless
  `dataDir` is set. With several `symbols`, one cycle covers every symbol
  whose bar closed, so none is starved.

### Backtesting

`scripts/backtest.js` replays historical bars from Parquet, Excel, CSV, or
JSON files the way algoTraderBot backtests. After every closed bar it:

1. settles the open trade against the bar;
2. trails its stop;
3. checks every strategy for an entry, with the same rules evaluation the
   live scan uses.

The market session always applies, as it does live: entries only from
18:00 to 16:00 ET (Sunday evening to Friday), and every trade closed at end
of day. By default it also applies the harness's other rules (sessions,
order-gate limits); `--no-gate` drops those to compare with algoTraderBot.

```bash
node scripts/backtest.js --data data/NQ_3min.parquet --symbol MNQ --start 2025-01-01 --end 2025-04-01
node scripts/backtest.js --config backtest.json    # see mcp-configs/backtest.example.json
```

Entries fill at the next bar's open with a tick of slippage (live, the
order goes in after the cycle that read the bar; `--fill close` for
algoTraderBot's mechanics). Results are in R (as algoTraderBot reports them)
and in dollars after fees, broken down by strategy, exit, month, entry hour,
and weekday, with a 95% interval on mean R, an edge verdict, Sharpe, MAE, a
data audit, and provenance. `--walk-forward --grid <param>=a,b,c` tunes a
rules strategy in sample and reports only its out-of-sample trades. See
[docs/BACKTESTING.md](docs/BACKTESTING.md).

### Operating it

- `node scripts/bars.js --symbol MNQ --timeframe 3 --record`: 2000 closed
  bars to `/tmp/fth/MNQ-3m.json` (credentials from your `.env`, never
  printed) and the multi-timeframe read recorded for the gate. Interactive
  sessions use it in place of pasting `get_bars` replies.
- `node scripts/autotrader.js --status`: a watchdog for cron or launchd;
  exits 1 when the runner is silent or the kill switch is on. Runner errors
  also go to `alertWebhook` / `alertCommand` (config) and
  `logs/alerts-<day>.jsonl`.
- `node scripts/reconcile.js --day 2026-10-07`: the day's entries against
  the signals the runner saw (taken, passed and why, off-scan entries).

### Passing prop challenges

A trained policy learns to pass prop-firm combines with a **high pass rate
and a high win rate**, never blowing the account. It plays thousands of
simulated combines from random start days on the harness's own backtester,
rewarded for passing (more for passing sooner) and for winning trades,
penalized far more for a blow, and lightly for losing trades and for running
out of time.

The prop challenge is a strategy: a **policy strategy** (`signal: policy`)
trades the setups of every rules strategy it lists on a prop account, and a
trained policy learns which to take, at what size, and when to bank a trade
(`strategies/prop_portfolio_3m/STRATEGY.md`):

```yaml
signal: policy
strategies: [ema_cross, supertrend, keltner, bos, cisd_ote, orb, vwap_reclaim, crt_1h, crt_4h]   # every 3-minute strategy
account: topstep_100k        # accounts/topstep_100k/ACCOUNT.md: $6,000 target, $3,000 trailing max loss, $2,000 daily limit
sizing: { cushion_frac: 0.3, cap_usd: 1000, drawdown_halve_usd: 1500, min_size_guard: 1.5 }   # risk from the headroom
contracts: auto              # micro | mini | auto: sized in micros, traded as minis once the size reaches one (10 MNQ = 1 NQ)
policy: { bundle: prop_portfolio_3m_topstep_100k }   # models/<bundle>.json, once one passes the gate
```

- `node scripts/combine.js start --account topstep_100k` starts an attempt;
  `status` shows balance, floor, cushion, progress, and the size budget. The
  runner snapshots the balance every bar and records each day's close; the
  order gate refuses that strategy's entries without a started attempt, a
  fresh snapshot, or room under the daily limits and the size budget.
- The policy sees which strategy fired, the account, the setup's risk (micro
  or mini), and the market; it decides at each setup (skip, half, or full
  size) and, past the ratchet, whether to bank the trade. It never picks the
  side. It is trained
  in Python (`pip install -r rl/requirements.txt`) with MaskablePPO on the
  harness's own backtester, so training, backtests, and live trading run the
  same rules. Each config family is JSON:

  ```bash
  python rl/sweep.py   --config rl/configs/sweep/prop_portfolio_3m_topstep_100k_v1.json --dry-run
  python rl/sweep.py   --config rl/configs/sweep/prop_portfolio_3m_topstep_100k_v1.json     # Optuna over the search space
  python rl/retrain.py --config rl/configs/retrain/prop_portfolio_3m_topstep_100k_v1.json   # best trial, more seeds
  python rl/ship.py    --config rl/configs/ship/prop_portfolio_3m_topstep_100k_v1.json      # out of sample, gate, promote
  ```

- The sweep ranks recipes by pass rate plus win rate (any blow is
  infeasible). A policy is promoted only when every retrained seed is
  blow-free on the selection window and, out of sample, it has zero blows in
  every month and a pass rate of at least 40% over 20+ attempts (and a win
  rate floor, if `min_win_rate` is set); live trading refuses any other.
- `node scripts/backtest.js --config <file> --prop prop_portfolio_3m [--bundle <name>]`
  runs combine attempts from every start day: pass, blow, and timeout rates.

See [docs/RL-DESIGN.md](docs/RL-DESIGN.md).

### Order flow from TopstepX

The `ofi` and `ofi_absorption` strategies are plain STRATEGY.md rules that
declare the data they need: `connectors: [order_flow]`. For them the runner
subscribes to the ProjectX market hub's trade prints (SignalR over the
built-in WebSocket, Node 22+), takes each print's aggressor side (the hub's
trade `type`: 0 buy, 1 sell), and sums 1-minute buy and sell volume into
the bars it scans, where `ofi(n)` and `delta(n)` read it. `orderFlow:
"auto"` (the default) turns the connector on when a strategy on the
runner's timeframe declares it. Recorded minutes go to
`<FTH_HOME>/flow/`, and `scripts/orderflow.js` records without the runner
and exports bars with flow for backtests. The hub keeps no history: flow
exists from when recording started.

```bash
node scripts/orderflow.js record --symbols MNQ,MES
node scripts/orderflow.js export --contract CON.F.US.MNQ.Z26 --from 2026-10-01 --to 2026-10-08 --out data/MNQ-1m-flow.csv
```

### Order gate settings

| Variable | Default | Meaning |
|---|---|---|
| `FTH_KILL_SWITCH_FILE` | `~/.futures-trading-harness/STOP` | If it exists, no new entries |
| `FTH_STRATEGIES_DIRS` | (none) | Extra strategy folders |
| `FTH_ACCOUNTS_DIRS` / `FTH_MODELS_DIRS` | (none) | Extra account-profile and policy-bundle folders |
| `FTH_PLAN_MAX_AGE_MIN` | 120 | Plan freshness |
| `FTH_MAX_CONSECUTIVE_LOSSES` / `FTH_LOSS_COOLDOWN_MIN` | 2 / 30 | Loss-streak cooldown |
| `FTH_MAX_DAILY_LOSSES` | 3 | Losing trades per trading day |
| `FTH_MAX_ENTRIES_PER_DAY` | 6 | Entries per trading day (0 = off) |
| `FTH_ENTRY_HOURS` | empty (the whole session) | New entries only inside these windows (`ny`, `london`, `asia`, or `HH:MM-HH:MM@Zone`); the 18:00-16:00 ET session is a hard limit either way |
| `FTH_NO_ENTRY_WINDOWS` | `09:30-09:35@America/New_York,15:45-16:00@America/New_York` | No new entries (the New York opening print, and into the close) |
| `FTH_BLACKOUTS_FILE` | `~/.futures-trading-harness/blackouts/blackouts.json` | News blackouts (append-only via `scripts/blackouts.js`) |
| `FTH_PAPER` | (unset) | `1` refuses every entry (the runner sets it for `"paper": true`) |
| `FTH_AUTONOMOUS` | (unset) | `1` (set by the runner) ignores skip lists and hook disables for the gate |
| `FTH_ORDER_GATE_SKIP` | (none) | Checks to turn off |
| `FTH_GATE_LOG` | `~/.futures-trading-harness/logs/gate-log.jsonl` | Gate decisions (readable by autonomous agents) |
| `FTH_HOOK_PROFILE` / `FTH_DISABLED_HOOKS` | `standard` / (none) | Hook gating |
| `PROJECTX_JOURNAL_PATH` | `~/.projectx-mcp/journal.jsonl` | Must match the MCP server |

### The rationale convention

`place_order` rationales start with `setup:<strategy> ...` for entries,
`[exit] ...` to close or reduce, and `[protect] ...` for a protective stop or
target. Exits and protective orders skip the journal checks (plan, reviews,
limits) and the trading hours, so risk can always be reduced; the gateway
only checks that they really reduce the position.

## Development

```bash
npm install
npm test                         # node:test: gate, gateway, strategies, runner, installer, sync, content (+ rl/tests when Python has numpy)
npm run lint                     # eslint + markdownlint
node scripts/sync-harness.js     # regenerate Codex/Qwen/workspace files after editing agents, commands, rules, skills
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/HARNESS-DESIGN.md](docs/HARNESS-DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
