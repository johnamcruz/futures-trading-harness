---
name: gate-refusals-skills
description: Use when the gate refuses an entry with [skills-at-entry].
---

# Gate refusals: skills

## When to Use

- The gate refused an entry with `[skills-at-entry]`.

## How It Works

| Message | Meaning | Do |
|---|---|---|
| `[skills-at-entry] … not read in this session: <skills>` | An entry before the head trader read `setup-judgment` and `trade-plan` (the skill tool, or `skill_lookup`) in this session; also when the session's transcript can't be read | Autonomous: end the cycle `blocked` (trade-session step 6); next cycle, read both before handing on a plan. Interactively: read both, then plan again. Unreadable transcript: check the CLI writes its session transcript. Exits, `[protect]` stops, stop moves, size cuts and cancels still go. |

## Examples

```text
place_order -> [skills-at-entry] ... not read in this session: trade-plan
  end blocked; next cycle read both before the plan
```
