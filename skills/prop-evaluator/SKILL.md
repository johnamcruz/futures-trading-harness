---
name: prop-evaluator
description: Use when reading or reporting a replay run's prop score (pass, blow and timeout rates, days to pass).
---

# Prop Evaluator

## When to Use

- The user asks about, or shares, a replay run's prop score.

## How It Works

A replay run's prop score is the 30-day Monte Carlo of the model's own trades.
It is the user's command; an agent never runs it:
`node <root>/scripts/replay.js report <run dir> [--account <name>] [--config <replay.json>]`
(`scripts/lib/prop/model-score.js`; `sessions` is the account's attempt
length). The order is: zero blows; the pass rate within `sessions` trading
days; the median and p90 days to pass; the blow and timeout rates with their
intervals. A curated run's score is "diagnostic (reweighted)" and is never a
promotion score. When you read or report a result:

- **Quote the interval and the effective sample size,** not only the rate.
  A handful of independent attempts can't tell a 25% policy from a 40% one.
- **A blow anywhere is a failure.** The top-level blow count covers the
  real attempts, the resampled paths and the expectancy cuts.
- **Sealed windows spend a look.** A validate, test or final run's score is
  refused without the learning ledger's look, which was taken before its
  first cycle; a score is not a look and spends nothing. Only the user
  decides to take a look. A refusal is final: report it, don't route around
  it with another window or tool.

## Examples

```text
pass 30% (interval 10-62%, effective sample 9): can't tell a 25% policy from a 40% one.
Blows: 0 real, 1 on a resampled path: a failure.
```
