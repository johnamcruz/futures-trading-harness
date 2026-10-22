---
name: autonomous-trading
description: Use when a prompt says it is an autonomous or scheduled cycle - one bounded cycle per bar, the CYCLE RESULT line.
---

# Autonomous Trading

## When to Use

- The prompt comes from the autonomous runner ("autonomous cycle").
- Any headless run with no user to answer questions.

## How It Works

1. **One cycle per closed bar, then exit.** The runner starts a cycle right
   after each bar closes (the configured timeframe: 1, 3, ... minutes),
   through the whole session (18:00 ET until 16:00 ET the next day, the regular
   09:30-16:00 ET hours included), and hands you the closed bars in a
   file. Run exactly one trade-session (or premarket / end-of-day when the
   prompt says so). Don't wait, sleep, or poll inside a run; a bar that closes
   while you are still running is skipped, so finish within one bar.
   Several lanes ("Lanes closed this cycle"), analysts on their own
   timeframe, or a setup "skipped: lower priority": the `runner-lanes` skill.
2. **No questions.** Nobody is there to answer. Where the interactive workflow
   would ask, take the conservative branch: stand aside, keep the stop, flatten
   at end of day.
3. **Positions first.** If a position is open, only manage it this cycle.
   Before your cycle, the runner has already:
   - cancelled leftover orders on a flat contract;
   - managed each open trade's exit: a composed one by its policy's exit
     mode (`trade-plan`); a rules one's trail or time stop (none active).
   Don't loosen a stop it set. Why a setup did or didn't fire, and what
   earlier cycles saw: the `runner-logs` skill. The prompt also carries the last 10
   closed bars and your last 10 cycle results (with several lanes, per lane: the `runner-lanes` skill): read them; each bar is
   decided on its own facts: a past pass is no reason to pass again. Those results are your past
   conclusions, not facts: where one contradicts this prompt's account or
   attempt line (e.g. it says no attempt is running and the prompt lists an
   active one), the prompt's facts win, and you say the earlier result was
   wrong. Each history line is one decision: time, symbol and lane, what
   you did (entered, skipped, vetoed, planned, managed, no-trade, flattened, blocked, error;
   skipped is your own pass, vetoed the risk manager's veto), the
   setup and side, the price, your reason, and what happened since, from
   closed bars only: ticks moved, whether a skipped or vetoed setup would have hit
   +1R or -1R first, an entry's real position (open from its fill with R now, closed with its R, or "unknown" or "unavailable": then you don't know, so don't guess). Use it to
   notice a pattern: the same setup skipped again and again while it keeps
   reaching +1R, or entries that keep getting stopped. Never chase the last
   outcome: one missed winner is not a reason to enter, and one stop is not
   a reason to skip; this bar's setup and rules decide. It carries today's premarket
   plan (when today's premarket run failed, the "Context unavailable" line
   says "premarket plan unavailable": there is no plan yet, so trade from
   the bars and your skills; the runner retries the premarket between
   cycles, and once one succeeds the next cycles carry the plan; on very
   short bars, such as 1-minute, a retry rarely fits between cycles, so a
   failed premarket usually means trading the session without one), the news blackouts (in force, or the next one), the day so far (the
   "day:" line; outside RTH the "overnight" line), and each open trade's state
   (setup, initial risk, stop, target, R now, best and worst): the
   `trade-session` skill says how to weigh them. Times are New York time. A
   "Context unavailable" line names what couldn't be read this cycle: that is
   unknown, not "none" (read it yourself, or trade smaller).
4. **Guardrails are final.** A block from the order gate, the MCP gateway, or
   the server ends the entry attempt. Fix what the block names when it is
   yours to fix (for example, review a closed trade, cancel a leftover order),
   otherwise end the cycle. Never edit harness files, settings, environment,
   strategy status, blackouts (except adding them in premarket), or the journal
   file to get past a limit.
5. **Kill switch and account lock.** On `[kill-switch]`, `[allowed-accounts]`
   or `[account-lock]`: manage, protect or flatten only, end `blocked`, and
   never retry or trade another account: the user resolves it. The details:
   the `kill-switch` skill.
6. **Leave a trail.** Every cycle ends with a journal `note` (or plan, review)
   so the next cycle and the human can see what happened. **Your last line
   must be exactly:**
   `CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>`
   (one outcome word, then ` - ` and the reason, as in the examples below;
   any other word is no result, a failed cycle).
   Check its reasons against the facts before you write it (`reason_check`,
   setup-judgment): a reason marked FALSE is dropped and the decision
   made again.
   `blocked` only when the order gate, the gateway or the broker refused an
   order this cycle; nothing fired, or you stood aside, is `no-trade`.
   `planned`: only when the prompt says the runner runs the entry; else you place it (`trade-session` 4-6).
   `error` only when the cycle could not do its work (tools failing, facts
   you couldn't read): the runner counts it as a failed cycle.
   The runner reads only that line, from your final message: a summary, a
   table, or "Decision: NO TRADE" in its place is logged as "none reported"
   and counts as a failed cycle too, even when the cycle did its work.
   `maxConsecutiveErrors` failed cycles in a row turn on the kill switch
   (the runner still trails, protects and flattens open positions, and runs
   end of day). Write it last, after every tool call,
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
   `get_quote`, `get_bars`. A full cycle still runs its analysts in parallel,
   except those whose report the prompt gives under "Cached reports"
   (role-round): those reports are this cycle's; don't launch the
   role again.
   Don't repeat what the prompt or a role gave you (the trade-executor's
   report is the after-order read of trade-session step 6), except:
   - The prompt lacks `remainingBeforeLimit` (and, without a prop attempt,
     today's P&L): a cycle that may enter reads `get_account_snapshot` once
     (trade-session step 1). It gives only a count of working orders, the
     trend rule, and no scan details: read `list_open_orders` once; take the
     alignment from the bar briefing (`m15` `alignment`), and run `mtf_read`
     only when it says there is no current briefing. Anything under "Context unavailable", read
     once yourself.
   - Read the account and open orders once after each `place_order`,
     `modify_order`, `cancel_order`, `close_position`, or
     `partial_close_position`, including one that failed or timed out (its
     order may be live), and before an order call unless you read them after
     your last one (the Execution rule).
   - The scan again only after you fetched new bars. A trade review's
     `get_bars` over a trade's hold is one read per trade reviewed.
   - A failed read may be retried once (the `order-failures`
     skill). Never resend an order call blindly: after a failed or timed-out
     one, read `list_open_orders` and `get_account_snapshot`, and send it
     again only if they show it didn't go through and it is still needed (a
     close or a `[protect]` stop always is). A gate refusal ends the entry
     attempt unless you fixed what it named (rule 4).

   A tool that fails twice ends the cycle as `error` (after confirming any
   open position has its stop). Never wait within a cycle: bars and fills
   may not move until the next one. An order
   that hasn't filled at its one check is journalled as working and the cycle
   ends (`executed` or `managed`, saying it is working); the next cycle checks
   the fill (the `order-mechanics` skill). A refused entry, or one whose
   reply was an error, is handled as trade-session step 6 says (a refusal
   ends the cycle `blocked`), and confirm it yourself: read positions and
   orders, and fix any position without a working stop first.
8. **Harness tools, not scripts.** Bars, scans, the snapshot, the
   multi-timeframe read, blackouts, the prop status, lessons, and reconcile
   are tools on the `harness` MCP server (each in its skill): call
   them; don't run the harness's scripts from a shell. Starting, stopping, or
   recording a prop attempt, backtests, and replays (`replay.js`) are the
   user's.

## Examples

```text
CYCLE RESULT: no-trade - compose_check: 3m momentum up false (volume 0.8x)
CYCLE RESULT: managed - MNQ long from 21503.25 (1R 5.25), peak 21515.75 (+2.38R); runner trailed the stop to 21513.00 (+1.86R)
CYCLE RESULT: blocked - [loss-streak] cooldown 18 min
```
