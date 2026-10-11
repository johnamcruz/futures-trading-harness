# Reasoning trader: replay, labels, and a policy that learns from it

Status: design, not built. Owner review before any code.

## The problem

The harness's trader is the reasoning model. Each cycle it reads everything
the skills and strategies give it (the rules strategies and the manual ones,
market structure, liquidity, VWAP and the volume profile, the timeframes, the
day so far, sessions, news windows, the account) and decides: no trade, long
or short with a stop, target and size, or, in a trade, hold, tighten, or exit.
It is not tied to one setup.

Nothing trains on that judgment today:

- The backtester (`scripts/lib/backtest/engine.js`) runs only rules
  strategies; it skips manual ones ("manual strategies need the LLM").
- The RL policy (`docs/RL-DESIGN.md`) learns from the rules' setups and the
  simulated outcomes. Its observation (`scripts/lib/rl/observation.js`) is
  built around a setup, and its actions are skip, half, or full at a rules
  setup, then hold or close past the ratchet
  (`scripts/lib/rl/challenge-env.js`). It never sees the reasoning model, so
  it can't learn how it trades, and live the model is reduced to placing the
  policy's verdict.

So the strongest part of the harness, the reasoning, is never measured over
history and never taught to anything.

## The idea

Two stages, each useful on its own.

1. **Replay: the reasoning trader backtested.** Run the reasoning model over
   historical data, cycle by cycle, as it trades live, with point-in-time data
   only. Its orders go through the order gate and fill in a simulated broker
   on the real bars. Every decision is recorded with what it saw and what
   followed. The result answers the first question: does the reasoning trader
   have an edge out of sample? And it produces the labels.
2. **Student: a policy that trades as the reasoning model does.** A policy
   with the reasoning model's own action space and an observation that
   carries what the skills read, trained first to imitate the recorded
   decisions (behaviour cloning), then fine-tuned with RL on the challenge
   (pass rate, zero blows) while held close to the teacher. Live, it is fast,
   deterministic, and validated by the same promotion gate.

Stage 2 is built only if stage 1 shows an edge: cloning a trader with none
adds nothing.

## Stage 1: replay

### Decision points

A decision at every closed bar of the sessions under study, as the runner's
`trigger: bar` does live, not only at rules setups. A cycle is a decision
whether flat (enter or not, and how) or in a trade (hold, tighten, exit).
Days are independent: the harness is flat overnight, so each trading day (the
18:00 ET open to the 16:00 ET close) replays on its own and days run in
parallel. Holidays are skipped; early closes end at 13:00 ET.

### The decision prompt

Live, the agent loads the skills and calls tools (bars, the market snapshot,
the scan, the journal, the broker) each cycle. Replay can't call live tools,
and tool results from today would leak the future. Two modes:

- **Compact (the label run).** One call per decision. The prompt is a fixed
  part (the trading skills and rules, the same text the live agent loads) and
  a point-in-time part built by code from the data up to the bar: the last
  bars on each timeframe, `market-snapshot.js` (levels, VWAP, volatility,
  structure, participation), `mtf.js` (the trend rule), every strategy's scan
  (rules results and manual strategies' context), `day-context.js`,
  `volume-profile.js`, the session, the account and open trade
  (`open-trades.js`), and the trader's own recent decisions. The answer is a
  structured decision (below). The fixed part is cached, so each call pays
  for it at the cache-read rate.
- **Full (a fidelity check).** On a small sample of days, run the real
  harness CLI headless, cycle by cycle, with every tool served from the
  point-in-time data. Agreement between full and compact on the same bars
  measures how much compact loses. If agreement is low, the compact prompt
  is missing something the agent uses, and the gap says what.

### The decision

The same action space as live, structured so it can be checked and learned:

- flat: `none`, or `long` / `short` with an order type (market, limit,
  stop), a stop (price, and its distance in ticks and in ATR), an optional
  target, a size (contracts, micro or mini), and the strategy or setup it
  trades (`setup:<name>`, or a manual strategy);
- in a trade: `hold`, `tighten <stop>`, or `exit`;
- `reasons`: short tags for what drove it (for example `trend-aligned`,
  `swept-liquidity`, `vwap-reclaim`, `value-area-edge`, `news-window`), from
  a fixed list kept with the skills, plus one sentence.

Each decision goes through the real order gate (`check-order.js` and the
account checks) as live; a refused order is recorded with the gate's
reasons, and the trader does not get to place it. The replay writes the
records the gate reads (the multi-timeframe read, the strategies' signals,
the plan in the journal) from the point-in-time data, as the runner does
live, so the gate judges each order as it would have then.

### Fills

The backtester's broker logic (`engine.js`), so replay, RL training, and
backtests share one fill model: market entries at the next bar's open with
at least one tick of slippage, stops at the price reached (a gap fills
worse), limits at their price, brackets as OCO, end of day flat.

### Leakage: the model may remember the market

The model has read about 2021–2025 markets. With real dates and prices in
the prompt it may recall what happened next, and the labels would look
excellent on history and fail live. The prompt is anonymized:

- no calendar dates or years; the time of day (ET), the weekday, the session,
  and "days since" stay (they carry information the trader legitimately
  uses);
- prices shifted by a per-day offset, a whole number of 100 points, so round
  numbers stay round and ticks stay on the 0.25 tick; levels and stops are
  shifted the same way and shifted back for the gate and the fills;
- no headlines; news windows only as "a high-impact release at 08:30" from
  the calendar;
- the symbol kept (the strategies are per instrument).

A **leakage test** runs before any label run: on a set of known large-move
days, the same bars with real and anonymized prompts. Decisions that do
better with real dates than anonymized ones mean the model recalls, and the
anonymization isn't enough. A second canary asks the model, from the
anonymized prompt, which date it is; it must not do better than chance.

### Out of sample

The same windows as the RL pipeline (train, select, out of sample, never
overlapping). Labels from the train window train the student; the select
window chooses among students; the out-of-sample window is replayed once,
to evaluate, and never tuned on. Each look at it is logged, as
`<FTH_HOME>/rl/oos_looks.jsonl` already does for policies.

### Store

`<FTH_HOME>/replay/<run>/<day>.jsonl`: one line per decision with the
anonymized prompt's hash, the point-in-time features (stage 2's
observation), the decision, the gate's verdict, the fill, and the trade's
outcome, plus the model id, its settings, and the prompt version. Runs
resume by day and skip decisions already recorded for the same prompt hash
and model. A changed prompt or model is a new run, never mixed into an old
one.

