# Training

How to train the model with the replay: what to run, in what order, and how
to read what comes out. The replay is the live harness on replayed data
(`docs/OPERATING.md`, "Replay"); training adds presets, a preflight and reports on top of
it. Where a feature is phase 2's (not merged yet), this guide says so and
names its branch.

## 1. Overview

One replay, two presets: the replay config's `stage`.

- **Stage 1, learn to trade.** The model practises composing trades
  (`trade_lifecycle`) from its skills on curated setup moments, and is checked
  on held-back months.
- **Stage 2, pass prop.** The same runs, plus the account layer: account
  states (each practice day starts from a state drawn from the model's own
  30-day Monte Carlo paths), account facts and prop risk rules.

Stage 2 starts only after stage 1's exit test passes on a validate run.
Both stages use the same curated lists throughout.

The data split (`config/schedule.json`, read through
`scripts/lib/schedule.js`; see "The schedule is config" below):

| Window | Dates | Use |
| --- | --- | --- |
| practice-train | 2020-01-01 to 2024-07-01 | practice runs, the experience index |
| practice-validate | 2024-07-01 to 2025-01-01 | validate runs (`--validate`), counted |
| test | 2025 | sealed: 3 judging looks |
| final | 2026 | sealed: 1 judging look, after a test pass |

A learning run lies inside one window. A replay outside the split declares
`"learning": false`.

## 2. One-time setup

Set up the harness, the replay broker and the model server as `docs/OPERATING.md`
describes ("Setup", "Replay") and `docs/BACKTESTING.md` (the bar data). Your
model and machine settings stay in your own local config, never in the repo.

**Curated lists.** Code scans history for setup moments, then picks seeded,
year-balanced lists:

```bash
node scripts/curated-lists.js scan --bars <NQ 3m series> --root MNQ --from 2021-04-01 --to 2024-07-01 \
  --use practice --out moments-practice.jsonl --jobs 10
node scripts/curated-lists.js scan --bars <NQ 3m series> --root MNQ --from 2024-07-01 --to 2025-01-01 \
  --use validate --out moments-validate.jsonl --jobs 10
node scripts/curated-lists.js build moments-practice.jsonl --use practice --seed 1
node scripts/curated-lists.js build moments-validate.jsonl --use validate --seed 1
node scripts/curated-lists.js show <FTH_HOME>/experience/curated-practice-<fingerprint>.json
```

The scan takes about 1.5 to 2 hours with about 10 jobs (an estimate). `build`
writes `curated-<use>-<fingerprint>.json`. The fingerprint is a hash of the
document's content: a list that changes after it was built is refused, and a
run keeps the list it pinned. Regenerate only when the code that defines a
setup changes (`scripts/lib/learning/curated-moments.js`,
`curated-lists.js`). Re-running
for any other reason gives you a different list, and your runs stop being
comparable.

- **Same bars as the replay.** Scan the lists from the same bars the replay
  broker serves the model. Today that is the replay server's CSV series:
  back-adjusted 1-minute files per root, with the 3-minute files derived from
  them. Scan the NQ 3-minute series as root MNQ: MNQ trades at NQ's prices.
- **Regenerate if the source changes.** If the replay is switched to the
  raw-price derived store, regenerate the lists from that source, so the two
  always match. The preflight's `curated-source` check compares the list's
  moments with the bars you give the run (`--bars`): a moment whose decision
  bar closed elsewhere than its entry means another series, and the run is
  refused. Give the run the bars the replay serves, so the check sees what the
  model sees.
- **History coverage.** The history starts 2021-04 (`data.start` in
  `config/schedule.json`), so practice-train effectively covers 2021-04 to
  2024-07.

The standard trade each moment measures is a limit held the strategy's
`valid_bars` base bars after its bar's close, the plan the gate allows (the
history library measures it the same way).

**The experience index.** This is the record of the model's own past
decisions. It is built only from practice-train runs' experience logs, and
it is walk-forward: a bar is shown only the days before its session.

```bash
node scripts/experience-index.js build <run home> ... --seed 1    # -> <FTH_HOME>/experience/index-<hash>.json
node scripts/experience-index.js show <index file>
```

A run names its index in `experienceIndex` and pins it when it starts. With
no index, the run is the "without" arm.

## 3. Preflight

Before every learning replay, the training preflight checks that the run is
set up for both goals. `scripts/replay.js run` runs it before the learning
gate and refuses to start on any FAIL. Nothing is seeded and no look is
taken. You can also run it on its own:

```bash
node scripts/training-preflight.js --config replay.json --bars MNQ=<the run's 1m bars> [--validate]
```

Each check prints one line:

- **PASS**: the check holds.
- **FAIL**: the check doesn't hold. The run is refused, and the line says why.
- **WARN**: something to look at (a skill under its minimum in the curated
  list). Never refuses.
- **N/A**: the feature is on a branch not merged yet ("not available (needs
  <branch>)": the composed scorecard), or the check doesn't apply to this run
  (the head prompt on a harness other than opencode, or full role-skills mode;
  the account states on a run without them). Never refuses. Every other
  feature is merged and judged: a run without it FAILs.

