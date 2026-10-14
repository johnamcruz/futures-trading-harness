---
name: reason-check
description: Check stated reasons against this bar's facts (reason_check).
---

# Reason Check

## When to Use

- Before a decision line goes out.

## How It Works

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `reason_check` | `symbol`, `reasons` (your decision line: CYCLE RESULT or VERDICT, with phase 2's FACTS line, at most 2000 characters), `json`? | each reason you stated checked against the facts of the bar you decide (this cycle's bar briefing: the session window and whether it allows entries, so a claim that the session is closed, in premarket or opens later is checked too (in an entry's result a window claim is UNCHECKED: it is no ground for an entry), the trend rule per side, the candidates, the room in R against `needR`, the multi-timeframe read per side; the policy verdicts on that bar; the started prop attempts): `TRUE`, `FALSE` (with the fact) or `UNCHECKED` per claim, `JUDGMENT` and `UNPARSED` clauses for you to check, and each setup's priority-order steps as the facts answer them; a FACTS line's claims each `TRUE`, `FALSE` or `UNCHECKED` against the briefing, as the order gate checks them. Read-only: it decides nothing; without a current briefing it checks nothing and says so | `reason-check.js --symbol MNQ --reasons "<line>" [--json]` |

A reason marked FALSE: name it, drop it, and decide again from the facts.
Check UNCHECKED and UNPARSED reasons yourself against the briefing; they
aren't false for that alone. Without a current briefing, check them against
the plan and the reports. In an autonomous cycle the order gate checks
phase 2's FACTS line itself (`[phase2-facts]`).

## Examples

```text
reason_check {"symbol": "MNQ", "reasons": "CYCLE RESULT: no-trade - opening print window until 10:00 ET; no prop attempt running"}
→ Reasons checked against this bar's facts:
  - FALSE no-entry-window: "opening print window until 10:00 ET" - the opening drive window allows entries (09:57 ET)
  - FALSE no-attempt: "no prop attempt running" - the my_50k attempt is active
  The priority order, step by step, as the facts answer it:
  - orb short: 1 hard stops pass (no hard stop); 2 trend rule pass (the trend rule allows a short); 3 room no-trade (VWAP (rth) at 0.4R before the 2R it needs); ...
  2 reasons FALSE: name each, drop them, and make the decision again from the facts.
```
