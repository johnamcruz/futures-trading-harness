---
name: trade-plan
description: Use before an entry - the plan entry, the exit, ticks, and order_plan's numbers.
---

# Trade Plan

## When to Use

- Before an entry (`trade-session` step 4); the gate refuses one without it.

## How It Works

`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}`
(+ `paper` in plan-only mode). It holds:

- Thesis; trigger (what, price, time); entry, stop, exit.
- Size (position-sizing or the policy verdict), $ risk, the account sized
  from (balance, today's P&L; prop: cushion, size budget).
- Skip rules checked; analyst agreement.
- Each role's report it rests on:
  - structure: bias, the level entry and stop sit against;
  - volume-liquidity, session-timing: VWAP side, value area or POC;
    `inTheWay` (compose record's or candidate's: first level its way, in
    points and R of its own stop): check room to the target or trail activation.
    Session window (`m3` `windowText`: entries allowed, until when);
  - trend-momentum: regime, momentum;
  - multi-timeframe alignment for the side (aligned, pullback, mixed,
    counter) and the size it implies;
  - risk-manager phase 1: budget, pace.

Can't name them: not ready.

### The exit

Composed: the record's target level (`trade-lifecycle`). Policy or rules
strategy: its `exit` (rulebook, scan):

- **Trailing:** stop only, no target order. The runner (or you, without
  one) trails from `trailActivateR`, `trailGivebackR` give-back; read
  both from its `exit`, never assume.
- **Target:** stop, and target at `targetR` (or `risk.min_rr`) x stop
  distance.

### Ticks

- Tick specs are the broker's, recorded when `search_contracts` or
  `get_contract` returns the contract; gate, `order_plan` and scan use only
  those. No tick specs yet: look the contract up, then ask again. Never
  supply your own.
- On the tick (MNQ/MES 0.25): stop rounded away from entry, target toward.
  Bracket ticks = `ceil(distance / tickSize)`, same in rationale and
  brackets.
- Scan distances are points; its summary shows both (`stop 5.25 pts = 21 ticks`).

### `order_plan`: the numbers

- Exact numbers come from `order_plan` (rules strategy, policy verdict, or
  `trade_lifecycle`'s compose record), never your arithmetic. Once strategy
  and side are chosen:
  `order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "<name>", "side": "long"}`.
- A calculator: never picks setup, side, or whether to trade. Shows its
  working (entry reference, stop and target in points and whole ticks,
  stop below a long's entry, above a short's, size derivation, $ risk) and
  the `place_order` arguments with the `setup:<name> <side>` rationale.
- Plan: its stop price, ticks, size, $ risk; in your words, why the stop
  sits there, the R multiple, the exit.
- Refused (not a candidate now, or fired the other side): no entry on that
  strategy and side; never work around it.
- Policy: call with the policy strategy's name; plans exactly the verdict,
  on bars whose last closed bar is the verdict's. A verdict older than the
  last recorded bar is refused (as by the gate): wait for the next verdict.
- Starting size: rules strategy 1 (position-sizing's size-1 rule); policy,
  the verdict cut to the attempt's size budget now (its most); composed,
  your stated size, refused over its cap (in an attempt, over the verdict).
- A size other than your plan's changes only `size`; risk scales. Rules strategy: smaller
  for `mixed` or a reversal fade; larger only as position-sizing allows
  (30+ reviewed trades, positive expectancy, within budget and caps).
- Manual strategy: no order_plan (stop from its STRATEGY.md); work its
  numbers by these rules and position-sizing.

## Examples

```text
plan: trade_lifecycle long, stop 111 ticks, target 231 ticks, size 1 from the compose record
```
