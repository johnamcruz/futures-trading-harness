# Quant plan: measuring the reasoning trader on combines

Status: the plan of record for the label runs and what follows them. The
pieces it builds on are described in `docs/REASONING-TRADER-DESIGN.md`
(replay, labels). The trained PPO policy this plan once led to (behaviour
cloning, then RL) is retired; the learned-rulebook design (to come)
replaces it: a small set of numbers and context rules, searched on history,
that the gate enforces and the skills teach. This plan is the LLM
measurement that design points to. Order flow comes after this plan
(`docs/ORDER-FLOW.md`).

## The objective

A prop combine is a race between two barriers, not a return to maximize. On
`accounts/topstep_100k`: reach +$6,000 (with the best day at most 50% of the
profit) before equity touches the trailing floor ($3,000 below the highest
end-of-day balance, locking at the starting balance), within 30 sessions
(the harness's attempt length). The firm's $2,000 daily limit stops the day,
not the attempt.

The system is judged by:

- **P(blow)**: zero, in every out-of-sample month (the promotion gate,
  `scripts/lib/prop/promotion.js`).
- **P(pass)** per attempt: at least 40% (the gate's floor; it may be raised,
  never lowered).
- **Days to pass**.

## The combine Monte Carlo is the score

The backtester's prop runs are the combine Monte Carlo
(`scripts/lib/prop/challenge.js`): each attempt starts on a trading day and
runs through the backtester (the same evaluator, fills, trailing exits, fees
and session as live) until it passes, blows, or times out. Passes and blows
are counted month by month.

What the combine needs decided is the size at each setup (today the
policy strategy's sizing verdict: full or skip; the priority order may halve
it); the trail exits every trade.

## The pipeline, and what to measure at each stage

| Stage | Who | Question |
| --- | --- | --- |
| Signals | rules strategies | Does each setup have an edge after fees: expectancy in R, win rate, the R distribution, by regime, session and trend alignment? |
| Filter | the reasoning model with the skills | Does its judgment add edge? Taken setups against every signal, using the counterfactuals on skipped labels. |
| Sizing | the position-sizing skill and the policy strategy's `sizing` | Which risk per trade maximizes P(pass) with P(blow) at zero? |
| Exits | `prop_portfolio`'s `exit` (hold the stop, then trail; the numbers in its account's `RULEBOOK.md`) | Do exits keep the move: the best and worst R in a trade against the R banked? |
| Portfolio | `strategies/prop_portfolio` order | Do losses cluster on the same days across strategies? Combines die from clustered losses, not the average. |

### Why sizing is the crux

At 1 MNQ with an 80-tick stop ($40 = 80 ticks x $0.50), the trailing cushion
is 75R and the target 150R. Two trades a day at +0.2R expectancy make about
0.4R a day, 12R ($480) in 30 sessions: no pass. The size that reaches
+$6,000 before -$3,000 most often depends on the measured edge, how often it
fires, and how losses cluster. Expect "more size on the best setups only",
which is the sizing verdict's job (full or skip today; a size multiplier in
the learned-rulebook design).

## Labels: how the reasoning trader decides

The reasoning model trades replayed windows through the live harness (every
skill, strategy and role; the full multi-agent cycle). Its decisions become
labels (taken, skipped with counterfactuals, refused): the record of how
closely it follows the skills and whether its judgment adds edge.

### Every window is a combine attempt

Each label window runs as a `topstep_100k` attempt started at the window's
first moment, in the run's own home (`skills/replay/SKILL.md`, The prop
policy), so the reasoning model sees what it would see in a live combine:
the balance, the floor and cushion, progress to the target, the day's P&L,
sessions left, and the prop pacing rules, and the gate's prop checks apply.
The replay report's combine verdict is per calendar month; the window's own
attempt is read with `combine.js status`.

