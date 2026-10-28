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
The replay driver passes the account's limits (`max_contracts`, `daily_loss_limit`) to the replay broker through the variables its `brokers.json` entry names (`limits`; `mcp-configs/README.md`): change a limit in the account file, once. The size limit is the smallest `max_contracts` among the run's symbols (the broker has one size limit); an account that states none for them refuses a learning run. The preflight's `broker-limits` check confirms the broker reports them, and fails a learning run on a replay broker it cannot read.

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

A curated run's moments are picked outcome-balanced, so its decisions are
weighted back to natural rates by its curated lists document: add
`--lists <curated lists file>` to the build. Without it, or for a document
built before it recorded its candidates' outcomes, they are counted but never
rated.

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
- the adapter (N/A with none selected): the selected fine-tuning adapter's
  manifest is valid, current (its skills and prompt digests the harness's
  now) and validated (section 9)

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

**A practice run.** The run's window must hold every moment of the list
(its start at or before the list's first window), and lie in one window of
the split: here to just before practice-validate. A start in the bars' first
days fails the preflight's facts check (no completed 4h candle and no VWAP in
its sample briefing yet), so start once the bars have that history. The run
trades the runner's default sessions, the ones the scan used. A narrower
`sessions` leaves windows with no decision time, and the run is refused.

```json
{
  "runId": "s1-practice-01",
  "workDir": "~/fth-replays",
  "broker": "backtester",
  "stage": 1,
  "start": "2021-05-03T00:00:00Z",
  "end": "2024-06-29T00:00:00Z",
  "practice": { "mode": "setup-focus", "setupTf": 15, "quietSample": 0.15, "seed": 1 },
  "curatedList": { "file": "~/.futures-trading-harness/experience/curated-practice-<fingerprint>.json", "list": "mix" },
  "experienceIndex": "~/.futures-trading-harness/experience/index-<hash>.json",
  "autotrader": {
    "harness": "opencode", "model": "", "symbols": ["MNQ"], "account": "1", "timeframe": 3,
    "lanes": [{ "timeframe": 3, "trigger": "bar" }, { "timeframe": 1, "trigger": "data" }],
    "premarketAt": "08:00@America/New_York", "eodAt": "15:50@America/New_York"
  }
}
```

```bash
node scripts/replay.js run --config s1-practice.json --bars MNQ=<1m bars>
```

**A validate run:** the same, with a window in practice-validate that holds
the validate list (for example `"start": "2024-07-01T00:00:00Z"`,
`"end": "2024-12-31T00:00:00Z"`),
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
and desk-role edits faster without loosening the bar for keeping one. A cheap screen
first, then the strict test. The LLM proposes; code judges every step.
It is on when the loop config has a `probe` block
(`scripts/lib/train/probe-config.js`), and it needs `modelScore`:

```json
"probe": {
  "replay": "s1-practice.json",
  "windows": [{ "from": "2021-05-03", "to": "2022-09-01" }],
  "k": 4,
  "parallel": 1
}
```

`replay` is a stage-1 practice config with a curated practice list (as in
"A practice run" above), and `windows` lie in practice-train. Each window is
a run of that list, so it must hold every moment of the list (a run refuses
a list with moments outside its window): with a list over all of
practice-train, that is one window spanning the list, as here. The
windows share no session date with the keep rule's `tuningWindows` (the
config refuses an overlap): the dates edits are found and screened on never
judge them. Here the probes take 2021-05-03 to 2022-08-31, and the keep
rule's windows (section 6) lie after them. Its
`autotrader` must be the loop's (leave it out to use the loop's), so the
probes and the keep rule run the same model and runner config. Each
iteration of the loop then runs these steps (`scripts/lib/train/probe.js`):

0. **Split.** The curated moments are split by session date, by a seeded
   hash (the loop's `seed`), into a probe half and a confirm half, both in
   practice-train. Each half is written once per loop as a curated list of
   its own (`scripts/lib/train/probe-halves.js`: the source's moments of
   that half only, fingerprinted again), so a side replays only the half it
   is judged on: the champion each half, every edit the probe half, the
   combined change the confirm half. No edit's run holds a confirm moment.
   The iteration's `probe-report.json` records the seed and each half's
   dates, read from the list before any run. Give the windows enough session
   dates for both halves (a half with too few decisions shows no gain; a
   half with none is `inconclusive` and nothing is replayed).
1. **Findings.** The champion replays the probe half. Its skill-usage
   report and scorecard give the skills with the most misreads, misses and
   wrong-reason refusals (`scripts/lib/train/findings.js`). A refusal is
   credited to the skills whose reads the model composed at that bar. Each
   finding is placed on the step of the trading flow it blocks
   (`scripts/lib/train/flow.js`: bias, location, setup, entry, stop, target,
   then risk and execution, the desk's steps after the plan). The
   champion's confirm half runs only once a round has a combined change.
2. **Propose.** One proposer call (the `design-self-review` skill's probe
   prompt) writes up to `k` small, independent edits, each to one skill or
   to one desk role's body. The prompt gives the flow in order and the
   findings grouped by the step they block, and asks for the earliest
   step's fix first. Each edit targets one finding and carries a tag: the
   skill (or `agent`, the role), the finding and the edit's kind
   (rewording, example, rule or removal). A finding that names a skill or a
   role takes only that one. Code checks every edit
   (`scripts/lib/train/probe-edit.js`): one document, no new numbers
   (in digits or words, such as "three bars" or "half"), condition → action
   lines of at most 120 characters, a removal that removes, the frontmatter
   untouched, and the skill's byte cap (`scripts/lib/skill-caps.js`, the
   same caps the basics-skills test enforces) plus a small growth budget
   (`probeEdit.growBytes` in `config/training.json`): room for the rule or
   example a misread needs, even in a skill already over its cap. Only an
   edit that helps is kept, and its PR's checklist asks the reviewer to trim
   the bytes back before merging, so no role prompt grows. An edit probed before is not run again.
   A desk role (`agents/<role>.md`: the three analysts, `risk-manager` and
   `trade-executor`, never the reviewer, the researcher or the calendar
   analyst) is checked as well by `scripts/lib/train/agent-edit.js`: its
   frontmatter byte for byte (its tools, so only the executor ever holds
   order tools, and its skill lists), its "Load the skills" sentence, every
   heading, fenced block and paragraph naming a report format (VERDICT,
   FACTS, EXECUTED, ABORTED, PLAN, CYCLE RESULT, a line starting `Size:` or
   naming it, and a verdict word in code or quotes) unchanged and none added,
   no second `---` block in the body, no skill named that its lists don't hold
   (in code, as "the <name> skill", a hyphenated name written plainly, or a
   one-word name right after a load verb such as "read" or "use", so the word
   in ordinary prose never counts), no new number (in digits, words, vulgar
   fractions or roman numerals), and its body at most its size plus the
   growth budget.

   **What stays editable, and what guards it.** The judging prose is the
   role's reasoning and is editable: the risk manager's veto conditions
   (when to approve, when to veto, when to cut the size), and the
   executor's prose. No format guard protects them. A change there is held
   only by the code gates, which no edit can loosen, and by the keep rule.
   The gates are the approval cap (the order is never larger than the size
   phase 2 approved), `[min-contracts]`, the composed reads the gateway
   re-checks, and the contract match an exit needs. The edit's tree is synced (`sync-harness`), so every harness's
   adapter carries it, and it is probed, composed and kept exactly as a
   skill edit is.
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
   edits exist only in the probe trees and the PR. The keep rule judges
   inside the loop's iteration, which needs a panel: with `probe` on, a
   combined change reaches the keep rule only while the champion's tuning
   scorecard still holds flagged decisions not targeted before (the loop's
   panel, `maxFlagged`). Once the champion's tuning replays have run and
   nothing flagged is left, the loop stops before a round's probes ("nothing
   flagged left to work on"), however well its screen did.

**What no model's proposal edits.** Code (the order gate, the promotion
gate, the tunables, `harness-sync.js`), `config/`, `ACCOUNT.md`, `rules/`,
`commands/`, generated files and the loop's own skills are never a
document a proposal may edit. A rulebook (`accounts/<account>/RULEBOOK.md`)
is the owner's: only a proposal a person brings
(`train-loop.js import-proposal --approved-by <name>`) may edit it, and
then only to tighten it (`scripts/lib/train/rulebook-guard.js`).
`scripts/lib/train/proposal.js` refuses it in every model's proposal, the
probe round's and the single-shot proposer's alike.

