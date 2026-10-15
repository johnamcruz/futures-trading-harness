# Reasoning trader: replay and labels

Status: stage 1 (replay) is built: the replay driver (`scripts/replay.js`,
`scripts/lib/replay/`), the replay clock (`scripts/lib/trading/harness-now.js`)
and the simulated-broker module the replay broker's fills are ported from.
Stage 2 (labels) is built: the labeler (`scripts/lib/replay/labels.js`,
`node scripts/replay.js labels <run dir>`). The student policy this design
once planned on top of the labels (behaviour cloning, then PPO fine-tuning)
is retired with the trained PPO policy; the learned-rulebook design (to
come) replaces it, and reads the labels to measure how closely the reasoning
trader follows its rules.

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
- The prop backtests (`scripts/lib/prop/challenge.js`) run the rules'
  setups through the combine. They never see the reasoning model, so they
  can't say how it trades. (The trained PPO policy that once sized those
  setups learned only from them too; it is retired.)

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
2. **Labels: every decision on the record.** Each decision the reasoning
   model made, with the gate's answer, the outcome, and what each skipped
   candidate would have done. They show whether its judgment adds edge over
   the rules, and how closely it follows the skills and the rules it is
   given (the learned-rulebook design's adherence measurement, to come).

## Stage 1: replay (built)

### The pieces

- **The replay broker** (its own repo; backtester-mcp is the first): the
  broker MCP interface over local historical bars, with a clock file the
  driver moves forward and simulated fills (ported from the harness's
  `scripts/lib/backtest/sim-broker.js`, so replay and backtests share one
  fill model). It is a `brokers.json` entry with `"replay": true`;
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

The replay broker's: market entries at the replay moment (the open of the
one-minute bar containing it, plus slippage; nothing from later bars), stops at the stop less slippage (a gap fills at the open), targets
at the target, stop first when a bar reaches both; the runner flattens at end
of day as live. backtester-mcp's fill engine is ported from
`sim-broker.js`, and it has limit and stop entries.

### Leakage: the model may remember the market

The model has read about the markets in its training data. With real dates
and prices it may recall what happened next, and the records would look
excellent on history and fail live. The defence is **time**: the reasoning
model is judged only on months after its knowledge cutoff. Windows before
the cutoff (train, and select when it lies there) supply labels for skill
and strategy iteration and its held-out check only, never a decision about
the trader (`docs/QUANT-PLAN.md`).

Anonymization (no dates, a price offset per day) would need the replay
broker to serve shifted prices and times consistently to every tool; it is
not built, and the live tools show real times. If the train window needs it,
it belongs in the replay broker, so the harness stays unchanged.

**Leakage tests**, before relying on a train-window run:

- **Cutoff gap:** the same config on the train window (before the cutoff) and
  months after the cutoff. A large drop after the cutoff, beyond what the
  market explains, means it recalls.
- **Placebo:** the same decisions scored against another day's continuation
  spliced on. A trader that does better on the true continuation than the
  placebo, beyond chance, on bars it can't have seen, has an edge; one that
  only does better before its cutoff recalls.

### Windows

The three split windows (`scripts/lib/prop/splits.js`), never overlapping:
train, select, out of sample.

- **Train** (may lie before the cutoff): labels, and all prompt, skill and
  config iteration.
- **Select**: the held-out check of those changes, and choosing among
  rulebook candidates (by their backtests, which see only bars). The
  reasoning trader itself is judged on months after the cutoff, which may
  lie outside the three windows (`docs/QUANT-PLAN.md`).
- **Out of sample** (after select): the promotion gate's window, in the
  backtester. The reasoning model is not replayed there. Each look is
  logged.

### Nondeterminism

A replay is one draw of a stochastic trader. The run's manifest records the
harness command and model; results on the months after the cutoff are
repeated on a sample of days (separate run ids) to report their spread.

### Store

Local, never in the repository: `<run home>/replay/<runId>/`:

