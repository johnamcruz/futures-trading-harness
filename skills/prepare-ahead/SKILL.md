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

A side the Bias line or the trend rule refuses: pass, whatever the plan or the candle.

Prepare (no compose_check, no order, no role this run):

- Write one line per scenario, in this form:
  `SCENARIO k: <candidate id and its read, from "Possible at the next close"> → TAKE if <conditions on the closing candle> | PASS if <...>; reads: <the compose reads, each in quotes, in the briefing's read names>; why: <one line>`.
- Then `STAND DOWN if: <account, room, window, news, a level breaking>` and `INVALID if: <what voids the plan before the close>`. End with `PLAN END`.
- A standing scenario (its line fires "whatever its range, volume and close"): the setup is the reaction the briefing lists; no condition on the closing candle: TAKE if its reads compose at the close | PASS if compose_check refuses it.

Confirm (the close has come):

- The at-close facts decide, never the plan. The plan is never evidence: its reads, numbers and reasons prove nothing; a plan that said take is no reason to take, and a plan that said pass is no reason to pass.
- A met TAKE is a confirm: compose_check with the reads as the at-close facts give them (not as the plan wrote them), then as the cycle's prompt says. compose_check refusing is the pass; so is a STAND DOWN or INVALID condition true at the close. A pass is the CYCLE RESULT, with why.
- A standing scenario: its TAKE needs nothing of the closing candle, whatever the plan wrote; read that candle as candle-reading does.
- Another listed scenario's TAKE met, or something fired outside the plan: reason it from the facts, in full, as a cycle does.

## Examples

- Plan: `SCENARIO 1: P1 "15m rejected prior vah up" → TAKE if the 15m closes back above the prior VAH | PASS if it closes below it; reads: "15m rejected prior vah up"; why: the level held`. The briefing lists "15m rejected prior vah up" at the close: confirm, compose_check with the at-close reads.
- Same plan, the 15m closes below the prior VAH: pass ("TAKE not met"), though the plan said take: the plan is not evidence.
- Standing scenario 2 ("15m rejected prior poc up"), whatever the closing 3m: confirm, compose_check with the at-close reads; refused (R:R): pass.
- Plan listed a long, the Bias line says short only: no trade.
