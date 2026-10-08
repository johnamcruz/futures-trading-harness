---
name: trade-session
description: One complete, harness-neutral trading cycle - risk gate, parallel analyst and risk roles, head-trader synthesis against the strategy library, journaled plan, risk verdict, execution, and position management. Use for /trade-session, autonomous runs, and plan-only (paper) cycles.
---

# Trade Session

One decision cycle for a symbol (default MNQ). In autonomous mode a cycle
starts after every closed bar of the configured timeframe (1 or 3 minutes),
so finish well inside one bar. Run it again for the next cycle; never loop
inside one run.

## When to Use

- The user asks to trade, or the autonomous runner starts a cycle.
- Plan-only mode (`paper`, `plan only`, or trading disabled): stop after the verdict.

## How It Works

### 1. State first

- `get_server_config`. Trading disabled → plan-only mode.
- **Know the account before deciding anything**: balance, today's realized
  P&L and room to the daily limits, open positions, working orders, and, if a
  prop attempt is running, its floor, cushion, progress to the target,
  sessions left, and size budget. In autonomous runs the cycle prompt states
  them (as read just before the run); otherwise, or when the prompt says
  they're unavailable, read `get_account_snapshot` (and
  `node <root>/scripts/combine.js status` for an attempt). Every decision
  below (take, skip, size, manage, stand down) is made with these numbers.
- `get_account_snapshot`. **If a position is open, manage it and end the
  cycle**: confirm the protective stop is working (`list_open_orders`), apply
  the plan's management (breakeven, trail, scale-out) through the
  trade-executor role, and journal any change. No new entries while a position
  is open. Protective stops move toward the market only. If the strategy's
  exit trails (`exit` in the scan), the runner already moved the stop on this
  bar. Don't touch it unless you are exiting.
- **Flat with working orders**: cancel leftovers from a closed trade (its stop
  or target) right away; they could fill into an unplanned position. Keep only
  a pending entry from your own plan. New entries wait until no order is
  working in the contract. The runner also cancels leftovers before each bar.
- **Flat, with an earlier entry today that has no review** (it closed or was
  cancelled between cycles): run trade-review (`trade-reviewer` role) first.
  The order gate refuses the next entry until every entry is reviewed.
- Daily stop or loss-streak cooldown in the briefing or journal → report and end.

### 2. Parallel read

**Lean cycle** (the prompt says "lean"; used for 1-minute bars so a cycle
fits inside one bar): skip the parallel analysts. Run market-snapshot and
`strategies.js scan` on the bars file yourself, manage any open position, and
only when a strategy is a candidate run `risk-manager` (phase 1 and 2) before
executing. Everything else in this skill still applies.

**Full cycle** (default):

If the prompt names a bars file (the autonomous runner writes the bars that
just closed, e.g. `~/.futures-trading-harness/bars/MNQ-3m.json`), pass its path to every analyst:
they run market-snapshot and `strategies.js scan` on it instead of fetching
that timeframe again. Other timeframes are still fetched with `get_bars`.

Run these roles at the same time with your harness's subagents (Claude Code:
the Agent tool; Qwen Code: the agent tool; Codex: the configured agent roles),
and wait for every result before step 3. On Qwen Code, named subagents run in
the background by default: launch them with `run_in_background: false`, and
always run `risk-manager` phase 2 and `trade-executor` in the foreground.
Without subagents, play each role yourself in turn. Pass symbol, contractId,
and the current time.

| Role (agent file) | Returns |
|---|---|
| `market-structure-analyst` | Bias, swings, levels, structure strategies in play |
| `trend-momentum-analyst` | Regime, indicator values, strategy scan results |
| `volume-liquidity-analyst` | VWAP, participation, liquidity, sweeps |
| `news-calendar-analyst` | Today's events, proposed blackouts |
| `risk-manager` (phase 1) | Account state, limits, budget, stand-down conditions |

### 3. Head-trader synthesis (you)

- Tabulate each analyst's bias and confidence. Trade only when at least two of
  the three market analysts agree and none is strongly opposed.
- Start from the computed regime (`regime` in market-snapshot, the same value
  `strategies.js scan` reports): trend-up, trend-down, range, or transition,
  plus volatility. Don't override it with a narrative; if the analysts disagree
  with it, say why in the plan.
- Pick at most one strategy that is a `candidate` in the scan (candidates are
  already in session and in regime), or a manual strategy whose trigger you
  verified on closed bars and whose `regimes` fit. `show` it (strategy-library)
  and check every context filter and skip rule against the reports.
- No candidate, a failed skip rule, an event within 15 minutes, or an
  unanswered red flag → **no trade**: journal a short `note` with the reason
  and what would change it, and end.

### 4. Plan

`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}`:
thesis, trigger (what happened, price, time), entry, stop, exit, size
(position-sizing), $ risk, the account it was sized from (balance, today's
P&L, and for a prop attempt the cushion and size budget), skip rules checked,
analyst agreement. Add the
tag `paper` in plan-only mode.

The exit follows the strategy's `exit` (shown in the scan):

- **Trailing:** stop only, no target order. The runner trails it from
  `trailActivateR` with `trailGivebackR` give-back. The ported strategies use
  2R and 0.5R.
- **Target:** stop and target at `targetR` (or `risk.min_rr`) times the stop
  distance.

### 5. Verdict

`risk-manager` phase 2 with the plan. `VETO` → journal a note, end. In
plan-only mode, report the plan and verdict and end.

### 6. Execute

On `APPROVE`, hand the plan and verdict line to `trade-executor`. If the order
gate, the MCP gateway, or the server blocks it, report the block and end.
Never retry around a block.

### 7. Report

Decision, plan, verdict, execution result, protective stop status, and what
to watch next. After the position closes, run trade-review.

## Examples

```text
Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium, scan: orb
candidate long), volume long (rel-vol 1.6x), no events until 14:00, risk budget
$40/trade. orb skip rules clear. Plan: long 21503.25, stop 21498.00 (1R =
21 ticks = $10.50), 1 MNQ; exit: trail from +2R (21513.75), giving back 0.5R.
Verdict APPROVE. Executed with a stop bracket only, stop working.
```
