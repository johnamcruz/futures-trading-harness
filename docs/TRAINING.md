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
  states, account facts and prop risk rules (phase 2, not merged yet).

Stage 2 starts only after stage 1's exit test passes on a validate run.
Both stages use the same curated lists throughout.

The data split (`scripts/lib/learning/splits.js`):

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
- **History coverage.** The history starts 2021-04, so practice-train
  effectively covers 2021-04 to 2024-07.

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
- **N/A**: the feature is phase 2's, or on a branch not merged yet ("not
  available (needs <branch>)": the composed scorecard, the rulebook's
  `loss_streak_stop` and exit mode, the account facts, the Monte Carlo), or
  the check doesn't apply to this run (the head prompt on a harness other than
  opencode, or full role-skills mode; stage 2's own requirements). Never
  refuses. Every other feature is merged and judged: a run without it FAILs.

The checks:

- strategy, and its `valid_bars` (1 to 3)
- the skills crosswalk
- the head prompt and its four composed reads (opencode, index mode)
- generated adapters in sync
- the facts (a sample briefing on the bars you give: 1h, 4h, 15m, 3m and 5m,
  VWAP, FVGs, briefing age)
- the curated list (its fingerprint, market, use and lists), and its source
  (its moments' entries against the run's bars; N/A with nothing to compare)
- the split window
- latency (charged on every learning run)
- practice mode
- the library display (shown only on an evaluation's arm, `--evaluation`)
- the experience index
- the risk record (N/A when `riskRecordDisplay` is off)
- the ledger look
- the stage (stage 2's own requirements: N/A until phase 2)
- the composed scorecard (N/A until `fix/scorecard-composed`)
- `prop_portfolio` and its rulebook; the rulebook's missing keys, the account
  facts and the Monte Carlo (N/A until phase 2)

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
the validate list (`curated-validate-<fingerprint>.json`), and `--validate`.
Every validate run is a look, logged in the ledger and counted.

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
| Planned reward:risk | at least 2R on every entry (`min_rr` enforces it; the test checks none fell under) |
| Average winner | at least 1.8R, realized |
| Expectancy | at least +0.3R per entry, and the lower bound of its interval above 0 |
| Correct-read rate | at least 0.80 of the compose records' reads true |
| Process adherence | at least 0.80 scorecard agreement |

Each threshold reports PASS only over at least 20 samples. That is the
experience index's `MIN_N`, the same rule a cell needs before it shows a rate.
Below 20 it reports "insufficient sample (n)", never PASS. The expectancy's
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

## 5. Stage 2: pass prop

The `stage: 2` preset is stage 1 plus:

- account states (phase 2, `feat/prop-mc-model`, not merged yet);
- account facts (phase 2, not merged yet);
- the prop risk rules: `loss_streak_stop` and the exit mode (phase 2,
  `feat/prop-portfolio-missing`, not merged yet).

`prop` is allowed in stage 2, but a curated list can't be combined with
`prop` (the replay config refuses it), so a curated stage-2 run gets its
account from the account states (phase 2). Until they are merged, the
preflight's stage check reports stage 2's own requirements as N/A with that
reason (its stage-1 part is still judged).

**Practice with account states:** the stage-1 practice config with
`"stage": 2`. The account-state settings come with `feat/prop-mc-model`
(phase 2, not merged yet).

**Validate with the promotion gate:** the stage-1 validate config with
`"stage": 2` and `--validate`. At the end, the run prints the promotion gate
(`scripts/lib/prop/promotion.js`, frozen: 0 blows in every out-of-sample
month, a pass rate of at least 40% over at least 20 independent attempts and
2 months). It is judged on the Monte Carlo's attempts, so it prints N/A until
`feat/prop-mc-model` is merged.

**An A/B of a risk-skill or rulebook change:** as in stage 1. Two runs with
the same stage, seed and list, judged with the paired test. A rulebook change
is screened by the training loop's evaluator first, but only where it can:
the evaluator's layer 1 takes setups with a mechanical stop distance, and
`trade_lifecycle` (the one strategy `prop_portfolio` lists) has none, so the
screen finds no trades and the change stays blocked until a model-trade Monte
Carlo exists. The backtester's own prop runs are retired
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
unfinished run, a run that isn't practice-train, and a day that two runs both
hold.

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

**The 30-day Monte Carlo** (phase 2, not merged yet) is printed at the end of
a stage-2 run. Read it in this order:

1. **0 blows.** This is a hard rule: any blow fails.
2. **Passes within 30 days.**
3. **The median and p90 days to pass.**
4. **The breakdown by account state.**

The Monte Carlo of a curated run is diagnostic only: the curated moments are
reweighted, not a calendar of whole days.

## 6. Sealed test and final

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

## 7. Rules that keep it honest

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

## 8. Troubleshooting

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
