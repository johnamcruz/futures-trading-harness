---
name: runner-logs
description: Use when you need why a setup did or did not fire, or what earlier cycles saw - the runner logs.
---

# Runner logs

## When to Use

- Why a setup fired or didn't on a bar.
- What an earlier cycle was given and did, or what the gate refused.

## How It Works

To see why a setup did or didn't fire, read
that bar's record in `<FTH_HOME>/logs/scans-<day>.jsonl` (the runner's own
log is `<FTH_HOME>/logs/autotrader-<day>.log`; your earlier cycles, with
their prompts, tool calls, and skills loaded, are in
`<FTH_HOME>/logs/cycles-<day>.jsonl` and `logs/cycles/<day>/`; the gate's
decisions in `logs/gate-log.jsonl`; the runner records every decision
point of the day in `<FTH_HOME>/sessions/<day>/`, as a replay is, with
the broker field values the strategies read on each bar and an archive
of the bars, for the adherence scorecard and training: the user's to
score, not yours to edit). The cycle's log
(`logs/cycles/<day>/`) holds the prompt and what it was built from.

## Examples

```text
orb didn't fire at 10:33 ET -> logs/scans-<day>.jsonl, the 10:30 bar's record
```
