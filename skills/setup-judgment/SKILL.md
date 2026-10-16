---
name: setup-judgment
description: Use when deciding a cycle, and before any entry - each setup's facts, the analysts, the pick, reason_check.
---

# Setup Judgment

## When to Use

- Every decision (`trade-session` step 3); the gate refuses an entry without
  it and `trade-plan`.

## How It Works

- **Read each setup's facts first**: a composed setup's are your reads and
  the record's plan, each checked by `compose_check` (`trade-lifecycle`); a
  rules candidate's (none active), `facts`, `inTheWay`, `needR` and
  `blocked` in `m3` `candidates`. They are context, not a verdict: judge by
  the side rule (`htf-to-ltf`) and its alignment table, and the min R:R (a rules
  strategy: also its STRATEGY.md). A setup on that side, with room past
  what it needs and confluence with it is the opportunity this
  harness looks for, when the rest of this skill agrees and it isn't
  `blocked`: the strategy's normal size (position-sizing and the prop
  budget), and let its own exit work (don't bank before its trail or
  target). The priority order decides: a policy strategy's verdict
  too.
- Tabulate each analyst's bias and confidence. Trade only when at least two of
  the three market analysts agree and none is strongly opposed.
- Start from the computed regime (the briefing's `m3` `regime`, the same value
  market-snapshot and `strategies_scan` report): trend-up, trend-down, range, or transition,
  plus volatility. Don't override it with a narrative; if the analysts disagree
  with it, say why in the plan.
- **A prop attempt with a policy strategy is running** (the prompt lists
  verdicts, or `combine_status` names a policy strategy): the policy
  strategy's verdict is the only trade there can be. Plan it (`setup:<policy
  strategy>`, its contract and side, its stop ticks, at most its size) per the
  `prop-challenge-pacing` skill only when the priority order says take, at
  the size it allows; no trade when there is none, it says skip, or the
  order says no. Never tag the component (`trade_lifecycle`) yourself; the
  gate refuses it.
- **Track record** (a rules strategy; none active): weigh its signal by
  its recorded backtest and reviewed live trades: no recorded edge, a
  negative slice for this regime or hour, or live results well under it is
  a smaller trade or none. Under 30 trades is anecdotal; "no backtest
  recorded" is the weakest case; a STALE record doesn't describe it.
  `trade_lifecycle` has no backtest record: none of this cuts its size.
- **Confluence.** A composed setup's: the count of `confluence-counting`.
  Rules strategies (none active) firing both sides (`confluence.against`):
  stand aside (priority step 6: no exception).
- **The setup**: compose it (`trade-lifecycle`). A rules strategy (none
  active): at most one scan `candidate` this direction on the last closed
  bar, or a manual strategy whose trigger you verified on closed bars;
  quote the trigger; check its context filter and skip rules.
- **Check every reason against the facts** before you decide (a plan, a
  skip, or no trade): state the decision and its reasons, then call
  `reason_check {"symbol": "<SYMBOL>", "reasons": "<your CYCLE RESULT line>"}`
  once. It checks each reason against the bar briefing (the session window
  and whether it allows entries, the trend rule per side, the candidates
  and verdict, the room in R against the room needed, the multi-timeframe
  read for the side) and the attempt line, and lists each setup's
  priority-order steps as the facts answer them: judge each step on its
  own. A reason marked FALSE: name it, drop it, and decide again from the
  facts. Check UNCHECKED and UNPARSED reasons yourself; they aren't false
  for that alone. The order gate's checks still come first and don't
  change.

## Examples

```text
trade_lifecycle long: compose_check OK, read long aligned, nothing in its way -> take; reason_check
```
