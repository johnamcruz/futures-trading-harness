# Quant plan: from the reasoning trader to a policy that passes combines

Status: the plan of record for the label runs and what follows them. The
pieces it builds on are described in `docs/REASONING-TRADER-DESIGN.md`
(replay, labels, dataset) and `docs/RL-DESIGN.md` (the env, training, the
promotion gate). Order flow comes after this plan (`docs/ORDER-FLOW.md`).

## The objective

A prop combine is a race between two barriers, not a return to maximize. On
`accounts/topstep_100k`: reach +$6,000 (with the best day at most 50% of the
profit) before equity touches the trailing floor ($3,000 below the highest
end-of-day balance, locking at the starting balance), within 30 sessions
(the harness's attempt length). The firm's $2,000 daily limit stops the day,
not the attempt.

The system is judged by:

- **P(blow)**: zero, in every out-of-sample month (the promotion gate).
- **P(pass)** per attempt: at least 40% (the gate's floor; it may be raised,
  never lowered).
- **Days to pass**.

## The combine Monte Carlo is the training

The RL env is the combine Monte Carlo: each episode is one combine attempt
from a random start day, run through the backtester (the same evaluator,
fills, trailing exits, fees and session as live) until it passes, blows, or
times out. The reward pays a pass (more for a faster one) and punishes a blow
harder than any pass earns. Training runs many attempts; selection and
the out-of-sample check count passes and blows month by month.

The policy decides what the combine needs decided: at each setup skip, half
or full size; in a trade past the ratchet, hold or close. It sees the account
(cushion, progress, day P&L, sessions left), the setup's risk against the
cushion, the trade, and the market (`docs/RL-DESIGN.md`, Observation).

## The pipeline, and what to measure at each stage

| Stage | Who | Question |
| --- | --- | --- |
| Signals | rules strategies | Does each setup have an edge after fees: expectancy in R, win rate, the R distribution, by regime, session and trend alignment? |
| Filter | the reasoning model with the skills | Does its judgment add edge? Taken setups against every signal, using the counterfactuals on skipped labels. |
| Sizing | the position-sizing skill, then the policy | Which risk per trade maximizes P(pass) with P(blow) at zero? |
| Exits | each strategy's `exit` | Do exits keep the move: the best and worst R in a trade against the R banked? |
| Portfolio | `strategies/prop_portfolio` order | Do losses cluster on the same days across strategies? Combines die from clustered losses, not the average. |

### Why sizing is the crux

At 1 MNQ with an 80-tick stop ($40 = 80 ticks x $0.50), the trailing cushion
is 75R and the target 150R. Two trades a day at +0.2R expectancy make about
0.4R a day, 12R ($480) in 30 sessions: no pass. The size that reaches
+$6,000 before -$3,000 most often depends on the measured edge, how often it
fires, and how losses cluster. Expect "more size on the best setups only",
which is the policy's skip / half / full decision.

## Labels: the policy's head start

The reasoning model trades replayed windows through the live harness (every
skill, strategy and role; the full multi-agent cycle). Its decisions become
labels (taken, skipped with counterfactuals, refused); behaviour cloning
copies them, then RL on the combine Monte Carlo improves on them.

### Every window is a combine attempt

Each label window runs as a `topstep_100k` attempt started at the window's
first moment, in the run's own home (`skills/replay/SKILL.md`, The prop
policy), so the reasoning model sees what it would see in a live combine:
the balance, the floor and cushion, progress to the target, the day's P&L,
sessions left, and the prop pacing rules, and the gate's prop checks apply.
The replay report's combine verdict is per calendar month; the window's own
attempt is read with `combine.js status`.

While an attempt runs, only the policy strategy may enter, so the policy
must be `active` where the replay runs. `prop_portfolio` stays `paper` in
the repository until a trained bundle passes the promotion gate; the label
runs use a checkout of the harness whose only change is `status: active` on
it (never committed). Without a bundle the policy sizes each setup by its
`sizing` rules (skip, half or full), which is what the labels record.

### Windows

Thirty trading days each (one combine attempt), on the RL pipeline's split
(`rl/configs/sweep/prop_portfolio_topstep_100k_v1.json`). The starts are
stratified and seeded (drawn once and recorded): each split's range is cut
into equal buckets, and one random weekday start is drawn per bucket, each
window inside its own bucket, so windows never overlap.

| Split | Range | Reasoning-model windows | Used for |
| --- | --- | --- | --- |
| Train | 2021-01 to 2023-07 | 8 (from 2021-06: the bars start 2021-04-25) | cloning labels; all skill and strategy iteration |
| Select | 2023-07 to 2024-07 | 3 | the clone's held-out check; choosing among policies |
| Out of sample | 2024-07 to 2025-07 | none | the policy alone in the backtester, once, under the gate |

The out-of-sample test needs no reasoning model: the policy sees only bars,
so it cannot remember the market, and the test stays unseen until the end.

### Leakage

The reasoning model may remember what markets did before its knowledge
cutoff, which can make its labels look better than its judgment. The train
and select windows here lie before the cutoff, so neither judges the
reasoning model: its own quality (the go/no-go for cloning: does it beat the
rules baseline and the current policy?) is judged on months after the cutoff
(recent months, e.g. 2026-06, where the bar data covers them), with the
cutoff-gap test (train against those months) and the placebo test in
`docs/REASONING-TRADER-DESIGN.md`. Labels from before the cutoff train the
clone (train) and check its imitation (select) only. Policies are chosen on
select and judged out of sample in the backtester, where they see only bars.
This replaces that design's requirement that select and out of sample start
after the cutoff; its Leakage, Windows and Plan sections are amended to
match.

### Throughput

With `trigger: "signal"` in the runner config (the default, `bar`, runs a
cycle on every closed bar), a cycle runs only when an active strategy fires
(a paper one too in a paper run), a trade or working order is open, at
premarket, or at the end of day. A trading day starts about 13 cycles.

Measured on a local model (a 9B model, opencode, MNQ 3m, one window of
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
- **Tuning**: skills and strategies are tuned on train and select only. A
  change must improve select, not just train.
- **Multiple testing**: every tweak tried is a chance to fit noise; log each
  one and its result.
- **Re-label after a change**: the reasoning model's decisions depend on the
  skills, so after a skill or strategy change the affected windows are
  replayed, and the policy trains on labels from the current skills
  (training equals live).
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
4. **Improve**: fix or drop setups with no edge, tighten skill rules where the
   filter loses, set sizing from the Monte Carlo; each change its own pull
   request with the regression and review; then re-label train and select.
5. **Clone, then RL**: behaviour cloning on the train labels (checked on
   select), then RL fine-tuning on the combine Monte Carlo.
6. **Test once**: the out-of-sample months in the backtester under the gate:
   zero blows every month and at least 40% passes, or it doesn't ship.

## What the label runs trade with

- **Strategies**: the active rules strategies (`orb`, `ema_cross`,
  `keltner`, `supertrend`, `bos`, `cisd_ote`, `vwap_reclaim`, `crt_1h`,
  `crt_4h`, `value_area_reentry`, `value_area_breakout`), activated for the
  labels on the owner's call; the order-flow ones stay `paper`. The
  trend-following ones (`ema_cross`, `supertrend`, `keltner`, `bos`, `orb`,
  `value_area_breakout`, and `vwap_reclaim` in a trend only) are
  regime-gated: never in a range.
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
  strategies stay `paper`. The label windows lie inside the months that have
  order-flow data, so their flow features can be added later.
- New strategies: after the scorecard shows where the current ones fall
  short.
