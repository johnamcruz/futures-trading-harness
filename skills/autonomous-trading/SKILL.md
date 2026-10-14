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
   through the whole session (18:00 ET until 16:00 ET the next day, the regular
   09:30-16:00 ET hours included), and hands you the closed bars in a
   file. Run exactly one trade-session (or premarket / end-of-day when the
   prompt says so). Don't wait, sleep, or poll inside a run; a bar that closes
   while you are still running is skipped, so finish within one bar.
   **Several lanes.** A runner may trade timeframe lanes (for example 3m on
   every bar and 1m on a signal). When several lanes' bars close at the same
   minute (each 3m close is also a 1m close), the prompt says "Lanes closed
   this cycle: 3m (every bar), 1m (on a signal ...)" and gives each lane's
   bars file and what fired on it: it is still ONE cycle. Run the analysts
   once, and decide once (one plan, at most one entry) across every lane's
   setups. A symbol's second lane adds only its own bars and signals; its
   trend line, plan and day are the first lane's. A 1m lane cycles only
   when its strategy fired or a position is open, and the cycle's time
   limit is the fastest lane's, so finish within that bar. When two policy
   strategies have a setup in the same cycle, or one comes while the other's
   setup from an earlier cycle is still open (on any of the runner's
   symbols: settled per runner, which trades one account), the runner keeps the one with the higher priority (lower
   `priority` number; equal or none, the 3m-and-slower one) and marks the
   other "skipped: lower priority": never enter it (the gate refuses it),
   and say in your result which one you traded. A rules strategy's signal
   expires 3 bars of its own timeframe after its bar closed, never more
   than 45 minutes (3 min on 1m, 9 min on 3m), so a 1m setup can't wait.
   A cycle with only a 1m bar reuses the analysts' cached reports of the
   last 3m bar (served under "Cached reports"): don't launch them again.
   **Analysts on their own timeframe.** When the prompt says "Each analyst
   reads its own timeframe" (e.g. trend-momentum-analyst on 15m,
   volume-liquidity-analyst on 1h), pass each named analyst its timeframe
   with the symbol (trade-session step 2). Its cached report says
   "(15m, from 10:45 ET, holds until 11:00 ET)": it rests on its own bar and
   may be up to one of its bars old, so this bar's facts come from the bar
   briefing. Merge every analyst's latest report and decide once.
   Your last cycle results are those of the lanes that closed (each tagged
   with its lanes, e.g. "MNQ 1m"), plus the first lane's last 3 and those
   of the lane an open trade was entered on, so 1m cycles never crowd out
   the slower decisions.
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
   decisions in `logs/gate-log.jsonl`; the runner records every decision
   point of the day in `<FTH_HOME>/sessions/<day>/`, as a replay is, with
   the broker field values the strategies read on each bar and an archive
   of the bars, for the adherence scorecard and training: the user's to
   score, not yours to edit). The prompt also carries the last 10
   closed bars and your last 10 cycle results (with several lanes, per lane: see rule 1): read them, and don't reverse a
   recent decision without saying what changed. Those results are your past
   conclusions, not facts: where one contradicts this prompt's account or
   attempt line (e.g. it says no attempt is running and the prompt lists an
   active one), the prompt's facts win, and you say the earlier result was
   wrong. Each history line is one decision: time, symbol and lane, what
   you did (entered, skipped, planned, managed, no-trade, flattened, blocked, error), the
   setup and side, the price, your reason, and what happened since, from
   closed bars only: ticks moved, whether a skipped setup would have hit
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
   manage or flatten open positions only, and end. `[allowed-accounts]` is
   the same for you: the account isn't on the broker's allow-list (the user's
   setup, checked by their preflight, `scripts/preflight.js`). It refuses
   entries only: manage, protect or flatten, and end the cycle `blocked`.
   **One runner per broker account.** A second live runner on an account
   another runner already trades (from any harness home of this user, under
   any broker name for the same server), or a manual `--once` trade or
   premarket run on it, is refused at start, before any cycle: `account <id> on broker "<name>" is
   already traded by another runner (pid, host, harness home, started)`.
   Preflight reports it as a failed `account lock` check. It is the user's to
   resolve: stop that runner, or trade another account (one runner trades
   several policies). Only a lock whose runner is gone may be removed; the
   runner takes such a stale lock over itself. A runner whose lock another
   runner it can identify now holds takes no broker action and exits (that
   runner manages the account); one whose lock it can't confirm stops new
   entries (the kill switch, with the reason) and keeps managing the account's
   risk. An
   entry refused with `[account-lock]` is the same for you: this cycle's
   runner doesn't hold the account's lock, the order names another account
   than the runner's, it is a manual end of day (which never takes it), or
   another runner trades the account: manage, protect or
   flatten your own position, and end the cycle `blocked`. Paper runs and confirmed replays never take the lock, so a
   replay never blocks a live run.
6. **Leave a trail.** Every cycle ends with a journal `note` (or plan, review)
   so the next cycle and the human can see what happened. **Your last line
   must be exactly:**
   `CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>`
   (one outcome word, then ` - ` and the reason, as in the examples below;
   any other word is no result, a failed cycle).
   Check its reasons against the facts before you write it (`reason_check`,
   trade-session step 3): a reason marked FALSE is dropped and the decision
   made again.
   `blocked` only when the order gate, the gateway or the broker refused an
   order this cycle; nothing fired, or you stood aside, is `no-trade`.
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
   (trade-session step 2): those reports are this cycle's; don't launch the
   role again.
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
   the fill (the `order-mechanics` skill). Every entry carries its
   stop bracket; a refused entry (`success: false` with an `errorCode`
   other than 6 (`OrderPending`) or 7 (`UnknownError`), its brackets
   included) ends the cycle as `blocked` with the broker's message,
   journalled, and is never sent again without its bracket. Any other error
   on an entry (codes 6 and 7 included) is an unknown outcome, not a refusal: read positions and
   orders at once, protect or close any position without a covering stop
   first, and never re-send it.
8. **Harness tools, not scripts.** Bars, scans, the snapshot, the
   multi-timeframe read, blackouts, the prop status, lessons, and reconcile
   are tools on the `harness` MCP server (the `harness-tools` skill): call
   them; don't run the harness's scripts from a shell. Starting, stopping, or
   recording a prop attempt, backtests, and replays (`replay.js`) are the
   user's.

## Examples

```text
CYCLE RESULT: no-trade - orb fired but relative volume 0.8x (skip rule)
CYCLE RESULT: managed - MNQ long from 21503.25 (1R 5.25), peak 21515.75 (+2.38R); runner trailed the stop to 21513.00 (+1.86R)
CYCLE RESULT: blocked - [loss-streak] cooldown 18 min
```
