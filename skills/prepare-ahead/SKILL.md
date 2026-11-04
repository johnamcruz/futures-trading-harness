---
name: prepare-ahead
description: Use when a prompt says Prepare ahead or Your plan said - write the bar plan during the bar, then confirm at the close only what the closed candle meets.
---

# Prepare Ahead

## When to Use

- The prompt says "Prepare ahead": you write the plan for the next close, from closed bars only.
- The prompt says "Your plan said: scenario k": the close has come; you confirm or pass.

## How It Works

**The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass.**

A side the Bias line or the trend rule refuses is no trade, whatever the plan or the candle: pass.

Prepare (no compose_check, no order, no role this run):

- Write one line per scenario, in this form:
  `SCENARIO k: <candidate id and its read, from "Possible at the next close"> → TAKE if <conditions on the closing candle> | PASS if <...>; reads: <the compose reads, each in quotes, in the briefing's read names>; why: <one line>`.
- Then `STAND DOWN if: <account, room, window, news, a level breaking>` and `INVALID if: <what voids the plan before the close>`. End with `PLAN END`.
- Reads: the briefing's read names, in quotes. Never invent a read.
- TAKE and PASS conditions: on the closing candle (its close, body, wick), so the at-close facts can settle them.

Confirm (the close has come):

- The at-close facts decide, never the plan. The plan is never evidence: its reads, numbers and reasons prove nothing.
- Closed candle meets the scenario's TAKE conditions: confirm. Confirming is compose_check with the reads as the at-close facts give them (not as the plan wrote them), then as the cycle's prompt says. A met candle is never a pass.
- Closed candle does not meet them: pass, with why in the CYCLE RESULT. A plan that said take is no reason to take.
- The candle meets a different listed scenario's TAKE conditions, or something fired outside the plan: reason it from the facts, in full, as a cycle does. It may be taken or passed; a plan that said pass is no reason to pass.
- A STAND DOWN or INVALID condition true at the close: pass.

## Examples

- Plan: `SCENARIO 1: P1 "15m rejection at VWAP" → TAKE if the 3m closes back above VWAP with a lower wick | PASS if it closes below VWAP; reads: "15m rejection at VWAP"; why: the level held`. The close is above VWAP with the lower wick: confirm, compose_check with the at-close reads.
- Same plan, the close is below VWAP: pass ("closed below VWAP, TAKE not met").
- Plan said take scenario 2, the closed candle has no wick and closed inside the range: pass. The plan is not evidence.
- Plan said pass scenario 1, the candle meets scenario 3's TAKE conditions: judge scenario 3 from the facts; take it if they hold.
- Plan listed a long, the Bias line says short only: no trade.