**The trend pool** (`probe.trend`, optional). The curated list holds few of
the market's trend legs (a 200-moment list covers about 140 of
practice-train's thousands), so the round can also screen on the legs
themselves. Their pool is the trend-leg census (`curated-lists.js census`,
`scripts/lib/learning/leg-census.js`: every leg of practice-train by the
capture report's own detector, in one seeded, hashed order), read for the
screen period. In the loop config:

```json
"trend": {
  "replay": "s1-sessions.json",
  "census": "~/fth-train/leg-census-practice-<fingerprint>.json",
  "from": "2021-05-03",
  "to": "2022-09-01",
  "regression": { "days": ["2021-05-03", "2021-05-04", "2021-05-05", "2021-05-06"] }
}
```

`replay` is a stage-1 replay config (no curated list, no practice, no
combine or account states, no `stepWindows` or `dayAttempts`: the loop
sets those), on the loop's runner config. The pool is the census's legs of `from` to `to`,
every leg whether a curated moment marks it or not, without the regression
days. Both lie in practice-train and outside the tuning windows (the config
refuses either).

A census holds its role's split window only: `curated-lists.js census
--use practice` finds legs in practice-train's bars alone, and a census with
a leg outside practice-train (practice-validate, or a sealed test or final
day) is refused when it is built (`leg-census.js buildCensus`). A census
built before this rule may hold such legs. The loop's pool never uses them
(the screen period lies in practice-train), but rebuild it to keep sealed
days out of the file: run `census` again from the same moments and bars and
point `trend.census` at the new file. Its fingerprint changes, so a loop on
the new file is a new loop.

**Stepped windows** (`scripts/lib/train/trend-windows.js`). A trend run
steps only around each leg, not whole sessions, as a curated run steps its
list's windows. For each leg of a batch half (every census leg on a
regression day):

- **The leg window**: the decision bars from `leadBars` bars before the
  leg's start bar (`config/training.json` `trendWindows`, 4) through its
  catch window (its first `catchShare`, the span a catch counts in), clipped
  to the runner's sessions. Legs whose windows touch merge into one window.
- **Control windows**: `controlPerLeg` (1) windows a leg, of the same
  length, in the same session, sharing no bar with any census leg that day
  (the batch's or not, from its lead-in to its end, its tail past the catch
  window included) or another window, chosen by the loop's seed. They give
  the screen the entries made where there is nothing to catch.
- **Management**: a position or working order still open after a window is
  managed bar by bar until flat, and every window day's end of day runs.
- **Nothing left out silently**: a leg or control with no window (outside
  the runner's sessions, an exchange holiday, no free stretch) and a day
  with no window at all (never run) are listed in the round's
  `probe-report.json` (`trend.windows`) and in the log. A regression day the
  census holds no leg on would never run, so the config refuses it.

The run's replay config carries the windows (`stepWindows`,
`scripts/lib/replay/step-windows.js`); the driver steps them with the curated
runs' own stepping. The champion and every edit of a round step the same
windows (the same legs, seed and runner config give the same windows), one
run a day; a day's windows are a phase of their own, so the champion's run
of the same windows (the regression days every round) is reused. No look
ahead reaches the model: the windows are chosen from the census, which
read later bars to find each leg, but nothing of them reaches the runner
config, the environment or the run home. Each bar's cycle sees exactly what
a whole-session run sees at that bar; only which bars run differs. A
stepped run is never scored by the keep rule (`model-score.js` refuses it).
The trend set's runs carry the loop's `trend-set` role, which the training
preflight requires for a run with `stepWindows` (see "The loop's run roles"
below).

**A round's batch.** Each round takes the pool's next legs in the census's
order (its seeded order, its fingerprint recorded). The draw is without replacement
until the pool is used up, then reshuffled by the loop's seed, so over the
rounds every leg is screened, as often as any other. The batch splits by session date into a
probe half and a confirm half: whole days, in a seeded order, go to the
probe half until it holds `half` of the legs, and no day is in both.

**How many legs** (`config/training.json` `trendBatch`; a loop config's
`trend.batch` may set `start`, `max` and `half` for itself). Each loop starts
at `start` legs (100: 50 probe, 50 confirm). A round shows an improvement
when its combined change is confirmed on the confirm half. After
`growAfter` rounds in a row with none (2: every edit inconclusive or with
no gain, or the combined change not confirmed) at the current size, the
next batch is `growFactor` times larger (2), up to `max` (400) and the
pool. A round with nothing judged, or where every edit was clearly worse
(`hurt`), counts neither way: a rejected edit is no sign the batch is too
small. A kept change (a new champion) sets the next batch back to `start`,
so the next search starts cheap. Each round's report records the size, the
trigger (start, keep, grow, cap, restart) and why.

**The learning curve** (`scripts/lib/train/trend-curve.js`). The champion
replays each round's confirm half too, so each round has a point: the
confirm half's capture rate (with a Wilson interval at the keep rule's
level) and net R per window, as the champion after that round's keep
stands (the kept change's numbers when one was kept). The point reads only
the windows the champion stepped to their end, the screens' own guard: a
window it left early adds no leg, no R and no first try. Each point
carries its unit (`unit: "window"`), and only window points pool or judge
the plateau: a point from before the stepped windows (whole sessions, no
unit) stays in the record, flagged (`excluded`), and never pools. A loop
started before this change has whole-session rounds and a different trend
set (its loop hash differs): start it again as a new loop (a new `loopId`).
Beside it are the
round's first-try read accuracy, first-try compose OK rate and hint-rescue
rate (OK only after a hint), and, with `trend.moments` (the curated scan's
moments file), the **selection value** (`scripts/lib/train/selection.js`).
Each traded scan reaction on the confirm half carries the standard trade's
own R. Only the reactions the model could act on count: their bar closed
inside the runner's sessions (the scan covers wider hours, and a reaction
outside them could only count as passed), on a bar the run stepped. One is
taken when the model placed an entry its side within the reaction's entry
window, else passed. The value is the taken reactions' mean R
minus the passed ones'. About 0 means no selection skill, which is what a
first baseline measured; moving it above 0 on fresh batches is the target. The iteration's record holds the curve across
rounds and its pooled rate, and `train-loop.js status` prints them. Two flags report
only, and never keep or reject a change:

- **plateau**: in the last `plateauRounds` rounds (3), no round's capture
  rose beyond its interval above every earlier round's.
- **memorization**: an edit whose legs caught rose on the probe half and on
  the regression days, but whose combined change did not gain on the
  confirm half. The
probe half gives the findings and screens each edit; the confirm half judges
the combined change, which counts only if it helps there too. The champion
and every edit of a round step the same windows, one run a day, and each
screens the batch's own legs only. The round's `probe-report.json`
records the batch's index, the census's fingerprint, and each half's days
and leg ids; the lessons lines record the batch too.

- **Findings.** The champion's missed legs on the probe half
  (`scripts/lib/train/trend-findings.js`, kind `trend-blocker`) are grouped
  by the flow step that blocked them and its owner, ranked by the R they
  left (each leg's `availableR`), and come before the curated findings. Code
  ranks by that move; the proposer's line names what blocked the plan and
  how many legs, never the move, a price or an R. The owner is the skill of
  the read compose_check refused at that step, `risk-manager` for a phase-2
  veto, or `trade-executor` for an abort. A size under the rulebook's floor
  at the model's stop (`min-contracts`, phase 2's or the gate's) is the head
  trader's stop choice. It is filed under the flow step `stop` and owned by the
  skill of its plan's stop read, never by the risk manager: the floor is the
  rulebook's. A late or unfilled entry, or the head trader's pass, names no
  owner. A rule (the clock, the account's stops, news), a bar outside the
  session and a position already open are never findings: those are code
  and the rulebook.
- **Exit findings** (`scripts/lib/train/exit-findings.js`, kind
  `exit-decision`). Each run's trend-capture report scores every exit and
  every stop the model tightened by what price did next on the closed bars,
  to the end of the session it exited in
  (`scripts/lib/replay/exit-scorecard.js`, post-hoc): cut a trend (price went
  `cutR` the trade's way before `rightR` against), right, unclear,
  unresolved, and late (open profit given back past the late threshold), by
  who exited: the model's market exit or tightened stop (from its transcript
  and from the gateway's records of each cycle, a trade-executor's own
  session included), the runner's trail or close, the initial stop, the
  target. The thresholds are in `config/replay.json` `exitScore`; the late
  one is never below the active policy's `lock_giveback_r` (its rulebook),
  so the runner's trail giving back what it was built to give back is never
  late. Only what the model decided is a finding: its exits that cut a trend
  (decided on an HTF bias flip apart), and its late exits (its own, or its
  hold to the initial stop before the runner's trail armed). The runner's
  trail, its close and the target are rows of the report only; an initial
  stop that then ran the trade's way is the report's stop-placement row.
  Findings rank by the R they cost with the trend findings, owned by the
  open trade's read (`pullback-vs-reversal`; `manage-position` is a
  management skill, never probed), each example the facts code read at the
  decision (`scripts/lib/trading/trade-read.js` on the bars closed by
  then), no date, price or R. The round's report counts them (`probe
  exits`). An exit finding's edit is screened as a curated one, with the
  trend set's harms: no exit-specific gain test exists yet. The read
  itself is held to an acceptance check (`tests/lib/read-mechanical.test.js`,
  `scripts/lib/replay/read-mechanical.js`): applied to the letter on a real
  trend it keeps at least what the runner's 15m structure trail keeps, and
  weakening is rare on that trend's bars.
- **Learnable legs only** (`scripts/lib/train/trend-facts.js`). After the
  probe half's champion runs, code works out each missed leg's facts at its
  entry-able bars: the trade cycles of its catch window, less those a rule
  blocked. The briefing at each bar is rebuilt from the run's own bars, as
  the skill-usage report rebuilds it. A frame the rebuild can't make though
  the run had it (the 5m without the run's 1m bars) is `unknown`. Its reads
  are never counted, and neither is an `at` read when it is the frame above
  the base: the check would fall back past it to a higher candle. Where the
  run recorded a compose_check call on the bar, its reads are checked again:
  if the record and the rebuild disagree, the bar is `unknown`. The model's
  own OK record that way (passed on, vetoed, late, refused at the gate,
  unfilled) shows a plan passed whatever the rebuild, unless the floor
  refused it. At each bar code says whether a valid with-trend plan existed:
  the window allows entries, the trend rule allows the side (not only as a
  reversal), and the standard plan or a combination of the reads TRUE on the
  leg's side (compose-hints' candidates) passes compose_check and the plan
  (R:R, room, the stop floor). Under a prop attempt a size must fit by the
  entry's own size chain (`prop/size-translate.js`): the policy's budget plan
  at the budget and room that cycle's attempt line stated, at the full
  multiplier (an upper bound on the verdict's). Then comes the composed
  strategy's `risk.max_risk_usd` at the contract's all-in risk (`capsOf`,
  `allInRisk`), and the floor on the capped size (`minContractsRefusal`). A
  leg with a valid plan at any bar is learnable and can be a finding. A leg
  every bar of which was known, with none, had no valid plan at the time: a
  correct pass, counted, never a finding. A bar with a missing frame and no
  valid plan on its known reads is not known: the missing reads might have
  made one. Any other leg's facts are unknown, also counted. `probe-report.json` (`trend.missed`), the round's log and
  `train-loop.js status` give the three counts.
- **The base rate.** A valid plan exists on most bars, legs or not, so a
  leg's verified reads alone would teach over-trading. Code runs the same
  plan check on the champion's control-window bars (no leg), each side on
  its own, as a leg bar is checked on its leg's side: like with like.
  `probe-report.json` (`trend.baseRate`) and `status` give the share of
  control bar-sides with a valid plan, and how those plans did on the
  session's later bars (won, lost, undecided by its end), beside the share
  of the missed legs' entry bars. The proposer also reads those control
  plans split by setup type (the setup read's kind and level, no timeframe,
  side or number), labelled as from this round's control windows (small n):
  the most common `setupTypes` types with at least `setupMinN` plans each,
  the rest folded into "other" (`config/training.json` `trendFindings`).
  Every outcome is the round's own replay's, never a census's. The proposer reads them all. It also reads up to `examples` control bars, a day each in
  turn, where a valid plan existed and lost: its stop was hit before its
  minimum R:R mark on the run's later bars that session, the stop first when
  one bar holds both. They are labelled "valid plan, it lost: what tells
  these apart from the legs?". The probe prompt says an edit must tell the
  legs from the losers, never just enter more.
- **What the proposer sees.** Each trend finding lists up to `examples`
  of its legs (`config/training.json` `trendFindings`), the costliest
  first, each clipped to `exampleChars` at a clause boundary. A late or
  unfilled entry's legs (the runner's execution) give none. Each example
  gives the side, what the model said (its CYCLE RESULT line, clipped to
  `saidChars`; the runner's own words labelled "the runner") and, for a
  refused plan, its reads. Then it gives the passing plan's reads, or why
  none passed. It never gives the whole list of TRUE reads, and code never
  parses what was said: the proposer reads it beside the plan that passed
  and sees for itself where they part. A leg is owned by the earliest step where
  a read the model composed the leg's way was not verified, and that read's
  skill; a no-plan leg (it composed none) has no owner. A parser of the model's stated
  claims was tried and dropped: out of sample it was wrong about a third of
  the time.
- **No leak.** The examples name reads by timeframe and level name only:
  dates, months, weekdays, clock times, prices, numbers (digits, words,
  fractions), ids, `#` tags and account names are removed. Tests scan the
  proposer's prompt for the legs' dates and prices. The facts are worked out
  after the run, outside the run home: the capture in the run's folder is
  unchanged, and no trading prompt or tool requires the module. The trading
  model never sees them.
- **The screen** (`scripts/lib/train/trend-screen.js`). Its units are the
  stepped windows. Legs are paired by id: caught or not, a one-sided McNemar
  test. A catch counts as fixed only when its window's net R got no worse,
  so catching more by trading more and losing more never gains. Net R is per
  window: each round trip goes to the window it was opened in (by its
  opening fill's time), so a trade opened in a leg window and closed during
  the next window, while managing, or at the day's end of day stays the leg
  window's; one whose opening isn't known goes to the window its close
  followed. The control windows carry the entries made where there was no
  leg. Harms are fewer legs caught, net R per window worse (on at least
  `minPairs` windows), first tries worse and a blow. These use the `SCREEN`
  thresholds above, and they mean what they meant per session: a looser
  rule's losses show on the control windows as they showed on the days with
  nothing to catch. On the regression days fewer of the champion's legs
  caught, net, is a harm. They never show a gain.
- **Finished windows only.** A window pairs only when both runs stepped it
  to its end: a record at or after its last bar, at least one trade cycle
  on its own bars (the day's end of day reaching it is not enough), and its
  last cycle not failed. A window a run left early (a call limit, a crash,
  failed cycles) holds fewer bars than the other side's. A bar skipped
  because a cycle was still running (latency charged: live, bars pass while
  the model works) is part of the result, not a reason to drop the window:
  each window records its skipped decision times and whether a leg's start
  or catch bar was among them, and the iteration's record and `status` give
  each side's share of skipped bars (`skipped bars: champion ..., <edit>
  ..., combined ...`), so a slower edit is visible. Its missed legs already
  count against it in capture. Its legs, net R and first tries count neither as a miss nor as a
  catch: they are dropped. Each side's report gives the batch legs its
  captures found, the legs paired, and the windows dropped and why.
- **Contract rolls are unverified.** Leg ids are `day|side|start` and never
  a price, so a constant back-adjustment offset leaves them as they are. On
  a roll day, though, a back-adjusted roll gap could shift a leg's start, and
  pairing across a roll has not been checked against a run that spans one.
  Until one does, each side's report flags the sessions in the front
  contract's expiry month or the month after its roll (`rollMonth`, from
  the run home's contract day files).
- **First-try reasoning** (`scripts/lib/train/first-try.js`). compose_check
  answers a refusal with HINT lines that say what is true on the bar, so a
  final OK can hide whether the model read the bar itself. For each
  decision point (the compose record's root, bar and side), the first record
  by time is the first try, and every later one is after a hint. The first
  try gives its reads verified or not, whether it was OK, and the flow steps
  it failed. The point is hint-rescued when the first try was refused and a
  later one was OK. Paired on the same points, an edit whose first tries are
  all verified on fewer points, significantly under the loop's decision
  rule (`decisionRule`: at least `minDiscordant` changed points, p at most
  `alpha`), is `hurt`, even if it catches more legs. First tries never make
  a gain on their own.
- **Both sets judge every edit.** A harm on either hurts. The gain is the
  target set's: the trend batch's legs for a trend finding, the curated
  target for any other. The combined change must keep every trend part's
  gain on the confirm half, and every curated part's.

**The cost.** A run steps a leg's window and its control windows, not the
leg's whole session: on the 3-minute morning session (about 50 cycles a
session), a leg's window is about 10 cycles, plus its control window's
when one fits, the day's end of day and any management. On that session
most control windows find no free stretch: the census's legs, each from
its lead-in to its end, cover most of the morning (in the dry run below
about four in five were left out, each listed in the report). The
champion steps each
round's windows, both halves (a day's same windows, such as the regression
days', are reused), then every edit steps the probe half's windows and the
regression days, on top of its curated half, and the combined change the
confirm half's. A model-free dry run of a 50-leg batch (25 probe legs on 25
days, 24 confirm on 24, 4 regression days, three edits and the combined
change) stepped 2,319 trend cycles in all: 658 for the champion, 425 for each
edit, 386 for the combined change. The same days in whole sessions are 8,466
cycles, and the earlier whole-session screen of a 100-leg batch was 15,096.
The keep rule's runs are unchanged (full days, the strict judge): about 5,300
cycles a tuning window a side. A smaller `batch` costs less and screens with
fewer legs (the `SCREEN` thresholds: at least four changed legs and a tenth
of the pairs, net); the batch grows only when rounds show nothing.

**The iteration's record.** Each iteration writes
`<iteration dir>/iteration-report.json` (`scripts/lib/train/iteration-report.js`):
the findings with their steps, what was proposed (and refused), each
edit's screen verdict and n, the combined change and its confirm verdict,
the keep rule's verdict, the combined change's deltas on the confirm half
(net reads, process and target decisions fixed, R per decision; with a
trend set the legs caught, fixed and broken, each side's capture rate and
the net R per window), and the cycles each side's runs recorded. `train-loop.js status` prints it as one
line per iteration.

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
half once per loop, and the confirm half once, when a round first has a
combined change. Each round then replays one half k + 1 times: each of the
k edits the probe half, the combined change the confirm half. That is about
(k + 1) / 2 times the model time of one practice run of the list a round,
on top of the keep rule's runs. The keep
rule's champion runs (its full-day tuning windows, the costliest part) run
once, and only when a round first has a combined change to judge: rounds
whose probes pass nothing never pay for them. Probes
run one after another by default (`parallel: 1`). `parallel` above 1 is
refused unless `probe.replay` sets `latency: false`: a replay that
charges each cycle's real time would charge probes queued at the model
server more than the champion's probe run, which runs alone. Raise it only
when your local model server serves that many prompts at once (its own
concurrency setting, in your local config).

### Trend capture

`node scripts/replay.js report` writes `trend-capture.json` beside
`report.md` (`scripts/lib/replay/trend-capture.js`): every trend leg in the
run's sessions (a zigzag on the base bars, `config/replay.json`
`trendCapture.minMoveAtr` times the session's mean true range), whether an
entry the leg's way filled in its first `catchShare`, and for a missed leg
one line per decision cycle with its first blocker by flow step (bias,
location, setup, entry, stop, target, then risk and execution) and who
blocked it (compose_check, phase 2, the gate, the executor, the head
trader, a rule). It reads outcomes, so it is analysis after the run only,
never shown to the model. The curated lists can take the same legs
(`curated-lists.js build --legs-bars`): a moment at a leg's start its way
is a trend moment, and each leg's first moment is chosen first.

**Trend catch & ride.** Catching a trend is half of it; riding it is the
other. The same report measures both (`scripts/lib/replay/trend-ride.js`,
its `MEASURES` the one list of definitions), from fills and closed bars
only, after the run, never shown to the model. Each caught leg, in points
of the leg's own move (from its start to its extreme, a short's counted
down):

- `entryLag`: (entry fill − leg start) / leg points: 0 the leg's start, 1
  its extreme.
- `captureShare`: (exit fill − entry fill) / leg points: the share of the
  whole leg the trade banked. Not capped: negative on a loss, and more than
  was left when the trade rode on past the detector's extreme.
- `rideShare`: (exit − entry) / (leg extreme − entry): of what was left
  after the entry, the share kept (not capped; none when the entry was at
  or past the extreme).
- `peakR`: the best R reached while open, the round trip's `mfeR` when the
  broker sends it, else the closed bars held (opened at or after the entry
  fill, closed before the exit: the exit's own bar may make its high after
  a stop filled in it) at the trade's risk; never below the exit's own R. `givebackR` = `peakR` − the trade's R.
- A trade still open at the run's end is caught and `open`, with no exit
  measure.

The totals (`totals.ride`): the legs (the trends that happened), the caught
ones and the catch rate, also by leg size (the leg's points over its
threshold, bucketed by `trendCapture.sizeEdges`, `[2, 4]`: 1–2×, 2–4×, 4×+,
so the big trends show; a given leg without its session's scale is
`unknown`, so the training loop, whose census legs carry no scale, has no
size split); the median and mean of each measure over the caught legs; the
R the caught legs banked against the available R of every leg (R caught /
R available; the available R is at the planned stop, the banked at the
trade's own); and the run's filled entries by kind: in-trend (inside a leg
its way, its start bar to its extreme bar's close), counter (inside one the
other way only) or none, each with its R, so the false entries show (a
training-loop run classifies them against every census leg of its day, its
windows' own and the others). The
replay report prints them as a "Trend catch & ride" block. The training
loop's round report carries the same totals for the champion's confirm and
probe halves, each edit's probe half and the combined change's confirm half
(their finished windows only, as the learning curve), and `train-loop.js
status` prints them under the round's line. Nothing judges by them: no
screen, keep rule or prompt reads them.

The twelve legs of `tests/fixtures/trend-moves` are a regression and
diagnosis set, never a tuning target. The follow-up for the training loop's
findings is a census of these legs over practice-train, split by session
date with the loop's seeded split, so an edit tuned on one half is
confirmed on dates it never saw: the probe round's trend set
(Propose–Probe–Compose above, `probe.trend`: a batch of the pool's legs each round).

## 5. Stage 2: pass prop

The `stage: 2` preset is stage 1 plus:

- one of two modes, one per replay config, never both (the config refuses
  `combine` with `accountStates`):
  1. **the continuous combine** (`combine`): the main stage-2 measure, the
     test that judges the model;
  2. **drawn account states** (`accountStates`): extra practice of chosen
     account situations (near the max loss limit, after losses);

  a practice-train run takes one of them;
- account facts (the attempt line);
- the prop risk rules: `loss_streak_stop` and the exit mode.

`prop` is allowed in stage 2, but a curated list can't be combined with
`prop` (the replay config refuses it), so a curated stage-2 run gets its
account from the account states. A plain `prop` replay is no stage-2 mode:
it keeps cycling after its attempt passes or blows, and no report shows its
attempts.

Use the continuous combine to see how the model does: can it start at zero
and make the profit target without touching the max loss limit, and how often.
Use drawn states to give it more practice of the situations a combine reaches
rarely. Both are learning runs (practice-train, or practice-validate with
`--validate`); each run's look names its mode, so the stage-1 exit test's pool
never mixes a combine run, a drawn-state run and a stage-1 run.

**The continuous combine (`combine`).** The replay config:

```json
{
  "runId": "s2-combine-1", "stage": 2, "start": "2022-04-04T13:30:00Z", "end": "2022-08-12T00:00:00Z",
  "combine": { "account": "<prop_portfolio's account>", "attempts": ["2022-04-04", "2022-05-17", "2022-06-30"], "maxSessions": 30 },
  "autotrader": { "...": "the trader's runner config", "sessions": ["09:30-12:00@America/New_York"] }
}
```

- `account`: the profile the attempts trade. It must be the account the active
  policy strategy (`prop_portfolio`) trades: the runner keeps that account's
  attempt record.
- `attempts`: each attempt's first trading day, in order.
- `maxSessions`: the most trading sessions an attempt runs (default and most:
  the profile's `sessions`). Fewer is for a short smoke only: the model's
  horizon and clock sizing stay the profile's, so it trades a real
  `sessions`-long combine and the run just stops early.

Each attempt's window is its first `maxSessions` trading days of the run from
its start date. The config refuses an attempt that starts on no trading day of
the run, whose window runs past the run's end or spans two split windows, or
that overlaps the attempt before it. It also refuses `combine` outside stage 2,
with `accountStates`, `curatedList`, `prop` or `practice`, with `everyNthBar`
above 1, a `maxSessions` above the profile's `sessions`, and an account that
isn't the policy's. Narrower sessions are fine.
The combine block is in both run hashes. The preflight's `combine` check shows
the account, `maxSessions` and every attempt's window.

A day the replay server has no bars for (its `get_server_config.dataGaps`
entries with `bars: false`, replay only: docs/BROKER-MCP-INTERFACE.md) is not
a trading day of the run:
the driver reads the list once at a fresh start (pinned in the run's manifest),
runs no decision time on it and logs `<day>: no source data on the replay
server; skipped (not a session)`, so an attempt's `maxSessions` count only
replayable days and its window ends that much later (refused when it then
starts on one, or runs past the run's end or its split window). The
preflight's `data-gaps` check warns listing them. A day with bars but no order
flow (`bars: true, flow: false`) is traded normally, its flow facts absent as on
any minute without flow; the check notes it. A server without the field skips
nothing.

Each attempt's entries are sized as live: the policy's verdict from the
account's rulebook, never under its floor (`sizing.min_contracts`, in
micro-equivalents: a mini counts as its family's ratio). A setup that fits
fewer at its stop is a skip, and the gate refuses an entry under it
(`[min-contracts]`). The size the model states is a suggestion: the order
is the translated size (`prop/size-translate.js`: the largest the verdict,
the budget, the composed cap and the broker's max order size allow), in a
combine run as live. The run's prop Monte Carlo (`prop/model-score.js`)
sizes its attempt simulator the same way: the rulebook's sizing and floor,
then the composed cap and the broker's max order size recorded in the run's
home (`prop/size-translate.js limitPlan`), in the contract the run traded
(its runner's symbols). A backtest applies those limits only when its run
config states them (`prop.limits`).

What the run does:

1. **Each attempt is a real combine from zero.** Before its first step, with
   the account flat (else refused), the driver ends the previous attempt's
   record (kept, renamed), sets the replay broker's balance to the profile's
   starting balance through the balance schedule, starts a fresh attempt
   record (no closed days, profit 0), and checks the broker now reports the
   starting balance (else refused).
2. **Every decision time of the attempt's days is stepped**, on consecutive
   trading days, as a non-learning prop replay steps them: no curated list, no
   setup-focus skipping.
3. **It ends when it passes or blows,** under the account's rules (the pass is
   checked at a close, with consistency where the profile has it), or after
   `maxSessions` sessions (`unfinished`). Before each step the driver reads the
   attempt from its record, the broker's balance and the lowest equity since
   the last check: the open position at its worst price since then, and each
   trade opened and closed since then at its worst price between its fills
   (the broker's positions, fills and 1-minute bars, less the account's fees,
   never assumed). Equity at or below the floor is a blow, as in a real
   combine, even if the trade later recovers or closed at a gain. The check runs at each decision time, so a touch between two
   steps is caught at the next step. An open position it can't value refuses
   the step (the run stops, resumable): an open loss is never assumed away.
   After a blow during a day, no trade cycle runs: only that day's end of day
   (the runner's flatten and the day's close, as live). After a pass at a
   close, nothing more runs for the attempt, unless a position or working
   order is still open the next day: then only that day's end of day (the
   flatten) runs. The days left in its window are not stepped: the clock
   moves to the next attempt's start, and the run finishes after the last
   attempt ends.

**What resets per attempt.** A fresh attempt's prompt starts with no history
of its own: the attempt line is the fresh record's (day 1, no profit, no trades,
losses or streak today), and "Your last N reviewed trade(s)" and "Your last N
cycle(s)" count only the attempt's own trades and decisions (reads scoped to
the attempt's start, its record's `historyFrom`; the journal and the decision
history stay whole for reviews, labels and the experience log). An entry of
an earlier attempt left without a review is still named (the gate still
requires its review). What doesn't reset: lessons and the experience lookup,
the learning that every run gets. A live attempt, a drawn state's seeded day
and a stage-1 run show their history as before.

Each attempt's start and end are in the run's `combine.jsonl`, never shown to
the model. At the end, the stage report (and `replay.js report`) prints, for
each attempt: its start, sessions run (a pass: up to the close that passed
it), outcome (passed, blown or unfinished),
final profit, lowest cushion to the floor, worst day against the daily limit
(the lowest day P&L seen, $0 when no day was down), and its trades, win rate
and mean R. Then the totals: pass rate (passed over every ended attempt: an
unfinished one counts as not passed), blows and median sessions to pass.
Then the promotion gate's numbers (`scripts/lib/prop/promotion.js`, frozen)
applied to the attempts, labelled practice: these attempts are never a
promotion score. Then the 30-day Monte Carlo of the run's own trades. The days
are continuous, so the trades come at their natural rate and the score is a
real (full-day) one, not reweighted.

**Drawn account states (`accountStates`): a training config.** The replay
config:

```json
{
  "runId": "s2-states-1", "stage": 2, "start": "...", "end": "...",
  "practice": { "mode": "setup-focus", "...": "as stage 1" },
  "curatedList": { "file": "<curated lists>", "list": "mix" },
  "accountStates": { "file": "<the drawn states document>" }
}
```

Stage 2 teaches the model to pass the combine: grow the balance to the target,
never touch the max loss limit, in 30 days or fewer. With drawn states, each
practice day starts from an account state, not always a fresh account:

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

**The 30-day Monte Carlo** is printed at the end of a stage-2 run (after a
combine run's attempt lines). Read it in this order:

1. **0 blows.** This is a hard rule: any blow fails.
2. **Passes within 30 days.**
3. **The median and p90 days to pass.**
4. **The breakdown by account state.**

The Monte Carlo of a curated run (drawn states) is diagnostic only: the
curated moments are reweighted, not a calendar of whole days. A continuous
combine run's is a real score of its whole days.

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

These hold 103, 106 and 128 sessions.

**The loop's run roles** (the training preflight's `loop-role` check,
`scripts/lib/learning/preflight.js` `LOOP_ROLES`). Two kinds of the loop's
runs are practice-train runs that read the market's whole days by design,
so the preflight takes them without a practice mode or a curated list, in
that role only. The loop sets the role in code on the run's learning gate;
no replay config or `replay.js` flag sets it, and an ordinary practice-train
or stage-1 run still needs its practice mode and its curated list.

- `keep-rule`: the keep rule's runs, the loop's own `replay` under
  `modelScore`: the champion's tuning replays and each challenger's, and
  held-out judging's runs of `heldOutWindows`, the champion's and the
  challenger's (outside practice-train the role changes nothing the
  preflight checks: no practice mode is needed there). Give
  that replay no `practice` and no `stage`: its runs are then full days and
  their score is real. A replay that sets `practice` still runs, but its
  score is `diagnostic (setup-focused)`: it can keep a change on tuning,
  labelled so, and never judges held-out months. Never a curated list.
- `trend-set`: the probe round's trend runs (`probe.trend.replay`): stage 1,
  the stepped windows the loop sets, never a curated list, practice, a
  combine, account states or a prop attempt. A run with `stepWindows` in any
  other role is refused.

**The loop's day attempts** (`scripts/lib/replay/day-attempts.js`; the
owner, 2026-10-24: "We should using translation on ppc as well as live").
Every run of the loop (the keep rule's, the trend set's, the curated
probes', held-out judging's) trades inside a combine attempt of the account
the active policy strategy trades, started fresh at its starting balance
before each session day's first step. A composed entry is then sized the way
live sizes it in an attempt: the size translation (the rulebook's verdict,
size budget, cap, floor and floor stretch), `order_plan`, phase 2's request,
`compose_check`'s no-size-fits and the gate's checks. A model's suggested
1 MNQ goes as the rulebook's size, at least its floor of 3. A day's own
trades update its attempt as live, so the daily loss limit, the soft stop
and the stretch's "no loss today" work; no day's loss or blow reaches
another day, so the champion and every edit size the same window from the
same state. The loop sets `dayAttempts` in code for each run (a replay
config that names it is refused); the training preflight's `day-attempts`
check requires it on every loop run and refuses it on any other learning
run (a loop run declared not learning has no preflight: the loop refuses it
itself). A model-scored loop's `replay` names no `prop`, `accountStates` or
`combine` (refused: an attempt across days would carry losses); a loop
without `modelScore` whose replay names one keeps that attempt instead. It is part of both run hashes and the loop's own, so a loop started
before it is another loop, and its runs never pool with these. R is
unchanged; dollar figures are at the translated size. The model sees only
the attempt line a live attempt shows (day 1 of a fresh attempt each day).

A curated run is never paired: its
moments are picked outcome-balanced, so even at natural rates its outcomes are
the list's, not the market's, and its rebuilt days are drawn, so it has no
real start days to pair.

**The session and the model-call limit** (your local `loop.json`, never
committed). Give the loop's runner config the session you trade: for the
New York morning, `"sessions": ["09:30-12:00@America/New_York"]` (03:30 to
06:00 HST). The probes run the same runner config (probe-config.js), so they
match. That is about 50 three-minute cycles a session instead of about 127
for 09:30 to 15:50: the keep rule's statistics don't change (the same
windows of at least 90 sessions, blocks of S), only their cost. Set
`limits.maxModelCalls` to cover what an iteration may spend: the keep
rule's first judgment runs the champion and the challenger over every
tuning window, so two windows of about 105 sessions cost about 10,500
cycles a side on the morning session (about 21,000 for the first keep,
about 10,500 for each later challenger), plus the probe rounds. The loop
stops at the limit between calls, resumable; a limit under the keep rule's
cost stops every keep before its verdict. The default (`loop.limits` in
`config/training.json`) is small, for a first dry run.

The continuous combine (section 5) is not the keep rule's evidence. A
window of about 105 sessions holds only about three attempts that share no
session, too few for blocks of S, and a combine run steps no day after an
attempt passes or blows, so its trades are not the market's whole days and
the two sides' days differ. Run it to see how the model does from zero.

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

**A rulebook change** (only a person's, brought with `import-proposal`: no
model proposes one). The account's firm rules (its `ACCOUNT.md`: sessions,
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

### Config files

Every tunable the code uses lives in a config file under `config/`, read
through `scripts/lib/tunables.js` (the schedule through
`scripts/lib/schedule.js`). The code states no value of its own.

| File | What it holds | Tighten-only keys |
| --- | --- | --- |
| `config/schedule.json` | The learning split, the prop schedule, look budgets, recorded looks, data dates (above) | look budgets, validate cap (down); reserve months (up); final needs a test pass |
| `config/training.json` | The stage-1 exit test, the experience index and risk record minimums, the keep rule, the paired decision rule, the probe screen, probe and loop ranges, A/B levels, proposal, compose, lesson and probe-edit limits, skill byte caps, the learning report, the field studies, the trend findings' example legs | the exit test's bars, the sample floors and levels, the keep rule (its primary pinned), the decision rule, the screen, the loop's budget maxima, proposal limits, arms per evaluation, skill byte caps |
| `config/replay.json` | Latency, the stage presets, curated lists and moments, setup moments, the account-state draw, driver retries, decision labels, the scorecard's give-back rule, the backtester's plain-run defaults | the stage presets (pinned) |
| `config/runner.json` | The order gate's limits and timing, the trade lifecycle's size cap, the account snapshot, the replay clock, cycles, bars, prompt sizes, the live session, alerts, read caps and page sizes, the Monte Carlo's size | the gate's timing (pinned), its loss, entry, age and confluence limits, the bracket tolerances, the facts check, the size cap, the snapshot and clock tolerances, the kill switch's error count, bar staleness, the close settle time, the kill graces and the gate slack (pinned), the Monte Carlo maximum |
| `config/analysis.json` | The reads' parameters: indicators, the snapshot, regime, CISD, CRT, volume profile, candles, the multi-timeframe read, day context, structure, momentum, fair value gaps, the briefing's frames, the rules evaluator's window | none |

What stays out of these files:

- **A value with a document home.** A rulebook's sizing and stops
  (`RULEBOOK.md`), an account's limits and fees (`ACCOUNT.md`) and a
  strategy's numbers (`STRATEGY.md`, e.g. `trade_lifecycle`'s stop buffer
  and floor, `risk.stop_buffer_ticks`, `risk.stop_floor_ticks` and
  `risk.stop_floor_atr`) are read from their documents.
- **The promotion gate.** Its thresholds stay frozen in code.
- **Mechanics.** Units, format versions, ids, parse and input limits,
  exchange hours and similar. `tests/plugin/no-tunable-literals.test.js`
  lists each with why it is no setting, and refuses a new literal.

A strategy's `params` still override `config/analysis.json` for that
strategy (`scripts/lib/trading/market-snapshot.js` `PARAMS` are the defaults
it overrides).

To change a value:

1. Edit the key in its file. The schema in `scripts/lib/tunables.js`
   refuses a missing or unknown key, or a value of the wrong type or range.
2. A tighten-only key may only move the stricter way, and a pinned key may
   not move at all: the loader refuses a file past a pin (`PINS` in
   `scripts/lib/tunables.js`, checked by `tests/lib/tunables.test.js`).
   Loosening one needs the owner's yes and a new pin.
3. Update `tests/fixtures/config/pre-move.json` too (it holds every value
   as it was when it moved, checked by `tests/lib/config-golden.test.js`),
   and say why in the pull request.

How it's enforced:

- **A critical error.** A missing, unreadable, non-JSON, incomplete,
  unknown-keyed or mistyped file, or a value past its pin, is a CRITICAL
  config error naming the file and every problem (key path, what is
  wrong, what is expected). It is printed to stderr and logged to the run
  log and the gate log. Nothing that opens risk runs on a default: a run,
  replay, training run, preflight or backtest refuses to start, and the
  gate refuses every new entry. Exits are never held: exits, protective
  stops, `close_position`, `partial_close_position`, `cancel_order` and the
  runner's reconcile and end-of-day flatten keep working on built-in
  values (`BUILT_IN` in `scripts/lib/tunables.js`, equal to the shipped
  `runner.json` and `analysis.json`), and the runner runs exits-only.
- **Fingerprints.** Every ledger entry, `learning-run.json` and replay
  manifest records each config file's version and hash (`configFiles`),
  beside the schedule's.

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

## 9. Fine-tuning on verified decisions (after stage 2)

When stage 2 is done, the local model can be fine-tuned with a LoRA adapter on
the decisions the code verified correct. Everything for it is in place, and
nothing uses it until then. `adapters/README.md` explains how to build, judge
and use an adapter. In short:

1. **Label by process, never by outcome**
   (`scripts/lib/learning/decision-label.js`).
   - **A take** is correct only if every claimed read is verified true, the
     scorecard grades it right, its R:R is at least `min_rr`, its risk is at
     most `max_risk_usd`, no gate or risk rule refused it, and (stage 2) the
     account state is known to leave room.
   - **A pass** is correct when a mechanical rule says no trade (a step of
     the priority order, or no setup found), or when the account state calls
     for standing down. compose_check refusing the model's own plans is not
     enough.
   - **A risk action** is correct when it fits the rules for that account
     state.

   A losing trade made by the process is correct; a winning trade made
   against it is not. Everything else is `incorrect` or `unverifiable`, with
   its reason, and is never trained on.
2. **Sample.** `node scripts/decision-dataset.js sample` re-runs each curated
   practice-train moment K times with sampling on. It reuses the decision-point
   replay, seeds each sample and records which sample produced which decision.
   The sampling settings come from a local file.
3. **Build.** `node scripts/decision-dataset.js build` writes the correct
   decisions as model-agnostic chat JSONL:
   - the exact prompts the head trader saw, then its whole turn with its
     tool calls and their results (format version 2); a subagent's turns only
     when `--roles` names it (its claims are unchecked);
   - never a failed, timed-out or interrupted cycle;
   - balanced by `adapters/spec.json`;
   - deduplicated and fingerprinted, with its source runs;
   - only examples made under the harness's skills, prompt and code digests
     now (the stale ones dropped and counted; `--include-digest` keeps others
     by name, marked), under one exit plan;
   - a warning, and a refusal past half, when the sampled repeats of moments
     all answered the same.

   Train comes from practice-train only and validate from practice-validate
   only; test and final are refused. Each example is tagged stage 1 (no
   account state) or stage 2 (account state plus risk action).
4. **Train in two steps** (`adapters/spec.json`): step 1 on stage-1 data
   alone, then step 2 on stage-2 data with the spec's slice of stage-1 data
   mixed back in. The template is `adapters/<base>/train.example.sh`; the
   weights stay local.
5. **Record the manifest** (`node scripts/adapter.js init`): the harness
   commit, the skills, prompt and code digests, the dataset fingerprint, the
   base model, the training settings, step 2's parent (the step-1 manifest's
   tag and path) and the validation result.
6. **Judge it on practice-validate**:
   - step 1 by the stage-1 exit test;
   - step 2 by the full keep rule of section 6 (`model-verifier.js decide`,
     the pair as one held-out window): `kept` passes, `inconclusive` stays
     pending, anything else fails; zero blows on real attempts and resampled
     paths alike, and a resampled-only gain never passes.

   The evaluation is two replays of the same windows and seed, base and
   adapted. The adapted run's runner config declares the adapter
   (`"adapter": "<manifest>"`). The declared adapter is in both run hashes by
   its manifest's digest, so the pair differs in that one field: compare them
   with `node scripts/ab-compare.js <base> <adapted> --field adapter`, and
   record the result with `node scripts/adapter.js validated <manifest>
   --base <run dir> --adapted <run dir>`, which derives it from that
   comparison and records its evidence (the runs, their setup record
   digests, a hash over the record).
7. **Use it.** The live preflight refuses a declared adapter that is
   pending, failed, stale, invalid or not backed by its evidence. The
   training preflight's `adapter` check:
   - is N/A with no adapter selected;
   - FAILs on a missing or invalid manifest;
   - FAILs on a stale adapter (its skills, prompt or code digest isn't the
     harness's now);
   - FAILs on a missing or failed validation, or a passed one not backed by
     its evidence (a hand edit);
   - FAILs on a step-2 adapter whose parent is missing, changed, or not
     passed with its evidence;
   - FAILs on a pending validation outside practice-validate.

`adapters/` is the one folder that may name a model.

## 10. Troubleshooting

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