The checks:

- strategy, and its `valid_bars` (1 to 3)
- the skills crosswalk
- the head prompt and its four composed reads (opencode, index mode)
- generated adapters in sync
- no web in the replay (`no-web-in-replay`): the replay step's permissions let
  no agent search or fetch the web, and the news analyst is not launched (a
  replayed date's news is on the web). It reads the user's own config each
  CLI inherits too: a shell or fetch-like MCP tool it allows, or an MCP server
  other than `broker` and `harness`, FAILs (Claude Code loads only those two in
  a replay; Codex runs with its network off and web search disabled). A custom
  command FAILs a learning run unless the replay config attests `noWeb: true`
- the facts (a sample briefing on the bars you give: 1h, 4h, 15m, 3m and 5m,
  VWAP, FVGs, briefing age)
- the curated list (its fingerprint, market, use and lists), and its source
  (its moments' entries against the run's bars; N/A with nothing to compare)
- the split window
- latency (charged on every learning run)
- practice mode
- the library display (shown only on an evaluation's arm, `--evaluation`)
- the experience index, its exit plan the run's (its decisions scored under
  the exit the run's composed trades are managed by)
- the risk record (N/A when `riskRecordDisplay` is off)
- the ledger look
- the stage (stage 2's own requirements: the account states on a
  practice-train run, the prop risk rules and the Monte Carlo)
- the composed scorecard (N/A until `fix/scorecard-composed`)
- `prop_portfolio` and its rulebook, and the rulebook's missing keys
- the account states (N/A on a run without them): the document the config
  resolved, drawn on the account `prop_portfolio` trades, from practice-train
  runs only, under the gate's loss limits now, every bucket the paths have
  given a day of the run
- the account facts: the attempt line the runner shows (from a real attempt
  record and snapshot, on the run's after-losses draw when it has one) holds
  the balance, floor, cushion, profit, the day of the attempt, the profit
  needed, the daily and soft room, today's trades, losses and streak, and
  nothing that says the state was drawn
- the Monte Carlo

The 5m facts need a 1m data lane in the runner config
(`{ "timeframe": 1, "trigger": "data" }`) and one-minute bars in `--bars`, as
live. Each start (and each resume) appends its result to the run home's
`preflight.jsonl`. A resume runs the preflight again, so give it `--bars` again.
The training loop (`scripts/train-loop.js`) runs the same preflight before each
champion run; its facts read the loop's data source (`evaluator.data`; the evaluator is `scripts/lib/train/evaluator.js`, whose
logic is in `scripts/lib/prop/`, not the retired backtester prop runs), and are
N/A ("no bars given to the loop") without one. A loop's replay config sets
`practice` like any practice-train run.

## 4. Stage 1: learn to trade

The `stage: 1` preset needs:

- a practice-train or practice-validate run;
- a curated list on practice;
- latency charged;
- the history library hidden (`libraryDisplay` off);
- the risk record hidden (`riskRecordDisplay` off);
- no `prop` attempt.

It defaults `latency` to true and `libraryDisplay` and `riskRecordDisplay` to
false. An explicit value that contradicts the preset (`"learning": false`,
`"latency": false`, `"libraryDisplay": true`, `"riskRecordDisplay": true`, or
a `prop` in stage 1) is refused, never silently changed. `stage` is part of the run's hashes.

**A practice run:**

```json
{
  "runId": "s1-practice-01",
  "workDir": "~/fth-replays",
  "broker": "backtester",
  "stage": 1,
  "start": "2022-03-01T00:00:00Z",
  "end": "2022-04-01T00:00:00Z",
  "practice": { "mode": "setup-focus", "setupTf": 15, "quietSample": 0.15, "seed": 1 },
  "curatedList": { "file": "~/.futures-trading-harness/experience/curated-practice-<fingerprint>.json", "list": "mix" },
  "experienceIndex": "~/.futures-trading-harness/experience/index-<hash>.json",
  "autotrader": {
    "harness": "opencode", "model": "", "symbols": ["MNQ"], "account": "1", "timeframe": 3,
    "lanes": [{ "timeframe": 3, "trigger": "bar" }, { "timeframe": 1, "trigger": "data" }],
    "sessions": ["09:30-15:50@America/New_York"], "premarketAt": "08:00@America/New_York", "eodAt": "15:50@America/New_York"
  }
}
```

```bash
node scripts/replay.js run --config s1-practice.json --bars MNQ=<1m bars>
```

**A validate run:** the same, with a window in practice-validate (for
example `"start": "2024-07-01T00:00:00Z"`, `"end": "2024-10-01T00:00:00Z"`),
the validate list (`curated-validate-<fingerprint>.json`), `--validate` and
`--candidate <name>`, the name of the skill version being validated. Every
validate run is a look, logged in the ledger and counted.

**At the end of the run**, the replay prints:

- **Skill usage.** For each skill: used, correct, wrong, missed and outcome
  (the skill-usage report, `scripts/lib/learning/skill-usage.js`; the same
  report runs alone: `node scripts/skill-usage.js <run dir>`).
- **The scorecard summary.** Decisions, agree, disagree, unchecked.
- **R by setup.** For each setup step's skills: the decisions with an R,
  how many were entered, and their mean R.
- **The stage-1 exit test,** on a validate run only.

**The exit test** (owner-confirmed). The thresholds live in one place:
`EXIT_TEST` in `scripts/lib/replay/stage.js`.

| Test | Threshold |
| --- | --- |
| Average winner | at least 1.8R, realized |
| Expectancy | at least +0.3R per entry, and the lower bound of its interval above 0 |
| Correct-read rate | at least 0.80 of the composed decisions with every read true |
| Process adherence | at least 0.80 scorecard agreement |

Planned reward:risk (at least 2R) is printed as a sanity line, not a
criterion: `min_rr` already enforces it. The correct-read rate counts
decisions, not reads: a decision passes only when all its reads are true, so
many trivially true reads can't carry a false one.

**Pooled over the candidate's validate runs.** The test is never judged on
one run alone: each retry of a run would be a fresh chance at a false pass
(about 1 to 2% a run at zero edge). It pools the candidate's validate runs
from the ledger, the first 3 only (`VALIDATE_RUNS_PER_CANDIDATE` in
`scripts/lib/learning/looks.js`). A later run of that candidate is not read
and can't change the verdict. The runs are read from their run homes beside
this one (the same `workDir`); a counted run that isn't found makes the test
fail. A run without `--candidate` is its own candidate, so its retries never
pool and its test can't pass. A new skill version is a new candidate. Give
the candidate's runs different windows: two runs of the same days add
correlated samples, not independent ones.

Each threshold reports PASS only over at least 20 samples. That is the
experience index's `MIN_N`, the same rule a cell needs before it shows a rate.
Below 20 it reports "insufficient sample (n)", never PASS. The average winner
needs 20 winners. At the thresholds' own profile (winners 1.8R, losers 1R,
+0.3R a trade: a 46% win rate) that is about 43 entries on average and 53 to
reach it nine times in ten (61 at a 40% win rate). Plan for 50 to 60 entries
across the pooled runs, and they must be distinct: runs over the same days replay the same
moments, so each (day, moment) counts once (the report says "overlapping validate windows:
counted once"). The expectancy's
interval is the experience index's day bootstrap (90%, whole trading days
resampled), so it also needs 10 distinct days (`MIN_DAYS`). Process adherence
is N/A until the scorecard scores composed setups
(`fix/scorecard-composed`), and the test can't pass while any line is N/A.

**An A/B of a skill change.** Run two replays with the same stage, seed and
list. They differ only in the skill. Score each one
(`node scripts/replay.js scorecard <run dir>`), then compare them with the
paired test in `scripts/lib/train/paired.js` (`pairUp`, `judge`), the same
test the training loop (`scripts/train-loop.js`) applies. There is no
standalone compare command yet. Keep the change only if it is measurably
better.

**A skill edit needs the owner's OK** before it is made or kept.

### Propose–Probe–Compose

Stage-1 tuning, inside the training loop (section 6): find good skill
edits faster without loosening the bar for keeping one. A cheap screen
first, then the strict test. The LLM proposes; code judges every step.
It is on when the loop config has a `probe` block
(`scripts/lib/train/probe-config.js`), and it needs `modelScore`:

```json
"probe": {
  "replay": "s1-practice.json",
  "windows": [{ "from": "2022-03-01", "to": "2022-04-01" }],
  "k": 4,
  "parallel": 1
}
```

`replay` is a stage-1 practice config with a curated practice list (as in
"A practice run" above), and `windows` lie in practice-train. Its
`autotrader` must be the loop's (leave it out to use the loop's), so the
probes and the keep rule run the same model and runner config. Each
iteration of the loop then runs these steps (`scripts/lib/train/probe.js`):

