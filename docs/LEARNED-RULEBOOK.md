# Learned policy: requirements

Status: **proposed, for design review**. Nothing here is built. It replaces
the trained PPO policy, retired in PR #70 (section 9).

The learned policy is **the agent's design**: its skills, prompts, roles,
strategies, and the rulebook of numbers they trade with. **Training means
improving that design** in a gated loop (section 7a). The approach follows
the self-improving LLM agent work of Stanford CS329A (generate, verify, keep
what passes): the system improves its own agent design, and an automated
verifier decides what is kept.

## 1. Goal

Pass a prop combine **before the next renewal fee is charged, and the
faster the better, without ever blowing the account**. (Trading the funded
account is out of scope for this design; section 11.)

- **The attempt length** is the billing period: about 21 trading sessions
  for a monthly cycle (`sessions` in `ACCOUNT.md`, today 30, set to match).
- **Consistency** means 40-50% of attempts pass within it, and **no attempt
  blows the account: zero, with no exception**, in the search and in every
  out-of-sample month.
- **Speed** is the tie-break: among settings that pass as often, the one
  with the fewest days to pass. The firm's consistency rule (best day at
  most 50% of the profit) and any minimum number of trading days set the
  floor on speed.
- The edge comes from the **reasoning model (the LLM) trading with the
  skills and strategies**. What is learned is the configuration those skills
  and strategies run with. It is learned from the history we have, and it is
  checked again as new data arrives.

## 2. The idea in one paragraph

The policy is the agent's design: the skills, prompts and roles that teach
the LLM to trade, the strategies, and a **rulebook**: a small set of numbers
and context rules in one place. The runner and the order gate enforce the parts that can be
computed from facts, and the skills teach the rest to the LLM. The
backtester runs the rulebook mechanically. A search over the rulebook's
parameters, scored by Monte Carlo combine attempts on five years of bars,
picks the configuration that passes most often without blowing. Each
skill's claims about the market are tested on the same data, and the ones
that hold set the rulebook's numbers. Replays measure whether the LLM
follows the rulebook, and that measurement feeds back into the estimate of
the pass rate the LLM will get. Training is a loop (section 7a): replays
produce a scorecard; an LLM proposes edits to the skills, prompts, roles or
rules, and Optuna tunes the numbers; Monte Carlo and replays verify them;
the champion is replaced only with the owner's approval.

## 3. What the rulebook contains