- `manifest.json`: the run id, the config hash (the derived runner config,
  window, decision points, broker, harness command and the gate's `FTH_*`
  settings), the harness and model, the window, the last decision time done
  and the days done;
- `<trading day>.jsonl`, one line per decision time, plus a line for each
  failed attempt at a time (`retried: true`; read folded into the time's
  line as `retries`, its cycles with the line's): the time, its kind,
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
logged and never run twice. A time whose cycle made no decision (an
infrastructure failure: no `CYCLE RESULT` line, a harness that failed or
timed out) is an attempt and runs again at once; while it is due the
manifest says so (`cycleRetry`), it never counts as done, and a resume runs
it first. The agent's own `CYCLE RESULT: error` is a decision, recorded as
live records it, never retried. A changed config, harness, model, broker setting,
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
gate's refusals by check. Next to the rules-only baseline (from
`scripts/backtest.js` on the same window): later.

The prop score (`scripts/lib/prop/model-score.js`) replaced the per-month
combine verdict, which judged one fresh attempt per calendar month on the
run's single path. The run's own trades become a trade stream
(`scripts/lib/prop/model-stream.js`: R and ticks from the replay broker's
fills, the adverse path and the no-stop path from the run's own bars, each
trade's order within its day and its record's context; a day the model passed
is a no-trade day), and the evaluator (`scripts/lib/prop/evaluator.js`) runs
30-day Monte Carlo combine attempts on it under the account's rules
(`combine.js`, the one rule engine of live, the gate and the simulator): every
start day of the run, and stationary-block-bootstrap paths over its days with
the stop overshoots redrawn and faults injected (docs/LEARNED-RULEBOOK.md,
R6-R9). The report and the end of every run print, in order:

1. **Zero blows**, the hard gate: the frozen promotion gate
   (`prop/promotion.js`), never weakened.