0. **Split.** The curated moments are split by session date, by a seeded
   hash (the loop's `seed`), into a probe half and a confirm half, both in
   practice-train. The iteration's `probe-report.json` records the seed and
   each half's dates. Give the windows enough session dates for both
   halves (a half with too few decisions shows no gain).
1. **Findings.** The champion replays the windows' curated moments. Its
   skill-usage report and scorecard on the probe half give the skills with
   the most misreads, misses and wrong-reason refusals
   (`scripts/lib/train/findings.js`). A refusal is credited to the skills
   whose reads the model composed at that bar.
2. **Propose.** One proposer call (the `design-self-review` skill's probe
   prompt) writes up to `k` small, independent skill edits. Each targets
   one finding and carries a tag: the skill, the finding and the edit's
   kind (rewording, example, rule or removal). Code checks every edit
   (`scripts/lib/train/probe-edit.js`): one skill's file, no new numbers
   (in digits or words, such as "three bars" or "half"), condition → action
   lines of at most 120 characters, a removal that removes, the frontmatter
   untouched, and the skill's byte cap (`scripts/lib/skill-caps.js`, the
   same caps the basics-skills test enforces). An edit probed before is
   not run again.
3. **Probe.** Each edit's tree replays the same curated moments with the
   same replay config and seed as the champion. Code pairs the two runs
   decision by decision on the probe half only
   (`scripts/lib/train/screen.js`), under one exit plan (two runs whose
   exit plans differ are refused): the correct-read rate per decision,
   process adherence, R per decision, and the target. The target rewards
   reading better, never claiming more: for a misread, only the decisions
   where the champion claimed the skill; for a miss, only those where the
   skill was relevant at the bar (a TRUE read of it pointed the side's
   way); for a wrong-reason refusal, the refusals fixed. A fix counts only
   when the decision's scorecard result got no worse. The targeted skill's
   used, correct and missed counts are shown beside them. The verdict is
   `helped`, `no effect` or `hurt`.
   Probing uses practice-train only and spends no looks: its tuning look
   is logged in the loop's ledger, as every loop look is, and counts
   against no budget.
