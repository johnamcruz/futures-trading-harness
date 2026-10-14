---
name: replay-labels
description: Use when turning a finished replay or live session into labels.
---

# Replay labels

Labels record how the reasoning trader decided in a replay run (the
`replay` skill) or a live session (the `live-session-records` skill).

## When to Use

- The user wants a finished run or session turned into labels, or to read
  a labels summary.

## How It Works

1. **Labels.** `node scripts/replay.js labels <run dir>` turns a run into
   labels, a record of how the reasoning trader decided (any harness, any
   model), the input for measuring how closely it follows its rules: one
   per decision time and symbol in `<run dir>/labels.jsonl`, with
   `labels-summary.json`, never in the repository. Each holds the bar's
   candidates; the field values its line recorded (`values`; null with
   `valuesAbsent` for a run recorded before lines carried them, with
   `valuesError` when taking them failed) and the archived bar
   (`archivedBar`; `archiveError` when the archive can't be read or the
   bar's archiving failed, `archivePruned` when retention removed it);
   the teacher's action (`none`, `long`, `short` flat; `hold`,
   `tighten`, `exit` in a trade), its setup, its stop as a multiple of
   ATR(20) on bars closed by then, its size as a step of the budget
   (`--budget USD`; unknown without it); the gate's answer (refused intents
   kept and flagged; a refused try then an allowed retry is one decision);
   the trade's outcome from the fills; and, for a skipped candidate or one
   on a bar no cycle ran, the counterfactual: the strategy's own trade with
   the brackets `order_plan` would place, filled by the backtester's
   simulated broker (next-open fill plus a tick, stop before target in a
   bar, flat at end of day; pass the data the run replayed with
   `--bars MNQ=<file>`, else the run home's bars). Label a run only once
   it is finished: the labels hold what came after each decision, and the
   command refuses an unfinished run unless `--out` names a folder outside
   its run home. A run counts as finished once the driver ran every
   decision time of its window (`finished` in its manifest); a run made
   before the driver recorded that has no flag and can only be labelled
   with `--out` (resuming it is refused once skills changed: they are in
   its config hash). A refused try followed by one that went through is one
   decision (the refused tries counted); an intent the gate or the broker
   refused gets its candidates' counterfactual too. Candidates are only
   what the teacher could trade (a paper strategy is left out unless the
   run is in paper mode, where no flat decision is a skip); a flat cycle
   with a resting order or a manage-only cycle is no skip, and the
   strategies a failed policy screen names are no candidates. Decisions the
   mechanical action space can't express (limit or stop entries, a target
   other than the strategy's own exit as `order_plan` places it, adds,
   partial exits) are counted as uncloneable, by reason.
   Read the printed counts (taken, unknownOutcome (an entry whose call
   timed out with no broker record or fill: never counted as taken), skipped, refused, wins, losses,
   skipped-would-have-won and -lost, uncloneable, unmapped, unsimulated)
   before drawing conclusions from a run. An exit by `close_position` shows only when
   the harness's transcript names tool calls (Claude Code, Codex, Qwen
   Code, opencode); a custom harness printing plain text shows it as a
   hold.

## Examples

```bash
node scripts/replay.js labels ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03 --budget 200 --bars MNQ=~/data/MNQ-1m.parquet
```
