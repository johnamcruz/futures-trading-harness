# Reasoning trader: replay, labels, and a policy that learns from it

Status: design, not built. Owner review before any code.

## The problem

The harness's trader is the reasoning model. Each cycle it reads what the
skills and strategies give it (the strategies' rules and documents, market
structure, liquidity, VWAP and the volume profile, the timeframes, the day
so far, sessions, news windows, the account) and decides: no trade, long or
short with a stop, target and size, or, in a trade, hold, tighten, or exit.
It is not tied to one setup.

Nothing measures or trains on that judgment today:

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

So the reasoning is never measured over history, and nothing learns from it.

## The idea

Two stages, each useful on its own.

1. **Replay: the reasoning trader backtested.** Run the reasoning model over
   historical data, cycle by cycle, as it trades live, with point-in-time data
   only. Its orders go through the order gate and fill in a simulated broker
   on the real bars. Every decision and trade is recorded with what the model
   saw and what followed. The result answers the first question: does the
   reasoning trader have an edge? And the records are the labels.
2. **Student: a policy trained on those records.** A policy with an action
   space that covers the teacher's decisions and an observation that carries
   what the skills read, trained first to imitate the recorded decisions
   (behaviour cloning), then fine-tuned with RL in the simulator on the
   challenge (pass rate, zero blows). Live, it is fast, deterministic, and
   validated by the same promotion gate.

Stage 2 is built only if stage 1 shows an edge on the selection window
(below): cloning a trader with none adds nothing.

## Stage 1: replay

### Decision points

A decision at every closed bar of the sessions under study, as the runner's
`trigger: bar` does live, not only at rules setups. A cycle is a decision
whether flat (enter or not, and how) or in a trade (hold, tighten, exit).
Holidays are skipped. The replay's end of day is the backtester's: 15:50 ET,
12:50 ET on an early close.

**Days are not independent.** The account carries across days (a prop
attempt's cushion, trailing floor, and sessions left; a plain account's
balance, which sizes trades), and so does the prompt's own history (the
strategies' track record, the lessons, the last decisions). Days in one
account path run in order. Parallelism is across independent paths: separate
combine attempts (each from its own start day, as the backtester's prop runs
do) or separate windows.

### Isolation

Each replay worker runs in its own freshly seeded harness home
(`FTH_HOME`), never the user's: the gate keeps one record per symbol family
(`<home>/mtf/`, `<home>/signals/`), prop state under `<home>/combine/`, and a
live attempt in a shared home would refuse every replayed entry. The worker's
home holds a journal, the gate's records, the combine state, a blackouts file
rebuilt from the historical calendar for that day, and no kill switch. Every
check is evaluated at the bar's time (`now`), as `check-order.js` already
accepts.

### The decision prompt

Live, the agent loads the skills and calls tools each cycle (bars, the
market snapshot, the scan, the journal, the broker), and a `full` cycle runs
parallel analyst roles and a risk manager. Replay can't call live tools, and
tool results from today would leak the future. Two modes:

- **Compact (the label run).** One call per decision. The prompt is a fixed
  part and a point-in-time part. The fixed part is the workspace
  instructions (`workspace/AGENTS.md`, rules embedded), the trading skills,
  and the strategies' documents, read from the canonical tree. The
  point-in-time part is built by code from the data up to the bar:
  - the last bars on each timeframe;
  - `market-snapshot.js` (levels, VWAP, volatility, structure,
    participation) and `mtf.js` (the trend rule);
  - every strategy's scan;
  - `day-context.js` and `volume-profile.js`;
  - the session, the account, and the open trade (`open-trades.js`);
  - the trader's own recent decisions.

  The answer is a structured decision (below). The fixed part is cached.
