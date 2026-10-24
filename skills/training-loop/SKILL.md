---
name: training-loop
description: Use when the user wants to plan, run, resume or read a training loop. User-run.
---

# Training loop

The loop automates what has been done by hand so far: replay, scorecard, a
proposed fix, review. The model proposes; code judges; the owner approves.
Nothing it does reaches the repository's main branch, a remote, or a live
account: a kept change is a local branch and a pull request body draft,
and the pull request is opened, reviewed and merged by people, as every
change is (CLAUDE.md, "Before a pull request").

## When to Use

- The user wants the agent's skills, strategies or desk roles improved from
  its own replays, or wants to resume, read or judge a loop.
- Not inside an autonomous cycle: the loop, like a replay, is the user's to
  start. An agent may explain it and prepare the config.

## How It Works

1. **Config** (`mcp-configs/train-loop.example.json`): `loopId`; `replay`
   (a replay config: the runner config, the replay broker, `workDir`; its
   window is the loop's); `tuningWindows` (session dates in Train or a
   walk-forward tuning quarter, the only months the loop runs on);
   `heldOutWindows` (for judging only); `proposer` (a runner config: the
   harness CLI that proposes, built as the runner builds it, so any model
   the user runs locally); `repeats`, `seed`, `maxFlagged`,
   `controlPoints`, `maxProposals`; `limits` (`maxIterations`,
   `maxModelCalls`, `maxWallMinutes`); `decision` (the decision rule may be
   tightened, never loosened).
2. **Plan first:** `node scripts/train-loop.js plan --config loop.json`
   shows each window's unit and whether the look ledger allows it. Nothing
   runs.
3. **Run:** `node scripts/train-loop.js run --config loop.json` (add
   `--dry-run` to write no branch). Once per loop: the champion's tree (the
   repository's HEAD, which must have no uncommitted changes), its
   continuous replay of each tuning window with a checkpoint before every
   trade decision, and its scorecard. Then each iteration: the flagged
   decisions not targeted before plus a seeded sample of right ones (the
   panel); the proposer (the `design-self-review` skill's prompt) or a
   person's imported proposal; the champion and each candidate re-run on
   the panel's points from the same checkpoints, with the same seeds and
   repeats; the paired test; the archive. Every look is logged in the look
   ledger before it is taken: one ledger, the default harness home's
   `training/looks.jsonl`, whatever `FTH_HOME` says.
4. **The verdict** on each edit, and the evaluator and scorecard that feed
   it: the `training-verdict` skill.
   With `modelScore`, the keep rule decides; the panel and the evaluator
   can only reject.
5. **Kept:** the archive entry, `pr-body.md` and the proposal in the
   iteration's `promotion/` folder, and a local branch
   `train/<loopId>-i<n>-<id>` on the champion's commit. Review it, run
   `npm run verify`, get the adversarial review, open the pull request
   yourself.
6. **Held-out judging** is its own step and spends the look budget:
   `node scripts/train-loop.js judge --config loop.json --proposal <id>
   --held-out-look`. Each held-out month judges once, across every change
   and loop: a month an earlier judging look (or a recorded look) used is
   refused.
   With `modelScore`, each sealed window takes two looks: judging is
   refused up front when the budget can't hold them. Judge on
   practice-validate first; final can't be judged this way.
7. **Status:** `node scripts/train-loop.js status --config loop.json`:
   iterations, verdicts, leaders per category.

**Propose-Probe-Compose.** With a `probe` block in the config (a stage-1
curated practice config, practice-train windows, `k`, `parallel`; it
needs `modelScore`), each iteration's proposal comes from a probe round:
`k` tagged skill edits from one proposer call, each replayed alone on the
same curated moments and seed as the champion and screened by code, the
ones that helped combined by code and probed once more, then the full keep
rule. Edits are screened on one half of the moments (split by session
date, seeded) and the combined change judged on the other. With `probe`,
the champion's tuning-window replays run only once a round first has a
runnable proposal: a round whose probes pass nothing never pays for them. The
iteration's `probe-report.json` and the loop's `lessons.jsonl` say what
each probe showed, and the keep rule's verdict on each combined change
(`docs/TRAINING.md`, "Propose–Probe–Compose"). Keep `parallel` at 1
unless your local model server serves that many prompts at once; above 1
needs `latency: false` in the probe replay. A proposal a person imported
still comes first, without a probe round.

**The tiers.** (1) the scorecard's deterministic checks flag failures;
(2) the local model reviews its own flagged decisions and proposes; (3) a
paired re-run on the same tuning windows judges. An external model is a
last resort and is never called by the loop: a person who chooses to ask
one brings its proposal with
`node scripts/train-loop.js import-proposal --config loop.json --file
proposal.json --approved-by <name>`, and it is judged like any other.

**Safety.** One loop at a time (`<FTH_HOME>/training/loop.lock`). It
refuses to run while a live runner holds the account. The limits stop it
between model calls; a re-run resumes where it stopped. A model's proposals
may edit only skills, strategies (never a `name:` or `status:` line, nor a
policy's account, sizing, contracts or exit) and the desk roles' bodies
(the analysts, `risk-manager`, `trade-executor`: never a role's
frontmatter, its "Load the skills" sentence or its report formats). A
rulebook (`accounts/<account>/RULEBOOK.md`) only a person brings, by
the import-proposal command. Never code (the gate, promotion, tunables), config,
account profiles (`ACCOUNT.md`), rules, or the loop's own skills. The proposer runs
with its kill switch on and every live broker disabled. A trade either
side opens at a decision point is followed to its end, so a candidate that
enters where the champion stayed flat is judged on that trade too.
**Never run `npm run verify` or any tests while the loop or a replay
runs**: the local model server runs out of memory. Run them after.

## Examples

```text
node scripts/train-loop.js plan --config ~/fth-train/nq-skills-1.json
[train-loop] tuning 2022-03-07..2022-03-12 (...): allowed (train [2021-01-01, 2023-07-01))
node scripts/train-loop.js run --config ~/fth-train/nq-skills-1.json
[train-loop] iteration 1: 3f1c0a9e2b7d kept: fixed 9, broke 0 of 36 pairs (effect 0.25, p 0.002)
[train-loop] kept 3f1c0a9e2b7d: branch train/nq-skills-1-i1-3f1c0a9e2b7d (...); never pushed
```

A window in Select for tuning is refused by the plan and by the run: the
look ledger allows Select for judging only.
