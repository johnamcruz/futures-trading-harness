---
name: trade-plan
description: Use before an entry - the plan entry, the exit, ticks, and order_plan's numbers.
---

# Trade Plan

## When to Use

- Before an entry (`trade-session` step 4); the gate refuses one without it.

## How It Works

`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}`:
thesis, trigger (what happened, price, time), entry, stop, exit, size
(position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's
P&L, and for a prop attempt the cushion and size budget), skip rules checked,
analyst agreement, and what each role reported that the plan rests on: the
structure bias and the level the entry and stop sit against
(market structure); the VWAP side, the value area or POC, the nearest
liquidity in the trade's way (`inTheWay`, the compose record's or a
candidate's: the first level in its direction in points and R, where 1R is
its own stop: a read beside the target, not a pass), and the session window (the briefing's `m3`
`windowText`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the
multi-timeframe alignment for the side (aligned, pullback, mixed, counter)
and the size it implies; and risk-manager phase 1's budget and pace. A plan
that can't name them isn't ready. Add the
tag `paper` in plan-only mode.

The exit: a composed trade sends the record's stop and target
(`trade-lifecycle`); its policy's `exit` (the rulebook; a rules strategy's:
the scan's) manages it:

- **Target then trail** (today's policy mode, in an attempt or not): At 2R nothing exits: the 2R order is cancelled; the stop holds at +0.5R until a 15m swing confirms past it, then trails behind it.
  You tighten it only behind turned structure (`manage-position`).
- **Trailing:** stop only, no target order. The runner (or you, without one)
  trails it from `trailActivateR` with `trailGivebackR` give-back; read both
  from its `exit`, don't assume them.
- **Target:** stop and target at `targetR` (or `risk.min_rr`) times the stop
  distance.

Tick sizes and values are the broker's: the harness records them when
`search_contracts` or `get_contract` returns the contract, and the gate,
`order_plan` and the scan use only those. A tool that says there are no tick
specs from the broker for a contract yet means: look the contract up with
`search_contracts` (or `get_contract`) first, then ask again; never supply
tick numbers of your own.

Prices are on the tick (MNQ/MES 0.25). Round a stop away from the entry and a
target toward it; bracket ticks = `ceil(distance / tickSize)`, the same
numbers in the rationale and the brackets. The scan's distances are price
points, not ticks: its summary shows both (`stop 5.25 pts = 21 ticks`).

**The exact numbers come from `order_plan`** (a rules strategy, a policy
verdict, or `trade_lifecycle`'s compose record: `trade-lifecycle`),
not from your own arithmetic: once you have chosen the strategy and the
side, call it with them, e.g.
`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "<name>", "side": "long"}`.
It is a calculator, not a second opinion: it doesn't choose the setup, the
side, or whether to trade. It shows its working (the entry reference, the
stop and target in points and in whole ticks, the stop below a long's entry
and above a short's, how the size was derived, the dollar risk) and gives
the `place_order` arguments with the `setup:<name> <side>` rationale. Put its
stop price, ticks, size, and $ risk in the plan, and explain the plan in your
own words (why the stop sits there, the R multiple, the exit). Don't
compute stop prices, ticks, size, or dollar risk by hand. A refusal (the
strategy isn't a candidate now, or its rules fired the other side) means no
entry on that strategy and side; never work around it. For a policy verdict,
call it with the policy strategy's name: it plans exactly the verdict, on
bars whose last closed bar is the verdict's, and refuses (as the gate does)
a verdict for an older bar than the last one recorded: no entry until the
next setup's verdict. Its size is the starting size:
1 for a rules strategy (position-sizing's size-1 rule) and, for a policy,
the verdict's cut to the attempt's size budget now, which is the most a
policy entry may have; a composed trade's is the size you stated, refused
over its cap (in an attempt, also the verdict). A different size from
your plan changes only `size`, and the risk scales with it: for a rules
strategy, smaller for a `mixed` read, and larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual
strategy has no order_plan (its stop is your read of STRATEGY.md): work its
numbers by the rules above and position-sizing.

## Examples

```text
plan: trade_lifecycle long, stop 111 ticks, target 231 ticks, size 1 from the compose record
```