- **Full (a fidelity check).** On a small sample of days in the train
  window, the real harness CLI headless, cycle by cycle, in the live `lean`
  cycle mode (one trader, no parallel analysts), every tool served from the
  point-in-time data, and no web or other live tool (the autonomous
  allowlist's web search removed). Agreement between full and compact on the
  same bars measures how much compact loses; low agreement means compact is
  missing something the agent uses. The `full` cycle mode, with its analysts,
  is out of scope for replay; the report says the replay measures a single
  trader.

### The decision

Structured so it can be checked and learned:

- flat: `none`, or `long` / `short` with an order type (market first; limit
  and stop entries later, below), a stop (price, and its distance in ticks
  and in ATR), an optional target, a size (contracts, micro or mini), and the
  strategy it trades (`setup:<name>`);
- in a trade: `hold`, `tighten <stop>`, or `exit`;
- `reasons`: short tags for what drove it (for example `trend-aligned`,
  `swept-liquidity`, `vwap-reclaim`, `value-area-edge`, `news-window`), from
  a fixed list kept with the skills, plus one sentence.

### The gate in replay

Each order goes through the real order gate (`check-order.js` and the
account checks in `account-gate.js` against the simulated broker's
positions, orders, fills, and ledger). Each check is served one of three
ways, and the report counts refusals only from the real ones:

| Check | In replay |
|---|---|
| Market hours, holidays, early closes, the calendar's end | Real, at the bar's time |
| Trend rule (`mtf-trend`), trigger fired, strategy status | Real, from records the worker writes as the runner does live |
| Blackouts | Real, from the day's historical calendar |
| Size, risk, order consistency, brackets, exposure, position and working orders, losses from fills, max entries | Real, against the simulated broker |
| Prop checks (combine, policy) | Real, against the worker's attempt |
| Plan required | Synthesized: the decision's plan is written to the journal before its order (the trader writes one live) |
| Review before the next entry | Synthesized: after each closed trade the worker writes a graded review from the outcome, as the trade-review step does live |
| Skills loaded | Not applicable (no transcript; the fixed part carries the skills) |

### Fills

The backtester's broker logic, so replay, RL training, and backtests share
one fill model where they overlap: market entries at the next bar's open
plus at least one tick of slippage, targets at the target price, stops at
the stop price less slippage (a gap through the stop fills at the bar's
open), stop first when a bar reaches both, flat at the end of day.

That logic is the simulated-broker module
(`scripts/lib/backtest/sim-broker.js`, tested on its own, driven bar by bar
by the engine and, later, the replay). New work: it has no resting limit or
stop entry orders yet; replay needs them added. Until then the teacher is
limited to market entries.

### Leakage: the model may remember the market

The model has read about the markets in its training data. With real dates
and prices it may recall what happened next, and the labels would look
excellent on history and fail live. Two defences, the first one decisive:

1. **Time.** The selection and out-of-sample windows start after the
   teacher model's knowledge cutoff. Only the train window lies inside it,
   and only training (not any decision about the trader) uses it.
2. **Anonymization**, for the train window:
   - no calendar dates or years; the time of day (ET), the session, and the
     weekday stay;
   - one price offset per replayed day, applied to the whole lookback (daily
     and 4-hour bars, prior-day levels, the prior profile) so levels don't
     jump between days; a whole number of 100 points so round numbers stay
     round and prices stay on the 0.25 tick; drawn across the instrument's
     whole historical range, so the price level says nothing about the year;
     shifted back for the gate and the fills;
   - no headlines; news windows only as "a high-impact release at 08:30";
   - the symbol kept (strategies are per instrument).

   Volatility in points (ATR, the day's range) is kept: the strategies use
   it. It hints at the era, which is why time, not anonymization, guards the
   evaluation windows.

**Leakage tests**, before any label run:

- **Cutoff gap:** the teacher on the train window (before its cutoff) and
  the select window (after) with the same prompt. A large drop after the
  cutoff, beyond what the market explains, means it recalls.
- **Placebo:** the same decisions scored against another day's continuation
  spliced on. A trader that does better on the true continuation than the
  placebo, beyond chance, on bars it can't have seen, has an edge; one that
  only does better before its cutoff recalls.
- **Date canary:** from the anonymized prompt, the model names the year and
  the month, on at least 200 sampled bars; it must not beat chance (1 in the
  number of years in the window, 1 in 12).

### Windows

The RL pipeline's three windows, never overlapping: train, select, out of
sample.

- **Train** (may lie before the cutoff): the student's labels, and all
  prompt and anonymizer iteration, including the one-month trial and the
  fidelity sample.
- **Select** (after the cutoff): the go/no-go for stage 2 (does the teacher
  beat the rules baseline and the current policy?), and choosing among
  students.
- **Out of sample** (after the cutoff, after select): looked at once, after
  the student exists, to validate it under the promotion gate. Replaying it
  is allowed once per frozen prompt version and teacher model; each look is
  logged in `<FTH_HOME>/rl/oos_looks.jsonl` under its own key (the teacher
  model and the prompt version, next to the policy looks keyed by strategy,
  window, and data).

### Nondeterminism

The teacher is called with a fixed temperature (and a seed where the API has
one); every decision records the model id and settings. Its results on the
select window are repeated on a sample of days to report their spread: a
single replay is one draw of a stochastic trader.

### Store

`<worker home>/replay/<run>/<path>/<day>.jsonl`, one line per decision: the
symbol, the anonymized prompt's hash, the point-in-time features (stage 2's
observation), the decision, the gate's verdict, the fill, and the trade's
outcome, plus the model id, its settings, and the prompt version. Runs
resume by day within a path. A changed prompt or model is a new run, never
mixed into an old one.

### Report

Month by month, on the select window (and once on out of sample), next to
the rules-only baseline and the current policy: trades, win rate, mean R,
pass and blow rates over combine attempts from every start day, the real
gate refusals, and how often the trader stood aside. Which reason tags carry
the edge, and the spread across repeated runs.

### Cost

Per decision:

- the fixed part, read from the cache: `workspace/AGENTS.md` (about 17.6k
  characters), the 14 trading skills (about 80k), and the strategies'
  documents (about 79k) come to about 177k characters, roughly 44k tokens;
- a point-in-time part of about 4–8k tokens;
- an answer of about 0.5–1k tokens.

| Scope | Decisions a year (3-minute bars, ~250 days) |
|---|---|
| The whole session (18:00–15:50 ET) | ~110,000 |
| The New York session (09:30–16:00 ET) | ~32,500 |
| New York, a decision every other bar | ~16,000 |

The cost is decisions × (fixed tokens × cache-read price + point-in-time
tokens × input price + answer tokens × output price), at the prices current
when the run is planned. The replay CLI prints the estimate and asks before
it spends; a budget cap stops a run cleanly. Batch requests and a cheaper
teacher lower it further; the fidelity sample measures how much a cheaper
teacher agrees with the strongest.

### Multiple markets

The runner trades several symbols, one cycle per symbol, and the gate's
exposure and correlation checks read every position. The prop policy now
trades NQ, ES, YM, and RTY on one combine, one position at a time across
them (`docs/RL-DESIGN.md`, Markets). Replay keeps that: one account path
holds every market on one timeline, a market waits while another's trade is
open or filling in a prop attempt, and the store records the market on each
decision. One price offset per index family per day (NQ with MNQ, ES with
MES); offsets only shift levels, so each market's moves, and how the indices
move together, are unchanged. The first runs use one market.

## Stage 2: the student policy

### Observation

Everything the compact prompt carries, as numbers, scaled to the account and
to the market's ATR as the current observation is (so one policy reads every
market): the current RL observation (account, trade state, timeframes,
confluence, VWAP, value area)
widened with every strategy's signal as an input (not a gate), structure and
liquidity levels as distances in ATR, the day context (opening type, IB, day
type, ADR used), the session and time to the close, news windows, and the
recent decisions. Where the student can't match the teacher, the observation
is missing what the teacher used; the per-reason agreement says which.

