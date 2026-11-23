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

## Goal: the edge is reading the market

The edge isn't a prediction and isn't a mechanical signal. It is the model
learning to read the market as it is at each candle, and reacting correctly
to what it reads:

- It recognizes a real trend and gets in on a confirmed pullback.
- It sits out chop.
- It holds the trends that run.

The exit is built so that losers stop at 1R, and a trend that keeps running
(2-5R) is left to run. The model doesn't forecast where price goes next. It
reads what is true now and acts on it.

The aim is a model that trades profitably and passes a 30-session prop-firm
combine consistently, with zero blown accounts.

## How the model reads the market

Each read states what is true at this candle, and each read leads to an
action. The skills teach the reads, and the briefing prints the facts they
rest on.

| Step | Read | Action |
|---|---|---|
| Side | The 4h and the 1h both trend one way. | Trade only that way; never counter it. |
| Market | The briefing's `Market state` line: what the 3m market is doing, computed once by code from the owner's three layers on the RTH bars: internal structure (the 3m breaks), protected structure (the leg's protected level, `HL` or `LH`: a close through it is the only invalidation of the leg; a CHoCH then BOS against it is a confirmed transition, a reversal once that level is closed through) and price behavior (overlap, efficiency, displacement, failed continuation). The states: forming before the first RTH break; pullback (the pullback guard: no chop inside it); rotation; transition; chop, which takes structural AND behavioral evidence (a CHoCH pair alone is not enough) and lasts until displacement ends it or the leg re-establishes with a fresh extreme its way; weakening; trend; in the leg; else range. The 4h and 1h sit beside it, then the class code computes (`; class trend-up`). A BOS is continuation; a CHoCH is a potential reversal. A read, not a filter: no gate reads it. | The class word is the one the line prints, and only it: `chop` → `chop`, sit out; `(not aligned)` → `unclear`, no trade; `rotation` or `weakening` → `unclear`, wait; a pullback their way, `range`, or a trend, leg or transition their way → their trend class, setups their way (a pullback: wait for the 15m turn); `forming` → their trend class, no setup yet; a trend, leg or transition against them → `unclear`, no trade. |
| Setup | The 15m pullback turns the side's way: a live strong 15m CISD, a 15m BOS, a 15m CHoCH back, or a 15m reaction at the level. | The setup is on. |
| Entry | The first 3m BOS or CISD the side's way, near VWAP or the EMA20. | Compose on that confirming 3m bar: a limit at its close. Never a limit back at the broken level, and never a chase. |
| Manage | A later 15m BOS the side's way. | Hold. |
| Manage | A 15m CHoCH or CISD against. | This pullback failed. Flat: wait for a new 15m turn. In a trade: `manage-position` acts. Never counter. |

A CISD the side's way reads like a BOS; a CISD against reads like a CHoCH. A
CISD confirmed by an engulfing or displacement candle is the strong form.

The model states its read as one chain, for example: "4h and 1h up; 15m
pulling back to the broken level; 15m CISD up confirmed by a bullish
engulfing candle; 3m BOS up near VWAP: a strong setup, enter."

The state table is in
[skills/trade-session](skills/trade-session/SKILL.md) (step 3), the state's code in
`scripts/lib/trading/market-state.js`, and the
owner's chop definition in [skills/trend-vs-range](skills/trend-vs-range/SKILL.md).
The full pullback sequence is in
[skills/pullback-vs-reversal](skills/pullback-vs-reversal/SKILL.md), and the
evidence behind it is in
[docs/research/pullback-read-evidence.md](docs/research/pullback-read-evidence.md).

That evidence is why the work goes into the reading. Entry rules tested on
their own came out about break-even or worse. Beyond how deep a pullback
already is, no single fact visible at it separated the pullbacks that
resumed from the ones that ranged or reversed. The 3m timing has not been
measured on its own. The edge has to come from the model reading correctly:

- getting into the trends that run;
- staying out of chop;
- letting the trail carry the winners.

Whether the reading earns is what the replays measure.

**How improvement is measured:** by how well the model reads.

- **A context quiz:** closed-choice questions on every read, many with a trap
  answer, asked several times.
- **The recognition test:** real trend legs and chop days, candle by candle.
  Does the model name the trend early, enter through the pullback read, and
  sit out chop?
- **Replays:** the full harness over history, with a 30-session combine
  Monte Carlo.

Every skill change goes through tests written first and an independent
adversarial review before it merges.

## The strategy

The harness ships one active strategy stack, written as documents in
[strategies/](strategies/README.md):

| Strategy | What it is |
|---|---|
| `trade_lifecycle` | The model's own trade: it composes bias, location, setup, entry, stop and target from its skills as one record, and code checks every read in it before the order can go ([docs/COMPOSED-ENTRY.md](docs/COMPOSED-ENTRY.md)). |
| `momentum_continuation` | A rules strategy (a closed 3m momentum candle the prevailing trend's way, in the morning window). It never trades on its own: a composed record may cite it as a setup. |
| `prop_portfolio` | The account layer: a policy strategy that sizes each composed trade within the account's budget (or skips it) and exits it by the account's rulebook. |

What the trade looks like:

- **Style:** trend following on index futures (Nasdaq, S&P, Dow, Russell, in
  micro or mini form; the selected contract trades). Replay testing so far
  has used Nasdaq data.
- **When:** the focus is the New York morning session; the runner's clock
  and the gate set the hours, and everything is flat before the session
  closes.
- **Side:** never against a trending 4h or 1h. A trade against it is a pass.
- **Entry:** after a pullback ends, on a confirming 3m close (the cited
  momentum setup enters on its own momentum candle).
- **Stop:** where the trend idea is wrong, beyond the reaction's swing.
- **Exit:** the stop and the target are set when the trade goes on. Once the
  target is reached, the stop locks at the target's R less 1.5R (+0.5R on a
  2R target) and trails behind the latest confirmed 15m swing, so a trend
  that keeps running is held.
- **Selective:** a valid setup is a pass when its reward to risk is under 2:1,
  when the reads don't all check true, or when the account's state says to
  wait.

The model reasons and proposes. Code checks every read, sizes the trade and
refuses anything outside the rules ([Safety](#safety)).

## The account: a prop-firm combine

The goal is a combine pass: reach the profit target before the loss limits
are touched. An account is a document in [accounts/](accounts/) (the firm's
rules as numbers) and its rulebook beside it (the numbers the policy trades
with, and which rules code enforces and which the skills teach). The shipped
100K profile has:

- a profit target and a trailing max loss: the floor trails the highest
  end-of-day balance and locks at the starting balance, and a blow is equity
  at or below the floor at any moment;
- a daily loss limit that stops the day;
- a consistency rule: the best day may be at most a set share of the total
  profit;
- a 30-session window the evaluation uses (not a firm rule).

Verify the numbers against the firm's current rules before trading.

Inside those limits:

- **Risk per trade:** the composed trade's cap is $300 all in (in its
  strategy document). The size is the most contracts that cap fits; the
  rulebook's cushion rules only lower it, and near the loss floor they shrink
  it so a stop at its price does not reach the floor.
- **Floor and stretch:** when the cap fits fewer contracts than the minimum
  size, the rulebook allows exactly the minimum, up to a set dollar amount
  all in, while the attempt is healthy.
- **Stops on the day:** a soft daily stop and a losing-streak stop end new
  entries for the day. Exits are never blocked.
- **One position at a time**, shared across the instruments.

Where the numbers live: the firm's limits in the account, sizing, exit and
the soft stops in its rulebook, the per-trade cap and minimum reward to risk
in the strategy documents, and the gate's entry limits in `config/runner.json`.
The runner, the gate and the simulator all read them from there.

## Context the model may read: gamma

The `gex-regime` skill records the day's options gamma word from a line the
code computes, as context only. The
book is never a forecast: the word is never a reason to enter, pass, size,
stop or exit, and it casts no vote in the count. A harness version that
prints a code-computed gamma line from your own gamma data is proposed in a
separate pull request. Until then the skill is inert.

## Where it stands

Honestly:

- **Not proven.** Entry rules tested on their own showed about break-even or
  worse expectancy in model-free tests on historical data. The bet is that the model's
  reading, with the exit that holds trends, earns where a mechanical rule
  doesn't. That is measured in replays and not assumed.
- **Replay only.** No live account is involved. Live trading needs the
  consistent-replay-pass requirement and the runbook in
  [docs/LIVE-DRY-RUN.md](docs/LIVE-DRY-RUN.md), and the owner's decision.
- **Small samples.** A few trades can swing a replay's R. A result counts
  when it holds on held-out days the model and its skills were not tuned on.
- **The numbers that count** are in dollars against the account's rules:
  zero blown accounts first, then the pass rate over 30 sessions.

The plain-language tour is [docs/HOW-IT-TRADES.md](docs/HOW-IT-TRADES.md),
with the evidence behind the reads.

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