4. **Compose.** Code combines every edit that helped into one change
   (`scripts/lib/train/compose.js`). Two edits that touch the same lines:
   the larger paired gain stays and the conflict is reported. An edit that
   would break the proposal's limits (3 edits, the diff size, a byte cap)
   is left out, with the reason. The combined change is probed once more
   and judged on the confirm half only, which no edit was chosen on: no
   measure may be worse and every part's target must still gain there, so
   its parts can't cancel and a gain found by chance on the probe half
   doesn't carry it.
5. **Keep.** The combined change is the iteration's one proposal and goes
   through the full keep rule (section 6), unchanged: the challenger's
   full-day tuning windows, zero blows, the pooled interval, then held-out
   judging as its own step. A kept change is a local branch and a PR body
   that lists its parts. Nothing merges, and no skill is edited on main:
   edits exist only in the probe trees and the PR.

**The screen's thresholds** are `SCREEN` in `scripts/lib/train/screen.js`,
the one place:

| Setting | Value | Meaning |
| --- | --- | --- |
| `gainAlpha` | 0.1 | a gain on the target: one-sided McNemar p at most this |
| `harmAlpha` | 0.2 | a harm on any measure: p at most this (quick to call a harm) |
| `minDiscordant` | 4 | the discordant decisions a gain or a harm needs |
| `minPairs` | 10 | the paired decisions R per decision needs before it can show a harm |
| `minEffect` | 0.10 | a gain's size: fixed minus broken, as a share of the target's paired decisions |

A gain needs a practical size (`minEffect`: at least a tenth of the target's
paired decisions improved, net) and significance (`gainAlpha`, with at
least `minDiscordant` changed decisions). Noise at small n is the test's to
catch: 3 fixed and 0 broken never passes (under `minDiscordant`), 4 and 0
on 30 pairs does (p 0.0625, effect 0.13), 8 and 0 on 80 does (p about
0.004), and 5 fixed and 1 broken on 40 has the size (0.10) but not the
significance (p about 0.22). The screen requires both a practical size and
significance, and the strict keep rule is the real gate.

The screen is permissive: it only filters noise. Passing it keeps nothing.
The keep rule stays strict and unchanged.

**The lessons record** (`<loop dir>/lessons.jsonl`,
`scripts/lib/train/lessons.js`) is append-only and written by code. Each
probed edit (and each combined change) gets one line: the skill, the
edit's kind, the finding, the paired measures, the verdict, n, the split
seed and the half it was judged on. A combined change that went to the
keep rule gets one more line with the keep rule's verdict (its tuning
windows are practice-train), so a screen `helped` that the keep rule
rejected shows as such in the summary, on the change and on its parts. The
proposer reads a short, capped summary of it in the next round, for
example "a, rewording (misread): helped 3 of 4, no effect 1, hurt 0 (n per
probe: 12, 9, 15, 20)". It is evidence only, labelled with its sample
sizes. It holds practice-train lines only: a line on any other window is
refused, and no validate, test or final outcome is ever in it.

**Cost.** K probes multiply model time. The champion replays the probe
windows once per loop. Each round then replays them k + 1 times: each of
the k edits and the combined change. That is about k + 1 times the model
time of one practice run a round, on top of the keep rule's runs. Probes
run one after another by default (`parallel: 1`). `parallel` above 1 is
refused unless `probe.replay` sets `latency: false`: a replay that
charges each cycle's real time would charge probes queued at the model
server more than the champion's probe run, which runs alone. Raise it only
when your local model server serves that many prompts at once (its own
concurrency setting, in your local config).

## 5. Stage 2: pass prop

The `stage: 2` preset is stage 1 plus:

- account states (`accountStates`; required on a practice-train run);
- account facts (the attempt line);
- the prop risk rules: `loss_streak_stop` and the exit mode.

`prop` is allowed in stage 2, but a curated list can't be combined with
`prop` (the replay config refuses it), so a curated stage-2 run gets its
account from the account states.

**Practice with account states.** Stage 2 teaches the model to pass the
combine: grow the balance to the target, never touch the max loss limit, in 30
days or fewer. So each practice day starts from an account state, not always a
fresh account:

