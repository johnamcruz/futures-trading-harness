---
name: topstep_50k
description: The rulebook for this account - the numbers its policy strategies trade with and which of its rules the code enforces or the skills teach. Today's values; nothing is learned yet.
learned: none                   # none: today's values, carried over unchanged (docs/LEARNED-RULEBOOK.md, step 7)
daily_loss_soft: 500            # dollars: no new entries for the rest of the day once the day is down this much
enforced: [daily_loss_soft, sizing, exit, multipliers, target_stop, consistency_stop, one_position, hard_stops, trend_rule]
taught: [trend_fade, room, mtf_read, skip_rules, confluence, secondary_context, halving]
---

# Rulebook: `topstep_50k`

The one place for the numbers this account's policy strategies trade with
(docs/LEARNED-RULEBOOK.md, R1-R4). The frontmatter holds every value; nothing
else states one. No policy strategy trades this account yet, so it holds the
soft daily stop and the classification only; a policy that names this
account gets its sizing, trail and multipliers here (`policies`, as the
100K account's rulebook has them).

## When to Use

- To see or change when the day stops on this account: edit the frontmatter
  here, never the account profile or a skill.
- To see which rules the code holds (`enforced`) and which the skills teach
  (`taught`).

## How It Works

The kinds, the verdict's multiplier and the evidence work as in every
rulebook (`scripts/lib/trading/rulebook.js`): an `enforced` item is held in
code, a `taught` item is taught by the priority order in the
`strategy-library` skill.

**Evidence (R3).** Nothing here is learned yet.

| Value | Today's source | Training-window effect | Stability across years | Learned |
| --- | --- | --- | --- | --- |
| `daily_loss_soft` | this account's profile | not measured | not measured | not learned |

## Examples

```text
node scripts/combine.js status
  entries blocked once the day is down daily_loss_soft dollars, until the next session.
```
