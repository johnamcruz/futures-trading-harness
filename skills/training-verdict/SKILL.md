---
name: training-verdict
description: Use when reading why the training loop kept, rejected or blocked an edit. User-run.
---

# Training verdict

How the training loop (the `training-loop` skill) judges each proposed
edit. Code decides; the model never does.

## When to Use

- The user wants to know why an edit was kept, rejected or `blocked`, or
  to set up the evaluator or a plugged scorecard.

## How It Works

1. **The verdict is code** (`scripts/lib/train/paired.js`, frozen): kept
   only with zero blows, no failure category worse than the tolerance or
   significantly worse, and a significant gain on what it targets (a
   targeted failure now decided right), on at least the rule's minimum
   decisions, discordant decisions and effect. A decision's repeats count
   once (the category most of them gave). A decision the scorecard left
   `unchecked` on the champion's side is left out (its blows still count),
   and more than 10% left out is insufficient evidence, never kept; one the
   candidate turned `unchecked` where the champion's was judged counts as
   broken, so a candidate can't hide a break by skipping on judgment. A change
   to a strategy or the rulebook is `blocked` until the evaluator (section
   10 step 9) screens it; a strategy's name, status, account, sizing,
   contracts, exit, instruments, timeframe, list and regime gate are never a
   proposal's to change, and a rulebook may only be tightened, key by key
   (no limit raised or turned `off`, no fact value's effective size
   multiplier raised, including a value no entry lists, which is 0; no exit
   changed, no key removed).

**With `modelScore`** (`scripts/lib/train/model-verifier.js`):

- **What runs:** the challenger replays the champion's windows with the
  same seed; judged on the paired 30-day Monte Carlo.
- **Kept only if:**
  - 0 challenger blows: hard.
  - One pooled interval over the real attempts favours the challenger on
    the pass rate.
  - No window significantly worse on pass, blow or median days.
  - Reads and adherence not significantly worse.
- **Inconclusive, never kept:** a window shorter than about 3×
  `sessions`; too few paired decisions; decisions that don't pair.
- **Resampled paths** are conditional on the window's days: never
  evidence of a gain.
- **A rulebook change:** scored under its own rulebook, on practice-train
  and practice-validate only; the account must be unchanged (else
  `blocked`); a loosening is rejected unscored.
- **Without `modelScore`:** a strategy or rulebook change stays
  `blocked`.

**The scorecard** is section 10 step 2's (`replay/scorecard.js`, read
through an adapter in `scripts/lib/train/loop.js`), under the look's rules:
tuning on the tuning windows, judging on held-out ones. Either step can be
replaced with `--steps steps.js` (a module exporting `scorecard` and/or
`evaluator`); a plugged scorecard is called only after the loop has checked
its look against the same ledger, so it can't skip the check. A held-out
judging resumed without its ledger snapshot (`ledger-before.jsonl`) is
refused: restore the file, or judge again under a new `loopId`.

## Examples

- A candidate fixed 9 targeted decisions and broke none, but it edits a
  strategy and the config names no evaluator: it stays `blocked`, never
  kept.
- A candidate that turns a judged decision `unchecked` counts that
  decision as broken.
- A challenger that wins on resampled paths but not on the real start
  days is not kept.
