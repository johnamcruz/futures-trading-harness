---
name: trade-session
description: One complete, harness-neutral trading cycle - risk gate, parallel analyst and risk roles, head-trader synthesis against the strategy library, journaled plan, risk verdict, execution, and position management. Use for /trade-session, autonomous runs, and plan-only (paper) cycles.
---

# Trade Session

One decision cycle for a symbol (default MNQ). Run it again for the next
cycle; never loop inside one run.

## When to Use

- The user asks to trade, or the autonomous runner starts a cycle.
- Plan-only mode (`paper`, `plan only`, or trading disabled): stop after the verdict.

## How It Works

### 1. State first

- `get_server_config`. Trading disabled → plan-only mode.
- `get_account_snapshot`. **If a position is open, manage it and end the
  cycle**: confirm the protective stop is working (`list_open_orders`), apply
  the plan's management (breakeven, trail, scale-out) through the
  trade-executor role, and journal any change. No new entries while a position
  is open.
- Daily stop or loss-streak cooldown in the briefing or journal → report and end.

### 2. Parallel read

Run these roles at the same time with your harness's subagents (Claude Code:
the Agent tool; Qwen Code: the agent tool; Codex: the configured agent roles).
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
- Pick at most one strategy that is a `candidate` in the scan (or a manual
  strategy whose trigger you verified on closed bars). `show` it (strategy-library)
  and check every context filter and skip rule against the reports.
- No candidate, a failed skip rule, an event within 15 minutes, or an
  unanswered red flag → **no trade**: journal a short `note` with the reason
  and what would change it, and end.

### 4. Plan

`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>"]}`:
thesis, trigger (what happened, price, time), entry, stop, target, size
(position-sizing), $ risk, R:R, skip rules checked, analyst agreement. Add the
tag `paper` in plan-only mode.

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
$40/trade. orb skip rules clear. Plan: long 21503.25, stop 21498.00, target
21513.75, 1 MNQ, $10.50, 2R. Verdict APPROVE. Executed, stop working.
```