While an attempt runs, only the policy strategy may enter, so the policy
must be `active`: `prop_portfolio` is, for live and replay alike. Its
`sizing` rules set the size the reasoning model may take (the full size its
budget allows, or a skip); the labels record the reasoning model's take or
skip.

### Windows

Thirty weekdays each (one combine attempt: thirty trading days less any
exchange holiday in them), on the split windows
(`scripts/lib/prop/splits.js`). The starts are
stratified and seeded (drawn once and recorded): each split's range is cut
into equal buckets, and one random weekday start is drawn per bucket, each
window inside its own bucket (a start is drawn no later than 30 weekdays
before its bucket ends), so windows never overlap. A window with a holiday
has fewer than 30 sessions (one or two short of the attempt's length). A
replayed attempt never times out (it runs until it passes or blows), so a
window that does neither ends `active` whatever its session count, and is
read as it stands, by sessions done.

| Split | Range | Reasoning-model windows | Used for |
| --- | --- | --- | --- |
| Train | 2021-01 to 2023-07 | 8 (from 2021-06: the bars start 2021-04-25) | labels; all skill and strategy iteration |
| Select | 2023-07 to 2024-07 | 3 | the held-out check of skill changes; choosing among rulebook candidates |
| Out of sample | 2024-07 to 2025-07 | none | the rulebook in the backtester, under the gate |

The out-of-sample test needs no reasoning model: the backtester runs the
rules on bars alone, so it cannot remember the market, and the test stays
unseen until the end.

### Leakage

The reasoning model may remember what markets did before its knowledge
cutoff, which can make its labels look better than its judgment. The train
and select windows here lie before the cutoff, so neither judges the
reasoning model: its own quality (does it beat the rules baseline?) is
judged on months after the cutoff
(recent months, e.g. 2026-06, where the bar data covers them), with the
cutoff-gap test (train against those months) and the placebo test in
`docs/REASONING-TRADER-DESIGN.md`. Labels from before the cutoff serve skill
and strategy iteration (train) and its held-out check (select) only.
Rulebook candidates are chosen on select and judged out of sample in the
backtester, where they see only bars.
This replaces that design's requirement that select and out of sample start
after the cutoff; its Leakage, Windows, Plan, Nondeterminism and Open
questions sections, and its stage-2 condition, are amended to match.

### Throughput

With `trigger: "signal"` in the runner config (the default, `bar`, runs a
cycle on every closed bar), a cycle runs only when an active strategy fires
(a paper one too in a paper run), a trade or working order is open, at
premarket, or at the end of day. A trading day starts about 13 cycles.

Measured on a local model (a small local model, opencode, MNQ 3m, one window of
15 bars): a cycle whose roles all run takes about 6 to 9 minutes; one whose
reports all come from the report cache, 0.5 to 2 minutes; an entry cycle
(plan, phase 2, the order) about 15 minutes. The bar briefing gives every
role the same computed facts once per bar, and the report cache reuses an
analyst's report until the next 15-minute close and risk-manager phase 1
until the account changes (phase 2 always runs). At those times a 30-day
window takes a day or more. Windows run one at a time against one model
server unless its GPU memory allows more: role prompts are long (8k to 15k
tokens with their skills), and several at once exhausted the memory of a
32 GB machine. Nothing else heavy (the full test suite) runs beside a
window. A window yields a few hundred teacher decisions (cycles), among
thousands of labels (one per decision time and symbol).

## Discipline

- **Samples**: about 30 trades per setup before trusting its expectancy;
  more per regime. Report the count beside every number.
- **Tuning**: skills and strategies are tuned on train only. Select is a
  check against overfitting, never proof of the reasoning model's edge (its
  windows lie before the cutoff); that is judged on the months after the
  cutoff. Metrics from the rules alone (a strategy's signal edge) carry no
  recall risk on any window; the reasoning model's filter lift does, and
  is trusted only after the cutoff.
- **Multiple testing**: every tweak tried is a chance to fit noise; log each
  one and its result.
- **Re-label after a change**: the reasoning model's decisions depend on the
  skills, so after a skill or strategy change the affected windows are
  replayed, and every measurement uses labels from the current skills
  (replay equals live).
- **Costs**: fees are in the backtester. Market entries fill at the replay
  moment (the open of the minute containing it, plus slippage; no later
  data), as live; live slippage is still measured before any live use.

## The loop

1. **Label**: the train windows, then select, then the judge month.
2. **Review every decision like a quant**: each take and skip is checked
   against the facts recorded for its bar, the bar briefing's (the trend
   rule and the multi-timeframe read for the side, the first level in the
   way in the setup's own R against the room it needs, confluence, the
   VWAP side, the session window, the news) and the strategy's own
   `STRATEGY.md` (context filter, skip rules, min R:R). The briefing gives
   facts, never a verdict; the strategy and the skills decide. A reason that
   contradicts the record (for example "trend up" when the record says
   down, or "outside the session" at 10:00 ET) is a reasoning error; a
   setup that meets its strategy's conditions with the trend rule, the
   alignment and the room in its favour is strong, one that misses any is
   weak; a strong setup skipped or a weak one taken is questionable. A role
   used for something other than its own analysis is a process error.
   Joined with each decision's outcome (the counterfactuals), this shows
   whether the checks predict winners, and which skill rule to fix.
