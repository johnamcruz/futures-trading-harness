# Reasoning trader: replay, labels, and a policy that learns from it

Status: stage 1 (replay) is built: the replay driver (`scripts/replay.js`,
`scripts/lib/replay/`), the replay clock (`scripts/lib/trading/harness-now.js`)
and the simulated-broker module the replay broker's fills are ported from.
Stage 2 is design only, built if stage 1 shows an edge.

## The problem

The harness's trader is the reasoning model. Each cycle it reads what the
skills and strategies give it (the strategies' rules and documents, market
structure, liquidity, VWAP and the volume profile, the timeframes, the day
so far, sessions, news windows, the account) and decides: no trade, long or
short with a stop, target and size, or, in a trade, hold, tighten, or exit.
It is not tied to one setup.

Nothing measured or trained on that judgment:

- The backtester (`scripts/lib/backtest/engine.js`) runs only rules
  strategies; it skips any `signal: manual` strategy ("manual strategies need
  the LLM").
- The RL policy (`docs/RL-DESIGN.md`) learns from the rules' setups and the
  simulated outcomes. Its observation (`scripts/lib/rl/observation.js`) is
  built around a setup or a trade, and its actions are skip, half, or full at
  a rules setup, then hold or close past the ratchet
  (`scripts/lib/rl/challenge-env.js`). It never sees the reasoning model, so
  it can't learn how it trades, and live the model is reduced to placing the
  policy's verdict.

## The idea

Two stages, each useful on its own.

1. **Replay: the live harness on replayed data.** The live harness runs over
   history, cycle by cycle, exactly as it trades live: the same runner, the
   same harness CLI (whichever the runner config selects: Qwen Code, Claude
   Code, Codex, or a custom one), the same agents, skills, scripts, order gate
   and broker interface. Only three things are simulated, by a **replay
   broker** (an MCP server like any broker, e.g. backtester-mcp): the data,
   the clock, and the fills. There is no separate prompt path and no direct
   model call: what is measured is what trades. The result answers the first
   question (does the reasoning trader have an edge?), and its records are
   the labels.
2. **Student: a policy trained on those records.** A policy with an action
   space that covers the teacher's decisions and an observation that carries
   what the skills read, trained first to imitate the recorded decisions
   (behaviour cloning), then fine-tuned with RL in the simulator on the
   challenge (pass rate, zero blows). Live, it is fast, deterministic, and
   validated by the same promotion gate.

Stage 2 is built only if stage 1 shows an edge on the selection window
(below): cloning a trader with none adds nothing.

## Stage 1: replay (built)

### The pieces

- **The replay broker** (its own repo; backtester-mcp is the first): the
  broker MCP interface over local historical bars, with a clock file the
  driver moves forward and simulated fills (ported from the harness's
  `scripts/lib/backtest/sim-broker.js`, so replay, backtests and RL training
  share one fill model). It is a `brokers.json` entry with `"replay": true`;
  its `get_server_config` reports `replay: true` and the replayed
  `serverTime`, and its `search_trades` adds round-trip metrics (R, MAE, MFE,
  bars held, exit reason).
- **The replay clock** (`trading/harness-now.js`, HARNESS-DESIGN.md, Replay
  clock): `FTH_REPLAY_NOW` moves every trading decision's "now" (the gate,
  the scripts, the runner) to the replayed time, honored only for a replay
  broker whose server attests it; otherwise the gate refuses new entries.
  It never relaxes a check.
- **The replay driver** (`scripts/replay.js`, `scripts/lib/replay/`): for
  each decision time, moves the broker's clock, runs one pass of the live
  runner at that time in its own process, and records what happened.

### Decision points

The live runner's own: after every closed bar of the runner's timeframe inside
its sessions and the market session, polled `barDelaySeconds` after the close
as the live runner polls it (optionally every Nth bar of a trading day);
premarket at `premarketAt`; end of day at `eodAt` (`earlyCloseEodAt` on an
early close), retried a minute later while the runner hasn't verified the
account flat. Holidays, weekends and early closes come from the harness
calendar; a year the built-in table lacks gets its holidays from the same CME
rules (`exchange-calendar.js cmeHolidays`), passed to the runner and the gate
as configured closed dates (`replay/schedule.js`).

