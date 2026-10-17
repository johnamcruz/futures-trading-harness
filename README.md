# Futures Trading Harness

An LLM-agnostic futures trading harness. A reasoning model trades by combining
skills (plain Markdown documents that teach it structure, liquidity, bias,
entries and risk), reads facts that code computes and checks, and places
orders only through a fail-closed order gate in front of a broker MCP server.
An autonomous runner drives it on a schedule, a replay driver runs the same
harness over history, and a learning loop improves the skills and rulebook
toward passing a prop-firm combine without blowing the account.

It runs on Claude Code, Codex, Qwen Code or opencode, with any model those
CLIs can drive. The harness names no broker, firm or model.

> [!WARNING]
> This software lets an AI place real orders on your account. Futures trading
> involves substantial risk of loss, and AI models make mistakes. Start with
> trading disabled on the broker server and `"paper": true` (`autotrader.paper`
> in the runner config), then a practice
> account, micro contracts and size 1. You are responsible for every order
> placed.

## How it works

```text
 skills (agents/, skills/, strategies/)     what the model knows and how it reasons
        │
 briefing facts                              bars, levels, session, account, computed and checked by code
        │
 trade_lifecycle / compose_check             the model composes a trade from skills; code checks its reads
        │
 order gate                                  hook + MCP gateway; fails closed, enforces strategy and account rules
        │
 broker MCP server                           one interface; live and replay servers are swapped in config
        │
 runner (scripts/autotrader.js)              cycles on a clock, end of day flatten, kill switch
        │
 replay (scripts/replay.js)                  the same runner on historical data and a simulated clock and fills
        │
 learning loop (scripts/train-loop.js)       scorecards and paired A/B runs; a change is kept only if it measurably helps
```

- **Skills and agents** are canonical documents; adapters for each CLI are
  generated from them (`node scripts/sync-harness.js`).
- **Briefing facts** put computed, checked facts in front of the model, so it
  reasons from data and not from what it remembers.
- **`trade_lifecycle` and `compose_check`** are the harness tools the model
  uses to compose a trade and to have its reads checked against the facts.