1. **Draw the states** from practice-train runs of the model (its own trades):

   ```bash
   node scripts/account-states.js draw --run <run dir> [--run <run dir> ...] --account <prop_portfolio's account> \
     [--lists <curated lists of those runs>] [--seed 1] [--paths 500] [--count 200] [--oversample near-mll=3,after-losses=3]
   node scripts/account-states.js show <FTH_HOME>/experience/account-states-<hash>.json
   ```

   The draw runs the 30-day Monte Carlo of those trades (a curated run's at
   its lists' natural rates) and takes every decision moment on its paths: the
   account as each day opened, and after each trade while a new entry was
   still allowed. Each moment falls in a bucket: near the max loss limit
   (`near-mll`), after a loss today (`after-losses`), near the target, the
   first session (`fresh`), or `mid`. The draw is stratified: near-limit
   states are oversampled (3x by default), and each draw records its sampling
   weight, the bucket's natural share over its share of the draws. The
   document is hashed.

2. **Name it in the practice config:** the stage-1 practice config with
   `"stage": 2` and `"accountStates": { "file": "<the document>" }`. The run
   needs its runner config's `account` (the replay broker's account). The draw
   and its assignment to the run's days are in both run hashes, so a resume
   can't change them; the replay broker stops the day at the account's daily
   loss limit.

3. **What the run does.** Day k of the curated windows (in time order) takes
   draw k. Before the day's first step, with the account flat, the driver
   appends the day's balance and today's P&L to the run's balance schedule
   (the replay broker reads it: the replay-only setting
   `BACKTESTER_BALANCE_SCHEDULE`), seeds the attempt record (closed days on
   the sessions before it, the peak, today's trades, losses and streak), and
   checks the broker now reports the drawn balance. A broker that doesn't
   apply the schedule refuses the run. A day that opens with a position still
   open goes on from the attempt it has. The runner, the gate and the attempt
   line then work as live from that state: the soft stop, the loss streak
   stop and the gate's daily loss count include the losses carried into the
   day.

4. **What the model sees.** Its normal attempt line: balance, floor and
   cushion, profit against the target, the day of the attempt, the profit
   still needed, the room to the daily limit and the soft stop, today's
   trades, losses and streak, and the consistency headroom. Nothing says the
   state was drawn, and no outcome is shown.

5. **The scores are reweighted.** At the end, the stage report prints the
   practice by account state: each day's attempt as it ended (blown, stopped
   for the day, at the target, its P&L), as practised and reweighted to the
   natural mix of states. The prop Monte Carlo weights each decision by its
   day's state weight, so the model's take rate counts at the natural mix.
   The take rate is per curated moment: every moment the run stepped is a
   candidate, including one the model composed nothing on, and a moment it
   entered twice counts as one entry.
   Read the reweighted numbers; the raw ones are the oversampled practice.
   The weights come from the planned assignment, not from the days actually
   run (the report line says "N of M days run"). A moment whose loss streak
   is at the gate's consecutive-loss limit is never drawn: a seeded day puts
   its last loss at the window start, where that cooldown would still run.

**Validate with the promotion gate:** the stage-1 validate config with
`"stage": 2` and `--validate`. At the end, the run prints the promotion gate
(`scripts/lib/prop/promotion.js`, frozen: 0 blows in every out-of-sample
month, a pass rate of at least 40% over at least 20 independent attempts and
2 months). It is judged on the Monte Carlo's attempts (see the prop report).

**An A/B of a risk-skill or rulebook change:** as in stage 1. Two runs with
the same stage, seed and list, judged with the paired test. A rulebook change
is screened by the training loop's evaluator first, but only where it can:
the evaluator's layer 1 takes setups with a mechanical stop distance, and
`trade_lifecycle` (the one strategy `prop_portfolio` lists) has none, so the
screen finds no trades. Without the loop's model scoring (section 6) such a
change stays blocked; with it, the change is judged on the model's own trades.
The backtester's own prop runs are retired
(`docs/research/mechanical-prop-backtester.md`).

**The model's risk record.** `experience_lookup` can end with a "Your risk
record" section: by account state, what reverting the model's own risk
decisions (standing down, sizing under the ceiling, exiting early, stopping
for the day) did to the blows and passes over the same Monte Carlo paths. It
is off by default. Build it from finished practice-train runs:

```bash
node scripts/risk-record.js build <run home> ... --account <name> [--out dir] [--seed N] [--paths N] [--reps N] [--min-n N]
node scripts/risk-record.js show <record file>
```

For each day with a risk action, the build reverts that day's actions alone,
over paths drawn from the run's days up to and including it, so a day's entry
holds nothing from later days. The model sees an entry only on bars after its
day. The output is `risk-record-<hash>.json`, fingerprinted with the runs,
account, seed and path count it was built from. The build refuses an
unfinished run, a run that isn't practice-train, a setup-focused or curated
run (its setups come at practice density, not a live day's: build from
full-day practice-train runs), and a day that two runs both hold.

