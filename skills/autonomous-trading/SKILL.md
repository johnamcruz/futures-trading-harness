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
   so the next cycle and the human can see what happened. **Your last line
   must be exactly:**
   `CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>`
   (one outcome word, then ` - ` and the reason, as in the examples below).
   The runner reads only that line, from your final message: a summary, a
   table, or "Decision: NO TRADE" in its place is logged as "none reported",
   even when the cycle did its work. Write it last, after every tool call,
   as plain text in your final message: never as a tool call or a tool's
   arguments.
7. **Budget.** Keep the cycle short: reuse bar files fetched this cycle, at most
   one plan, at most one entry. The bar briefing (`bar_briefing`) is the
   runner's file for this bar: read it once per role and reuse it (it doesn't
   change during the cycle), and take its numbers instead of recomputing them. **Read once per cycle.** For each symbol, each
   role (you, each analyst, each call of a role; a role you play yourself
   counts as that role) reads each of these at most once and reuses it:
   `strategies_scan` (one with `name` is a separate read), `mtf_read` (one
   call, with `daily` when you have the daily file), `get_account_snapshot`,
   `get_quote`, `get_bars`. A full cycle still runs its analysts in parallel.
   Don't repeat what the prompt or a role gave you (the trade-executor's
   report is the after-order read of trade-session step 6), except:
   - The prompt lacks `remainingBeforeLimit` (and, without a prop attempt,
     today's P&L): a cycle that may enter reads `get_account_snapshot` once
     (trade-session step 1). It gives only a count of working orders, the
     trend rule, and no scan details: read `list_open_orders` once; take the
     alignment and the scan's candidates from the bar briefing (`m15`
     `alignment`, `m3` `candidates`), and run `mtf_read` or `strategies_scan`
     only when it says there is no current briefing. Anything under "Context unavailable", read
     once yourself.
   - Read the account and open orders once after each `place_order`,
     `modify_order`, `cancel_order`, `close_position`, or
     `partial_close_position`, including one that failed or timed out (its
     order may be live), and before an order call unless you read them after
     your last one (the Execution rule).
   - The scan again only after you fetched new bars. A trade review's
     `get_bars` over a trade's hold is one read per trade reviewed.
   - A failed read may be retried once (broker-mcp skill, Failures and
     limits). Never resend an order call blindly: after a failed or timed-out
     one, read `list_open_orders` and `get_account_snapshot`, and send it
     again only if they show it didn't go through and it is still needed (a
     close or a `[protect]` stop always is). A gate refusal ends the entry
     attempt unless you fixed what it named (rule 4).

   A tool that fails twice ends the cycle as `error` (after confirming any
   open position has its stop). Never wait within a cycle: bars and fills
   may not move until the next one. An order
   that hasn't filled at its one check is journalled as working and the cycle
   ends (`executed` or `managed`, saying it is working); the next cycle checks
   the fill (broker-mcp skill, Order mechanics). An unfilled entry without a
   stop bracket is cancelled, not left working (it would fill with no stop),
   and the cancel confirmed: cancelled, journal a `result:nofill` review and
   end as `no-trade` (entry cancelled: no stop bracket); filled before the
   cancel and protected, `executed`; still working after a second cancel,
   `error` (journal it as an entry without a stop bracket), and the next
   cycle cancels it first. Any quantity that filled is protected first.
8. **Harness tools, not scripts.** Bars, scans, the snapshot, the
   multi-timeframe read, blackouts, the prop status, lessons, and reconcile
   are tools on the `harness` MCP server (the `harness-tools` skill): call
   them; don't run the harness's scripts from a shell. Starting, stopping, or
   recording a prop attempt, backtests, replays (`replay.js`), and training
   are the user's.

## Examples

```text
CYCLE RESULT: no-trade - orb fired but relative volume 0.8x (skip rule)
CYCLE RESULT: managed - MNQ long from 21503.25 (1R 5.25), peak 21515.75 (+2.38R); runner trailed the stop to 21513.00 (+1.86R)
CYCLE RESULT: blocked - [loss-streak] cooldown 18 min
```
