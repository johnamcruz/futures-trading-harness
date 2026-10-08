---
description: Per-setup expectancy scorecard from journal reviews and get_performance - win rate, R, expectancy with confidence band, rule-break share - with promote, restrict, or cut recommendations.
argument-hint: "[week|month|all]"
---

# /setup-scorecard

1. Load the `setup-expectancy` skill.
2. `get_performance` for the window in `$ARGUMENTS` (default month).
3. `journal_read {kind:"review"}` (raise `limit` to cover the window) and group
   by `setup:*` tag. Keep `paper` reviews in a separate column.
4. Compute n, win rate, average win and loss in R, expectancy, profit factor,
   the ±2σ/√n band, and the rule-break share per setup.
5. Show a table sorted by expectancy, with the recommended action per the
   skill's decision table. Ask the user before writing any `lesson` that
   restricts or cuts a setup.
