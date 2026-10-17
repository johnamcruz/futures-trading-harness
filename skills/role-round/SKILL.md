---
name: role-round
description: Use when running a full cycle's roles - their inputs and reports, cached reports, [roles-ran].
---

# Role Round

## When to Use

- Every full cycle (`trade-session` step 2).

## How It Works

**Full cycle** (default):

If the prompt names a bars file (the autonomous runner writes the bars that
just closed, e.g. `<FTH_HOME>/bars/MNQ-3m.json`, by absolute path), pass the
symbol and that path to every analyst: they start from the bar briefing and
use the file only for what it lacks (other timeframes with `bars_fetch`).
Each report opens with a `Data:` line: the briefing versions it used, or,
without a current briefing, the tools it called. A report with no `Data:`
line, or naming another bar's `m3` version while this bar's briefing is
current, didn't read this bar: run that analyst again once; if it still
doesn't, stand aside. An old briefing (the tool says so) counts as none:
the roles read the bars themselves. A report the prompt gives under "Cached
reports" names an earlier bar's versions by design: the runner checked that
the parts it rests on (`m15`, `h1`, `day`) are still current, so it counts.

Run these roles at the same time with your harness's subagents, and wait for
every result before step 3. Always delegate to a harness role by its agent name
(risk-manager, trade-executor, …), never to a generic, forked, or other-CLI
agent: autonomous runs may allow only the harness roles. A role's call is that
role's own analysis (the order gate counts it as its report): never ask a role
to read, load or summarize skills or files for you; load skills yourself (your
skill tool; none: skill_lookup or `SKILL.md`). Launch each so you wait
for its result (not left running in the background), and always run
`risk-manager` phase 2 and `trade-executor` in the foreground. Without
subagents (interactively), play each role yourself in turn; in an autonomous
run there is no stand-in: without the roles' reports, no entry. A role sees
only your request: one role a launch, never "already provided". Pass symbol,
contractId, and the current time, and with several lanes every other lane's
setup that fired this cycle with its trend rule (the `runner-lanes` skill).

**Cached reports.** The autonomous runner keeps each role's last report and
gives it again under "Cached reports" in the prompt while what it rests on
holds: in a one-symbol cycle, an analyst's report while the bar briefing
parts it was built on are current (until the next 15m close); `risk-manager`
phase 1 while the account is unchanged (no fill, order, balance or attempt
change, same day, and no `trade-executor` call in the cycle that wrote it).
Don't launch a role whose report the prompt gives (where the harness can, it
refuses the launch; in a trade cycle it also refuses roles outside the desk,
such as `strategy-researcher`): use that report for its
15m-and-up view, and take this bar's 3m facts (the trigger, the VWAP side,
the setups to check) from the bar briefing. Phase 2 reviews this bar's plan and
is never cached. Cached reports count for the cycle's first entry only: after a
`trade-executor` call, the next entry needs every role again, and where the
harness refuses a cached role's launch (opencode) that is the next cycle: a
`trade-executor` call ends this cycle's entries.

Every other role runs every full cycle: each carries skills the decision needs
(market structure and liquidity, trend and momentum, VWAP, volume profile and
session timing, sizing and pacing), and neither the prompt's facts (the
trend rule) nor the bar briefing are their reports:
the briefing is their input, not their analysis.
`[desk]` (`compose_check` refused): launch the roles it names, then compose.
In an autonomous run the order
gate refuses an entry (`[roles-ran]`) until `market-structure-analyst`,
`trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` have
returned as subagents this cycle or were given under "Cached reports",
`risk-manager` twice (phase 1, then phase 2 once phase 1 and the analysts
that ran have returned; phase 2 alone when phase 1 was cached), each in the foreground (a
background launch hasn't reported), and since the last `trade-executor` call:
each entry has its own round of reports. The refusal names the roles that
were missing; the refused `trade-executor` call itself ends the round, so
report the block and end the cycle (step 6): the next cycle runs every role
again, except those its prompt gives under "Cached reports". The gate also
checks the `FACTS:` line of the phase-2 report that approved the entry
against the bar briefing (`[phase2-facts]`): a fact the briefing contradicts,
fewer than two facts it checks (with a current briefing), or facts it can't
check, refuses the entry. Report that block with the fact
it names, and end the cycle the same way.

| Role (agent file) | Returns |
|---|---|
| `market-structure-analyst` | Bias, swings, levels, breaks, candle reactions |
| `trend-momentum-analyst` | Regime, indicator values, trend and momentum |
| `volume-liquidity-analyst` | VWAP, participation, liquidity, sweeps |
| `news-calendar-analyst` | Today's events, proposed blackouts. Premarket only: on trade cycles read `blackouts_list` instead, and run the analyst only when no blackout was recorded for today's scheduled events |
| `risk-manager` (phase 1) | Account state, limits, budget, stand-down conditions |

## Examples

```text
3 analysts + risk-manager phase 1 in parallel, foreground; then step 3
```
