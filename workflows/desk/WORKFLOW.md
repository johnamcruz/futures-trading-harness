---
name: desk
description: The desk each full trade cycle runs before the head trader decides - the three analysts and risk-manager phase 1, run by the runner, not the model.
phases:
  - name: desk
    parallel: [market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager]
    request: desk
    accept: [read-data, report-shape]
    retries: 1
---

# Desk

## What it is

Before the head trader decides a full trade cycle, the runner runs the desk: the
market structure, trend and momentum, and volume and liquidity analysts, and the
risk manager's phase 1 (the account and its limits). Each is its own run, with one
request built in code (`orchestrate/requests.js`, `desk`). The report cache serves
the roles it can; this runs the rest.

## What counts

A role's report counts only if its own run read market or account data
(`read-data`) and it is its role's report (`report-shape`: an analyst's names its
`Data:` line, phase 1 is a risk state). A role that fails is run once more, then
recorded missing: the order gate refuses an entry without it.

## What the head trader does with it

The reports reach the head trader in its prompt, and the order gate counts them as
returned. The head trader keeps the judgment: synthesis, `compose_check`,
risk-manager phase 2 on its plan, and the trade-executor. See
[docs/TOOL-CALLS-AND-ORCHESTRATION.md](../../docs/TOOL-CALLS-AND-ORCHESTRATION.md).
