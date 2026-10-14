---
name: trader-process
description: Top-down trade thinking (HTF first) and its PLAN block. It adds no filter; the priority order decides. Every cycle.
---

# Trader Process

## When to Use

- Every trade cycle; each role for its steps.

## How It Works

It adds no filter and no veto:

- **The priority order decides** (strategy-library, "The priority
  order"): take, skip and size. Only its hard stops and the gate's end a
  plan early.
- **No setup without a fired strategy.** VWAP, value, levels, higher
  timeframes and broker fields are confluence only: they never make a
  trade on their own.
- **Management always runs.** Protecting, managing and exiting an open
  position, and the end-of-day flatten, go ahead whatever steps 1-8 say;
  a no-entry window or a wait never blocks an exit or a risk reduction.
- **`unknown`, never invented.** A value the briefing or a report doesn't
  give is written `unknown` (or `unavailable`); never estimate one.

### The steps

1. **HTF.** The 4h, 1h and 15m trends and structure frame everything
   below. The bias agrees with the gate's `Trend rule:` line; where they
   differ, the Trend rule wins, and the plan says so. Read: `trend-vs-range`.
2. **Context.** Window, news, regime, account (phase 1's Budget and
   Attempt lines).
3. **Location.** Price vs VWAP, value, nearest levels, sweeps.
   Read: `levels-and-reactions`, `breakout-vs-fakeout`.
4. **Setup.** Which strategy fired, which side. Continuation is a strategy
   without `mtf: reversal`, with the Trend rule's prevailing trend;
   reversal is one with it (a fade). Its STRATEGY.md and the
   priority order judge it, not this label. Read: `pullback-vs-reversal`;
   setups: `mtf-rejection`, `mtf-breakout`.
5. **Confluence.** Count the six items of `confluence-counting`; the
   candidate's own `values` are always neutral.
6. **Entry.** Its trigger fired on a closed bar; never anticipate.
   Read: `candle-reading`.
7. **Risk.** Stop and size (`order_plan`, the priority order); its exit
   (target or trail); the room.
8. **Decision.** Take, skip or wait, decided with the priority order;
   write its ONE main reason. The counts never overrule it.
9. **Management.** What invalidates the trade; its exit. Never loosen the
   stop. Read: `invalidation`.

### Roles

| Role | Steps |
|---|---|
| market-structure-analyst | 1, 3, 4 |
| trend-momentum-analyst | 1, 4 |
| volume-liquidity-analyst | 3, 5 |
| news-calendar-analyst | 2 (news) |
| risk-manager | 2, 5, 7, 8 (phase 2) |
| head trader | the whole PLAN |

The three market analysts never write step 2: a cached report would carry
a stale window. In a cached report, take this bar's 3m facts from the
briefing. Phase 2 writes line 2 fresh from this cycle's briefing; phase 1
writes no PLAN line.

### The PLAN block

Your reasoning, not a claim list. If your role's instructions give a
fact-claim line, state facts only there, in its forms. Fields are the
briefing's (`m3`, `m15`, `h1`, and a `candidate` in `m3.candidates`):
on your own timeframe's briefing `m3` is its `bar`; `rule`, `vwap`,
`location` are the runner's; candidates and `nearestLiquidity`, the
briefing's of the lane trading them.

```text
PLAN:
1 HTF: 4h <h1.h4.trend>, 1h <h1.h1.trend>, 15m <m15.frame.trend>, bias <long|short|neutral>, rule <m3.trendRule>
2 Context: window <m3.window>, entries <m3.windowEntries>, news <clear|blackout: m3.news.inBlackout>, regime <m3.regime.primary>, account <phase 1 Budget, Attempt>
3 Location: vwap <m3.vwap.side>, value <m3.location.priorValue>, nearest <m3.nearestLiquidity>
4 Setup: <candidate.name candidate.direction continuation|reversal | none>
5 Confluence: for <n>, against <n>, neutral <n>: <main ones>
6 Entry: trigger <fired|none>
7 Risk: stop <order_plan ticks>, size <n>, exit <target R|trail>, room <candidate.inTheWay.R vs candidate.needR>
8 Decision: <take|skip|wait> - <one main reason>
9 Manage: <flat | invalidation, exit>
```

A null `candidate.inTheWay` with a stop (`stopPoints`) means nothing in
its way: room enough, not `unknown`. The cycle result's reason is line 8's.

Scorecard failures, by step: wrong-side entry 1, 4; bad size 7; early
close 9; excessive abstention 8; wrong stated reason the false line's;
risk-rule rejection 2, 7.

## Examples

```text
PLAN:
1 HTF: 4h up, 1h up, 15m up, bias long, rule prevailing trend 4h up
2 Context: window opening drive, entries allowed, news clear, regime trend-up, account unknown
3 Location: vwap above, value above, nearest prior RTH high above
4 Setup: vwap_reclaim long continuation
5 Confluence: for 4, against 0, neutral 2: aligned, VWAP, level, momentum
6 Entry: trigger fired
7 Risk: stop from order_plan, size 1, exit trail, room enough
8 Decision: take - aligned continuation with room (priority order: full)
9 Manage: flat
```
