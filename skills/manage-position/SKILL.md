---
name: manage-position
description: Use when a position is open - its stop, the plan's management, the open-trade line.
---

# Manage Position

## When to Use

- A position is open (`trade-session` steps 1 and 3).

## How It Works

- **If a position is open, manage it and end the cycle**: confirm the protective stop is working (`list_open_orders`); an entry order on the position's side (one that would add to it) still working without a stop bracket (one the gate never checked, e.g. placed outside the harness; tell by its `order_placed` record, as for a flat account below) is cancelled first, and the cancel confirmed, since a fill would add size beyond the stop. The position's own stop and target (bracket legs, `[protect]` and `[exit]` orders, on the opposite side) are never cancelled here; apply
  the plan's management (breakeven, trail, scale-out) through the
  trade-executor role, and journal any change. No new entries while a position
  is open. Protective stops move toward the market only. A rules strategy
  (none active) whose exit trails (`exit` in the scan): the runner already
  moved the stop on this bar: don't touch it unless you are exiting.
  **Interactive, no runner**: the brackets are the whole exit, a composed
  trade's too; nothing moves them. A rules trailing exit: run this
  skill again after every closed bar while the position is open (fetch the
  bar with `bars_fetch`). On each: from `trailActivateR` of open profit, move the
  stop to `trailGivebackR` behind the best price since entry, rounded to the
  tick, toward the market only; if the bar already traded through that new
  level, close at market instead; after `maxBars` bars in the trade, close at
  market (time stop). Each stop move and close goes through the
  trade-executor role, as all management does. The strategy bodies' "don't move the stop yourself"
  means: not while the runner trails it.
- **A composed trade** (`setup:trade_lifecycle`, in an attempt
  `setup:prop_portfolio`): its bracket holds the compose record's stop and
  target; the policy's exit mode (`trade-plan`), in an attempt or not, is
  the runner's: it moves the stop. Before its target, don't touch it unless
  you are exiting; never close early by feel; never loosen the stop.
- **Past its target** the runner locks the stop at a small R and trails it
  behind 15m swings, so an ordinary pullback doesn't close a trend leg.
  Read the move against it top-down with `pullback-vs-reversal`.
  - A pullback while the 15m trend holds (a 3m CHoCH against included) →
    hold; tightening here is what stops a winner before the leg runs on.
  - Momentum ends (a 15m CHoCH against, or 15m momentum turned against after
    a failed new extreme) → tighten behind the last confirmed 15m swing.
  - Never tighten on one candle or by feel.
- **An open trade** (the prompt's "Open trade" line) is managed before any
  new entry: its setup, initial stop and risk, the working stop and target in
  R, where it stands now, its best and worst so far, and bars held. "NO
  working stop" is the first thing to fix. A rules strategy's (none
  active): the line compares it with the strategy's backtested winners (how far they ran, how deep 80% of them
  dipped, how often +1R was given back): a trade already deeper than most
  winners went, or one that reached +1R in a strategy that often gives it
  back, is weaker than its R says. Manage it by its `exit` (trail, target,
  time stop); never loosen the stop. A trade that gave back most of a large best (e.g. best +2R, now
  +0.3R) or is past its time stop is the case to act on; say what you did and
  why in the cycle result.

## Examples

```text
trade_lifecycle long +2.1R, past its target, stop trailed by the runner -> hold; journal
trade_lifecycle short +2.6R, 3m CHoCH up, 15m still down -> hold (a pullback)
trade_lifecycle short +3.1R, 15m CHoCH up after a failed new low -> stop just above the last 15m swing high
```
