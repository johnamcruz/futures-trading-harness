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
   after each 1- or 3-minute bar closes and hands you the closed bars in a
   file. Run exactly one trade-session (or premarket / end-of-day when the
   prompt says so). Don't wait, sleep, or poll inside a run; a bar that closes
   while you are still running is skipped, so finish within one bar.
2. **No questions.** Nobody is there to answer. Where the interactive workflow
   would ask, take the conservative branch: stand aside, keep the stop, flatten
   at end of day.
3. **Positions first.** If a position is open, only manage it this cycle.
4. **Guardrails are final.** A block from the order gate, the MCP gateway, or
   the server ends the cycle. Never edit harness files, settings, environment,
   strategy status, blackouts (except adding them in premarket), or the journal
   file to get past a limit.
5. **Kill switch.** If `~/.futures-trading-harness/STOP` exists, place no new
   entries; manage or flatten open positions only.
6. **Leave a trail.** Every cycle ends with a journal `note` (or plan, review)
   so the next cycle and the human can see what happened, and a final line:
   `CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>`.
7. **Budget.** Keep the cycle short: reuse bar files fetched this cycle, at most
   one plan, at most one entry.

## Examples

```text
CYCLE RESULT: no-trade - orb fired but relative volume 0.8x (skip rule)
CYCLE RESULT: managed - MNQ long +1.1R, stop moved to breakeven 21503.25
CYCLE RESULT: blocked - [loss-streak] cooldown 18 min
```