2. **Pass within 30 trading days** (the account's `sessions`).
3. **Days to pass**: the median and the 90th percentile.
4. **Blow and timeout rates**, with their intervals (a block bootstrap over
   start days, Wilson at the effective sample size, Wilson over the paths).

A full-day run's score is `real`. A curated run (a pinned curated list) is
rebuilt at each list's natural frequency, from the curated scan's candidate
counts in its lists document (`prop/natural-rate.js` `curatedRates`; the
report needs the run's `--config`, which names the document, or rates by
hand with `--natural-rates`), and labelled `diagnostic (reweighted)`; a setup-focused run is `diagnostic (setup-focused)`. The
promotion gate refuses a diagnostic score. A score of a practice-validate,
test or final run is logged in the learning ledger beside the run's own
look (`learning/looks.js` `recordScore`), never as a look of its own; a
reasoning-fix run's outcomes are hidden, so it has no score. Account:
`--account`, else the run's own attempt, else the runner config's `account`
when it names a profile, else the policy strategies' account; with none the
run is not scored (there is no default account). The score is what the
replayed trades would do across attempts, never a guarantee of a live
result.

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

## Stage 2: labels (built)

`node scripts/replay.js labels <run dir> [--budget USD] [--bars SYM=file] [--out dir]`
(`scripts/lib/replay/labels.js`, `counterfactual.js`) writes
`<run dir>/labels.jsonl` and `labels-summary.json`, in the run's own folder
(refused inside the repository; a run the driver hasn't marked finished,
`finished` in its manifest once every decision time of the window ran, is
labelled only with `--out` outside its run home: the labels hold what came
after each decision, which a resumed teacher could read there), and prints
the coverage. Model-neutral: it
reads only what every replay writes (the day files, the cycle files'
context and transcript, the gate's log, the scans log, the bars, the
fills). One label per decision time and symbol:

- `decision`: `flat` or `in-trade` (a trade or manage cycle ran for the
  symbol: the teacher decided; the position is what the cycle's context
  showed, else the fills through t), `no-cycle` (a trade time with no cycle
  for it: counted, not a teacher decision), `housekeeping` (premarket, end
  of day), `kill-switch` (a trade time while the run's kill switch was on).
  Interrupted lines are labelled and flagged; torn lines counted. A failed
  or timed-out cycle, or one with no cycle log line, is never cloneable and
  never a skip; so is a flat label with a resting order (`working order`:
  the cycle ran for it; the count is the account's, so while another
  symbol holds a position its brackets explain it and no flag is set), of
  a manage-only cycle (`manage-only`: the day's cycle cap was reached, no
  new entry allowed), of a paper-mode run (`paper mode`: the gate refuses
  every live entry; the teacher journals plans), or of a cycle whose
  policy screen failed without naming its strategies (`policy screen
  failed`; when the runner names them, only their candidates are dropped:
  plain strategies still trade).
- `candidates`: what the scan fired on the decision's bar, with direction
  (only scans logged by t), that the teacher could trade: a strategy whose
  status isn't active (paper: the gate refuses its entries, the runner
  starts no cycle for it) is left out unless the run is in paper mode
  (where no flat decision is a skip), and
  a no-cycle bar the runner's scan decided not to run on has none.
- `teacher`: `none` / `long` / `short` flat (a flat cycle with a candidate
  and no entry is a skip), `hold` / `tighten` / `exit` in a trade (a
  modify that widens the working stop the context showed is flagged, one
  against an unknown stop too); the
  setup tag; the stop in ticks, points, and the nearest of 0.5, 0.75, 1,
  1.5, 2, 3 x ATR(20) on bars closed by t, the market features' ATR
  (`trading/market-features.js` atr20: Wilder over the whole series; null and
  counted when there are too few, or when the stop is under 0.375 or over 4.5 ATR: out
  of range, never snapped to an end bucket), from the order alone (never its fill); the size as a
  step (0.25, 0.5, 0.75, 1) of the budget given with `--budget` (a prop
  attempt's budget needs its whole state at t, which the run doesn't
  record: without `--budget` the step is null and counted), with the
  order's own contract's tick value (NQ on an MNQ run) as the run's broker
  reported it (`contracts-<broker>.json` in the run home, or its replayed
  days' `contracts-<broker>.<YYYY-MM-DD>.json`), else the static
  table; a broker spec unlike the table is measured with the table and
  flagged, as live refuses entries on it (`provenance.specs`: broker, table
  or mismatch); the raw orders. The
  entry that counts is the last one the broker accepted, else the last one
  the gate let through and the broker didn't refuse, else the last one sent
  (refused tries before it, by the gate or by the broker's guardrails in
  its journal, are one decision with it, counted in `priorRefusals`; only
  several entries that went through are "several entries"). An exit or a
  tighten is chosen the same way. Orders are the gate's records
  in the cycle's window (place, modify, cancel, partial close) joined to
  the transcript's calls for their arguments; an order the gate allowed and
  the gateway's order tracker then refused is one refused order;
  `close_position` isn't gated (`ungated`), so an exit by it is seen only in
  a parsed transcript. A modify or cancel naming no contract goes to its
  order id's contract (the broker's journal), else, with several symbols,
  every label of the cycle is flagged. Gate records outside every cycle are
  counted. The strategies are the caller's (the repository's and its
  `FTH_STRATEGIES_DIRS`): run it with the run's settings (the hash is in the
  provenance). A fill that reverses a position through flat is read as its
  close only (round trips don't split it).
- `gate`: allowed, refused (with checks, and `by`: the gate, another hook,
  the client (a gated call with no gate record never reached the gateway),
  or the broker with its reason (an exit whose call timed out but whose
  closing fill, not a bracket's, shows it went through is allowed; a client
  timeout with nothing to show is unknown and never cloneable, and an entry so is
  `outcome: unknown`, counted as `unknownOutcome`, never taken): the replay broker's journal, matched by rationale,
  contract and replayed time, or a call that came back an error with no
  journal record), not-logged (a call no gate record names: never taken,
  never cloneable), none; refused intents are kept and flagged, for the
  reader to decide. Flat, a modify or a cancel of a working order is a
  decision of its own: never a skip, never cloneable.
- `outcome`: the round trip from the broker's fills (P&L, net of every
  fill's fees, R from the initial stop, MAE and MFE in R when the broker
  sends them, win or loss).