**One cycle per process.** A process's environment is fixed when it starts,
so the driver starts `node scripts/autotrader.js --once <kind>` for every
decision time with `FTH_REPLAY_NOW` set. Under a replay clock `--once` runs
one pass of the live loop (`runner.step()`, wired by `runner-wiring.js`
exactly as the long-running loop is): the bars through the broker adapter at
the replayed time, the bars file, the multi-timeframe and signal records, the
strategy scan, a policy's verdicts, the account and its open trades, the
journal's plans, lessons and reviewed trades, then the harness cycle. The
runner's day state (`autotrader-state.json`: cycles, premarket and end of day
done, trailing stops, the model's last results) carries across processes in
the run's home, so its schedule decides what runs, as live. Without a replay
clock `--once` is unchanged (a manual run).

**Days are not independent.** The account carries across days (a prop
attempt's cushion, trailing floor, and sessions left; a plain account's
balance, which sizes trades), and so does the prompt's own history (the
strategies' track record, the lessons, the last decisions). Days in one run
are replayed in order. Parallelism is across independent runs (separate run
ids, so separate homes and broker state): separate windows or start days.

### Isolation

Each run has its own freshly seeded harness home (`FTH_HOME =
<workDir>/<runId>`), never the user's: the driver refuses a run home that is
or overlaps the default home, the caller's `FTH_HOME`, or the repository, and
a non-empty folder that isn't a replay run. The home holds the runner's
state, the gate's records (`mtf/`, `signals/`), prop state, logs, the bars, a
copy of `brokers.json`, a copy of the workspace's operator files (the harness
CLI runs there, so a replay never writes the live workspace or its Qwen
allowlist), and, under `replay/<runId>/`, the broker's state folder, clock
file and journal. Every process the run starts gets:

- `FTH_HOME`, `FTH_BROKER` (the replay broker), `FTH_REPLAY_NOW`, and the
  broker's run variables (clock file, state folder, run id, window, journal);
- every path override pinned inside the run home (`FTH_GATE_LOG`,
  `FTH_BLACKOUTS_FILE`, `FTH_KILL_SWITCH_FILE`, `FTH_BROKERS_FILE`,
  `FTH_ENV_FILE`) and the run flags set neutral (`FTH_PAPER`, `FTH_DRY_RUN`,
  `FTH_ORDER_GATE_SKIP`, `FTH_TEST_NOW`): set, never just removed, because
  a child's `.env` load fills a missing variable from the repository's `.env`;
- every live broker's variables (credentials, server entry, journal: from
  `brokers.json` and the shipped brokers) replaced by a dead value, so no
  `.env` file can fill them in.

Before the first step the driver checks that the selected broker is a replay
broker with a journal of its own and no live twin (`harness-now.js`), and
that its server attests `replay: true` at the clock's time; every replay pass
checks it again before reading anything, and the gateway before any order.
The isolation checks follow symlinks and fold letter case where the
filesystem does. Fetched bars go to the run home's own scratch directory
(`<run home>/bars-scratch`), never one the live runner or another run reads.
The driver refuses to start while the live runner runs, and one driver
holds a run at a time.

### The cycle: the live harness

Whatever the runner config says: the harness CLI, its model, the cycle mode
(`full` with parallel analysts, or `lean`), `trigger`, sessions, and the
autonomous allowlists. The tools the agents call are the live tools: the
scripts take the replayed time from the harness clock and the broker answers
at its replayed time with bars closed by then, so nothing from after the
decision time is visible. Web search and fetch remain in the allowlist; a
replay of a past window can read today's web (news about that day): the
report says a replay measures the trader with that caveat, and an owner who
needs a sealed run removes web tools from the replay's runner config
(`extraArgs`, or a custom harness command).

### The gate in replay

Every check is real: the gate runs in the hook and the gateway as live, at
the replayed time, against the replay broker's positions, orders, fills and
journal: market hours, holidays, early closes and the calendar's end; the
trend rule, the trigger and strategy status from the records the runner
writes; blackouts the premarket agents record; size, risk, brackets,
exposure, losses from fills, entries per day; prop checks against the run's
attempt; the plan and the review before the next entry, which the agents
write as they do live; skills loaded, from the harness's transcript. The
report counts refusals by check; `replay-clock` refusals (the replay clock
refused) are the replay's plumbing and counted apart.

### Fills

The replay broker's: market entries at the next one-minute bar's open plus
slippage, stops at the stop less slippage (a gap fills at the open), targets
at the target, stop first when a bar reaches both; the runner flattens at end
of day as live. backtester-mcp's fill engine is ported from
`sim-broker.js`, and it has limit and stop entries.

