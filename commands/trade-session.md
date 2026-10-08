---
description: Run one supervised trading cycle - parallel analyst and risk agents, head-trader synthesis, journaled plan, risk-manager verdict, then execution by the trade-executor. Stops at any veto, block, or missing trigger.
argument-hint: "[SYMBOL=MNQ] [account id]"
---

# /trade-session

One decision cycle for `$ARGUMENTS` (default MNQ). Repeat the command for the
next cycle; don't loop on your own.

## 1. Gate

- `get_server_config`. If trading is disabled, run the cycle as paper: write the
  plan, skip execution, and say so.
- If the SessionStart briefing or the journal shows a daily stop or cooldown,
  report it and end.

## 2. Parallel read (one message, five agents)

Launch in parallel with the Agent tool, passing symbol, contractId, time:
`market-structure-analyst`, `trend-momentum-analyst`,
`volume-liquidity-analyst`, `news-calendar-analyst`, and `risk-manager`
(Phase 1 risk state).

## 3. Head-trader synthesis (you)

- Tabulate each analyst's bias and confidence. A trade needs at least two of
  the three market analysts agreeing and none strongly opposed.
- Pick at most one playbook whose trigger **has actually fired** on a closed bar
  (from the trend analyst's signals or the structure analyst's live setups).
  Load that playbook skill and check every skip rule against the reports.
- No trigger, a failed skip rule, an event within 15 minutes, or a red flag
  you can't answer → **no trade**. Say what would change your mind and stop.

## 4. Plan

Write it with `journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>"]}`:
thesis, setup, trigger (what happened, with price and time), entry, stop,
target, size (position-sizing skill), $ risk, R:R, skip conditions checked,
analyst agreement.

## 5. Verdict

Send the plan to `risk-manager` (Phase 2). On `VETO`, journal a note with the
reason and stop.

## 6. Execute

On `APPROVE`, call `trade-executor` with the plan and the verdict line. Claude
Code will ask the user to approve the order tool calls; that's intended.
If the order gate or the server blocks it, report and stop. Never retry
around a block.

## 7. Report

Show the user: decision, plan, verdict, execution result, protective stop
status, and what to watch next. After the position closes, run `/trade-review`.
