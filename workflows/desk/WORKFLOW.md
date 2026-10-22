---
name: desk
description: The desk each full trade cycle runs before the head trader decides - the three analysts and risk-manager phase 1, run by the runner, not the model.
phases:
  - name: desk
    parallel: [market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager]
    request: desk
    accept: [read-data, report-shape, lookups]
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
`Data:` line, phase 1 is a risk state), and, in index mode, it looked up every
skill the bar requires of its role (`lookups`: the request names them; the order
gate counts its report only then). A role that fails is run once more, then
recorded missing and not given to the head trader: it launches that role itself,
and the order gate refuses an entry without it.

## What the head trader does with it

The reports reach the head trader in its prompt, and the order gate counts them as
returned from the runner's record of the runs (`FTH_CYCLE_ROLES`). The head trader keeps the judgment: synthesis and `compose_check`;
risk-manager phase 2 on its plan and the trade-executor are the runner's where it runs the entry
([workflows/entry](../entry/WORKFLOW.md)), the head trader's otherwise. In a managed cycle the runner runs
(where the machine opts in, on a harness that doesn't time the head trader's own launches) the head trader
manages and enters nothing. See
[docs/TOOL-CALLS-AND-ORCHESTRATION.md](../../docs/TOOL-CALLS-AND-ORCHESTRATION.md).