### Leakage: the model may remember the market

The model has read about the markets in its training data. With real dates
and prices it may recall what happened next, and the records would look
excellent on history and fail live. The defence is **time**: the selection
and out-of-sample windows start after the model's knowledge cutoff. Only the
train window lies inside it, and only training (not any decision about the
trader) uses it.

Anonymization (no dates, a price offset per day) would need the replay
broker to serve shifted prices and times consistently to every tool; it is
not built, and the live tools show real times. If the train window needs it,
it belongs in the replay broker, so the harness stays unchanged.

**Leakage tests**, before relying on a train-window run:

- **Cutoff gap:** the same config on the train window (before the cutoff) and
  the select window (after). A large drop after the cutoff, beyond what the
  market explains, means it recalls.
- **Placebo:** the same decisions scored against another day's continuation
  spliced on. A trader that does better on the true continuation than the
  placebo, beyond chance, on bars it can't have seen, has an edge; one that
  only does better before its cutoff recalls.

### Windows

The RL pipeline's three windows, never overlapping: train, select, out of
sample.

- **Train** (may lie before the cutoff): the student's labels, and all
  prompt, skill and config iteration.
- **Select** (after the cutoff): the go/no-go for stage 2 (does the teacher
  beat the rules baseline and the current policy?), and choosing among
  students.
- **Out of sample** (after the cutoff, after select): looked at once, after
  the student exists, to validate it under the promotion gate. Replaying it
  is allowed once per frozen config (skills, strategies, harness and model);
  each look is logged.

### Nondeterminism

A replay is one draw of a stochastic trader. The run's manifest records the
harness command and model; results on the select window are repeated on a
sample of days (separate run ids) to report their spread.

### Store

Local, never in the repository: `<run home>/replay/<runId>/`:

- `manifest.json`: the run id, the config hash (the derived runner config,
  window, decision points, broker, harness command and the gate's `FTH_*`
  settings), the harness and model, the window, the last decision time done
  and the days done;
- `<trading day>.jsonl`, one line per decision time: the time, its kind,
  what the runner ran (action, ok, result line, symbols), the cycle log's
  summary (prompt hash, tool calls, skills loaded, orders sent, skills an
  entry lacked, the cycle file), the gate's refusals in that step, and the
  broker's fills since the previous time with every field it sends
  (round-trip R, MAE, MFE when present);
- `steps.log`: every step's output; `report.md`.

The cycle files in the run home's `logs/cycles/` hold each whole prompt and
transcript (what the model saw and did), for stage 2's features.

**Resume** by day: a re-run skips the days done, and an unfinished day
continues after its last recorded time (the broker's clock only moves
forward). A time whose step started but whose line was never written (the
driver stopped mid-step) is recorded as interrupted from what its process
logged and never run twice. A changed config, harness, model, broker setting,
gate setting, or strategy, account, model, skill, agent or rule file is a new
run id; the driver refuses to mix them.

**Per-process runner state.** The runner's day state is saved between
processes, including the day whose end-of-day review ran (so a retry only
flattens); its consecutive-error count isn't, so the driver counts failed
cycles itself (a failed cycle, or a bar's pass that read no bar and logged
errors) and stops the run after `maxConsecutiveErrors`.

### Report

`node scripts/replay.js report <run dir>`: month by month, decision times,
cycles, failed cycles, the stand-aside rate (trade cycles reporting
`no-trade`), trades (closed round trips, net of fees), win rate, mean R,
expectancy, net, MAE and MFE in R when the broker reports them, and the
gate's refusals by check. Next to the rules-only baseline and the current
policy (from `scripts/backtest.js` on the same window) and pass and blow
rates over combine attempts: later, with a prop attempt per run.

### Cost

Each trade decision time is a full live cycle with the model, so a replay
costs what live trading the same bars would: decisions × the cost of a cycle
(measured from the cycle logs: prompt size, tool calls, duration). The
`lean` cycle mode, a narrower session, and every Nth bar lower it:

| Scope | Decision times a year (3-minute bars, ~250 days) |
|---|---|
| The whole session (18:00–15:50 ET) | ~110,000 |
| The New York session (09:30–15:50 ET) | ~32,000 |
| New York, every other bar | ~16,000 |

`replay.js points` counts a window's decision times before a run;
`--max-cycles` stops cleanly at a budget and the next run resumes.

