---
name: prop-evaluator
description: Use when reading or reporting a policy strategy's evaluator result (pass, blow and timeout rates on history).
---

# Prop Evaluator

## When to Use

- The user asks about, or shares, a policy strategy's evaluator result.

## How It Works

How often a policy strategy passes, blows or times out on history is the
evaluator's answer. It is the user's command, as the backtester is; an agent
never runs it:
`node <root>/scripts/evaluate.js --prop <policy> --data <SYMBOL>=<bars file> --from <date> --to <date>`
(`docs/BACKTESTING.md`, "The two-layer evaluator"). It prints the pass,
blow and timeout rates with their intervals, the effective sample size
(attempts that share no session), the resampled paths, the expectancy cuts,
and the promotion gate's verdict. When you read or report its result:

- **Quote the interval and the effective sample size,** not only the rate.
  A handful of independent attempts can't tell a 25% policy from a 40% one.
- **A blow anywhere is a failure.** The top-level blow count covers the
  real attempts, the resampled paths and the expectancy cuts.
- **Only Train runs freely.** The evaluator refuses any other window
  without a look (`--look-candidate`, `--look-purpose tuning|judging`,
  `--ledger <file>`) that the ledger allows. It logs the look before reading
  a bar. Looking spends the out-of-sample budget: only the user decides to
  take one, knowing which window and what it spends. A refusal
  (`needs a look`, `retired`, `reserved`, `crosses a unit`) is final: report
  it, don't route around it with another window or tool.
- **Flow-off results.** For a policy whose strategies read broker fields,
  attempts outside the fields' coverage are marked `flowOff`. They show the
  policy without that branch, not as it trades live.

## Examples

```text
pass 30% (interval 10-62%, effective sample 9): can't tell a 25% policy from a 40% one.
Blows: 0 real, 1 on a resampled path: a failure.
```
