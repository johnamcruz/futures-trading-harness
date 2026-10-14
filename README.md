# Futures Trading Harness

An LLM-agnostic agent harness that trades futures through a broker MCP
server: any broker or prop firm whose server implements one interface
([Brokers](#brokers)). It runs on
**Claude Code, Codex, Qwen Code, or opencode** (any model those harnesses can
drive, hosted or local; the harness names no model), and it can trade on its
own on a schedule.

Strategies are Markdown documents: drop a `STRATEGY.md` into `strategies/` and
the agents can trade it, and the order gate enforces its instruments, sessions,
and status in code.

The architecture is one canonical tree of agents, skills, commands, rules, and
profile-gated hooks, with native adapters generated for each harness.

Its goal is to **pass prop-firm combines** (Topstep 100K by default: $6,000
target, $3,000 trailing max loss, $2,000 daily limit) before the next renewal,
in 40-50% of attempts without ever blowing the account, then trade the funded
account. The edge comes from the model trading with the skills and strategies;
the numbers they trade with are to be learned from history (a learned rulebook,
replacing the earlier reinforcement-learning policy); see
[Passing prop challenges](#passing-prop-challenges).

## Architecture in brief

The harness keeps everything an agent needs as plain documents in one tree, and
generates each harness's own format from it:

| Slot | What it is | Here |
|---|---|---|
| `agents/` | Roles: a name, a description, the tools it may use | analysts, risk manager, executor (the only role with order tools), reviewer |
| `skills/<name>/SKILL.md` | Workflows and know-how: When to Use, How It Works, Examples | trade-session, premarket, end-of-day, prop-challenge-pacing, replay, ... |
| `commands/` | Thin shims that start a skill | `/trade-session`, `/combine-status`, `/mtf`, ... |
| `rules/` | Always-on rules | risk, the order rationale, market hours |
| `hooks/` | Code that runs on harness events | the order gate (PreToolUse), briefings, review reminders |
| Domain documents | The harness's own documents in the same style | `strategies/<name>/STRATEGY.md`, `accounts/<name>/ACCOUNT.md` |

Code reads each document's frontmatter; agents read its body. Adapters for
Codex, Qwen Code, opencode, and the shared workspace are generated
(`node scripts/sync-harness.js`) and never edited by hand. Logic lives in
`scripts/lib/` (pure, tested), CLIs and hooks stay thin, and anything that
must hold (the gate, the account rules, the promotion gate) is
enforced in code, not left to the prompt. The prop challenge fits the same
way: it is a strategy document (`signal: policy`), its account is an
account document, and its workflows are skills.

> [!WARNING]
> This software lets an AI place real orders on your account. Futures trading
> involves substantial risk of loss, and AI models make mistakes. Start with
> trading disabled on the broker server and `"paper": true`, then a practice or
> evaluation account, micro contracts, and size 1. You are responsible for every
> order placed.

## How it fits together

```text
 scripts/autotrader.js  ──(schedule, kill switch)──▶  claude -p | codex exec | qwen -p | opencode run
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
        │     └─ MCP gateway (every MCP client) ──▶ broker MCP server ──▶ broker
        ▼
   trade-reviewer → journal reviews and lessons → next session's briefing
```

## Trading hours

Trading follows the Topstep trading day (its 17:00 CT reset), not CME's, and stops before Topstep's 16:10 ET flatten: **18:00 ET to 16:00 ET
the next day, Sunday evening to Friday afternoon** (about 22 hours a day).
Nothing is traded from 16:00 to 18:00 ET or over the weekend, and every
position is flat by end of day (`eodAt`, default 15:50 ET, never later than
the 16:00 ET close). This is a hard rule: the order gate refuses entries
outside the session whatever the settings say, and the runner closes any
position it finds outside it. Exits are always allowed.

A trading day runs from the 18:00 ET open to the 16:00 ET close (Sunday
evening and Monday are Monday's trading day): one day from open to close,
whatever the calendar date, for everything the harness counts by day (the
gate's loss and entry counts, end of day, prop closes, the calendar). Strategies narrow their own
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
| Firm rules | The prop firm (its account profile) | Daily loss, trailing drawdown, 15:10 CT (16:10 ET) flatten | No |
| Server guardrails | The broker MCP server | Trading enabled, accounts, symbols, size, daily $ loss | No |
| **MCP gateway** (authoritative) | `scripts/mcp-gateway.js` in front of the broker MCP server | Everything the order gate checks, plus live account facts: `[exit]`/`[protect]` orders must really reduce the open position (resting stops and limits, including join orders, can't stack beyond it), no entries while a position in any month of the contract is open, loss streak and daily losses from real fills, working orders only shrink (never leaving part of a position without a stop) and only orders working an open position can be repriced, no cancelling the last protective stop, optional regime check. Order-changing calls go through one lane, one at a time (no batches): each waits for the server's answer, and orders that filled but aren't in positions yet are counted | Not through orders (deterministic, fails closed on missing or malformed account data). Limits: a fill the exchange reports more than 30 s late, and calls made outside the gateway |
| Order gate hook | PreToolUse on Claude Code, Codex, Qwen Code | Market session (18:00-16:00 ET, can't be skipped), prop challenge for strategies with an `account` (started attempt, fresh balance snapshot, daily limits, size budget for the stop, the sizing verdict, the balance reconciled with the broker's fills; can't be skipped), kill switch, paper mode, strategy (exists, `active`, instrument, session), setup tag first, a stop bracket (`stopLossBracket`) on every entry, plan with `contractId`, no-entry windows, news blackouts, journal loss streak, review before next entry, max entries | No (fails closed; locked in autonomous runs) |
| Autonomous lock-down | `scripts/autotrader.js` | `FTH_AUTONOMOUS=1` (gate can't be skipped or disabled), kill switch, caps, timeouts, end-of-day catch-up. Claude: allowlist (broker tools, scoped reads incl. the home's `bars-scratch`, harness scripts, calendar sites) plus explicit denies on credentials and harness files. Qwen: the same rules in `workspace/.qwen/settings.json`. opencode: the same in the generated `workspace/opencode.json` (everything denied, then the broker and harness tools, skills, the roles, reading; no shell, edits or web fetch), the runner's directories and the same lock-down passed per run. Codex: its `workspace-write` sandbox (writes only `workspace/`, `/tmp`, and the news-blackouts directory; the shell is available), plus a fingerprint check of the workspace instructions and settings after every run | Not through its own config |
| Rules, skills, roles | This repo | Risk math, strategy rules, process | Soft |

Always register the `broker` server **through the gateway** (the installer
does): it is the one layer that works the same on every harness and sees the
real account.

## Brokers

The harness holds no broker code. Every broker or prop firm runs its own MCP
server, in its own repo, implementing one interface:
[docs/BROKER-MCP-INTERFACE.md](docs/BROKER-MCP-INTERFACE.md) (as data:
`scripts/lib/broker/interface.js`). The live broker server is the reference;
a replay broker server serves history through the same interface and
reproduces the live server's output.

- `mcp-configs/brokers.json` lists the servers and picks the default (the one
  it names): each server's entry point (or the variable that holds it),
  journal, and the variables it reads. It is the one link between the harness
  and broker servers; swap its entry to swap the broker. `~/.futures-trading-harness/brokers.json` (or
  `FTH_BROKERS_FILE`) overrides or adds brokers; `FTH_BROKER` picks one.
- Every harness registers it as the MCP server `broker` (tools
  `mcp__broker__<tool>`), always as the gateway alone:
  `node <repo>/scripts/mcp-gateway.js`. The gateway starts the configured
  server.
- The runner, `bars.js`, and `backtest.js fetch`
  reach it only through the broker adapter (`scripts/lib/broker/adapter.js`):
  reads straight to the server, order calls through the gateway.
- Contracts have standard names: `MNQ`, `NQ`, `ES` for the front month,
  `NQ:2026-03` for another. The contract translator
  (`scripts/contract-translator.js`), which the harness always starts in front
  of the selected server, maps them to that broker's own ids and back by asking
  its `search_contracts` / `get_contract`, so nothing above it sees a broker id.
- Switching brokers is config: add the server to `brokers.json` and set
  `FTH_BROKER`. What still makes a new server harder to write than it should
  be is tracked in [docs/TECH-DEBT.md](docs/TECH-DEBT.md).

Check a server against the interface before using it. The check is read-only
(no orders, no journal writes):

```bash
node scripts/check-broker-mcp.js [--account <id>] [--symbol MNQ] -- <server command>
```

How to build and run a server, and the variables it reads (credentials, its
entry path), are documented in your broker server's repo.

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
  vwap_reclaim/STRATEGY.md   VWAP reclaim, active
  ofi/STRATEGY.md            1m order-flow imbalance, active
  ofi_absorption/STRATEGY.md 1m absorption reversal, active
  crt_1h/STRATEGY.md         1-hour CRT liquidity sweep, active
  crt_4h/STRATEGY.md         4-hour CRT liquidity sweep, active
  value_area/STRATEGY.md     POC rejection or breakout, flow/expansion confirmed, active
  value_area_reentry/        volume profile 80% rule, active
  value_area_breakout/       acceptance beyond the value area, active
  _template/STRATEGY.md      copy this to add a strategy
```

Every strategy's trigger is written as rules in its frontmatter (`signal:
rules`); none is code. The six ported strategies reproduce its signals bar
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
strategies are ported from an earlier Python trading bot.

## What's inside

| Path | Contents |
|---|---|
| `agents/` | 8 roles: 4 analysts, risk manager, executor, reviewer, strategy researcher (canonical, Claude format) |
| `skills/` | 21 skills: workflows (trade-session, premarket, end-of-day, autonomous-trading), strategy library and authoring, market analysis, risk, review |
| `strategies/` | Strategy documents and the template |
| `accounts/` | Prop account profiles (`ACCOUNT.md`): Topstep 50K, 100K, 150K combines |
| `commands/` | Thin shims onto skills: `/trade-session`, `/premarket`, `/eod`, `/trade-review`, `/setup-scorecard`, `/new-strategy`, `/combine-status`, `/mtf` |
| `rules/trading/` | Always-on rules |
| `hooks/hooks.json` | Order gate, session briefing, review reminder (Claude Code and Codex plugins, Qwen extension) |
| `scripts/` | Hook runtime, MCP gateway, broker adapter and conformance check, autonomous runner, strategy/snapshot/blackout CLIs, installer, harness sync |
| `workspace/` | Generated `AGENTS.md` / `CLAUDE.md` / `QWEN.md`: the operator instructions every harness reads; `opencode.json`: opencode's project config (MCP servers, roles as subagents, permissions) |
| `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/` | Claude Code and Codex plugin manifests |
| `qwen-extension/` | Qwen Code extension: generated manifest, `QWEN.md`, Qwen-format agents and commands, symlinks to the shared skills, scripts, strategies, hooks |
| `.codex/agents/` | Generated Codex agent roles |

Generated files come from the canonical sources: `node scripts/sync-harness.js`
(CI runs `--check`).

## Setup

Requires Node.js 22+ and a built broker MCP server: build it as your broker
server's repo says (`mcp-configs/brokers.json` links the configured ones) and
note the path to its entry point.

```bash
git clone https://github.com/johnamcruz/futures-trading-harness ~/futures-trading-harness
cd ~/futures-trading-harness
node scripts/install.js --target qwen,codex,claude --entry /abs/path/to/your-broker-server/entry.js
```

`--broker <name>` picks a broker other than the default (the one `mcp-configs/brokers.json` names);
`--entry` is written to `~/.futures-trading-harness/brokers.json`, and
`--dry-run` shows the plan without writing.

The installer backs up and edits only what each harness can't get from its
plugin. It prints the remaining native commands:

| Harness | Installer writes | You run |
|---|---|---|
| Qwen Code | `broker` MCP (via gateway) and `harness` MCP (the harness tools) in `~/.qwen/settings.json`; autonomous allowlist in `workspace/.qwen/settings.json` | `qwen extensions link <repo>/qwen-extension` (link, not install) |
| Codex | marked block in `~/.codex/config.toml`: `broker` MCP (via gateway, tools pre-approved so `codex exec` can use them, the broker's variables forwarded), `harness` MCP (the harness tools, pre-approved) + agent roles | `codex plugin marketplace add <repo>` then `codex plugin add futures-trading-harness@futures-trading-harness`; trust hooks in `/hooks` |
| Claude Code | rules in `~/.claude/rules/trading/` | `/plugin marketplace add <repo>`, `/plugin install futures-trading-harness@futures-trading-harness`, and the two printed `claude mcp add` commands (`broker` and `harness`) |
| opencode | nothing: `workspace/opencode.json` is generated and committed (the `broker` and `harness` MCP servers, started from `FTH_ROOT`; every role as a subagent; the permissions) | `npm install -g opencode-ai` (1.x) and your model provider in `~/.config/opencode/opencode.json` (the harness names no provider or model) |

Check each harness headless afterwards (one real run per harness, in paper
mode with the broker read-only: it calls the harness tools, delegates to a
harness role, and tries a shell command, then prints what each reached). A
tool reached through a harness's bridge (Qwen Code's deferred MCP tools,
called via `tool_call`) counts once it answers; the bridge's refusal doesn't.
Each run's raw transcript is kept at
`~/.futures-trading-harness/logs/headless-<harness>-<time>.json` (under
`FTH_HOME`; stderr beside it as `.stderr.log`), and its path printed, so a
failure can be diagnosed without another run:

```bash
node scripts/check-headless.js                      # claude, codex, qwen and opencode
node scripts/check-headless.js --harness claude     # one harness
node scripts/check-headless.js --config autotrader.json   # the runner's harness and settings
```

Qwen runs on the workspace allowlist the runner writes at start; without it
the Qwen probe says so (`--write-qwen-allowlist` writes it, while no runner
is trading).

The broker server's credentials and guardrails (its `env` in the broker
config) go in `~/.futures-trading-harness/.env`,
which the gateway loads (Qwen's extension settings don't reach MCP servers).
See `mcp-configs/` for examples.

**`.env` files.** The autotrader, the MCP gateway, `bars.js`,
`backtest.js`, and `check-broker-mcp.js` read, in order: `$FTH_ENV_FILE` (if set),
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
qwen      # or: codex, claude --plugin-dir .., FTH_ROOT=$(cd .. && pwd) opencode
> /premarket MNQ
> /trade-session MNQ paper
```

Autonomous:

```bash
cp mcp-configs/autotrader.example.json autotrader.json   # pick harness, symbols, paper, schedule
node scripts/preflight.js --config autotrader.json                 # read-only readiness check (exit 1: fix the FAIL lines)
node scripts/autotrader.js --config autotrader.json --dry-run      # show the next action and command
node scripts/autotrader.js --config autotrader.json                # run the schedule
touch ~/.futures-trading-harness/STOP                              # kill switch: no new entries
```

A live run (`"paper": false`) needs its account on the broker's allow-list (the
variable `allowedAccountsEnv` names in `mcp-configs/brokers.json`): the runner
won't start and the gate refuses live entries without it (exits and closes always
go). The first live sessions step by step: `docs/LIVE-DRY-RUN.md`.

The runner trades the session from the 18:00 ET open to end of day (15:50
ET), runs a premarket briefing at 18:05 ET (the start of the trading day,
ahead of the next morning's 08:30 ET data) and end of day on the clock, and
idles through the 16:00-18:00 ET break, weekends, and holidays. In session, **a
trade cycle starts after every closed bar** of the configured `timeframe`
(1 or 3 minutes, or any value up to 60):

1. The runner sleeps until the forming bar's close, waits `barDelaySeconds`,
   then polls `get_bars` (closed bars only) through the broker adapter every
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

Why polling: `get_bars` is the interface's one bar source, and it returns
the broker's official candle. Polling right after each close costs about one
request per symbol per bar (mind the broker's rate limit).

The runner starts the broker server with its credentials (from the `.env`).
A live runner refuses to start unless the server lists every interface tool,
has trading enabled, and allows
the account; it needs trading for its exits, stop moves, and cancels. Paper
mode sets the broker's `paperEnv` (its trading switch off). It logs everything to
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
kill switch, and errors. Each trading day is also recorded as a replay
run is, in `~/.futures-trading-harness/sessions/<day>/` (`source: live`, the
agent's fingerprints, one line per decision point, the day's fills and the
broker's journal at end of day), so `node scripts/replay.js scorecard
~/.futures-trading-harness/sessions/<day>` scores live decisions exactly
as it scores a replay's. `cycles-<day>.jsonl` has one line per cycle with
what the model saw and did (its prompt's size, the skills it loaded, its tool
calls by name, the orders it sent, and skills an entry needed but it never
loaded), and `cycles/<day>/<time>-<action>.json` the whole cycle: the prompt
(with the last 10 bars and the model's last 10 results), the transcript, and
the summary. `gate-log.jsonl` has every order the gate refused and why;
`alerts-<day>.jsonl` every alert.

Each run follows the `autonomous-trading` skill: one bounded cycle, positions
first, no questions, stand aside when unsure. Runs are locked down per harness: Claude
Code gets an explicit tool allowlist (broker tools, reading, and the
harness scripts by absolute path), Qwen Code runs in default approval mode
with the allowlist in `workspace/.qwen/settings.json`, opencode runs
`opencode run --format json` on the generated `workspace/opencode.json` (no
`--auto`: anything it doesn't allow is refused), and Codex runs in its
`workspace-write` sandbox. Start with `"paper": true` and tight server limits
(max position 1, a small daily loss limit, a practice account as the only
allowed account).

For unattended Claude runs, remove any `ask` rules on broker order tools
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
- `lanes` (optional) names the runner's timeframe lanes: a list of
  `{ "timeframe": <minutes, 1 to 60>, "trigger": "bar" | "signal", "strategies": [...], "policies": [...] }`
  (`trigger` defaults to `bar`; `strategies` and `policies` are optional and
  narrow the lane to those names; left out, the lane takes every strategy, or
  every policy strategy, on its timeframe, and a listed policy's own
  strategies always stay in). Without `lanes`, `timeframe` and `trigger` are
  the one lane, exactly as before. Each lane's timeframe appears once; a name
  belongs to the lane of its own timeframe and to one lane only (anything else
  is refused at start), and with `lanes` a `timeframe` or `trigger` that
  disagrees with the first lane's is refused. A `policies` list that leaves
  out another policy on the lane's timeframe with a running prop attempt is
  refused at start too: that policy owns its strategies' setups, which the
  lane would never trade. `node scripts/preflight.js` lists each lane with
  its strategies and policies.

  Several lanes cycle together: a bar clock per symbol and lane, and the
  lanes whose bars close at the same time go into ONE cycle (each 3m close is
  also a 1m close: the analysts run once, the risk manager, the executor and
  the gate decide once; a lane due at that close that publishes a few
  seconds late holds the cycle up to 10 s; a replay pass, one step per process, never holds: a lane missing its bar there is a gap in the data, and live cycles without it after the hold too). A `"bar"` lane cycles on every
  bar; a `"signal"` lane only when one of its strategies fired on the bar or
  a position is open (no fire and flat: no model call). The prompt says
  which lanes closed, and its "last cycles" history is those lanes' (10 each, kept per lane
  in the state), plus the first lane's last 3 and an open trade's lane's last 3 (the last
  reviewed trades are unchanged). The first lane is the runner's own: its bars write the
  multi-timeframe record, the bar briefing and the trailing stops (the
  report cache keys on its bar: a cycle with only a 1m bar reuses the
  reports cached at the last 3m bar), and its timeframe sets
  `cycleTimeoutMinutes`; a cycle's time limit is the fastest closed lane's
  (another lane's is max(3, 2 x its minutes), never over
  `cycleTimeoutMinutes`). When two policy strategies have an entry verdict
  in one cycle, or one arrives while another policy's entry verdict from an earlier cycle is still open
  (unexpired and unused), on any of the runner's symbols (collisions are settled per runner, that is per
  account: a runner trades one account), the one with the lower `priority` goes first (equal or
  unset: the one on 3m or slower; then the slower timeframe); the other's
  setup is skipped as "lower priority", recorded so for the gate (which
  refuses it; when that skip can't be recorded, the cycle runs manage-only and the runner turns the kill switch on, so the gate refuses every entry until the user looks) and in the cycle log and event log (`policy_skipped`). Each
  lane's last bar is kept in the runner state, so a replay pass (a new
  process per decision time) never takes a 3m lane's last bar for a new one
  at a 1m close; the replay schedule is the union of the lanes' closes, each
  decision point listing its lanes.
- `agents` (optional) sets an agent role's timeframe:
  `{ "<role>": { "timeframe": "15m" } }`, over the `timeframe` its
  `agents/<role>.md` may declare (none: the first lane's; no shipped role
  declares one). The role must exist and the timeframe be one such as `3m`,
  `15m` or `1h`. Only the analysts (`market-structure-analyst`,
  `trend-momentum-analyst`, `volume-liquidity-analyst`) read their own
  timeframe; the risk manager, the executor and the gate decide once per
  cycle on the cycle's bars, so any other role set off the first lane's
  timeframe is refused at start. An analyst's timeframe is a lane's (its
  bars), or whole bars of the first lane that divide the hour (`15m`, `30m`,
  `1h` from 3m bars: the runner builds them from the first lane's bars and
  writes them as `<dataDir>/<SYMBOL>-<minutes>m.json`, OHLCV only); anything
  else is refused at start. Such an analyst gets a bar briefing of its
  timeframe (`bar_briefing` with `"timeframe": "15m"`: its own bar's facts,
  the gate's trend rule, and the first lane's m15, h1 and day parts that
  change no faster than its bars), the prompt tells the head trader which
  analyst reads which timeframe, and its report is cached on that briefing
  until its own next bar close (a 15m analyst re-runs at most every 15
  minutes, a 1h one at most hourly; the last bar before the 16:00 ET break or
  the weekend holds until the first bar after the open), never past it. An
  analyst on the first lane's timeframe is cached as before (its 15m-and-up
  view to the next 15m close). Each cycle merges the latest report of every
  analyst; risk-manager phase 1 is still read fresh whenever the account
  changes. Preflight lists each role's effective timeframe.
- `"cycle": "lean"` skips the parallel analysts unless a strategy fires (use
  it for 1-minute bars so a cycle fits in one bar).
- `maxCyclesPerDay` (default: one per bar of the 22-hour session, plus 10)
  switches to manage-only cycles once reached.
- The CME equity index calendar for 2026-2027 is built in
  (`scripts/lib/trading/exchange-calendar.js`): every exchange holiday is
  closed (no session at all, even where CME runs a short one), and the day
  after Thanksgiving and Christmas Eve close at 13:00 ET. `closedDates` and
  `earlyCloseDates` (13:00 ET closes, end of day at `earlyCloseEodAt`) add
  days to it. Both go to the order gate too: no entries on a closed day or
  after an early close. After the calendar's last day the gate refuses every
  entry (those days' holidays are unknown); the runner warns once a day for
  the 30 days before it. Configured dates extend it only a whole year at a
  time: list every holiday (`closedDates`) and early close
  (`earlyCloseDates`) of the year, as CME publishes them (the rules in
  `exchange-calendar.js` `cmeHolidays` check that none is missing).
- No run outlasts end of day: each gets at most the time left until
  `eodAt`, and end of day closes positions directly before the agents'
  review run. It is done only once the account reads flat (a position whose
  size can't be read counts as open); otherwise it closes and cancels again
  on the next pass. `"eodReview": false` skips the agents' review run (end
  of day still flattens and records the close; replays use it to save model
  calls).
- `cycleTimeoutMinutes` defaults to max(3, 2 x timeframe); a cycle stopped by
  the timeout makes the next one start by checking protective stops.
- Bars go to `~/.futures-trading-harness/bars` (runner-owned) unless
  `dataDir` is set. With several `symbols`, one cycle covers every symbol
  whose bar closed, so none is starved.

### Replay

`scripts/replay.js` runs the live harness over history: the same runner,
harness CLI, agents, skills, scripts, order gate and broker interface, one
decision time per process, against a replay broker (a `brokers.json` entry
with `"replay": true`, such as backtester-mcp) that simulates the data, the
clock and the fills. Each run has its own harness home, never the live one.

```bash
cp mcp-configs/replay.example.json replay.json     # runner config, replay broker, window, runId, workDir
node scripts/replay.js points --config replay.json # the decision times, nothing run
node scripts/replay.js run --config replay.json    # run, or resume after the last decision time done
node scripts/replay.js report <run home>/replay/<runId>
node scripts/replay.js scorecard <run home>/replay/<runId>   # adherence: each decision against the priority order
```

With `"prop": "topstep_100k"` in the config, a fresh run starts that combine
attempt before the first decision, and its broker stops the day at that
account's own daily loss limit ($2,000 for 100K), as the firm does.

The report is month by month: cycles, trades, win rate, mean R, expectancy,
stand-aside rate, the gate's refusals by check, and MAE/MFE when the broker
reports them. The scorecard scores each decision against the priority
order's mechanical steps, checks the reasons the trader stated against the
facts it had, and sorts the misses into a failure taxonomy (wrong-side entry,
bad size, early close, excessive abstention, wrong stated reason, risk-rule
rejection). See the `replay` skill and
[docs/REASONING-TRADER-DESIGN.md](docs/REASONING-TRADER-DESIGN.md).

### Backtesting

`scripts/backtest.js` replays historical bars from Parquet, Excel, CSV, or
JSON files the way the original bot backtests. After every closed bar it:

1. settles the open trade against the bar;
2. trails its stop;
3. checks every strategy for an entry, with the same rules evaluation the
   live scan uses.

The market session always applies, as it does live: entries only from
18:00 to 16:00 ET (Sunday evening to Friday), and every trade closed at end
of day. By default it also applies the harness's other rules (sessions,
order-gate limits); `--no-gate` drops those to compare with the original bot.

```bash
node scripts/backtest.js --data data/NQ_3min.parquet --symbol MNQ --start 2025-01-01 --end 2025-04-01
node scripts/backtest.js --config backtest.json    # see mcp-configs/backtest.example.json
```

Entries fill at the next bar's open with a tick of slippage (live, the
order goes in after the cycle that read the bar; `--fill close` for
the original bot's mechanics). Results are in R (as the original bot reports them)
and in dollars after fees, broken down by strategy, exit, month, entry hour,
and weekday, with a 95% interval on mean R, an edge verdict, Sharpe, MAE, a
data audit, and provenance. `--walk-forward --grid <param>=a,b,c` tunes a
rules strategy in sample and reports only its out-of-sample trades. See
[docs/BACKTESTING.md](docs/BACKTESTING.md).

### Operating it

- `node scripts/bars.js --symbol MNQ --timeframe 3 --record`: the runner's count of closed
  bars to `~/.futures-trading-harness/bars-scratch/MNQ-3m.json` (the harness
  home's own scratch folder, `<FTH_HOME>/bars-scratch`; through the broker adapter; credentials
  from your `.env`, never printed) and the multi-timeframe read recorded for the gate. Interactive
  sessions use it in place of pasting `get_bars` replies.
- `node scripts/autotrader.js --status`: a watchdog for cron or launchd;
  exits 1 when the runner is silent or the kill switch is on. Runner errors
  also go to `alertWebhook` / `alertCommand` (config) and
  `logs/alerts-<day>.jsonl`.
- `node scripts/reconcile.js --day 2026-10-07`: the day's entries against
  the signals the runner saw (taken, passed and why, off-scan entries).

### Passing prop challenges

The goal is to pass prop-firm combines consistently, never blowing the
account. The prop challenge is a strategy: a **policy strategy**
(`signal: policy`) trades the setups of every rules strategy it lists on a
prop account, each at the largest size the attempt's budget allows (or
skipped), and its trail exits every trade
(`strategies/prop_portfolio/STRATEGY.md`):

```yaml
signal: policy
instruments: [MNQ, NQ, MES, ES, MYM, YM, M2K, RTY]   # four indexes, one shared account, one position at a time
timeframe: 3m                # the one bar-size setting: every listed strategy trades it
strategies: [ema_cross, supertrend, keltner, bos, cisd_ote, orb, vwap_reclaim, crt_1h, crt_4h, value_area, value_area_reentry, value_area_breakout]   # every 3-minute strategy
account: topstep_100k        # accounts/topstep_100k/ACCOUNT.md: $6,000 target, $3,000 trailing max loss, $2,000 daily limit
sizing: { cushion_frac: 0.3, cap_usd: 1000, drawdown_halve_usd: 1500, min_size_guard: 1.5, stop_slippage_ticks: 1 }   # risk from the headroom; a contract's risk counts a tick of stop slippage
contracts: auto              # micro | mini | auto: live, only with no contract selected (the verdict is sized in the selected one); a backtest sizes by this mode
```

- `node scripts/combine.js start --account topstep_100k` starts an attempt;
  `status` shows balance, floor, cushion, progress, and the size budget. The
  runner snapshots the balance every bar and records each day's close; the
  order gate refuses that strategy's entries without a started attempt, a
  fresh snapshot, or room under the daily limits and the size budget.
- The balance is checked against the broker's own fills: each day's first
  flat snapshot anchors it, and the broker's balance, read while flat, must
  equal that anchor plus every fill since (P&L less fees and commissions). A
  mismatch, or fills that can't be read, refuses entries until it
  reconciles; exits always go. The fills are asked for only when something
  moved (the balance, a position, an order of ours) or the last check didn't
  pass; otherwise the last good check carries forward.
- At each setup the runner records the verdict (`full` with the contract,
  size, and stop ticks, or `skip` with the reason); the order gate holds the
  entry to it, and the agents' priority order (the `strategy-library` skill)
  may still skip or halve it. The verdict never picks the side, and it is
  sized in the selected contract (MNQ selected: MNQ, never switched to NQ).
- `node scripts/backtest.js --config <file> --prop prop_portfolio`
  runs combine attempts from every start day: pass, blow, and timeout rates,
  by month.
- A configuration is promoted only when, out of sample, it has zero blows in
  every month and a pass rate of at least 40% over 20+ attempts and 2+ months
  (`scripts/lib/prop/promotion.js`, frozen code; the split windows are in
  `scripts/lib/prop/splits.js`).

The trained PPO policy that once decided each setup is retired. The
learned-rulebook design (to come) replaces it: a small set of numbers and
context rules, searched on history and scored by combine attempts, that the
gate enforces and the skills teach. The design for replaying the reasoning
trader over history and measuring its decisions is
[docs/REASONING-TRADER-DESIGN.md](docs/REASONING-TRADER-DESIGN.md).

### Order flow

The harness computes no order flow. A broker MCP server that has it puts it
on its bars as extra fields (turned on by the server's own settings, which
its `mcp-configs/brokers.json` entry passes through), and the harness passes
them through untouched. The `ofi`, `ofi_absorption`, and `value_area`
strategies read them with the rules' `field("path")`; on a bar without them
those conditions are false, so `ofi` and `ofi_absorption` give no signal and
`value_area` can confirm only through its range-expansion branch. They are active for replay and live (the owner's call), as is
`prop_flow_1m`, the policy strategy over the 1-minute pair. See
[docs/ORDER-FLOW.md](docs/ORDER-FLOW.md).

### Order gate settings

| Variable | Default | Meaning |
|---|---|---|
| `FTH_KILL_SWITCH_FILE` | `~/.futures-trading-harness/STOP` | If it exists, no new entries |
| `FTH_STRATEGIES_DIRS` | (none) | Extra strategy folders |
| `FTH_ACCOUNTS_DIRS` | (none) | Extra account-profile folders |
| `FTH_PLAN_MAX_AGE_MIN` | 120 | Plan freshness |
| `FTH_MAX_CONSECUTIVE_LOSSES` / `FTH_LOSS_COOLDOWN_MIN` | 2 / 30 | Loss-streak cooldown |
| `FTH_MAX_DAILY_LOSSES` | 3 | Losing trades per trading day |
| `FTH_MAX_ENTRIES_PER_DAY` | 6 | Entries per trading day (0 = off) |
| `FTH_ENTRY_HOURS` | empty (the whole session) | New entries only inside these windows (`ny`, `london`, `asia`, or `HH:MM-HH:MM@Zone`); the 18:00-16:00 ET session is a hard limit either way |
| `FTH_NO_ENTRY_WINDOWS` | `09:30-09:35@America/New_York,15:45-16:00@America/New_York` | No new entries (the New York opening print, and into the close) |
| `FTH_BLACKOUTS_FILE` | `~/.futures-trading-harness/blackouts/blackouts.json` | News blackouts (append-only via `scripts/blackouts.js`) |
| `FTH_PAPER` | (unset) | `1` refuses every entry (the runner sets it for `"paper": true`) |
| `FTH_SYMBOLS` | (unset; the runner sets it to its `symbols`) | The selected contracts, one per index (e.g. `NQ,MES`). A rules strategy trades only the selected leg of a micro/mini family it lists (listing MNQ covers a selected NQ; selecting NQ refuses MNQ). Unset: each strategy trades exactly its `instruments`, and a rules strategy listing both legs of a family trades neither. Invalid (two legs of one index), or unset in an autonomous run (`FTH_AUTONOMOUS=1`): every entry is refused |
| `FTH_AUTONOMOUS` | (unset) | `1` (set by the runner) ignores skip lists and hook disables for the gate |
| `FTH_ORDER_GATE_SKIP` | (none) | Checks to turn off |
| `FTH_GATE_LOG` | `~/.futures-trading-harness/logs/gate-log.jsonl` | Gate decisions (readable by autonomous agents) |
| `FTH_HOOK_PROFILE` / `FTH_DISABLED_HOOKS` | `standard` / (none) | Hook gating |
| `FTH_BROKER` / `FTH_BROKERS_FILE` | the broker `mcp-configs/brokers.json` names / `~/.futures-trading-harness/brokers.json` | The broker MCP server ([Brokers](#brokers)) |

### The rationale convention

`place_order` rationales start with `setup:<strategy> ...` for entries,
`[exit] ...` to close or reduce, and `[protect] ...` for a protective stop or
target that repairs an open position's protection. Every entry carries its
stop as `stopLossBracket {ticks, type: "stop"}`: the gate's `stop-defined`
check refuses an entry without one (skippable with `FTH_ORDER_GATE_SKIP`
only outside autonomous runs), and the rule is to always send it. A broker
that can't attach it refuses the entry, and it is never sent again without
one. Exits and protective orders skip the journal checks (plan, reviews,
limits) and the trading hours, so risk can always be reduced; the gateway
only checks that they really reduce the position.

## Development

```bash
npm install
npm test                         # node:test: gate, gateway, strategies, runner, installer, sync, content, e2e
npm run lint                     # eslint + markdownlint
node scripts/sync-harness.js     # regenerate Codex/Qwen/opencode/workspace files after editing agents, commands, rules, skills
```

`tests/e2e/mock-trading-e2e.test.js` trades end to end on a mock exchange
(`tests/fixtures/mock-exchange.js`) through the production stack: the order
gateway and the contract translator in front of a broker MCP server, and the
runner on the broker adapter. It covers a long's and a short's whole life (a
real signal, the refusals, stop moves, partial closes, a gap through the
stop, a target, the runner's trailing stop), closes in flight under three
names for the contract, closes refused or of unknown outcome, an entry whose
reply is lost, an unreadable position, holidays, the early close, end of day
against a broker that loses or delays its closes, losses counted from real
fills, malformed brackets, a prop attempt's daily close (recorded once flat,
or missed and then refused), and a runner that crashed mid-day catching up
the next morning. A change to the gate, the gateway, or the runner keeps it
green.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/HARNESS-DESIGN.md](docs/HARNESS-DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