To show it, set `"riskRecord": "<file>"` and `"riskRecordDisplay": true` in
the replay config. In stage 2 the display also needs `"comparisonArm": true`:
the run is one arm of a with/without pair, judged with the paired test. Stage
1 refuses the display. The preflight's `risk-record` check fails when the
display is on without a practice-train-built record, or on a test or final
run (or a window spanning two roles); it is N/A when the display is off. A
practice-validate run may show it: the record holds practice-train days only,
so it is train-derived evidence like the walk-forward experience index, and
validation outcomes never enter it. The run pins the record with its display
and its `comparisonArm`, and a resume can't change any of them.

**The 30-day Monte Carlo** is printed at the end of a stage-2 run. Read it in this order:

1. **0 blows.** This is a hard rule: any blow fails.
2. **Passes within 30 days.**
3. **The median and p90 days to pass.**
4. **The breakdown by account state.**

The Monte Carlo of a curated run is diagnostic only: the curated moments are
reweighted, not a calendar of whole days.

## 6. The training loop's keep rule

With `modelScore` in the loop config (`scripts/train-loop.js`), the loop
judges a change on the model's own trades. The verifier is
`scripts/lib/train/model-verifier.js`, and the keep rule lives only there.

```json
"modelScore": { "account": "<account profile>", "paths": 2000, "reps": 2000, "faults": "stop=0.01,outage=0.005" }
```

`account` is required. `faults` is optional; without it, faults are not
measured. The seed is the loop's, and both sides use it.

**What runs.** The challenger's tree replays every window the champion
replayed: the same replay config, the same seed, the same days. Then, window
by window, the two runs are scored:

- **The paired 30-day Monte Carlo** (`prop/model-score.js pairRuns`). Both
  runs go through the same start days, the same resampled day blocks and the
  same faults. Each side is scored as the model traded: every entry at its
  own filled share of the code's ceiling, and at its own exit where it took
  itself out (an early exit, a tightened stop). An exit the runner made (its
  trail or time stop, read from the run's event log) is the policy's, not the
  model's. The policy's exit re-exits every trade the model didn't take out
  itself. So a challenger that cuts losers near
  the max loss limit scores apart from one that holds, and one that sizes up
  pays for it. The ceiling-sized result (every entry at the ceiling under the
  policy's exit) is printed beside it, labelled, and never judged. Every
  difference is champion minus challenger, with a 90%
  paired interval. Two kinds of attempt come out of it:
  - **real attempts**, one per start day of the window. Their interval is a
    block bootstrap in blocks of the account's sessions (S, 30), so it
    counts independent stretches of days. This is the evidence.
  - **resampled paths**, which redraw the window's own days. Their interval
    shrinks as `paths` grows, whatever the effect, so it measures Monte Carlo
    precision, not evidence. These figures are conditional on the window's
    days, and only rules (a) and (b) read them.
- **The paired decision measures** (`train/paired.js`), each an exact
  one-sided McNemar test:
  - process adherence: each scorecard decision right or not;
  - the correct-read rate: each decision's reads all verified true or not.
    A read the champion made and the challenger didn't counts against the
    challenger.

**The keep rule.** The primary measure is fixed before any run: the pass
rate within the account's sessions, on the real attempts. The median days
to pass is secondary; it is reported and never keeps a change. In this
order:

1. **(a) Zero blows for the challenger.** This is a hard rule. A blow in any
   real attempt or resampled path of any window rejects the change.
2. **(b) No significantly worse blow rate** on the resampled paths of any
   window.
3. **(c) A gain on the real attempts.**
   - **One pooled interval.** The per-start-day differences of every window
     are stacked, and one paired interval is taken over them, a block
     bootstrap in blocks of S inside each window. For the pass rate it must
     be wholly in the challenger's favour.
   - **No window worse.** No window may be significantly worse on its real
     attempts in pass rate, blow rate or median days to pass.
   - **Enough days.** A window needs at least two blocks of S real start
     days (`KEEP_RULE.minBlocks`), so at least 3 × S session days: 90 for 30
     sessions, about four and a half months. A shorter window shows nothing,
     and the verdict is `inconclusive`. A 1-month practice window (about 21
     sessions) or a 3-month validate window (about 64) is always
     inconclusive. Two blocks is already the fewest a block bootstrap can
     resample, so the minimum is not lowered.
4. **(d) Process adherence and the correct-read rate are not significantly
   worse** in any window. "Significantly" uses the loop's decision rule: at
   least `minDiscordant` discordant decisions and p at most `alpha`. Each
   needs at least the rule's `minPairs` paired decisions (20), and the
   challenger must have decided on at least half of the champion's keys.
   Fewer, or decisions that don't pair, is `inconclusive`, never a pass.

**Windows that work.** Full-day windows (no `curatedList` in the loop's
replay config: the config refuses one with `modelScore`, and `pairRuns`
refuses a curated run), each at least 90 sessions:

```json
"tuningWindows": [{ "from": "2023-01-03", "to": "2023-06-01" }, { "from": "2023-06-01", "to": "2023-11-01" }],
"heldOutWindows": [{ "from": "2024-07-01", "to": "2025-01-01" }]
```

These hold 103, 106 and 128 sessions. A curated run is never paired: its
moments are picked outcome-balanced, so even at natural rates its outcomes are
the list's, not the market's, and its rebuilt days are drawn, so it has no
real start days to pair.

A change that adds return but adds a blow is rejected. A change with no
significant pooled gain is not kept. A measure that can't be read (an
unsettled entry, a run without its reads, a window too short, too few
decisions) is never a pass: the verdict is `blocked` or `inconclusive`.

The other verifiers can still only reject:

- the panel's paired test: blows, and any failure category broken past its
  tolerance or significantly worse;
- the mechanical evaluator: blows and failures.

With model scoring, a strategy or rulebook change is no longer blocked for
want of a mechanical screen.

**A rulebook change.** The account's firm rules (its `ACCOUNT.md`: sessions,
target, max loss, daily limit) must be the same in both trees, or the change
is blocked. The policy's sizing, exit and multipliers (the account's
`RULEBOOK.md`) and its contracts may differ:

