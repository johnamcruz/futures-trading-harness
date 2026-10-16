---
name: trader-process
description: Top-down trade thinking (HTF first) and its PLAN block. It adds no filter; the priority order decides. Every cycle.
---

# Trader Process

## When to Use

- Each cycle; each role for its steps.

## How It Works

No filter, no veto of its own:

- The priority order (strategy-library) decides take, skip and size; only
  its hard stops and the gate's end a plan early.
- A setup is reads you state step by step and `compose_check` verifies
  (`trade-lifecycle`); no one read makes a trade.
- Management always runs: protecting, managing, exiting and the end-of-day
  flatten go ahead whatever steps 1-8 say; no window or wait blocks an exit
  or a risk reduction.
- A value the briefing or a report doesn't give: `unknown` (or
  `unavailable`); never estimate.

### The steps

1. **HTF.** 4h, 1h, 15m trends and structure frame the rest. The bias
   agrees with the gate's `Trend rule:` line; if not, the rule wins and the
   plan says so. Read: `trend-vs-range`.
2. **Context.** Window, news, regime, account (phase 1's Budget, Attempt).
3. **Location.** VWAP side, value, nearest levels, sweeps.
   Read: `levels-and-reactions`, `breakout-vs-fakeout`.
4. **Setup.** The setup reads and side (`trade-lifecycle`), with or against
   the trend. Read: `pullback-vs-reversal`, `cisd`; setups: `rejection`,
   `breakout`.
5. **Confluence.** Count the six items of `confluence-counting`.
6. **Entry.** A closed bar's entry reads; never anticipate.
   Read: `candle-reading`.
7. **Risk.** Stop (`invalidation`), size, exit (target or trail), room;
   numbers from `order_plan` or the compose record.
8. **Decision.** Take, skip or wait by the priority order; ONE main reason.
   Counts never overrule it.
9. **Management.** Invalidation and exit; never loosen the stop.
   Read: `invalidation`.

### Roles

| Role | Steps |
|---|---|
| market-structure-analyst | 1, 3, 4 |
| trend-momentum-analyst | 1, 4 |
| volume-liquidity-analyst | 3, 5 |
| news-calendar-analyst | 2 (news) |
| risk-manager | 2, 5, 7, 8 (phase 2) |
| head trader | the whole PLAN |

Market analysts never write step 2 (a cached report's window goes stale);
in a cached report, this bar's 3m facts come from the briefing. Phase 2
writes line 2 fresh from this cycle's briefing; phase 1 writes no PLAN line.

### The PLAN block

Reasoning, not claims: facts go only in your role's fact-claim line, if it
has one, in its forms. Fields are the briefing's (`m3`, `m15`, `h1`); on
your own timeframe's briefing `m3` is its `bar`; `rule`, `vwap`,
`location` are the runner's; `nearestLiquidity`, the trading lane's.

```text
PLAN:
1 HTF: 4h <h1.h4.trend>, 1h <h1.h1.trend>, 15m <m15.frame.trend>, bias <long|short|neutral>, rule <m3.trendRule>
2 Context: window <m3.window>, entries <m3.windowEntries>, news <clear|blackout: m3.news.inBlackout>, regime <m3.regime.primary>, account <phase 1 Budget, Attempt>
3 Location: vwap <m3.vwap.side>, value <m3.location.priorValue>, nearest <m3.nearestLiquidity>
4 Setup: <side, the setup reads | none>
5 Confluence: for <n>, against <n>, neutral <n>: <main ones>
6 Entry: <the entry reads | none>
7 Risk: stop <ticks>, size <n>, exit <target R|trail>, room <the first level in the way, R>
8 Decision: <take|skip|wait> - <one main reason>
9 Manage: <flat | invalidation, exit>
```

A null `inTheWay` with a stop: room enough, not `unknown`. The cycle
result's reason is line 8's.

Scorecard failures, by step: wrong-side entry 1, 4; bad size 7; early
close 9; excessive abstention 8; wrong stated reason the false line's;
risk-rule rejection 2, 7.

## Examples

```text
PLAN:
1 HTF: 4h up, 1h up, 15m up, bias long, rule prevailing trend 4h up
2 Context: window opening drive, entries allowed, news clear, regime trend-up, account unknown
3 Location: vwap above, value above, nearest prior RTH high above
4 Setup: long, 15m rejected prior vah up
5 Confluence: for 4, against 0, neutral 2: aligned, VWAP, level, momentum
6 Entry: 3m close top, 3m momentum up
7 Risk: stop 111 ticks, size 1, exit target 2.08R, room enough
8 Decision: take - aligned continuation with room, compose_check OK
9 Manage: flat
```
