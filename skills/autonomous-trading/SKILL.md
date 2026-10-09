---
name: autonomous-trading
description: Rules for running the trading harness unattended (headless, scheduled by scripts/autotrader.js on Claude Code, Codex, Qwen Code, or another harness) - one bounded cycle per run, no user questions, stand aside when unsure, and never touch guardrails. Use whenever a prompt says it is an autonomous or scheduled cycle.
---

# Autonomous Trading

## When to Use

- The prompt comes from the autonomous runner ("autonomous cycle").
- Any headless run with no user to answer questions.

## How It Works

1. **One cycle per closed bar, then exit.** The runner starts a cycle right
   after each bar closes (the configured timeframe: 1, 3, ... minutes),
   through the whole 18:00-16:00 ET session, and hands you the closed bars in a
   file. Run exactly one trade-session (or premarket / end-of-day when the
   prompt says so). Don't wait, sleep, or poll inside a run; a bar that closes
   while you are still running is skipped, so finish within one bar.
2. **No questions.** Nobody is there to answer. Where the interactive workflow
   would ask, take the conservative branch: stand aside, keep the stop, flatten
   at end of day.
3. **Positions first.** If a position is open, only manage it this cycle.
   Before your cycle, the runner has already:
   - cancelled leftover orders on a flat contract;
   - for strategies whose exit trails, applied the trailing stop: the initial
     stop until `trailActivateR`, then `trailGivebackR` behind the best price
     (both in the scan's `exit`);
   - for strategies with a time stop (`exit.max_bars`), closed a trade that
     has been open that long.
   Don't loosen a stop it set. To see why a setup did or didn't fire, read
   that bar's record in `<FTH_HOME>/logs/scans-<day>.jsonl` (the runner's own
   log is `<FTH_HOME>/logs/autotrader-<day>.log`; your earlier cycles, with
   their prompts, tool calls, and skills loaded, are in
   `<FTH_HOME>/logs/cycles-<day>.jsonl` and `logs/cycles/<day>/`; the gate's
   decisions in `logs/gate-log.jsonl`). The prompt also carries the last 10
   closed bars and your last 10 cycle results: read them, and don't reverse a
   recent decision without saying what changed. It carries today's premarket
   plan, the news blackouts (in force, or the next one), the day so far (the
   "day:" line; outside RTH the "overnight" line), each fired strategy's track
   record (a `paper` one is marked: plan it only), and each open trade's state
   (setup, initial risk, stop, target, R now, best and worst): the
   `trade-session` skill says how to weigh them. Times are New York time. A
   "Context unavailable" line names what couldn't be read this cycle: that is
   unknown, not "none" (read it yourself, or trade smaller). The cycle's log
   (`logs/cycles/<day>/`) holds the prompt and what it was built from.
4. **Guardrails are final.** A block from the order gate, the MCP gateway, or
   the server ends the entry attempt. Fix what the block names when it is
   yours to fix (for example, review a closed trade, cancel a leftover order),
   otherwise end the cycle. Never edit harness files, settings, environment,
   strategy status, blackouts (except adding them in premarket), or the journal
   file to get past a limit.
5. **Kill switch.** When `<FTH_HOME>/STOP` exists the runner starts only
   manage cycles and the gate refuses every entry; you don't need to check
   the file (you can't read it). If an entry is refused with `[kill-switch]`,
   manage or flatten open positions only, and end.
6. **Leave a trail.** Every cycle ends with a journal `note` (or plan, review)
   so the next cycle and the human can see what happened, and a final line:
   `CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>`.
7. **Budget.** Keep the cycle short: reuse bar files fetched this cycle, at most
   one plan, at most one entry. A tool that fails twice ends the cycle as
   `error` (after confirming any open position has its stop).
8. **Allowed scripts.** Only these run, by absolute path:
   `strategies.js`, `market-snapshot.js`, `mtf.js`, `blackouts.js`, and
   `combine.js status`. Starting, stopping, or recording a prop attempt,
   backtests, and training are the user's.

## Examples

```text
CYCLE RESULT: no-trade - orb fired but relative volume 0.8x (skip rule)
CYCLE RESULT: managed - MNQ long from 21503.25 (1R 5.25), peak 21515.75 (+2.38R); runner trailed the stop to 21513.00 (+1.86R)
CYCLE RESULT: blocked - [loss-streak] cooldown 18 min
```
