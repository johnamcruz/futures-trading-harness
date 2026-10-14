---
name: replay-resume
description: Use when a replay run stopped or must resume - retries, the error limit, the kill switch. User-run.
---

# Replay resume

A replay run (the `replay` skill) resumes where it stopped; this is how,
and why a run stops.

## When to Use

- A replay run stopped, crashed, or hit its `--max-cycles`, and the user
  wants to resume it.
- A run reports retried or failed cycles, or its kill switch is on.

## How It Works

1. **Resume.** Run it again: completed days are skipped and an unfinished
   day continues after its last decision time (the broker's clock only moves
   forward). A changed config, harness or model needs a new `runId`.
2. **Stops.** A cycle that made no decision (an infrastructure failure: no
   `CYCLE RESULT` line, a harness that failed or timed out) is recorded as
   an attempt (`retried`, folded into the time's line as `retries`), and its
   decision time runs again: counted once in the report, never skipped,
   except that a crash during the retry records the time as interrupted
   (never run twice). The agent's own `CYCLE RESULT: error` is a decision:
   recorded as live records it, a failed cycle, and the run goes on with no
   retry. A premarket run's failure is never a failed cycle (as live: the
   runner retries it). The run stops, saying why, after `maxConsecutiveErrors` failed
   cycles in a row (a time still due, in the manifest's `cycleRetry`, runs
   first on resume), when a step can't run, and while the run's kill switch
   (`<run home>/STOP`) is on: the runner sets it when a cycle changed the
   workspace's operator files or settings (the file's latest line says
   why). As live, the day under way still runs with no trade cycle, its
   housekeeping and end of day included (flat at the close); the run stops
   before the next day. Review the change, remove the file, and run again
   to resume there. A queued end-of-day retry is kept across any stop (the
   error limit included) and runs first on resume; a time already recorded
   never runs again. A day whose end of day was never verified flat waits
   for that resume: the runner flattens it before the next day trades. The
   settings-format stamp (`"$version"`) Qwen Code writes into the workspace
   `.qwen/settings.json` on start is not a change.

## Examples

```bash
node scripts/replay.js run --config replay.json       # resumes after the last decision time done
```