3. **Scorecard** (to build, proposed separately): per strategy and regime
   the edge and sample size, the reasoning model's filter lift, exit quality,
   loss clustering, and the combine Monte Carlo's P(pass) and P(blow) by risk
   per trade, from the labels.
4. **Improve**: fix or drop setups with no edge (the rules-only signal edge
   on train), tighten skill rules where the decision review (step 2) finds
   reasoning or process errors against the recorded facts (the filter lift
   counts only once confirmed after the cutoff), set sizing from the Monte
   Carlo; each change its own pull
   request with the regression and review; then re-label train and select.
5. **Learn the rulebook** (the learned-rulebook design, to come): its
   numbers searched on train by the combine Monte Carlo, chosen on select.
6. **Test once**: the out-of-sample months in the backtester under the gate:
   zero blows every month and at least 40% passes, or it isn't promoted.

## What the label runs trade with

- **Strategies** (as they were then; `cisd_ote` has since been rewritten
  to the textbook CISD + OTE and is paper): the active rules strategies (`orb`, `cisd_ote`,
  `vwap_reclaim`, `crt_1h`, `crt_4h`, `value_area_reentry`,
  `value_area_breakout`), activated for the labels on the owner's call; the
  order-flow ones (and `value_area`, which needs order flow) stayed `paper`
  then, and were activated later, once order flow came from the broker
  servers' bars. The trend-following ones (`orb`, `value_area_breakout`, and
  `vwap_reclaim` in a trend only) are regime-gated: never in a range (the
  regime-gate pull request, merged before this plan). `bos`, `ema_cross`,
  `keltner` and `supertrend` were retired on 2026-10-13
  (`strategies/README.md`, "Retired strategies").
- **Context**: the bar briefing (facts by timeframe, computed once per bar)
  and the report cache; the setup's facts in its own R, no code grades.
- **Next, after the first train windows**: setup quality per strategy
  (what makes each strategy's setup strong or weak, in its own
  `STRATEGY.md`), and a strategy review that proposes turning off a
  strategy whose labelled trades show no edge (a code circuit breaker is
  an open option). Each is its own pull request, then the affected windows
  are labelled again.

## Not in this plan

- Order flow: after this plan (`docs/ORDER-FLOW.md`); the order-flow
  strategies stay `paper`. The train and select windows, on NQ/MNQ, lie
  inside the months that have order-flow data, so their flow features can be
  added later (not the judge month, nor the other indexes).
- New strategies: after the scorecard shows where the current ones fall
  short.
