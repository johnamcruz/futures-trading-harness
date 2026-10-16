---
name: setup-judgment
description: Use when deciding a cycle, and before any entry - each setup's facts, the analysts, the pick, reason_check.
---

# Setup Judgment

## When to Use

- Every decision (`trade-session` step 3); the gate refuses an entry without
  it and `trade-plan`.

## How It Works

- **Facts first**, context not verdict. Composed: your reads and the
  record's plan (`compose_check`, `trade-lifecycle`). Candidate: `m3`
  `candidates` `facts`, `inTheWay`, `needR`, `blocked`. Judge by its
  STRATEGY.md (`strategies_show`: context filter, skip rules), the trend
  rule, the alignment table in `htf-to-ltf`, its min R:R.
- Trend rule allows, `aligned`, room past its need, confluence, not
  `blocked`, rest of this skill agrees: the opportunity. Normal size
  (position-sizing, prop budget); let its exit work, no banking before its
  trail or target. The priority order decides, a policy verdict too.
- Analysts: tabulate bias and confidence. Trade only if 2 of 3 market
  analysts agree and none is strongly opposed.
- Regime: start from `m3` `regime` (trend-up, trend-down, range,
  transition; volatility). No narrative override; analysts disagree: say
  why in the plan.
- **Prop attempt with a policy strategy** (prompt lists verdicts, or
  `combine_status` names one): its verdict is the only trade. Plan it
  (`setup:<policy strategy>`, its contract, side, stop ticks, at most its
  size; `prop-challenge-pacing`) only when the priority order says take, at
  its size. Else no trade. Never tag `trade_lifecycle`; the gate refuses it.
- **Track record** (backtest overall, by regime and hour when there are
  enough trades; your reviewed live trades). No edge, negative slice for this regime or hour, or live
  well under backtest: smaller or none; the plan says which. Under 30
  trades: anecdotal. No record ("no backtest recorded"): weakest, not
  neutral. STALE (strategy changed): doesn't describe it.
- **Confluence.** Composed: the `confluence-counting` count. Rules
  strategies same side (`confluence.with`): stronger. Both sides
  (`confluence.against`): stand aside (priority order step 6, no
  exception). Trust the backtest's `byConfluence` over a feeling.
- Else compose one (`trade-lifecycle`), or pick at most one: a scan
  `candidate` this direction on the last closed bar (trigger fired, in
  session and regime), or a manual strategy whose trigger you verified on
  closed bars, `regimes` fitting. Quote the trigger in the plan. The gate
  checks a rules trigger from the signal record; a manual one is yours and
  risk-manager's. `show` it (strategy-library); check every context filter
  and skip rule against the reports.
- **Check every reason** before any decision (plan, skip, no trade): state
  it with reasons, then once
  `reason_check {"symbol": "<SYMBOL>", "reasons": "<your CYCLE RESULT line>"}`.
  It checks each reason against the briefing (window and entries, trend rule per side,
  candidates and verdict, room vs needed, the side's MTF read) and the
  attempt line, and lists each setup's priority-order steps: judge each.
  - FALSE: name it, drop it, decide again from the facts.
  - UNCHECKED, UNPARSED: check yourself; not false for that alone.
  - The order gate's checks still come first, unchanged.

## Examples

```text
trade_lifecycle long: compose_check OK, read long aligned, nothing in its way -> take; reason_check
```