- each side is scored under its own rulebook, with the same seed, start days
  and day blocks;
- the challenger's is a candidate rulebook. It is judged only on
  practice-train and practice-validate, and refused on test and final;
- a change to the exit is labelled "different trade streams under different
  sizing/exit";
- a rulebook that loosens a limit the rulebook guard forbids
  (`train/rulebook-guard.js`) is rejected without being scored.

**Splits and looks.**

- Tuning windows must lie in practice-train; the config refuses others.
- Held-out windows must each lie in one held-back learning window
  (practice-validate, test or final), and the loop needs
  `learning.evaluation`. Each held-out run, the champion's and the
  challenger's, takes its own look in the learning ledger before its first
  cycle. On test, that is two looks per window from its budget of 3.
  Judging is refused before any look is taken when the budget left can't
  hold them all, so final (one look) can't be judged this way. Judge on
  practice-validate first.
- A setup-focused (diagnostic) score can keep a change on tuning, labelled
  diagnostic, but it never judges held-out months and never promotes. A
  curated run is never paired.
- The promotion gate (`prop/promotion.js`) is frozen and stays the final
  gate. Held-out judging reports its verdict on the challenger's score
  beside the keep rule, and never replaces it. A kept change is not a
  promotion, and a candidate rulebook is never promoted.

**A kept change is a pull request for the owner.** The loop writes a local
branch and a PR body draft with the keep rule's table. Nothing is pushed or
merged, and no document is edited outside the candidate's own tree.

## 7. Sealed test and final

- **The budgets.** Test (2025) has 3 judging looks and final (2026) has 1.
  Final needs a test pass first (`scripts/lib/learning/looks.js`).
- **Running a sealed window.** Name the candidate and the evaluation:
  `--candidate <name> --evaluation <id>`. The arms of one evaluation share the
  id: with the index, without it, and shuffled. They differ in their
  experience index only.
- **The ledger.** Every look is written to the one ledger,
  `learning/looks.jsonl` in the default harness home (whatever `FTH_HOME` says), before the first cycle. It records the run,
  arm, setup and window.
- **Resumes.** A resumed run's repeat look is free and keeps its arm and
  setup.
- **Never reused.** A look isn't reused for another candidate, and a spent
  budget doesn't come back.
- **Reasoning-fix looks.** `--reasoning-fix` takes a free look whose outcomes
  are hidden.

### The schedule is config

Both schedules, the learning split above and the prop promotion schedule
(`scripts/lib/prop/splits.js`), live in one file, `config/schedule.json`.
It also holds the look budgets, the validate cap per candidate, the
recorded looks and the data dates. Before, they were two copies in code,
and when the copies disagreed, valid runs were refused. Now every module
reads the file through one resolver, `scripts/lib/schedule.js`.

The file has an `open` part and a `sealed` part for each schedule:

- **Open:** practice-train and practice-validate (learning), train and
  select (prop).
- **Sealed:** test and final with their budgets, final's test-pass rule,
  the validate cap and the recorded looks (learning); out-of-sample,
  Recent, the LLM month, the reserve size, the look budget and the
  recorded looks (prop).

What you can and can't change:

- **You can extend the data dates** (`data.start`, `data.flowCoverage`;
  the curated-lists scan refuses a `--from` before `data.start`).
  New months need no edit: they fall into the half-year walk-forward and
  reserve blocks by rule.
- **You can move the open windows.** For example, start practice-train
  earlier, or change where practice-validate starts. Windows must stay in
  order and must not overlap; a gap is allowed, and its days have no role.
- **You can't change a sealed part once a look was taken under it.** For
  learning, that is any ledger entry at test or final; for prop, any look.
  The recorded looks count as such looks, so today both sealed parts are
  fixed. Changing a sealed window after looking at it would let a result
  pick its own test.
- **Keep the ledgers.** The ledger files are the evidence of sealed looks, so
  keep them backed up and never delete them.
- **A changed file needs a new `version`.** If you edit the file and keep
  its version name, the change is refused.
- **Budgets only tighten.** A test refuses a higher look budget or validate
  cap, a smaller reserve, or final without its test-pass rule.

How it's enforced:

