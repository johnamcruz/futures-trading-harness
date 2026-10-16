---
name: role-round
description: Use when running a full cycle's roles - their inputs and reports, cached reports, [roles-ran].
---

# Role Round

## When to Use

- Every full cycle (`trade-session` step 2).

## How It Works

- Pass each role the symbol, contractId and current time; each analyst also
  the prompt's bars file if any (absolute, e.g.
  `<FTH_HOME>/bars/MNQ-3m.json`): it starts from the bar briefing, the file
  only for what that lacks (other timeframes: `bars_fetch`). Several lanes:
  every other lane's setup that fired this cycle, with its trend rule
  (`runner-lanes`).
- A report opens with `Data:`: the briefing versions used (no current
  briefing: the tools called). No `Data:` line, or another bar's `m3`
  version while this bar's briefing is current: it didn't read this bar;
  rerun that analyst once; if it still doesn't, stand aside. An old briefing (the tool says
  so) counts as none: roles read the bars. A cached report names an earlier
  bar's versions by design; it counts (the runner checked its `m15`, `h1`,
  `day` parts are current).
- Run the roles at once as your harness's subagents, by agent name
  (risk-manager, trade-executor, …), never a generic, forked or other-CLI
  agent; foreground only (always `risk-manager` phase 2 and
  `trade-executor`); wait for all before step 3.
- A role's call is its own analysis (the order gate counts it as its
  report): never ask a role to read, load or summarize skills or files;
  load skills yourself (skill tool; none: skill_lookup or `SKILL.md`).
- No subagents (interactive): play each role in turn. Autonomous: no
  stand-in; no reports, no entry.
- **Cached reports** (in the prompt) while their basis holds: an analyst's
  (one-symbol cycle) until its briefing parts change (the next 15m close);
  `risk-manager` phase 1's while the account is unchanged (no fill, order,
  balance or attempt change, same day, no `trade-executor` call in its
  cycle). Don't launch a cached role (the harness may refuse; a trade cycle
  also refuses roles outside the desk, e.g. `strategy-researcher`). Use it
  for 15m and up; this bar's 3m facts (trigger, VWAP side, candidates) from
  the briefing. Phase 2: never cached.
- Cached reports serve the first entry only: after a `trade-executor` call
  the next entry needs every role again; where the harness refuses a cached
  launch (opencode), that is next cycle: the call ends this cycle's entries.
- Every other role runs every full cycle, carrying skills the decision
  needs (structure, liquidity, trend, momentum, VWAP, volume profile,
  session timing, sizing, pacing). The prompt's facts (trend rule, fired
  strategies) and the briefing are their input, not their reports.
- Autonomous, `[roles-ran]`: the gate refuses an entry until
  `market-structure-analyst`, `trend-momentum-analyst`,
  `volume-liquidity-analyst` and `risk-manager` returned in the foreground
  this cycle (or cached), since the last `trade-executor` call: one round
  per entry. `risk-manager` twice: phase 1, then phase 2 after phase 1 and
  the analysts that ran (phase 2 alone if phase 1 was cached). It names the
  missing roles. The refused `trade-executor` call ends the round: report
  the block, end the cycle (step 6); the next cycle reruns every role not
  under "Cached reports".
- `[phase2-facts]`: the gate checks the approving phase-2 `FACTS:` line
  against the briefing: a contradicted fact, under two checked facts
  (current briefing), or uncheckable facts refuse. Report the block and its
  fact; end the same way.

| Role (agent file) | Returns |
|---|---|
| `market-structure-analyst` | Bias, swings, levels, structure strategies in play |
| `trend-momentum-analyst` | Regime, indicator values, strategy scan results |
| `volume-liquidity-analyst` | VWAP, participation, liquidity, sweeps |
| `news-calendar-analyst` | Premarket only: events, proposed blackouts. Trade cycles: `blackouts_list`; the analyst only if today's scheduled events lack one |
| `risk-manager` (phase 1) | Account state, limits, budget, stand-down conditions |

## Examples

```text
3 analysts + risk-manager phase 1 in parallel, foreground; then step 3
```
