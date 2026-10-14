---
name: runner-lanes
description: Use when the prompt names lanes, analysts on their own timeframe, or a lower-priority skip - one cycle, one decision.
---

# Runner lanes

## When to Use

- The prompt says "Lanes closed this cycle" or "Each analyst reads its own
  timeframe".
- A policy setup is marked "skipped: lower priority".

## How It Works

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
expires as trade-session step 2 says (the trigger check), so a 1m setup
can't wait. A cycle with only a 1m bar reuses the analysts' cached reports of the
last 3m bar (served under "Cached reports"): don't launch them again. A role
whose report the prompt doesn't give runs: another lane's setup can require
its skill lookups. When you launch the analysts and `risk-manager`,
name every other lane's setup that fired this cycle with its trend rule, as
the prompt shows it (e.g. "MNQ 1m: tick_up short, trend rule reversal"): the
order gate counts their reports for an entry only with the lookups that setup
requires, as if it were in the bar briefing.

**Analysts on their own timeframe.** When the prompt says "Each analyst
reads its own timeframe", run them as trade-session step 2 says ("An
analyst on its own timeframe").

Your last cycle results are those of the lanes that closed (each tagged
with its lanes, e.g. "MNQ 1m"), plus the first lane's last 3 and those
of the lane an open trade was entered on, so 1m cycles never crowd out
the slower decisions.

## Examples

```text
Lanes closed this cycle: 3m (every bar), 1m (on a signal)
  -> the analysts once, one plan, at most one entry across both lanes
```