| Group | Examples (today's source) | Learned how |
| --- | --- | --- |
| Pacing | risk per trade as a fraction of the cushion, the cap, the drawdown halving point, `min_size_guard` (`prop_portfolio` `sizing`, `combine.js` `DEFAULT_SIZING`); the soft daily stop (`daily_loss_soft` in `ACCOUNT.md`); stop-for-the-day rules near the target or under the consistency rule (`prop-challenge-pacing` skill) | Monte Carlo search (section 5) |
| Selection | which strategies are enabled per market; size multipliers per strategy and context (e.g. keltner in a `mixed` read: half) | Calibration (section 6), then the search |
| Priority order | the judgment calls in the `strategy-library` priority order: whether a mixed read halves the size or skips the setup, how much room is enough, which secondary context halves | Calibration, then the search |
| Strategy parameters | stops, targets, filters (e.g. ORB's ADX gate, keltner's ADX ≥ 20), per market where they differ | Calibration |
| Exits | `prop_portfolio` `exit` (hold to +2R, trail 0.5R) | The search, jointly with sizing (R10) |
| Stand-down | stop entries when the cushion to the floor falls below an amount (headroom) | The search |

**Units.**

- Dollar limits are **fractions of the account's max loss limit (MLL)**.
  That depends on the dynamic-account change, which is planned separately.
- Stops, room and distances are in **ATR units**, so rules carry across
  volatility regimes. NQ's median 1-minute RTH true range was 6.5 points in
  2021 and 15.25 in 2026.
- Contracts are whole numbers, so a rulebook learned in one contract does
  not carry over to another. Each account size has its own rulebook, searched
  in the contract that account trades.

**R1. One place.** Every learned value lives in one canonical document per
account size (a proposed `rulebooks/<account>/RULEBOOK.md`: frontmatter
holds the numbers, the body explains them). The runner, the gate, the
skills, the strategies and the backtester read it; none restates a value.
The skills keep the reasoning and point to the rulebook for numbers, as they
point to the priority order today. A test fails if a learned value is
restated elsewhere. This rule already holds for the priority order (PR #65).

**R2. Small.** At most about 30 searched parameters per account. Every rule
needs a measured reason to exist. A context rule is added only when it
passes calibration (section 6).

**R3. Readable.** Each value carries, in the body, the evidence that set it:
its training-window effect, its stability across years, and the date it was
learned.

**R4. Enforced or taught.** Every rulebook item is classified as one of two
kinds:

- **Enforced:** computable from facts the runner already has (the
  multi-timeframe read, the room, the confluence, the regime, the account
  state). The runner folds these items into the verdict's ceiling, and the
  gate holds the order to that ceiling. The LLM can only lower the size,
  never raise it.
- **Taught:** a judgment the skills teach.

The verdict carries a size multiplier for the enforced items. Gates fail
closed:

- A missing or stale fact (e.g. a 4-hour read with too few bars) sets that
  item's multiplier to 0, so the setup is skipped. This has gate and wiring
  tests.
- The gate refuses any verdict action other than `full` or `skip`.

The owner's classification is in section 11: the mechanical items enforced, judgment taught.

## 4. Data and splits

- **Bars:** 1-minute NQ, ES, YM and RTY, from 2021-04 to 2026-07-20 (each
  backtest config names its files); 3-minute and 15-minute bars are derived
  from them. Order flow: NQ trades and quotes, 2020-12 to 2025-11.
  The bars are **back-adjusted**, so price levels in early years are not the
  prices traded then. Any rule or base rate that depends on price level
  (percent of price, round numbers) uses unadjusted data or is excluded.
  Dollar and tick risk are unaffected.
- **Every month has a defined role**, set in advance, and the newest data
  goes to validation and testing. **Every attempt starts and ends inside one
  block of one role** (a split, or a half-year block), and each block is
  scored on its own. Half-year blocks hold about 126 sessions, at least
  twice an attempt:

| Split | Range | Use |
| --- | --- | --- |
| Train | 2021-04 to 2023-06 | calibration and the search |
| Select | 2023-07 to 2024-06 | choosing among candidates |
| Out-of-sample | 2024-07 to 2025-06 | the promotion gate, under a look budget (R16) |
| Recent | 2025-07 to 2026-06 | reserved: the next out-of-sample window once the current one is retired (R16). Nothing looks at it before then, except the June 1-5, 2026 LLM replay, which is recorded in the ledger and yields no candidate claims (R22). |
| New months | 2026-07 on | by half-year, alternately: 2026-H2 for walk-forward checks (R17), 2027-H1 into the reserve for a later out-of-sample window (R16), and so on. Never both. |
| LLM | 2026-06 on (after the model's cutoff), any month | the LLM's replays and adherence. These months come after the model's training cutoff, so it cannot remember them. Measuring the LLM chooses no rulebook, so it doesn't use up a month's mechanical role. |
| Live | every live session, as it is traded | the runner's own record of live trading (`source: live` in each session's manifest, below), scored by the same scorecard as a replay. Its own split: never pooled with replay decisions, and it chooses no rulebook. |

**Live sessions are recorded as replays are.** The runner records every
decision of a live session in a replay's layout (`<FTH_HOME>/sessions/<trading
day>/`: the manifest, one line per decision point, the runner config, the
broker's journal for the day, and the day's fills on its end-of-day line), so
`replay.js scorecard` and `replay.js labels` read a live session as they read
a replay run. Each manifest says its `source` (`live` or `replay`) and the
versions of the agent that made its decisions (R33). Live decision points are replay's (`replay/schedule.js`): premarket, end of
day (then `eod-retry` until verified flat), and every closed bar whose time is
one of replay's trade times (inside the runner's sessions, before end of
day), with or without a cycle. What still differs from a replay:

- A live line is written only for a bar the runner polled: with the kill
  switch on the runner polls none unless it keeps housekeeping (an account,
  not paper mode, the day already traded), and a bar not published in time is
  resynced, so neither is a line; a replay records both times.
- A bar that closed too long ago to start a cycle (a slow previous cycle) is a
  line with no cycle, marked `stale`; a replay's bars are never stale.
- A live line's time is when the pass ran (the close, the poll delay and the
  poll); a replay's is the close plus the poll delay. Its `step` is always
  `{ code: 0, timedOut: false }`, and live takes every bar (no `everyNthBar`).
- Fills are read once, at end of day once verified flat (a replay reads them
  at every decision time); until they are known the session isn't finished,
  and the runner retries the read only while idle (flat, its end of day done
  or the market closed, one day at a time).
- The lines' refusals come from the gate log in force (`FTH_GATE_LOG`), the
  labels read the harness home's `logs/gate-log.jsonl`.
- A restart on another config, harness or model is a new version of the same
  session (a replay refuses it): its runner config is kept beside the first
  (`autotrader-<since>.json`, named by its `versions` entry), and the labels
  and the scorecard read each line with the config in force at its time
  (timeframe, paper mode, symbols).

**R5. No double-dipping.**

- Calibration runs inside folds of train: claims are measured on one fold
  and the search is scored on another, so the same months don't both choose
  a rule and score it. The folds are **interleaved by month** (alternating
  months), with at least a day's gap so no trade falls in both, so each
  fold covers every year of train.
- Select chooses among candidates. Out-of-sample decides promotion.
- A candidate that fails out-of-sample is not re-tuned against it.

## 5. The search: Monte Carlo combine attempts

**R6. Evaluator, in two layers.**

1. **Trade generation (slow, deterministic).** For each set of strategy
   parameters, the backtester runs the strategies over the bars once.
   - It records each setup's facts: the multi-timeframe read, the room, the
     confluence and the regime. They are computed by **the functions live
     uses** (the multi-timeframe read in `harness-tools/mtf.js`, the room in
     the briefing, the confluence in the scan), never by a copy, so
     training can't drift from live. The engine computes none of them today.
   - It records each setup's outcome: R, the adverse excursion in R, and its
     order within the day.
   - It is the harness's own code, the same code live uses: the strategies'
     evaluator, fills, fees, slippage and the trailing exit.
   - **Entries fill after the model's cycle delay**, not at the next bar's
     open. The delay is drawn from the cycle times measured in replays (a
     conservative percentile by default). That is the price live gets.
2. **Attempt simulation (fast).** From those trades, the simulator applies
   the rulebook and runs combine attempts:
   - the priority order's steps, computed from the recorded facts;
   - the pacing;
   - the sizing, using `combine.js`;
   - the account's rules, using the prop rules in `prop-state.js`.

   Pacing trials re-run only this layer. Strategy-parameter trials re-run
   both.

**R7. Attempts and effective sample size.** An attempt runs from a start day
for at most `sessions` sessions under the account's rules:

- the trailing end-of-day floor;
- the firm's daily loss limit, which stops the day, not the attempt;
- the target;
- the consistency rule (best day at most 50% of the profit).

Outcomes are pass, blow or timeout, plus days to pass.

Attempts that start on neighbouring days share almost all their sessions,
so every report states the **effective sample size** (non-overlapping
attempts). For scale, at `sessions` = 21: the 12 out-of-sample months hold
about 12 independent attempts, and train about 26 (8 and 18 at 30 sessions).

A candidate is scored in two ways:

- **on every distinct start day** in the window: the real paths;
- **on resampled paths** (R9): the spread.

**R8. Objective.** Maximize the **lower confidence bound** (90%) of
P(pass within `sessions`), subject to **zero blows** over every attempt
scored (the real start days and the resampled paths), with the median days
to pass as the tie-break. A candidate with a single blow is rejected. The
objective scores the bound, not the point estimate, because the effective
sample is small. Zero blows over thousands of resampled paths may force
pacing too timid to pass within `sessions`; if no candidate meets both, the
search reports that trade-off for the owner, and nothing is relaxed on its
own.

**R9. Robustness.**

- Paths are resampled by a **stationary block bootstrap over trading days**
  (mean block of 5-10 days, with regime-matched blocks), so losing streaks
  and volatility clusters stay together. Bars are never resampled: the
  strategies' indicators span days.
- Each candidate is also scored with the per-trade expectancy cut by 25% and
  by 50%.
- **What a blow is, in the simulation.** The sizing is meant never to let a
  full stop reach the floor or the daily limit (`combine.js` `room`), so a
  blow comes only from a fill further past the stop than its expected
  slippage or a stop that wasn't working. `contractPlan`'s risk per contract counts the stop's expected
  slippage (`sizing.stop_slippage_ticks`, a tick by default, the
  backtester's fill slippage) as well as fees, so a size set by the room
  (not the budget) never ends a tick past the floor or the daily limit. The
  bootstrap therefore resamples the stop overshoots actually observed in the
  history (gaps and fast markets included, by contract), never a fixed tick,
  and injects faults at measured rates: a stop placed late, missing or
  refused, a runner outage. Zero blows means zero under those, so the
  constraint catches what really blows accounts.
- The chosen candidate sits in a flat region of the scores, not on a lone
  peak.

**R10. Search method: Optuna** (decided). Exits, sizing and the headroom
stand-down are searched **jointly**, with wide exit ranges. A sister
project's search found that single-lever searches failed: a 2R/0.5R trail
capped the large winners a low-win-rate strategy needs, and only a joint
search over sizing, exit and stand-down reached 0% blows at a 41.7% pass rate
(60 overlapping 30-day episodes on 2024, about 8 independent; another
strategy and data). That is a reason to search exits widely, not evidence
for any setting. Today's `prop_portfolio` exit (2R/0.5R) is one candidate.
The trail's range is bounded by the target and the consistency rule: one
winner of several thousand dollars against a $6,000 target makes that day
more than half the profit, which forces more profit before a pass, so days
to pass (the tie-break) prices a wide trail's cost.

- Bayesian optimization (TPE), with a fixed seed and `n_jobs=1` so results
  reproduce.
- Optuna runs offline in Python. It calls the JavaScript evaluator, a Node
  CLI under 200 lines with its logic in `scripts/lib/`, once per trial. The
  evaluator stays the harness's own code, and each trial records the git
  commit it ran on.
- The Python package (proposed: `research/`) has its own tests, run by CI
  and by `npm run verify`.
- Nothing at runtime needs Python.

## 6. Calibration: every skill claim tested on the data

**R11. Claim registry, written before measuring.** Each skill and strategy's
testable claims are listed with the rule that encodes them and the test that
will judge them, before any measurement. Examples:

- the multi-timeframe read's sizing in the priority order (step 4 of
  `strategy-library`);
- "a reversal only at a higher-timeframe level, nearest target";
- "skip when room < the setup's R";
- "lunch-window setups are weaker";
- each strategy's skip rules and filters.

**R12. Measurement.** Within the calibration fold, on NQ first, each claim
is measured: the expectancy in R, the win rate and the drawdown with and
against it.

- p-values come from a bootstrap clustered by day.
- Benjamini-Hochberg controls the false-discovery rate across the whole
  registry.
- A claim must also show the same sign of effect in every year (and in
  every market, once other markets are calibrated).

**R13. Verdicts.** Each claim is confirmed (kept, its number set), weakened
(e.g. skip becomes half), or dropped. A strategy with no edge on a market
after calibration is turned off for that market. The outcome is a
calibration report per skill, and changes to that skill's text and its
rulebook values.

**R14. Base rates as facts.** History supplies the briefing with base rates
the LLM can read. Examples: today's range percentile for this hour, how
often the opening range breaks, and the past expectancy of setups like this
one in this context. They are facts, never grades or vetoes (the briefing
rule). Each base rate is computed only from data before the bar it
describes, and none depends on back-adjusted price levels.

## 7. Promotion and the learning loop

**R15. Gate.** A rulebook is promoted only if out-of-sample shows all of
these:

- zero blows in every month;
- a pass rate of at least 40% (target 40-50%);
- at least 20 attempts over at least 2 months;
- a block-bootstrap lower bound on the pass rate (blocks of at least
  `sessions`), at 90% confidence; blows stay at zero.

The first three are the promotion gate's numbers, frozen in code since
PR #70 (`scripts/lib/prop/promotion.js`, with a test that they may only rise).
**They never live in the learnable rulebook**, so no proposed diff can lower
them. The split windows are in `scripts/lib/prop/splits.js` (train from
2021-01-01, where the bars begin 2021-04-25; select; out-of-sample), with a
test that out-of-sample never overlaps train or select and never moves
backward. **R32** adds Recent, the half-year walk-forward and reserve roles,
and each walk-forward half-year's tuning and held-out quarters to that module,
with tests; a window changes only when one is retired through the ledger
(R16).

**R32. The schedule in code.** `splits.js` encodes every role of section 4
(Recent, the half-year walk-forward and reserve blocks, the tuning and
held-out quarters), so "set in advance" is enforced, with tests that no two
roles overlap and none moves backward.

Zero blows in every month mostly tests the worst one or two weeks in the
window (in this window: August 2024 and April 2025). The bounds exist
because about 12 independent attempts can't separate a 25% rulebook from a
40% one.

**R16. Look budget.** Every out-of-sample evaluation is logged in a ledger:
the candidate, the date and the result. The ledger is kept with the
rulebook's evidence. A window is retired after a set number of looks
(3, the owner's decision), and the reserve (Recent first, then the reserved
half-years) becomes the next out-of-sample window. Reserved half-years
accumulate until they hold at least 12 months (about 12 independent
21-session attempts, as the current window does) before they become one. Because they
alternate with walk-forward half-years, the window after Recent is ready
only in mid-2028 (2027-H1 and 2028-H1). The look budget has to last until
then. Select-window rankings use a lower-bound score, not the best score,
so many trials don't select by luck.

**R17. Walk-forward re-learning.** Periodically (monthly, or on demand), new
bars and replay or live results are added, and calibration and the search
run again on rolling windows. A walk-forward check uses only months that
arrived after the last promotion, in the half-years assigned to
walk-forward (section 4). Those looks are counted in the same ledger and
look budget (held-out looks only, below), and those months never become a later out-of-sample window;
the reserved half-years do. **Each walk-forward half-year is split in two**
contiguous quarters (about 63 sessions each, at least twice an attempt, so
each holds mechanical attempts): its **tuning** quarter feeds the
scorecards the proposer reads and the Optuna trials (R25, R30), and those
looks are logged without a budget; its **held-out** quarter is used only by the
verifiers (R26), is never shown to the proposer or Optuna, and only those
looks count against the 3-look budget. One half-year holds only about 6
independent 21-session attempts, so a single walk-forward block is weak evidence: blocks are
pooled before a check can fail or confirm a rulebook. The result is a **proposed rulebook diff** with its gate
result, its ledger entry and its evidence. The diff is adopted only with the owner's
approval; nothing changes the rulebook on its own.

**R18. Versioned.** Each promoted rulebook is versioned and carries its
gate result. Live runs record the version they traded. Rolling back means
selecting the previous version.

## 7a. The training loop: improving the agent's design

### The LLM-native design: six mechanisms, two timescales

Stanford CS329A (self-improving AI agents) teaches the ways an LLM agent
improves through interaction with itself and its environment. Our system is
an LLM agent (the model trading through skills, roles and tools), so they
apply directly:

| # | Mechanism (the course's sources) | What it means here | Requirements |
|---|---|---|---|
| 1 | **Improve the agent's design**: skills, prompts, roles (ADAS, AlphaEvolve, the AI Scientist) | The agent's "program" is its skills, strategies and rulebook. An LLM proposes small diffs ("add a room check before the trend reason", "say the opening drive allows entries", "skip keltner in mixed reads"); replays and the backtest score them; an edit is kept only under the promotion rule (R25): no significant loss on any verifier, a significant gain on what it targets, zero blows; a diverse archive of versions is kept, not just the latest. **This is the training process.** The fixes made by hand so far (the phase-1 confirmation, the trend rule's side, the opening window) are this loop run manually. | R24-R28, R30 |
| 2 | **Learn from verified successes** (STaR, RLEF, scaling RL) | Decisions that matched the rulebook and the facts (selected by adherence, never by outcome) become training examples for a small adapter on the local model: the model learns to trade from its own verified decisions. A model-specific training artifact, never code in the harness; gated on months it never trained on. | R31 |
| 3 | **More thought on the hard decisions** (test-time compute: Large Language Monkeys, Archon) | Ask the take-or-skip decision on a verdict several times and act only when the answers agree, or let a checker pick among them. The most direct lever on a small model's misreads; it costs model time, so verdict decisions only. | R29 |
| 4 | **Verify before acting** (robust verification, Constitutional AI, step-level verifiers) | Deterministic checks first (the order gate). Then every reason the model states is checked against the briefing's facts ("opening window until 10:00" fails: the briefing says entries are allowed after 09:35). Each step of the priority order is checked on its own, not only the final call. | R29 |
| 5 | **Environment feedback in the loop** (ReAct; Search-o1, MemGPT for memory) | The harness already reasons, calls tools and updates on results. Trade outcomes and gate refusals become journal lessons, retrieved when relevant or when the model is uncertain, not added to every prompt. | R29 |
| 6 | **Evaluate over long horizons** (agentic evaluations, METR) | Reliability over whole attempts (about 21 sessions), with a failure taxonomy: wrong-side entry, bad size, early close, excessive abstention, wrong stated reason, risk-rule rejection. That is the scorecard. | R19, R25 |

**Two timescales:**

- **Fast loop (live):** the agent trades with frozen skills, rulebook and
  model. Within each decision it gets more thought on the hard ones (#3),
  verification (#4) and tool feedback (#5). Nothing rewrites itself mid-day.
- **Slow loop (offline, gated):** replays produce a scorecard (#6); an LLM
  proposes skill or rule edits (#1), and Optuna tunes the numbers and
  chooses among the variants; Monte Carlo and replays verify them, with all
  verifiers, zero blows and the reserved months; the champion is replaced
  only with the owner's approval; optionally, the model is fine-tuned on its
  verified good decisions (#2).

**First, because they fix problems the replays already showed:** #4's
fact-checked reasons in the risk manager's phase 2 (the "wrong reason"
misreads), and #1 by hand (replay, scorecard, fix), automated once the
scorecard exists. #2 comes last: the most powerful, needing the most
verified data and the strictest gating.

### Requirements

**R24. What is trained.** The canonical documents the agent runs on: skills
(know-how and workflows), the runner's prompt templates, roles (agents),
strategies (their parameters and skip rules), and the rulebook's numbers.
Every change is a small diff to those documents; the generated adapters
come from `node scripts/sync-harness.js`, as for any change. The harness
stays LLM-agnostic: what is trained is text and numbers every harness
reads, never model-specific code.

**R25. The loop.**

1. **Score.** Replays produce the adherence scorecard (R19): each decision
   against the rulebook, step by step, with a failure taxonomy (wrong-side
   entry, bad size, premature close, excessive abstention, wrong stated
   reason, risk-rule rejection) and each trade's result.
2. **Propose.** An LLM reads the scorecard, the calibration reports and the
   failure taxonomy and proposes edits: each a small diff with the failure
   it targets and the effect it expects. **Optuna then searches over the
   agent's design, not only the rulebook's numbers (R30):** the proposed
   variants of a skill, prompt or role are its categorical choices, and the
   agent's settings are its other parameters. The proposer never judges its
   own proposals.
3. **Verify.** Every verifier must pass (R26); one failure rejects.
4. **Promote.** One rule, everywhere: a challenger replaces the champion
   only with **no significant loss on any verifier** (R26; the pass/fail
   ones pass), **a significant gain on the measure it targets** (a paired
   test against the champion), and **zero blows**; and only with the
   owner's approval, as a pull request reviewed as today. Nothing changes the
   agent's design on its own.
5. **Optionally, fine-tune** (later, R31).

**R26. Verifiers, all required.** Several imperfect checks combined are
stronger than any one:

- the mechanical Monte Carlo: zero blows, the pass-rate lower bound, the
  expectancy cuts, every regime (R7-R9);
- the held-out quarters of walk-forward half-years (R17), never their
  tuning quarters and never the reserved months (R16);
- LLM replays on walk-forward months for any change to skills, prompts or
  roles, on the held-out panel: adherence at least 90%; no failure category
  significantly worse than the champion's (a paired test per category, with
  a minimum count, since small differences are noise); and the LLM-level
  estimate (R20) within the gate;
- the repository's regression and adversarial review.

**R27. Archive.** Every candidate and its scores are kept in the ledger
(R16), including the rejected ones, so a proposal is never retried blind. A
small set of diverse leaders is kept (e.g. the fastest to pass and the
safest, the best per regime), so the search doesn't collapse onto one local
optimum.

**R28. Replay budget.** A 5-day LLM replay takes about a day and a half on
the local model, so they are spent where they decide something: a change to
the mechanical rules is screened by the Monte Carlo first, and only changes
to skills, prompts or roles (or a mechanical change that passed) get an LLM
replay.

**R29. In-the-moment aids** (the fast loop: #3, #4, #5), each its own
change on its own evidence:

- **Fact-checked reasons (#4), first:** before approving or skipping, the
  risk manager checks every reason stated against the briefing's facts (the
  window and whether it allows entries, the trend rule's side, the room in
  R, the multi-timeframe read), and each priority-order step on its own. A
  reason no fact supports is named and the decision re-made. The order
  gate's deterministic checks stay first and unchanged.
- **Agreement on verdict decisions (#3):** the take-or-skip decision on a
  verdict is asked several times, and acted on only when the answers agree
  (otherwise no trade); verdict decisions only, for the model time it
  costs.
- **Lessons when relevant (#5):** journal lessons are retrieved when the
  model is uncertain or the setup matches one, not added to every prompt.

**R30. Optuna over the agent's design** (owner's decision). A trial is a
whole agent configuration:

- the rulebook's numbers (R10);
- categorical choices among the proposed variants of each skill section,
  prompt template and role;
- the agent's settings that keep every role (the multi-agent cycle is fixed;
  a lean or single-agent cycle is never a candidate): the samples per
  verdict decision and how they must agree (R29), the model's temperature,
  how long a cached report holds, which facts the briefing carries.

Each trial runs in its own worktree, its adapters generated by
`node scripts/sync-harness.js`, so trials never touch the live tree. Trials
that change only the mechanical rules are scored by the Monte Carlo (fast,
TPE, many trials). Trials that change the agent's design need LLM replays,
which are slow and noisy, so that search is small and paired:

1. **A small search:** a handful of variants per study and a fixed trial
   budget.
2. **A fixed tuning panel of decision points:** a few hundred bars where a
   setup or verdict exists, plus a sample of quiet ones, from tuning quarters
   (R17). Every trial runs the same panel, paired against the champion, with
   fixed sampling settings, and each point is decided several times so the
   model's own noise is measured.
3. **Each point starts from a reference state:** the account, the position
   and the journal as the champion's continuous run had them; a point inside
   a trade runs continuously until the trade ends, so its management is
   judged. Panel runs give per-decision measures only; pass and blow rates
   come from the LLM-level estimate (R20). This needs a replay mode that
   runs a list of decision times from a seeded state (a new requirement).
4. **Decided by a paired test,** not a few early decisions: a challenger is
   dropped or kept by a paired test against the champion (McNemar on the
   decisions, with a stated tolerance), never on noise.
5. **Confirmed on a held-out panel** from held-out quarters, never seen by the
   search (R26); panels are refreshed between studies, so prompts can't fit
   one panel.

Every trial goes into the archive (R27), and a winner is promoted only as a
reviewed pull request with the owner's approval (R25).

**R31. Fine-tuning on verified decisions** (optional, last; an owner's
exception to the LLM-agnostic rule). Examples are selected by adherence
(the decision and its stated reasons match the rulebook and the facts),
never by outcome: filtering on profit would teach lucky decisions, and
outcomes are the gate's to judge. Those decisions become training examples
for a small
adapter on the local model. It is a training artifact kept outside the
repository's code, gated exactly as a rulebook change, and judged only on
months it never trained on. The harness never depends on it: the agent runs
the same with or without the adapter, on any model.

**R33. A strategy change re-learns automatically** (owner's decision).
Strategies are documents read live, so an edited `STRATEGY.md` is traded
on the next cycle; what was *learned* about it is not, and goes stale. So:

- **Fingerprints, defined.** A strategy's fingerprint hashes its parsed
  frontmatter in canonical form (sorted keys, YAML comments stripped,
  `status` and `version` excluded so a paper-to-active flip doesn't churn)
  and its body with whitespace normalized (the model reads it). Learned
  values also depend on things outside the document, so each rulebook
  records, beside the strategies' fingerprints: a content hash of the code
  their rules and sizing run on (the evaluator, rules, indicators, the
  facts functions of R6, `combine.js`), the account's `ACCOUNT.md`
  fingerprint (its limits and `sessions`: a change there makes that
  account's whole rulebook stale), and the policy strategy's own
  fingerprint (its `sizing`, `exit`, `contracts` and list: a change makes
  the whole policy stale). The skills are not fingerprinted: they are what
  the training loop itself changes (R24): each change is reviewed, and
  changes from the training loop are also replayed (R26).
- **Day one (owner's decision):** when this is built (section 10), the
  champion then in use is sealed as the baseline with the fingerprints in
  the tree at that moment, so nothing changes when it lands. Only a strategy, code, account or policy that
  changes after that, or a strategy added after that, goes stale.
- **Staleness in code.** A fingerprint that differs from the one recorded
  marks what depends on it stale. A test asserts that the runner and the
  gate treat a mismatch as stale and fail closed (a strategy edit itself
  still merges: it then trades paper until re-learned).
- **Re-learning is triggered, not remembered.** A change is a trigger for
  the training loop (R25), beside new data (R17): calibration of the
  strategy's claims (R11-R13), the Monte Carlo search over the rulebook
  values it affects (R8-R10), and a replay scored by the scorecard (R19),
  in the tuning and held-out quarters as for any change. Those runs use
  their own worktree with the candidate's sealed rulebook (R30), so the
  changed strategy isn't stale there and its replay produces real
  decisions to score.
- **Paper until re-verified.** Until its re-learned rulebook passes every
  verifier (R26) and the owner approves it (R25), a changed or new
  strategy trades **paper only**: in this harness that means its plans are
  journaled and its live entries refused, no fills. For a policy strategy
  this is enforced on the verdict's component, not only the `setup:` tag:
  the runner passes over a paper or stale component when it picks the
  setup, and the gate refuses an entry whose latest verdict names one
  (gate and wiring tests). Exits and protective stops of an open position
  are never affected.
- **The rest of the policy keeps trading only if it is still safe.**
  Pacing, sizing and exits were searched over the whole portfolio's trade
  stream, so taking one component out changes the paths. Before the other
  components keep trading live, the mechanical Monte Carlo re-scores the
  champion without that component; any blow puts the whole policy on
  paper until re-learned. The re-score's result is a recorded entry keyed
  to the champion's seal and the set of stale components; the runner and
  the gate require a passing entry before the other components trade
  live, and with none (or one still running) the whole policy is on
  paper.
- **What was learned can't be changed by a later change.** Each promoted
  rulebook is sealed with a hash over its values, the evidence frozen at
  promotion, and the fingerprints above. The ledger (R16), which grows
  after promotion, sits outside the seal, in its own append-only file
  with a test that it is never rewritten. Each version's seal is also
  recorded in an append-only version list (R18) and in its promotion pull
  request, so recomputing a seal in the same file is caught. Versions are
  kept, never edited in place.
- **Verified before use, cheaply.** The runner and the gate check that the
  rulebook's seal matches its contents and appears in the version list,
  and that the recorded fingerprints match the named strategy, its
  verdict's component, the account, and the code hash now in the tree.
  The hook hashes only those (a few local files), and fails closed on a
  missing or unreadable seal. A code-hash mismatch puts every strategy the
  rulebook covers on paper. A seal mismatch (an edited or partial
  rulebook) and a fingerprint mismatch (a stale one) both leave the
  strategies it covers on paper.
- **Rollback restores the set.** Rolling back (R18) restores the rulebook
  version together with the strategy documents, code and account it was
  learned on; restoring only the rulebook leaves it stale, by design.
- **Promotion as always:** a reviewed pull request with the owner's
  approval; the new seal and fingerprints are recorded with the promoted
  rulebook and in the version list.
- **Recorded with every decision, today.** Each replay run's and live
  session's manifest carries `fingerprints` and a `versions` list (a new
  entry, with the decision time it starts at, whenever the agent changed):
  `code` hashes `scripts/` (the CLIs, hooks and `scripts/lib`: a superset of
  the code hash above, until it is narrowed to the evaluator, rules,
  indicators, facts and `combine.js`; live, taken once when the runner
  starts, the code it loaded),
  `harness` hashes the strategies, accounts, skills, agents and rules (the
  tree the replay config hash covers). The canonical strategy, account and
  policy fingerprints and the rulebook seal are not built yet: they are
  recorded as `null` until they are (`scripts/lib/session/record.js`).

## 8. The LLM: adherence and learning

**R19. Adherence scorecard.** For every replay or live decision, the
rulebook gives an expected decision (trade, skip, or size) from the facts
the LLM had. The scorecard reports:

- agreement, by priority-order step and by strategy;
- each trade's result in R and dollars;
- what each skipped setup would have returned (the counterfactual);
- the account pacing: cushion used, and the daily-limit headroom.

The scorecard is produced by a tested harness script, the same for every
run.

**R20. From adherence to an LLM-level estimate.** The gate judges the
mechanical rulebook, but the goal is the LLM's pass rate, and there are far
more decisions than attempts. The scorecard's per-step deviation rates go
back into the attempt simulation as perturbations: a taught item missed at
the measured rate, and a skip taken anyway. That gives an **estimated LLM
pass and blow rate**, reported beside the mechanical one.

**R21. Live readiness.** Trading live needs both of these:

- adherence of at least 90% on the taught items;
- an estimated LLM blow rate of zero and an estimated pass rate meeting the
  gate (R20).

**R22. Closing the loop** (the training loop's input, R25). Where the LLM
departs from the rulebook and loses, the fix is in the skill's wording, or
the item moves to enforced (R4). Where it departs and is consistently right, the departure becomes a
candidate claim for the next calibration run. Candidate claims come only
from LLM months in walk-forward blocks. The ledger records the months each
claim came from, and a reserve block that contributed to a claim never
judges it. The June 1-5, 2026 replay lies in Recent, so it measures
adherence only: no candidate claims are drawn from it.

**R23. Parity.** The rulebook the backtester runs is the one the runner
enforces and the skills teach. What must hold is enforced in code, and what
needs judgment is taught in skills.

## 9. Retiring PPO (done, PR #70)

The trained policy is removed completely: the trainer, the sweeps, the
bundles, and the code that runs a bundle. **What stays** is everything the
harness needs without one:

- `prop_portfolio`'s sizing verdict (each setup sized from the budget, or
  skipped);
- the order gate's verdict and budget checks, including the size fraction
  the rulebook's enforced items will use (R4);
- `combine.js`;
- the backtester and its combine simulation;
- the replay and label tooling, which is reused for the adherence
  scorecard;
- the promotion gate's numbers and the split windows, moved to their new
  homes (R15);
- the market features (ATR, ADX), moved to `scripts/lib/trading/`, which
  the evaluator's facts and the labels' ATR need. Confluence has one
  implementation, the scan's (`trading/strategies.js`): `observation.js`'s
  `confluence()` is deleted, and the backtester uses the scan's.

What changes in behaviour:

- **The verdict says `full` or `skip`** until the rulebook's multiplier
  (R4) arrives. The trained policy's `half` goes, but the gate keeps its
  fraction path for the multiplier, rather than deleting it and adding it
  back. The priority order still halves a trade when the LLM applies it.
- **No early close past +2R.** The policy's hold-or-close decision in a
  trade goes. The trailing exit (`exit` in `prop_portfolio`) manages every
  trade, as it does without a bundle today.
- **The verdict no longer records which policy produced it.** The check
  that pins a verdict to a bundle (prop-state, order_plan) goes. Old
  verdicts expire on their own.
- **`signal: policy` keeps its name**, but `policy: { bundle }` is removed
  from the schema.
- **The modules that stay leave `scripts/lib/rl/`,** so the directory can be
  deleted: the runner's prop hooks, the sizing verdict, and the combine
  simulator (proposed: `scripts/lib/prop/`). Each keeps its own unit tests
  (the ECC rule).
- **The PPO Python package goes.** Python returns with the search (R10).
  Until then CI and `npm run verify` have no Python step.

## 10. Order of work

Each step is its own pull request and is reviewed as today.

1. Retire PPO (section 9). Done, PR #70.
2. The adherence scorecard (R19) with the failure taxonomy (R25), applied to
   the June 1-5, 2026 replay. Until the automated loop exists, the loop runs
   by hand: replay, scorecard, a proposed fix, review, merge. Fixes to
   reasoning and fact errors (a stated reason the briefing contradicts) may
   come from Recent's replays, because they make no claim about the market;
   any fix that changes what is traded waits for walk-forward data. Bars
   past 2026-07-20 are needed for that (the first walk-forward half-year,
   2026-H2, starts in the data's last weeks).
3. The schedule in code (R32): Recent, the walk-forward and reserve
   half-years, and their tuning and held-out quarters, before any of them is
   used.
4. Fact-checked reasons in the risk manager's phase 2 (R29, #4): the fix for
   the "wrong reason" misreads the replays show.
5. Paper components stay paper inside a policy (owner's decision, right
   after step 4): the runner passes over a component whose status is not
   `active` when it picks the setup, and the gate refuses an entry whose
   latest verdict names one; gate and wiring tests. Today a `paper`
   component (e.g. `value_area`) can be traded live through
   `prop_portfolio`.
6. The dynamic account: limits as fractions of the MLL, with the account and
   its contract taken from the running attempt.
7. The rulebook document, its single-place test, the enforced or taught
   classification, and the verdict's multiplier (R1-R4). It starts from
   today's values, so nothing is learned yet.
8. Slippage-safe sizing: `contractPlan`'s risk per contract includes the
   stop's expected slippage, so a stopped trade never ends past the floor or
   the daily limit (R9). Stricter, not a gate weakening; tests in the order
   gate's unit and hook wiring suites.
9. The two-layer evaluator and the attempt simulation (R6-R9).
10. Calibration: the registry, the measurements and the reports (R11-R13).
   It starts with the claims the June replay shows the LLM relies on most
   (by how often, never by their June outcomes).
11. The search and promotion (R8, R10, R15-R16, R18). This produces the first
   learned rulebook for `topstep_100k`; 50K and 150K follow.
12. The LLM-level estimate and live readiness (R20-R21).
13. Base rates in the briefing (R14).
14. The training loop (R24-R28, R30): the proposer, Optuna over the agent's
    design with the decision-point replay mode and paired tests, the
    verifiers, the archive, and promotion as a reviewed pull request.
15. Walk-forward re-learning (R17), run through the training loop.
16. Strategy-change re-learning (R33): the fingerprint, staleness in code,
    the trigger, and paper until re-verified (enforced by the gate).
17. The other in-the-moment aids (R29): agreement on verdict decisions
    (#3) and lessons when relevant (#5), each on its own evidence.
18. Fine-tuning on verified decisions (R31), optional.

## 11. Decisions

Decided by the owner (2026-10-12):

- **Search tool: Optuna**, offline in Python (R10), over the rulebook's
  numbers **and the agent's design**: skills, prompts, roles and settings
  (R30).
- **Training is improving the agent's design** (section 7a): replays score,
  an LLM proposes, Optuna searches, Monte Carlo and replays verify, the
  owner approves; fine-tuning the model is optional and last.
- **Markets: NQ first.** Calibration and the first search run on NQ (the
  most data, order flow included). ES, YM and RTY follow once NQ passes
  the gate.
- **Contract by account size, measured.** The 50K account trades the micro
  (MNQ). For 100K and 150K, measure first: by year, how often one NQ can't
  fund a setup and the size distribution, NQ against MNQ, and pick the one
  that passes more. (At 2026 volatility a 1-1.5 ATR stop is about 20-60 NQ
  points, $400-1,200 a contract, so today's sizing gives mostly 0 or 1 NQ.)
  Each account's rulebook is searched, calibrated and replayed in its
  contract, so training equals live; the account profile records it.
- **Attempt length: the billing cycle**, about 21 trading sessions.
- **Goal: pass within it, the faster the better, with zero blows, no
  exception** (section 1, R8).
- **Funded phase: out of scope.**
- **Enforced: the mechanical items** computed from facts the harness has
  (the trend rule, the room, the multi-timeframe read, the confluence, the
  pacing, the daily stop). **Taught: judgment** (secondary context, news
  nuance, chart reading). (R4)
- **Strictness:** the pass-rate lower bound at 90% confidence; each
  out-of-sample window is looked at at most 3 times, then retired (R15,
  R16).
- **Live readiness:** at least 90% adherence on the taught items, and the
  LLM's estimated blow rate zero and its estimated pass rate meeting the
  gate (R21).
- **A changed or new strategy trades paper until its re-learning is
  verified and approved** (R33); re-learning is triggered automatically.
- **Day one of R33:** the champion in use when R33 lands is sealed as the
  baseline with the fingerprints then in the tree, so nothing changes.
- **Paper components** are enforced inside a policy too, fixed right after
  fact-checked reasons (section 10).
- **Where it lives:** `rulebooks/<account>/RULEBOOK.md`, numbers in the
  frontmatter and the evidence in the body (R1).

## 12. Not in scope

- New strategies (after calibration shows where the current ones fall
  short).
- Order-flow strategies beyond paper: done outside this design. The owner
  activated `ofi`, `ofi_absorption`, `value_area` and `prop_flow_1m` once
  order flow came from the broker servers' bars; the replay smoke and a
  fresh replay verify them before any live session. R33's rules are
  unchanged.
- Changing the LLM the harness runs (it stays a small local model) or adding
  model-specific code to the harness. The optional fine-tuned adapter (R31)
  is the owner's one exception: a training artifact outside the repository
  that the harness never depends on. Not otherwise model-specific
  code.
- The funded phase (decided, section 11).

## Appendix: PPO footprint

Measured on main after PR #66. It removes about 47 files and 6,250 lines,
and trims about 700 more lines in about 30 files.

### Removed

- `rl/`: the Python trainer, sweep, retrain and ship scripts, configs, tests
  and requirements (30 files).
- `models/`, and the `qwen-extension/models` link.
- `scripts/rl-env-server.js`, `scripts/rl-dataset.js`.
- From `scripts/lib/rl/`:
  - `env-server.js`, `policy-bundle.js` (its promotion gate moves first,
    R15) and `policy-net.js`;
  - `observation.js` (its market features move; its `confluence()` is
    replaced by the scan's);
  - `label-dataset.js`;
  - `env-config.js` (its `policyStrategy` moves).
- `skills/policy-training`, `commands/train-policy.md` (and the generated
  copies), `docs/RL-DESIGN.md`.
- The backtester's `--bundle` option and policy columns, and the engine's
  policy hooks: `ask`, the half or skip ask at a setup, and the close past
  the ratchet.
- Tests that only cover the removed code:
  - `python-rl`, `env-config` and `label-dataset`;
  - most of `rl.test.js` (two engine tests move to `backtest.test.js`);
  - the bundle cases in the multi-market, backtest, live-runner,
    order-gate, order_plan and strategies tests.
- The Python steps in CI, the PR template, `.gitignore`, `CONTRIBUTING.md`
  and `CLAUDE.md` (until the search adds its own).

### Kept and moved out of `scripts/lib/rl/`

- `live-runner.js`: the runner's prop hooks (screen, snapshot, end of day),
  without `bundleFor` and `position()`. The runner's call to `position()`
  goes too.
- `live.js` `decideSetup`: the sizing verdict, without the observation
  (about 40 lines). Its re-export of `prop-state` is replaced by direct
  imports.
- `challenge-env.js`'s combine simulator (`tradingDays`, `createEnv`,
  `runAttempt`, `evaluate`, without rewards and actions; about 90 lines).
  The backtester's prop runs use it, and the attempt simulation (R6) builds
  on it.
- The promotion gate's numbers and `gateFailures`, and the split windows
  (R15).
- The market features (section 9).

### Kept in place

- `scripts/lib/replay/labels.js`: each decision, the gate's checks, fills,
  outcomes and counterfactuals. This is the adherence scorecard's input.
  Its behaviour-cloning parts (`clone`, the stop and size buckets) are
  renamed or dropped. Its skip classification depends on them, so they are
  renamed, not deleted.
- The gate's size-fraction path (`budgetPlan`'s `fraction`), kept for the
  rulebook's multiplier (R4).

### Rewritten

- `docs/QUANT-PLAN.md` and the "student policy" half of
  `docs/REASONING-TRADER-DESIGN.md` become the LLM-measurement plan that
  this document points to.
- References in `README.md`, `docs/BACKTESTING.md`, `docs/ORDER-FLOW.md`,
  `docs/TECH-DEBT.md`, `strategies/README.md`, the two policy strategies,
  the strategy template, and the `prop-challenge-pacing`, `replay` and
  `strategy-authoring` skills.
- `CLAUDE.md`'s line on where the promotion gate lives.
