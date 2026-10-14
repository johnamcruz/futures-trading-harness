---
name: topstep_100k
description: The rulebook for this account - the numbers its policy strategies trade with and which of its rules the code enforces or the skills teach. Today's values; nothing is learned yet.
learned: none                   # none: today's values, carried over unchanged (docs/LEARNED-RULEBOOK.md, step 7)
daily_loss_soft: 1000           # dollars: no new entries for the rest of the day once the day is down this much
policies:                       # each policy strategy that trades this account (its STRATEGY.md names it; never restates these)
  prop_portfolio:
    sizing:                     # risk from the headroom above the floor
      cushion_frac: 0.3         # a trade risks at most this share of the cushion ...
      cap_usd: 1000             # ... and at most this many dollars
      drawdown_halve_usd: 1500  # half that while the balance is this far or more below its peak
      min_size_guard: 1.5       # one micro may risk up to this many times the budget; a mini never more than the budget
      stop_slippage_ticks: 1    # a stop's expected slippage, counted in each contract's risk
      clock_k: off              # a number: also at most k x what the pass still needs per session left; off: none
      r_per_session: 0.3        # the R a session is expected to make, for clock_k
    exit:
      trail_activate_r: 2       # hold the setup's own stop until this many R ...
      trail_giveback_r: 0.5     # ... then trail this many R behind the best price
    multipliers: []             # enforced size multipliers folded into the verdict: none yet
  prop_flow_1m:
    sizing:
      cushion_frac: 0.2
      min_size_guard: 1.5
      cap_usd: off              # off: no dollar cap
      drawdown_halve_usd: off   # off: no drawdown halving
      stop_slippage_ticks: 1
      clock_k: off
      r_per_session: 0.3
    exit:
      trail_activate_r: 2
      trail_giveback_r: 0.5
    multipliers: []
enforced: [daily_loss_soft, sizing, exit, multipliers, target_stop, consistency_stop, one_position, hard_stops, trend_rule]
taught: [trend_fade, room, mtf_read, skip_rules, confluence, secondary_context, halving]
---

# Rulebook: `topstep_100k`

The one place for the numbers this account's policy strategies trade with
(docs/LEARNED-RULEBOOK.md, R1-R4). The frontmatter holds every value; nothing
else states one. The account loader takes the soft daily stop from here, and
the strategy loader each policy's sizing, trail and multipliers, so the
runner, the sizing verdict, the order gate and the backtester all read them
from this file. A policy strategy listed here may not set them itself.

## When to Use

- To see or change what a policy strategy on this account risks, how it
  exits, or when the day stops: edit the frontmatter here, never the
  strategy or a skill.
- To see which rules the code holds (`enforced`) and which the skills teach
  (`taught`).

## How It Works

**Kinds (R4).** An `enforced` item is computed from facts the harness has
and held in code: the runner folds it into the verdict and the order gate
holds the order to it; the LLM can only lower the size. A `taught` item is a
judgment: the priority order in the `strategy-library` skill teaches it, at
the step named in `scripts/lib/trading/rulebook.js` (`ITEMS`). The loader
refuses an item classified as a kind no code or skill provides.

**The verdict's multiplier (R4).** Each verdict carries a `multiplier`: the
product of the policy's `multipliers` items, each the value its fact maps
to. A missing or stale fact sets its item to 0, so the setup is skipped. A
full verdict is sized at its multiplier; the gate refuses any action other
than `full` or `skip`, and a full verdict without a multiplier above 0 and at
most 1. There are no multiplier items yet, so every full verdict carries 1
and every skip 0: decisions are as before. No code supplies a fact yet (the runner and the backtester pass none), so an item added before its fact source exists skips every setup: it fails closed.

**Evidence (R3).** Nothing here is learned yet. Each value is today's,
carried over unchanged when the rulebook was created; the search and the
calibration (docs/LEARNED-RULEBOOK.md, sections 5 and 6) will replace each
one with its evidence.

| Value | Today's source | Training-window effect | Stability across years | Learned |
| --- | --- | --- | --- | --- |
| `daily_loss_soft` | this account's profile | not measured | not measured | not learned |
| `policies.prop_portfolio.sizing` | `prop_portfolio`'s STRATEGY.md | not measured | not measured | not learned |
| `policies.prop_portfolio.exit` | `prop_portfolio`'s STRATEGY.md | not measured | not measured | not learned |
| `policies.prop_flow_1m.sizing` | `prop_flow_1m`'s STRATEGY.md | not measured | not measured | not learned |
| `policies.prop_flow_1m.exit` | `prop_flow_1m`'s STRATEGY.md | not measured | not measured | not learned |

Every sizing key is stated for every policy: the loader refuses an entry
that leaves one out, since the code's default (`combine.js`
`DEFAULT_SIZING`) is off for the cap, the drawdown halving and the clock
and would loosen risk unseen. A limit is turned off only by the word `off`
(`prop_flow_1m` has no cap, no drawdown halving and no clock, as before):
0, an empty value, a negative number or text is refused, never read as
off. Each policy is sized only from here: a policy on this account that
isn't listed is refused, and so is the account when this file is missing,
malformed, or names another account.

## Examples

```text
node scripts/combine.js status
  prop_portfolio size budget: cushion_frac x the cushion, at most cap_usd,
  halved while the balance is drawdown_halve_usd or more below its peak.

A verdict: prop_portfolio long setup from orb: full, multiplier 1,
  at most 4 NQ with a 40-tick stop. A multiplier item whose fact is missing
  would make it a skip.
```
