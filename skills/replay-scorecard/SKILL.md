---
name: replay-scorecard
description: Use when scoring a finished replay or live session against the trader's rules.
---

# Replay scorecard

The adherence scorecard of a replay run (the `replay` skill) or a live
session (the `live-session-records` skill).

## When to Use

- The user wants a finished run or session scored against the priority
  order, or its flagged decisions reviewed.

## How It Works

1. **Scorecard.** `node scripts/replay.js scorecard <run dir>` scores every
   decision against the priority order (`strategy-library`): the facts the
   trader had at that time, from the run's own records (the scan's candidates
   and verdict, the trend rule per side, the room and the multi-timeframe read
   from the briefing rebuilt with the runner's own code on the bars closed by
   then, confluence, the session window, the attempt); the decision the
   order's mechanical steps expect (no trade, or take at most the verdict's
   size, halved once; a step it can't compute leaves it `unchecked`, and the
   skip rules and secondary context are left to judgment; an entry is judged
   against the setup it traded, a skip against the best one on the bar; a
   take that a judgment step can still turn down, a pullback, a reversal
   fading the trend, or halving a size the record doesn't give, scores
   neither a skip nor an entry right or wrong); what the trader did
   and the reasons its CYCLE RESULT gave, each checked against the facts
   (`true`, `false`, or `unchecked` when no fact can check it; a clause it
   doesn't recognize is `unparsed`, never counted as right; a claim about a
   setup the bar didn't have is `incidental`, reported apart and never the
   category). Each decision
   gets a category: `right`, `wrong-side entry`, `bad size` (over the ceiling,
   or an entry where the order says no trade), `early close` (an exit the
   trader sent before the plan's exit was reached; a partial exit, one past
   the time stop, or one after giving back most of a large best is
   `unchecked`), `excessive abstention` (a skip where the order
   says take, on false grounds or none), `wrong stated reason` (the right
   decision, a false reason), `risk-rule rejection` (the gate or the broker
   refused the entry), or `unchecked` (a judgment skip, a failed cycle, facts
   missing). It writes `scorecard.jsonl` (one record per decision, with the
   trade's R and dollars, a skipped setup's counterfactual, and the account
   pacing: cushion, daily-limit headroom, balance check),
   `scorecard-summary.json` and `scorecard.md` (agreement overall, by step
   and by strategy, the categories, the wrong-reason rate, trades, skipped
   setups, the account by day). Every failure carries a severity (`high`: a
   wrong-side entry, or an entry where the order says no trade; `medium`: a
   size over the ceiling, an early close, an excessive abstention, a refused
   entry, or a false hard-stop reason such as the window or the trend rule;
   `low`: any other false reason on a right decision), and the report counts
   the failures per type, per session day and per run, with rates.
   Everything is decided by code from the record, never by a model.
   **Session timing:** a false claim about the window ("opening print until
   10:00" in the opening drive, "session closed" or "opens 18:00" at 10:48)
   is a session-timing misread, counted apart inside its category.
   **Field check:** for a strategy whose rules read broker fields
   (`field("a.b")`), its field conditions are checked on the values the
   decision line recorded; an entry on a setup the scan did not fire whose
   own side fails is a `wrong-side entry` (the other side, all on fields,
   holds) or a `bad size` (the order says no trade), and a fired setup the
   values contradict is a recording `mismatch`, never the trader's failure.
   **Claim checks:** when a cycle record carries its own reason checks
   (`reasonChecks`; no cycle records them yet), a right decision that still
   states a claim its own check found false is a `wrong stated reason`;
   without them it reads "not checked". **Missing data:** values absent (a
   session recorded before they were), a values error, an archive error or a
   pruned archive are counted, never filled in. It also writes
   `flagged.jsonl` and `flagged.md`: one entry per failure, with what the
   trader saw (pointers, relative to the run home, to the decision line, the
   cycle record, the prompt's hash and the scan line, and the facts), what it
   did and said, what the code found, and one sentence to review it by.
   Scoring a run is a look at its days (`scripts/lib/prop/looks.js`):
   `--purpose reasoning-fix` (the default for a run in Recent and the only
   look Recent allows, e.g. the June 1-5, 2026 replay), `tuning` (the
   default elsewhere) or `judging` (it needs `--ledger <file>`, the look
   ledger the evaluator also uses: JSON lines, one look per line; an older
   ledger written as one JSON list still reads and is converted to lines on
   its next look. Each allowed look is appended to a ledger given, so the
   scorecard's and the evaluator's looks spend one budget. Use the one
   existing look ledger; never create, empty, replace or edit a ledger to
   get more looks, and if the ledger is missing or refused, stop and report
   it), `--candidate <name>`; a look the schedule refuses (a reserve
   half-year, a held-out quarter not judged) stops it before anything is
   read, and a live session is no look. On a reasoning-fix look every
   market outcome is hidden (owner, 2026-10-13): no trade results, no
   skipped setup's counterfactual, no account balance or P&L, and an exit
   is never scored from its excursion, and a dollar amount in any text (an
   entry block, a verdict reason, the trader's own words) reads `$…`; only
   the reasoning and fact
   failures show. A tuning look, or a live session, shows everything. Like
   labels, it is written in the run's own
   folder only once the run is finished, else to `--out` outside its run
   home; `--bars` as for labels. Read `unchecked` and `unparsed` as
   unmeasured, never as agreement; a false reason is a misread of a fact the
   trader was given.

## Examples

```bash
node scripts/replay.js scorecard ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03 --bars MNQ=~/data/MNQ-1m.parquet
```
