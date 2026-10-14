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
| `[skills-at-entry] … not read in this session: <skills>` | An entry before the head trader read `setup-judgment` and `trade-plan` (the skill tool, or `skill_lookup`) in this session; also when the session's transcript can't be read | Read each, judge the setup and write the plan by them (trade-session steps 3 and 4), then plan again; never place it unread. Exits, `[protect]` stops, stop moves, size cuts and cancels still go. |

## Examples

```text
place_order -> [skills-at-entry] ... not read in this session: trade-plan
  read trade-plan, plan again by it, then hand the plan on
```
