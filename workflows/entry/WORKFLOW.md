---
name: entry
description: A composed entry after the head trader decides - risk-manager phase 2 on its compose record, then the trade-executor with the order built in code, run by the runner, not the model.
phases:
  - name: review
    parallel: [risk-manager]
    request: review
    accept: [read-data, verdict-facts, lookups]
    retries: 1
  - name: execute
    parallel: [trade-executor]
    request: execute
    accept: [order-sent]
    retries: 0
    orders: true
---

# Entry

## What it is

In a full trade cycle where the runner runs the desk (a harness that runs a
role on its own: Claude Code, opencode; one symbol, not manage-only or paper)
and the cycle started flat with no working orders, the
head trader's job ends at its decision: an OK `compose_check`, then
`CYCLE RESULT: planned`. The runner then runs the entry, in code, with the same
roles: risk-manager phase 2 on the compose record, and on its approval the
trade-executor with the exact `place_order` arguments `order_plan` builds from
that record. The design stays multi-agent; only the sequence is code.

`planned` without an OK compose record for the cycle's bar is a process
failure: logged, and nothing runs.

## Phases

1. `review`: risk-manager phase 2 (its own run, the `review` request: the
   record, the desk's reports with phase 1's, the cycle's bars file). It counts
   only if its run read data (`read-data`), ends with a verdict and its FACTS
   line (`verdict-facts`, read by the order gate's own readers), and, in index
   mode, looked up what the bar requires of it (`lookups`). Run once more if
   not, then missing: no order. A VETO ends the entry: the cycle is a no-trade
   with its reason.
2. Between the phases, in code: the order (`order_plan`'s path,
   `trading/lifecycle-order.js`, so its rationale, brackets and, in a prop
   attempt, the policy verdict are what the gate checks) and the journal plan
   for this bar (through the broker adapter). Before them, an approving
   VERDICT line the reading still refuses (it reads as a veto, or its size
   can't be read) is restated once by phase 2 (`Size: <n>` and its VERDICT
   line), read by the same readers, its size at most the first VERDICT
   line's (`trading/phase2-restate.js`; `entry.phase2RestateRetries`).
3. `execute`: the trade-executor (the `execute` request: those arguments and
   phase 2's decisive VERDICT line, the one its approval was read from,
   `roles-ran.js decisiveLine`, never a heading). It counts if it called
   `place_order` or reported the refusal (`order-sent`). Never run again (`retries: 0`, `orders: true`:
   only a last phase may run the order role, once).

Each run is written to the cycle's role record (`FTH_CYCLE_ROLES`) with its
wall-clock times, so the order gate credits phase 2 by the same rules as a
launch, and the trade-executor's run ends the round. After it, the runner
reads the account and open orders through the adapter and sets the cycle's
outcome: executed, blocked (the gate's or the broker's refusal), or no-trade
(a veto, a failed run). See
[docs/TOOL-CALLS-AND-ORCHESTRATION.md](../../docs/TOOL-CALLS-AND-ORCHESTRATION.md).
