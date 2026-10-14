---
name: training-loop
description: Run the training loop that improves the agent's design - replays on tuning windows score the champion's decisions, the local model reviews its own flagged decisions and proposes small edits to skills, strategies or the rulebook, and code judges each edit by a paired re-run of the same decision points; a kept edit becomes a local branch and a PR body draft for the owner. Use when the user wants to plan, run, resume, read or judge a training loop. The user starts it, as replays.
---

# Training loop

The loop automates what has been done by hand so far: replay, scorecard, a
proposed fix, review. The model proposes; code judges; the owner approves.
Nothing it does reaches the repository's main branch, a remote, or a live
account: a kept change is a local branch and a pull request body draft,
and the pull request is opened, reviewed and merged by people, as every
change is (CLAUDE.md, "Before a pull request").

## When to Use

- The user wants the agent's skills, strategies or rulebook improved from
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
4. **The verdict is code** (`scripts/lib/train/paired.js`, frozen): kept
   only with zero blows, no failure category worse than the tolerance or
   significantly worse, and a significant gain on what it targets (a
   targeted failure now decided right), on at least the rule's minimum
   decisions, discordant decisions and effect. A decision's repeats count
   once (the category most of them gave). A decision the scorecard left
   `unchecked` on either side is left out for both sides (its blows still
   count); too many left out is insufficient evidence, never kept. A change
   to a strategy or the rulebook is `blocked` until the evaluator (section
   10 step 9) screens it; a strategy's name, status, account, sizing,
   contracts, exit, instruments, timeframe, list and regime gate are never a
   proposal's to change, and a rulebook may only be tightened, key by key
   (no limit raised or turned `off`, no multiplier raised or removed, no
   exit changed, no key removed).
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
7. **Status:** `node scripts/train-loop.js status --config loop.json`:
   iterations, verdicts, leaders per category.

**The tiers.** (1) the scorecard's deterministic checks flag failures;
(2) the local model reviews its own flagged decisions and proposes; (3) a
paired re-run on the same tuning windows judges. An external model is a
last resort and is never called by the loop: a person who chooses to ask
one brings its proposal with
`node scripts/train-loop.js import-proposal --config loop.json --file
proposal.json --approved-by <name>`, and it is judged like any other.

**Safety.** One loop at a time (`<FTH_HOME>/training/loop.lock`). It
refuses to run while a live runner holds the account. The limits stop it
between model calls; a re-run resumes where it stopped. Proposals may edit
only skills, strategies (never a `name:` or `status:` line, nor a policy's
account, sizing, contracts or exit) and rulebooks
(`accounts/<account>/RULEBOOK.md`): never code, account profiles
(`ACCOUNT.md`), agents, rules, or the loop's own skills. The proposer runs
with its kill switch on and every live broker disabled. A trade either
side opens at a decision point is followed to its end, so a candidate that
enters where the champion stayed flat is judged on that trade too.
**Never run `npm run verify` or any tests while the loop or a replay
runs**: the local model server runs out of memory. Run them after.

**The evaluator** (section 10 step 9) verifies every change mechanically
when the config names one (`"evaluator": { "prop", "data": { "MNQ":
"<bar file>" }, ... }`, any `scripts/evaluate.js` setting): the champion
and the candidate on the same bar files and seed; a blow, a gate failure
the champion lacks or a lower pass-rate bound rejects. Without one, a
strategy or rulebook change stays `blocked`, and so does a change to a
strategy its streams don't read, or to a rulebook (it reads none yet). On
held-out windows it scores the candidate alone against the promotion gate,
inside the judging's one look; a window too short for the gate's attempts
and months fails it, so judge a mechanical change on windows long enough.
Keep `scripts/evaluate.js --ledger` on the same ledger file and `HOME` the
same: the one ledger is where the budget lives.

**The scorecard** is section 10 step 2's (`replay/scorecard.js`, read
through an adapter in `scripts/lib/train/loop.js`), under the look's rules:
tuning on the tuning windows, judging on held-out ones. Either step can be
replaced with `--steps steps.js` (a module exporting `scorecard` and/or
`evaluator`); a plugged scorecard is called only after the loop has checked
its look against the same ledger, so it can't skip the check. A held-out
judging resumed without its ledger snapshot (`ledger-before.jsonl`) is
refused: restore the file, or judge again under a new `loopId`.

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
