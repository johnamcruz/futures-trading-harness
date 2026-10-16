---
name: trade-session
description: Use when running one trading cycle - /trade-session, an autonomous run's cycle, or plan-only (paper).
---

# Trade Session

One decision cycle per symbol (default MNQ), one run per cycle: never loop.
Autonomous: after every closed bar (1 or 3 min); finish well inside it.

## When to Use

- The user asks to trade, or the autonomous runner starts a cycle.
- Plan-only (`paper`, `plan only`, trading disabled): stop after the
  verdict; never call an order tool. A `paper` journal tag stops no order;
  only `FTH_PAPER=1` (or trading disabled on the server) makes the gate
  refuse live entries.

## How It Works

### 0. Load the skills

Before any decision, load `trade-session` (this skill),
`multi-timeframe-analysis` and `trade-lifecycle` with the skill tool (a
rules entry: `strategy-library`, `strategy-scan`, `strategy-gate-checks`
too). The gate refuses an entry until each is loaded (an errored load
doesn't count); one in your prompt counts: don't reload (no skill tool:
skill_lookup). Load `trader-process` too: your decision order. Load
`htf-to-ltf` every cycle as well: alignment labels per side, the reversal
rule. Others as a step names them.

### 1. State first

- `get_server_config`. Trading disabled → plan-only. The gate refuses any
  entry until its `maxOrderSize` is recorded, and any over it (never exits
  or stops).
- **Know the account first** (every take, skip, size, manage, stand down
  uses it): balance, today's realized P&L, room to the daily limits,
  positions, working orders; an attempt's floor, cushion, progress, sessions
  left, size budget. The autonomous prompt states balance, positions,
  working orders and attempt numbers; it lacks today's P&L and room: a
  cycle that may enter reads `get_account_snapshot` (`remainingBeforeLimit`),
  and `combine_status` for an attempt.
- **Position open**: the `manage-position` skill, then end.
- **Stale data, no decision**: the bars file's last closed bar over one bar
  (plus a minute) old, or not your timeframe → manage open positions only,
  journal a note, end. Interactively, check the front month
  (`search_contracts` / the roll guidance in `contract-roll`) first.
- **Flat with working orders**: the `leftover-orders` skill.
- **Flat, an earlier entry today unreviewed**: trade-review
  (`trade-reviewer` role) first; the gate refuses the next entry until
  every entry is reviewed.
- Daily stop or loss-streak cooldown (risk-manager phase 1, the prompt, the
  journal) → report, end. Past `FTH_MAX_ENTRIES_PER_DAY` (default 6) entries
  a day the gate refuses: manage and end.
- **A tool fails** (timeout, 429, 5xx, empty reply): retry a read once after
  a few seconds; an order call never blindly: read `list_open_orders` and
  `get_account_snapshot` first (it may have reached the exchange).
  `get_bars`: 50 requests per 30 s across all agents; use the bars file.
  Account unreadable → nothing new; report, end.
- **Bars, interactively**: `bars_fetch`
  (`{"symbol": "<SYMBOL>", "timeframe": <3 or 1>, "record": true}`) writes
  the runner's default count (5000 3-minute, 15000 1-minute) to
  `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json` (use the returned path) and
  records the multi-timeframe read for the gate (`bar-briefing`). Never
  paste a long `get_bars` reply into a file.

### 2. Parallel read

**Every cycle, first:** `bar_briefing {"symbol": "<SYMBOL>"}` (the
`bar-briefing` skill): the runner's analysis of this bar per timeframe
(alignment, trend rule, candidates, levels, VWAP, liquidity, window;
versioned). Once per role, reused: no role re-runs `market_snapshot`,
`mtf_read` or `strategies_scan` for it. No current briefing (none or old):
`mtf_read` on the bars file (the `timeframe-sources` skill).

**The trend rule is enforced:** a trend strategy never enters against the
prevailing trend (the highest of 4h, 1h, 15m with a trend); never argue one
into it. Only `mtf: reversal` fades it; a composed entry only with a true
CHoCH its way at or above the trend's frame (`trade-lifecycle`). The scan
drops such candidates; the gate refuses them. Autonomous: the prompt states the
recorded rule. Interactively, `bars_fetch` (or `mtf_read` with `symbol`)
with `record` records it; trend entries need it under 15 minutes old
(fetch fresh bars; re-recording an old file doesn't help). The side's read
goes in the plan entry. A policy verdict is a ceiling, never an order.

**The trigger is checked too.** A rules entry needs that strategy's
`candidate`, that side, on a bar closed at most 3 bars of its own timeframe
ago, and never more than 45 minutes ago (3 min on 1m, 9 min on 3m, 45 min
on 15m and 1h), per the signal record (the runner records every bar;
interactively `strategies_scan` with the bars file, `symbol`,
`record: true`). Only the strategy that fired: another tag is refused. A
composed entry's trigger is this bar's compose record (`trade-lifecycle`).

**Lean cycle** (prompt says "lean"): the `lean-cycle` skill. **Full cycle**
(default): the `role-round` skill (roles, reports, `[roles-ran]`; own
timeframe: `runner-lanes`).

### 3. Head-trader synthesis (you)

Decide in the `trader-process` skill's order and write its PLAN block
before your result line; the checks below fill it. It adds no filter.

- The priority order (the `strategy-library` skill) decides every setup, a
  policy verdict too, step by step.
- Every decision: the `setup-judgment` and `day-context` skills; before an
  entry, `trade-plan` too (the order gate refuses an entry until
  `setup-judgment` and `trade-plan` were read). Open trade: `manage-position`.
- No setup (no candidate, no `compose_check` OK), a failed skip rule, an
  event within 15 minutes, or an unanswered red flag → **no trade**:
  journal a short `note` (reason, what would change it); end.

### 4. Plan

The `trade-plan` skill: plan entry, exit, ticks, `order_plan`.

### 5. Verdict

`risk-manager` phase 2 on the plan. `VETO` → journal a note, end.
Plan-only: report plan and verdict, end. Pass its `FACTS:` line on with
the verdict line, unchanged.

### 6. Execute

`APPROVE` → plan and verdict line to `trade-executor`. Blocked by the gate,
the MCP gateway or the server: report, end; never retry around it. After
placing: the `entry-outcome` skill.

### 7. Report

Decision, plan, verdict, execution, stop status, what to watch. After the
position closes, trade-review.

## Examples

```text
Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium), volume
long (rel-vol 1.6x), no events until 14:00. compose_check long OK. Plan (numbers
from the record): limit long 21540.25, stop 21512.50 (111 ticks = $55.50),
target 21598.00 (231 ticks, 2.08R), 1 MNQ.
Verdict APPROVE. Executed with stop and target brackets, stop working.
```
