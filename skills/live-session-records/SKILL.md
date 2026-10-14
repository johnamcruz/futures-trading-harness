---
name: live-session-records
description: Use when reading or scoring a live trading day's records. User-run.
---

# Live session records

The live runner records each trading day as a replay run records its
days (the `replay` skill), so the same commands read it.

## When to Use

- The user wants a live trading day reported, labelled or scored.

## How It Works

1. **Live sessions.** The live runner records every trading day the same
   way, in `<FTH_HOME>/sessions/<trading day>/` (`source: "live"`): one line
   per decision point (premarket, end of day and its retries, and every
   closed bar at one of replay's trade times, a cycle or no cycle; with
   several lanes, the lanes whose bars closed in `lanes`), the
   runner config the session started with, and, once
   end of day verified the account flat, the day's fills on that end of
   day's line and the broker's journal for the day. `report`, `labels` and
   `scorecard` take a session's folder as they take a run's:
   `node scripts/replay.js scorecard ~/.futures-trading-harness/sessions/2026-10-07`.
   A session is finished once its end of day is done and its fills are
   known; a fills read that failed is retried by the runner (the manifest's
   `fillsPending`), and until then score it only with `--out` outside the
   harness home. Score live and replay decisions apart (the manifest's
   `source`): live is its own split. What still differs from a replay:
   (a) a line only for a bar the runner polled (none with the kill switch on
   unless it keeps housekeeping: an account, not paper mode, the day already
   traded; none for a bar not published in time), where a replay records
   each trade time; (b) a bar too old to start a cycle (a slow previous
   cycle) is a line with no cycle, marked `stale`; (c) a line's time is when
   the pass ran, not the close plus the poll delay, its `step` is always
   `{ code: 0, timedOut: false }`, and every bar counts (no `everyNthBar`);
   (d) fills are read once, at end of day; (e) the lines' refusals come from
   the gate log in force (`FTH_GATE_LOG`), the labels' from
   `<FTH_HOME>/logs/gate-log.jsonl`; (f) a restart on another config,
   harness or model is a new version of the same session (`versions`, its
   config in `autotrader-<since>.json`); the labels and the scorecard read
   each line with the config in force at its time (timeframe, paper mode,
   symbols), so a day started in paper mode and restarted live is labelled
   right on both halves (`--bars` then needs one-minute data: it is
   aggregated at each timeframe the session used). The fills retry runs only while the runner is idle
   (flat, its end of day done or the market closed), one day at a time.

## Examples

```bash
node scripts/replay.js scorecard ~/.futures-trading-harness/sessions/2026-10-07   # a live trading day, scored the same way
```