- **Fingerprints.** Every ledger entry, `learning-run.json` and replay
  manifest records the schedule it was taken under: its version, its hash,
  and a hash of each sealed part. `lookUsage` reports the version of each
  look. Entries written before fingerprints count as version `v1`.
- **The ledgers check every look.** A look under a schedule whose sealed
  part differs from the one a sealed look was taken under is refused.
- **The preflight `schedule` check** FAILs on the same rule. It also FAILs
  when a look in the run's evaluation was taken under another schedule,
  since the arms of one evaluation must be comparable. A resume under
  another schedule gets a WARN.
- **Fail closed.** A missing or unreadable file, an unknown or missing key,
  a bad date, or overlapping windows refuse everything that needs a role.

The promotion gate's thresholds stay frozen in code
(`scripts/lib/prop/promotion.js`). Only when its windows fall comes from
the schedule.

## Tuning plan (stages 1 and 2)

Stage 1 tunes setup decisions. Stage 2 tunes risk decisions by account
state, also scored by the 30-day Monte Carlo. Both follow the same plan:

1. Run Propose–Probe–Compose rounds until the correct-decision rate stops
   rising. Stopped: two rounds in a row with no significant paired gain on
   the same moments.
2. A skill that doesn't move after rounds of wording edits → switch
   levers: make the fact clearer in the briefing (code), or rely on LoRA.
3. Train LoRA on correct decisions made under the settled skills only
   (the same skills and prompt digest). Validate base against adapted
   with the keep rule.
4. Run more Propose–Probe–Compose rounds with the adapter, on the
   remaining errors only.
5. Retrain the adapter only when the skills change meaningfully. The
   preflight refuses a stale adapter.
6. Done: stage 1 when its exit test passes (pooled validate runs); stage 2
   when the promotion gate passes on validate. Then the sealed 2025 test,
   then 2026.

Track per round: the correct-decision rate overall and per skill, with
correct passes and correct entries reported apart.

The LoRA steps are the LoRA section's (branch `feat/lora-ready`, not merged
yet).

## 8. Rules that keep it honest

- **No outcomes shown to the model.** It sees only its own record (the
  walk-forward experience index), never a run's results or labels.
- **Latency charged.** Each cycle's real time runs on the replay clock, as
  live: orders go, fill and expire at the bar plus the cycle's time, and a
  compose record holds `valid_bars` base bars.
- **Library hidden.** The history library is hidden unless the run is a
  library comparison arm: `libraryDisplay` on an evaluation's arm (a run naming
  `--evaluation`; a practice-train run names none, so it never shows it).
- **Walk-forward index.** It is built from practice-train only.
- **Resumes can't change settings.** A resume keeps the run's role, look, arm,
  pins and list. Start another runId to change them.
- **Practice equals live.** The same runner, agents, skills, gate and
  briefing. Only the data, the clock and the fills are simulated.

## 9. Troubleshooting

| Message | Meaning |
| --- | --- |
| `training preflight refused the run` | A preflight check failed. Its `FAIL` line says which and why. |
| `FAIL facts: no bar data for MNQ` | Give the run's bars: `--bars MNQ=<file>`. |
| `5m candle (not whole 3m bars; no 1m bars configured)` | Add a 1m data lane to the runner config and give one-minute bars. |
| `FAIL practice-mode: a practice-train run sets its practice mode` | Add `practice` to the replay config. |
| `<key>: ... contradicts stage 1 (learn to trade)` | Remove the key, or change the stage. |
| `practice-validate months need the validate flag (--validate)` | A validate run needs `--validate`. |
| `test is sealed: name the candidate it judges (--candidate) and the evaluation id its arms share (--evaluation)` | A sealed window needs a judging look. |
| `look refused: final: candidate ... has no test pass` | Final comes only after a test pass. |
| `a resume keeps it (start another runId to change it)` | The config changed under a started run. |
| `FAIL facts: no bar data for MNQ` on a resume | A resume runs the preflight again: give it the bars again (`--bars MNQ=<file>`). |
| `PASS latency: pinned: a resume of a run started before latency was charged` | A run started before the setting keeps its pinned clock on resume; a new run charges it. |
| `index refused (leakage)` | The index was built from runs outside practice-train. |
| `curatedList: runs through setup-focused practice; set practice too` | A curated run needs `practice`. |
| `a validate curated list runs on practice-validate, not on this practice-train run` | You used the wrong list for the window. |
| `libraryDisplay: shows the pinned history library; name it (setupLibrary)` | The display needs a library to show. |
| `FAIL curated-source: ... disagree with the run's bars` | The list was scanned from another series than the run's bars: scan it from the bars the replay serves. |
| `FAIL library-display: libraryDisplay is on, but the run is no library comparison arm` | Show the library only on an evaluation's arm (`--evaluation`). |
| `riskRecordDisplay: true in stage 2 (pass prop) only on a run declared a comparison arm` | Add `"comparisonArm": true`, or turn the display off. |
| `FAIL risk-record: ... the risk record is shown on practice-train and practice-validate only` | Show the risk record only on practice-train or practice-validate runs, not test or final. |
