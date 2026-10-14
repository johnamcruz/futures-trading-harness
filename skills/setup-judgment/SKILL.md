---
name: setup-judgment
description: Use when deciding a cycle, and before any entry - each setup's facts, the analysts, the pick, reason_check.
---

# Setup Judgment

## When to Use

- Every decision (`trade-session` step 3); the gate refuses an entry without
  it and `trade-plan`.

## How It Works

- **Read each setup's facts first** (the briefing's summary, and `facts`,
  `inTheWay`, `needR` and `blocked` in `m3` `candidates`: what the trend rule
  says for its side, the multi-timeframe read for its side, the first level
  in its way in its own R against the room it needs, confluence, the VWAP
  side, the window; `values`, also in the "fired on this bar" line: the
  broker fields its fired side's rules read, on this bar (an `any(...)`
  group's held branches only), where a field's meaning and units are in the
  strategy's own document). They are context, not a verdict: judge the setup by its
  strategy's STRATEGY.md (`strategies_show`: its context filter and skip
  rules) and these rules (the trend rule, the alignment table in `htf-to-ltf`,
  its min R:R). A setup the trend rule allows, `aligned` for its side, with
  room past what it needs and confluence with it is the opportunity this
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
  order says no. Never plan the component strategy (e.g. `orb`) yourself; the
  gate refuses it.
- **Track record.** Each strategy that fired carries its record: the
  recorded backtest (overall, in this regime, at this hour, when there are
  enough trades) and your reviewed live trades. Weigh the signal by it: a
  strategy with no recorded edge, a negative slice for this regime or hour,
  or live results well under its backtest is a smaller trade or no trade;
  say which in the plan. Under 30 trades is anecdotal, not evidence. No
  record ("no backtest recorded") is the weakest case, not a neutral one, and
  a STALE record (the strategy changed since) doesn't describe it.
- **Confluence.** Several strategies firing the same side on the bar (the
  scan's `confluence.with`, the prompt's "fired on this bar" line) is a
  stronger setup: say so in the plan, and prefer it over a lone signal. Strategies firing
  both sides (`confluence.against`) is a conflict: stand aside (the priority
  order, step 6: no exception). The backtest reports results by confluence
  (`byConfluence`); trust it over a feeling that agreement helps.
- Otherwise pick at most one strategy that is a `candidate` in the scan in
  this direction on the last closed bar (candidates are already in session and
  in regime: the trigger fired), or a manual strategy whose trigger you
  verified on closed bars and whose `regimes` fit; quote the trigger in the
  plan. The gate checks a rules strategy's trigger from the signal record;
  a manual strategy's trigger is yours and risk-manager's to verify. `show` it (strategy-library) and check every context
  filter and skip rule against the reports.
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
orb long: aligned, room 2.4R, confluence 2 -> take; reason_check
```
