---
name: autonomous-trading
description: Use when a prompt says it is an autonomous or scheduled cycle - one bounded cycle per bar, the CYCLE RESULT line.
---

# Autonomous Trading

## When to Use

- The prompt comes from the autonomous runner ("autonomous cycle").
- Any headless run with no user to answer questions.

## How It Works

1. **One cycle per closed bar, then exit.** A cycle starts after each closed
   bar (1, 3, ... min), 18:00 ET until 16:00 ET the next day (RTH
   09:30-16:00 ET included); bars come in a file. Run one trade-session (or
   premarket / end-of-day if the prompt says). Never wait, sleep or poll: a
   bar closing mid-run is skipped. Several lanes, own-timeframe analysts,
   "skipped: lower priority": the `runner-lanes` skill.
2. **No questions.** Where the interactive workflow would ask: stand aside,
   keep the stop, flatten at end of day.
3. **Positions first.** A position is open: only manage it. The runner has
   already cancelled leftover orders on flat contracts, trailed stops
   (initial until `trailActivateR`, then `trailGivebackR` behind the best
   price; in the scan's `exit`) and closed trades open `exit.max_bars`.
   Never loosen its stop. Why a setup fired or not, earlier cycles: the
   `runner-logs` skill.

   The prompt (New York times; `trade-session` says how to weigh it):
   - The last 10 bars and cycle results (lanes: the `runner-lanes` skill).
     Reverse a recent decision only saying what changed. A result is a past
     conclusion: the prompt's account or attempt line beats it; say so.
   - A history line: time, symbol, lane, action (entered, skipped = your
     pass, vetoed = the risk manager's veto, planned, managed, no-trade,
     flattened, blocked, error), setup, side, price, reason; then, from
     closed bars: ticks moved, whether a skipped or vetoed setup hit +1R or
     -1R first, an entry's real R (open or closed; "unknown" or
     "unavailable": don't guess).
   - Spot patterns (a skipped setup that keeps reaching +1R; repeated
     stops). Never chase the last outcome: this bar's setup and rules decide.
   - Premarket plan. "Premarket plan unavailable": none yet; trade from the
     bars and skills (the runner retries between cycles; rarely in time on
     1-minute bars).
   - Blackouts (in force, or next); "day:" (outside RTH "overnight"); fired
     rules strategies' track records (`paper`: plan only); open trades'
     setup, initial risk, stop, target, R now, best and worst.
   - "Context unavailable": unknown, not "none" (read it yourself, or trade
     smaller).
4. **Guardrails are final.** A block from the order gate, the MCP gateway or
   the server ends the entry attempt. Fix what it names if it's yours (e.g.
   review a closed trade, cancel a leftover order), else end the cycle.
   Never edit harness files, settings, environment, strategy status,
   blackouts (except adding them in premarket) or the journal to pass a limit.
5. **Kill switch and account lock.** `[kill-switch]`, `[allowed-accounts]`,
   `[account-lock]`: manage, protect or flatten only; end `blocked`; never
   retry or trade another account (the user resolves it; the `kill-switch`
   skill).
6. **Leave a trail.** End every cycle with a journal `note` (or plan,
   review). **Your last line must be exactly:**
   `CYCLE RESULT: <no-trade | planned | executed | managed | flattened | blocked | error> - <reason>`
   - One outcome word, ` - `, the reason. Check its reasons with
     `reason_check` (setup-judgment) first: drop a FALSE one, decide again.
   - `blocked`: the gate, gateway or broker refused an order this cycle.
     Nothing fired, or you stood aside: `no-trade`. `error`: the cycle
     couldn't do its work (tools failing, facts unread).
   - The runner reads only that line. `error`, another word, or a summary,
     table or "Decision: NO TRADE" in its place is a failed cycle;
     `maxConsecutiveErrors` in a row turn on the kill switch (the runner
     still trails, protects, flattens and runs end of day).
   - Write it last, after every tool call, as plain text in your final
     message: never as a tool call or a tool's arguments.
7. **Budget.** At most one plan and one entry; reuse this cycle's bar files.
   - `bar_briefing` is the runner's file for this bar: read it once per
     role, reuse it (it doesn't change in the cycle), use its numbers.
   - **Read once per cycle**, per symbol and role (you, each analyst, each
     role call; a role you play counts as it): `strategies_scan` (with
     `name`: a separate read), `mtf_read` (one call, `daily` if you have the
     daily file), `get_account_snapshot`, `get_quote`, `get_bars`.
   - A full cycle still runs its analysts in parallel, except those under "Cached reports"
     (role-round): don't relaunch them.
   - Don't re-read what the prompt or a role gave (the trade-executor's
     report is trade-session step 6's after-order read), except:
     - No `remainingBeforeLimit` in the prompt (or, without a prop attempt,
       today's P&L): a cycle that may enter reads `get_account_snapshot`
       once (trade-session step 1). The prompt has only a working-order
       count, the trend rule, no scan details: read `list_open_orders`
       once; alignment and candidates from the briefing (`m15` `alignment`,
       `m3` `candidates`); `mtf_read` or `strategies_scan` only without a
       current briefing. "Context unavailable" items: read once yourself.
     - Account and open orders: once after each `place_order`,
       `modify_order`, `cancel_order`, `close_position`,
       `partial_close_position` (failed or timed out too: it may be live),
       and before an order call unless read since your last one (the
       Execution rule).
     - The scan: again only after new bars. A trade review's `get_bars`
       over its hold: one read per trade.
   - Retry a failed read once (the `order-failures` skill). Never
     resend an order call blindly (it may have reached the exchange): after
     a failed or timed-out one, read `list_open_orders` and
     `get_account_snapshot`; resend only if it didn't go through and is
     still needed (a close or a `[protect]` stop always is). A gate refusal ends the entry attempt unless you fixed what it
     named (rule 4).
   - A tool failing twice: confirm any open position's stop, end `error`.
   - Never wait within a cycle. An order unfilled at its one check: journal
     it as working, end (`executed` or `managed`, saying so); the next cycle
     checks the fill (the `order-mechanics` skill).
   - A refused or errored entry: as trade-session step 6 says (a refusal
     ends `blocked`); read positions and orders yourself, and fix any
     position without a working stop first.
8. **Harness tools, not scripts.** Bars, scans, the snapshot, the
   multi-timeframe read, blackouts, prop status, lessons and reconcile are
   `harness` MCP tools (each in its skill): call them, never the harness's
   scripts. Prop attempts (start, stop, record), backtests and replays
   (`replay.js`) are the user's.

## Examples

```text
CYCLE RESULT: no-trade - compose_check: 3m momentum up false (volume 0.8x)
CYCLE RESULT: managed - MNQ long from 21503.25 (1R 5.25), peak 21515.75 (+2.38R); runner trailed the stop to 21513.00 (+1.86R)
CYCLE RESULT: blocked - [loss-streak] cooldown 18 min
```