### Actions

Flat: `none` / `long` / `short` at the market, with a stop from a few ATR
multiples and a size from the account's budget; in a trade: `hold` /
`tighten` / `exit`. Masked as the current env masks (no entry outside the
sessions, no size over the budget).

Each label is mapped to the nearest student action (the stop to the nearest
ATR multiple, the size to the budget's step). Labels the student can't
express (limit or stop entries, targets) are kept out of cloning and
counted; the report gives the coverage. Limit and stop entries join the
student's actions once the simulated broker has them.

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

- Logic in `scripts/lib/replay/` (prompt builder, anonymizer, decision
  schema and validator, gate serving, store, report) and the extracted
  simulated broker in `scripts/lib/backtest/`, with unit tests in
  `tests/lib/`; thin CLIs (`scripts/replay.js`, `scripts/replay-report.js`)
  under 200 lines.
- The model is called through one small module with no dependencies (Node's
  `fetch`), configured by environment; keys never committed.
- The fixed part of the prompt is the skills and strategies themselves, read
  from the canonical tree, so a change to them is a new prompt version.
- Stage 2 lives in `rl/fth_rl` (cloning, the widened env) and
  `scripts/lib/rl/` (observation, env server), with tests in both.
- A `policy-training` skill section and a new `replay` skill tell agents how
  to run and read it; `node scripts/sync-harness.js` syncs them.
- E2E: a replay of a few days on the parity bars with a stub model, through
  the gate and the fills, in an isolated home.

## Plan

1. The simulated-broker module, extracted from the engine (no behaviour
   change; the backtests and parity must not move).
2. Isolation, the compact prompt, the anonymizer, and the gate serving, on
   a stub model.
3. Leakage tests (no label run until they pass).
4. Baseline parity on the train window: given only the rules' setups, does
   the teacher at least match the rules baseline? A cheap early check before
   the full spend.
5. One month of compact replay in the train window, the New York session,
   with the report; the fidelity sample on a few of its days.
6. The label run on the train window and the replay of the select window,
   within the budget. **Decision point**, on the select window only: build
   stage 2 if the reasoning trader beats the rules baseline and the current
   policy there.
7. Stage 2: widened observation and env, cloning, fine-tuning, the pipeline;
   then the one out-of-sample look.

## Open questions for the owner

- The teacher model, its knowledge cutoff, and the budget per run.
- The data years for the windows: the select and out-of-sample windows must
  start after the teacher's cutoff, so they may need recent data.
- The sessions to replay (the New York session only, or the whole session).
- Plain account or a prop attempt as the replay's account.
- Whether the student, once validated, trades live on its own or only
  advises the reasoning model.