- **The order gate** refuses an order that breaks a strategy or account rule
  (see [Safety](#safety)).
- **The broker MCP interface** ([docs/BROKER-MCP-INTERFACE.md](docs/BROKER-MCP-INTERFACE.md))
  is the only way the harness touches a broker.
- **Replay** is the live harness on replayed data: only the data, the clock
  and the fills are simulated.

How it trades, in plain language: [docs/HOW-IT-TRADES.md](docs/HOW-IT-TRADES.md). The design in full:
[docs/HARNESS-DESIGN.md](docs/HARNESS-DESIGN.md) and [docs/OPERATING.md](docs/OPERATING.md). How every tool call and
multi-role step is run: [docs/TOOL-CALLS-AND-ORCHESTRATION.md](docs/TOOL-CALLS-AND-ORCHESTRATION.md).

## Requirements

- Node.js 22 or newer (`.nvmrc`). There are no runtime dependencies.
- One supported CLI: Claude Code, Codex, Qwen Code or opencode.
- A broker MCP server for live trading, and a replay broker server plus bar
  data for replay. Which servers are configured is in
  `mcp-configs/brokers.json`.
- Optionally, a local model server, if you run a local model through your CLI.
  Model settings stay in your own CLI config, never in this repo.

## Quick start

1. Clone and install the dev tools:

   ```bash
   git clone https://github.com/johnamcruz/futures-trading-harness
   cd futures-trading-harness
   npm install
   ```

2. Install the harness into your CLI(s). `--entry` is the built entry point of
   the broker server you use (build it from that server's own repo). Add
   `--dry-run` first to see the plan without writing anything:

   ```bash
   node scripts/install.js --target claude,codex,qwen,opencode --entry /abs/path/to/broker-server/entry.js --dry-run
   node scripts/install.js --target claude --entry /abs/path/to/broker-server/entry.js
   ```

   The installer prints the remaining native commands for each CLI (plugin
   install, MCP registration). Details per CLI: [docs/OPERATING.md](docs/OPERATING.md#setup).

3. Configure the broker. `mcp-configs/brokers.json` names the broker servers
   and the default one; override or add brokers in
   `~/.futures-trading-harness/brokers.json`, or pick one with `FTH_BROKER`.
   Put the server's credentials in `~/.futures-trading-harness/.env`, never in
   the repo:

   ```bash
   mkdir -p ~/.futures-trading-harness
   cp .env.example ~/.futures-trading-harness/.env && chmod 600 ~/.futures-trading-harness/.env
   node scripts/check-broker-mcp.js -- <the broker server command>   # checks a server against the interface
   ```

   See [mcp-configs/README.md](mcp-configs/README.md).

4. Check the setup. This is the full regression (tests, lint, generated files,
   strategies, secrets) and needs no broker:

   ```bash
   npm run verify
   ```

5. Run a replay. A replay never touches a real account: the replay broker
   server serves your own historical bars (getting the server and the bar data:
   [docs/OPERATING.md](docs/OPERATING.md#replay) and
   [docs/BACKTESTING.md](docs/BACKTESTING.md)). Copy the example config, set the
   replay broker, window, `runId` and `workDir`, list the decision times, then
   run:

   ```bash
   cp mcp-configs/replay.example.json replay.json
   node scripts/replay.js points --config replay.json    # the decision times, nothing run
   node scripts/replay.js run --config replay.json       # run, or resume after the last decision time done
   node scripts/replay.js report <run home>/replay/<runId>
   ```

6. Run the training preflight before a learning replay. It checks that the
   run is set up correctly and prints one PASS, FAIL, WARN or N/A line per
   check (a FAIL means `replay.js run` would refuse to start):

   ```bash
   node scripts/training-preflight.js --config replay.json --bars MNQ=<1m bars file>
   ```

7. Go on: [Common tasks](#common-tasks), then [docs/TRAINING.md](docs/TRAINING.md)
   for the training order and [docs/LIVE-DRY-RUN.md](docs/LIVE-DRY-RUN.md) before any live money.

## Common tasks

| Task | Command | Read |
|---|---|---|
| Trade in replay | `node scripts/replay.js run --config replay.json` | [docs/OPERATING.md](docs/OPERATING.md#replay) |
| Train stage 1 (learn to trade) and stage 2 (pass prop) | `"stage": 1` or `2` in the replay config, then `replay.js run`; `node scripts/train-loop.js plan\|run\|status --config <loop.json>` | [docs/TRAINING.md](docs/TRAINING.md) |
| Skill usage of a run | `node scripts/skill-usage.js <run dir>` | [docs/TRAINING.md](docs/TRAINING.md) |
| Scorecard of a run (each decision against the priority order) | `node scripts/replay.js scorecard <run dir>` | [docs/TRAINING.md](docs/TRAINING.md) |
| 30-day Monte Carlo (printed at the end of a stage-2 run) | `node scripts/replay.js report <run dir>` | [docs/TRAINING.md](docs/TRAINING.md#5-stage-2-pass-prop) |
| A/B compare two runs | `node scripts/ab-compare.js <runA home> <runB home>` | [docs/AB-COMPARE.md](docs/AB-COMPARE.md) |
| Backtest a strategy on bar files | `node scripts/backtest.js --config <backtest.json>` | [docs/BACKTESTING.md](docs/BACKTESTING.md) |
| Check each CLI headless | `node scripts/check-headless.js` | [docs/OPERATING.md](docs/OPERATING.md#setup) |
| Live dry run (preflight, then the runner) | `node scripts/preflight.js --config ~/autotrader.json`, then `node scripts/autotrader.js --config ~/autotrader.json --dry-run` | [docs/LIVE-DRY-RUN.md](docs/LIVE-DRY-RUN.md) |
| Add a strategy | copy `strategies/_template/` | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Regenerate the CLI adapters after editing agents, skills, commands or rules | `node scripts/sync-harness.js` | [CLAUDE.md](CLAUDE.md) |

## Safety

- **The order gate fails closed.** It runs as a hook and in the MCP gateway
  (the gateway is authoritative). An order that breaks a strategy, session,
  size or account rule is refused, and if the gate cannot decide, it refuses.
  It cannot be turned off in autonomous mode.
- **Exits are never held.** The gate refuses entries that break a rule, never a close or a
  stop that reduces risk.
- **Live trading needs explicit setup.** Start in replay and paper mode, run
  the live preflight, and follow [docs/LIVE-DRY-RUN.md](docs/LIVE-DRY-RUN.md).
  One runner trades a broker account at a time.
- **Credentials never get committed.** They live in
  `~/.futures-trading-harness/.env`. `npm run check:secrets` (also in CI) fails
  on any env file or credential in tracked files, and `npm run hooks:install`
  adds a pre-commit check.

## Repository layout

| Folder | What is in it |
|---|---|
| `agents/` | Canonical roles (analysts, risk manager, the one order-writing executor, reviewer) |
| `skills/` | Know-how and workflows, one `SKILL.md` each |
| `commands/` | Thin shims that start a skill |
| `rules/` | Always-on rules |
| `hooks/` | Hook definitions, including the order gate |
| `strategies/` | Strategies as `STRATEGY.md` documents |
| `accounts/` | Prop account profiles and rulebooks, as documents |
| `mcp-configs/` | Broker links and example configs |
| `scripts/` | CLIs, hooks and `scripts/lib/` (the tested logic) |
| `workspace/`, `qwen-extension/`, `.codex/` | Generated adapters; never edit by hand |
| `docs/` | Design, training, broker interface and runbooks |
| `tests/` | `node:test` unit, wiring and end-to-end tests |

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) (the
architecture rules). Before any pull request, run `npm run verify` and get an
adversarial review of the whole diff from someone other than its author. The
pull request says what was run and what the review found.

## License

MIT. See [LICENSE](LICENSE).