### Multiple markets

The runner trades several symbols, one cycle covering every symbol whose bar
closed, and the gate's exposure and correlation checks read every position.
Replay keeps that: one run holds every market on one timeline, and the store
records the symbols of each cycle.

## Stage 2: the student policy (design)

### Observation

Everything the live cycle's context carries (the runner's prompt context in
the cycle files: bars, trend, day context, what fired with its record, the
account and open trades, the last results), as numbers, scaled to the account
and to the market's ATR as the current observation is (so one policy reads
every market): the current RL observation (account, trade state, timeframes,
confluence, VWAP, value area) widened with every strategy's signal as an
input (not a gate), structure and liquidity levels as distances in ATR, the
day context (opening type, IB, day type, ADR used), the session and time to
the close, news windows, and the recent decisions. Where the student can't
match the teacher, the observation is missing what the teacher used.

### Actions

Flat: `none` / `long` / `short` at the market, with a stop from a few ATR
multiples and a size from the account's budget; in a trade: `hold` /
`tighten` / `exit`. Masked as the current env masks (no entry outside the
sessions, no size over the budget).

The teacher's decisions are read from the records: the orders it sent (cycle
log), what the gate let through, and the broker's fills. Each is mapped to
the nearest student action (the stop to the nearest ATR multiple, the size
to the budget's step). Decisions the student can't express (limit or stop
entries, targets) are kept out of cloning and counted; the report gives the
coverage.

### Training

1. **Behaviour cloning** on the train window's labels: the policy learns to
   predict the teacher's mapped decision from the observation.
2. **RL fine-tuning** in the challenge env (the existing reward: pass,
   speed, blow, timeout, dense, win, loss), starting from the cloned policy
   and held close to it (a penalty on drifting from the frozen cloned
   policy, which shrinks over training): the teacher can't be asked about
   the new states RL reaches, but its clone can.
3. The existing pipeline (sweep, retrain, ship) and promotion gate: zero
   blows in every out-of-sample month, a pass rate of at least 40%. Never
   lowered.

Today's action space (skip, half, full; hold, close) stays a mode of the new
env, so today's policies still train and load.

### Live

The student decides each cycle as the reasoning model would; the reasoning
model reviews, journals, and can stand aside for what the student can't see
(a live headline). Every stand-aside is logged and counted in the student's
live record.

## Where it fits (ECC)

- Stage 1: the driver's logic in `scripts/lib/replay/` (`schedule.js`
  decision times, `config.js` the config, isolation and process environment,
  `store.js` the records and resume, `report.js`, `driver.js` the loop) and
  the runner's wiring in `scripts/lib/runner-wiring.js`, with unit tests in
  `tests/lib/replay.test.js`; the thin CLI `scripts/replay.js`; an end-to-end
  test (`tests/e2e/replay-e2e.test.js`) with the suite's fake harness against
  a stub replay broker. No model is called by the harness: the harness CLI
  is. The replay broker is its own repo, reached through the broker
  interface.
- The `replay` skill tells agents how to configure, run, resume and read a
  replay (the user's to start); `policy-training` points to it.
- Stage 2 lives in `rl/fth_rl` (cloning, the widened env) and
  `scripts/lib/rl/` (observation, env server), with tests in both.

## Plan

1. The simulated-broker module, extracted from the engine. Done.
2. The replay clock. Done.
3. The replay broker (backtester-mcp, its own repo). Done.
4. The replay driver, store and report. Done.
5. Leakage tests, then one month in the train window, the New York session,
   with the report.
6. A replay of the select window. **Decision point**, on the select window
   only: build stage 2 if the reasoning trader beats the rules baseline and
   the current policy there.
7. Stage 2: widened observation and env, cloning, fine-tuning, the pipeline;
   then the one out-of-sample look.

Not built yet: a prop attempt started per run (today a run's prop strategies
see no attempt, so the gate refuses their entries; plain accounts trade), the
blackouts rebuilt from the historical calendar for each day (the premarket
agents record what they find), and anonymization in the replay broker.

## Open questions for the owner

- The teacher model, its knowledge cutoff, and the budget per run.
- The data years for the windows: the select and out-of-sample windows must
  start after the teacher's cutoff, so they may need recent data.
- The sessions to replay (the New York session only, or the whole session).
- Plain account or a prop attempt as the replay's account.
- Whether the student, once validated, trades live on its own or only
  advises the reasoning model.
