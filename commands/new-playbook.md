---
description: Create a new playbook skill from strategy code, a backtest, or a described idea using the strategy-researcher agent, with optional snapshot trigger and tests.
argument-hint: "<name> <path to strategy code | description>"
---

# /new-playbook

1. Run the `strategy-researcher` agent with `$ARGUMENTS`.
2. Review the new `skills/playbook-<name>/SKILL.md` with the user: trigger,
   stop, targets, skip rules, and any flagged source-code quirks.
3. If a snapshot signal was added, run `node tests/run-all.js` and show the
   result.
4. The new setup trades at size 1 until `/setup-scorecard` shows 30+ reviews
   with positive expectancy.