### Report

Month by month, out of sample, next to the rules-only baseline and the
current policy: trades, win rate, mean R, pass and blow rates over combine
attempts from every start day, the gate refusals, and how often the trader
stood aside. A short section on the reasons: which tags carry the edge.

### Cost

Per decision: the fixed part (the trading skills, rules, and workspace
instructions, about 80k characters, roughly 20k tokens) read from the cache,
a point-in-time part of about 4–8k tokens, and an answer of about
0.5–1k tokens.

| Scope | Decisions a year (3-minute bars, ~250 days) |
|---|---|
| The whole session (18:00–15:50 ET) | ~110,000 |
| The New York session (09:30–16:00 ET) | ~32,500 |
| New York, a decision every other bar | ~16,000 |

The cost is decisions × (fixed tokens × cache-read price + point-in-time
tokens × input price + answer tokens × output price), at the prices current
when the run is planned (the replay CLI prints the estimate and asks before
it spends). Batch requests and a cheaper teacher model lower it further; the
fidelity sample measures how much a cheaper teacher agrees with the
strongest. A budget cap stops a run cleanly when reached.

## Stage 2: the student policy

### Observation

Everything the compact prompt carries, as numbers: the current RL
observation (account, trade state, timeframes, confluence, VWAP, value area)
widened with every strategy's signal as an input (not a gate), structure and
liquidity levels as distances in ATR, the day context (opening type, IB,
day type, ADR used), the session and time to the close, news windows, and
the trader's recent decisions. Where the student can't match the teacher,
the observation is missing what the teacher used; the per-reason agreement
says which.

### Actions

The teacher's: flat, `none` / `long` / `short` with a stop from a few ATR
multiples and a size from the account's budget; in a trade, `hold` /
`tighten` / `exit`. Masked as the current env masks (no entry outside the
sessions, no size over the budget).

### Training

1. **Behaviour cloning** on the train window's labels: the policy learns to
   predict the teacher's decision from the observation.
2. **RL fine-tuning** in the challenge env (the existing reward: pass,
   speed, blow, timeout, dense, win, loss) starting from the cloned policy, held close to the
   teacher (a penalty on drifting from its decisions that shrinks over
   training), so it keeps the reasoning and tunes it for the challenge.
3. The existing pipeline (sweep, retrain, ship) and promotion gate: zero
   blows in every out-of-sample month, a pass rate of at least 40%. Never
   lowered.

The current challenge env's action space (skip, half, full; hold, close)
becomes a mode of the new env, so today's policies still train and load.

### Live

The student decides each cycle as the reasoning model would; the reasoning
model reviews, journals, and can stand aside for what the student can't see
(a live headline). Every stand-aside is logged and counted against the
student's validation, as in the replay.

## Where it fits (ECC)

- Logic in `scripts/lib/replay/` (prompt builder, anonymizer, decision
  schema and validator, store, report) with unit tests in `tests/lib/`;
  thin CLIs (`scripts/replay.js`, `scripts/replay-report.js`) under 200
  lines.
- The model is called through one small module with no dependencies (Node's
  `fetch`), configured by environment; keys never committed.
- The decision prompt's fixed part is the skills themselves, read from the
  canonical tree, so a skill change is a new prompt version.
- Stage 2 lives in `rl/fth_rl` (cloning, the widened env) and
  `scripts/lib/rl/` (observation, env server), with tests in both.
- A `policy-training` skill section and a new `replay` skill tell agents how
  to run and read it; `node scripts/sync-harness.js` syncs them.
- E2E: a replay of a few days on the parity bars with a stub model, through
  the gate and the fills.

## Plan

1. Leakage test and the anonymizer (no labels until it passes).
2. Compact replay on one month, the New York session, with the report.
3. Fidelity sample (full vs compact) on a few days of that month.
4. The full label run on the train, select, and out-of-sample windows,
   within the budget, and the report. **Decision point:** build stage 2 only
   if the reasoning trader beats the rules baseline and the current policy
   out of sample.
5. Stage 2: widened observation and env, cloning, fine-tuning, the pipeline.

## Open questions for the owner

- The teacher model, and the budget per run.
- The sessions to replay (the New York session only, or the whole session).
- The data years for the windows.
- Plain account or a prop attempt as the replay's account.
- Whether the student, once validated, trades live on its own or only
  advises the reasoning model.