- `counterfactual(s)`: for a skipped candidate, a refused intent's
  candidates, or one fired on a no-cycle bar (`counterfactualFor` says
  which), what the strategy's own trade would have done: the brackets
  order_plan would place (the scan's stop ceiled to ticks, the exit block's
  target in ticks from the placed stop, floored), filled and managed by the
  backtester's simulated broker (a market entry at the next bar's open plus
  a tick of slippage; the stop checked before the target in a bar; trail
  and max bars at the close; flat at the end-of-day bar's close), on the
  run's bars or the data the run replayed (`--bars`). It is its own walk,
  not a backtest run (no gate, no other positions). For a taken entry the
  same fields come from its fills (MAE/MFE, when the broker sends none,
  from the bars wholly inside the trade and its exit price). A no-cycle bar
  while a position is open (by the fills) gets none. The one standing for
  the label is a taken trade's own, a refused intent's own setup and side,
  else the first candidate with a stop distance. So a skilful skip (a loser
  avoided) can be told from a cautious one (a winner missed). What can't be
  simulated is marked and counted.
- `clone`: whether the mechanical action space (an entry side, a stop in
  ATRs, a size step; hold, tighten, exit) can express it (limit or stop
  entries, a target other than the strategy's own exit as order_plan places
  it, several entries, adds, partial exits, unknown arguments, an unmapped
  stop stay out), and why; the skip and hold counts read its reasons. `teacher.target` says whose target a bracket is.
- provenance: harness, model, config hash, the strategies' hash (the files
  the counterfactuals read), prompt hash, the cycle file.

Decision-time fields never read anything after t; outcomes and
counterfactuals are what came after, only in their own fields. The same
files give the same labels (idempotent). Limitation: the runner's bars file
keeps the last `bars` bars, so a long run's earliest days may have no ATR
or counterfactual bars in the run home: pass the replayed data with
`--bars`, and read the counts.

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
- The `replay` skill tells agents how to configure, run and read a replay
  (the user's to start); `replay-resume` how to resume one, `replay-labels`
  how to label it, and `replay-scorecard` how to score it.
- Stage 2's labeler: `scripts/lib/replay/labels.js` and `counterfactual.js`
  (tests in `tests/lib/replay-labels.test.js`,
  `tests/lib/replay-counterfactual.test.js`, and the replay end-to-end
  test), through `replay.js labels`.

## Plan

1. The simulated-broker module, extracted from the engine. Done.
2. The replay clock. Done.
3. The replay broker (backtester-mcp, its own repo). Done.
4. The replay driver, store and report. Done.
5. Labels from a run (the labeler, with counterfactuals for what the
   teacher didn't take). Done.
6. Leakage tests, then one month in the train window, the New York session,
   with the report.
7. A replay of months after the cutoff: does the reasoning trader beat the
   rules baseline there?
8. The learned-rulebook design (to come) takes it from there: the rules the
   reasoning trader is given are learned on history, and the labels measure
   how closely it follows them.

A run's prop attempt starts at the window's first moment, before the first
decision, when its config names the account (`"prop": "topstep_100k"`;
`skills/replay/SKILL.md`, The prop policy). Not
built yet: the blackouts rebuilt from the historical calendar for each day (the premarket
agents record what they find), and anonymization in the replay broker.

## Open questions for the owner

- The teacher model, its knowledge cutoff, and the budget per run.
- Decided (`docs/QUANT-PLAN.md`): the windows follow the split
  (`scripts/lib/prop/splits.js`), the teacher is judged on the months after
  its cutoff, and the out-of-sample test runs in the backtester.
- The sessions to replay (the New York session only, or the whole session).
- Decided (`docs/QUANT-PLAN.md`): every label window is a prop attempt.
