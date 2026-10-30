---
name: manage-position
description: Use when a position is open - its stop, the plan's management, the open-trade line.
---

# Manage Position

## When to Use

- A position is open (`trade-session` steps 1 and 3).

## How It Works

- **If a position is open, manage it and end the cycle**: confirm the protective stop is working (`list_open_orders`); an entry order on the position's side (one that would add to it) still working without a stop bracket (one the gate never checked, e.g. placed outside the harness; tell by its `order_placed` record, as for a flat account below) is cancelled first, and the cancel confirmed, since a fill would add size beyond the stop. The position's own stop and target (bracket legs, `[protect]` and `[exit]` orders, on the opposite side) are never cancelled here; apply
  the plan's management (the trail behind turned structure, scale-out) through the
  trade-executor role, and journal any change. No new entries while a position
  is open. Protective stops move toward the market only.
- **Always a bracket, never an orphan**: the stop (and the target, where
  the exit plan has one) are the entry's own `stopLossBracket` /
  `takeProfitBracket` legs. Adjust them with `modify_order` (the stop toward
  the market only). Never cancel a leg while the position is open
  (`[bracket-leg]`), and never add a separate stop or target (`[protect]` or `[exit]`)
  beside them (`[bracket-only]`): an unlinked order outlives the position
  and can open a new, unprotected one. Under a `trail` or
  `target_then_trail` exit the runner owns the exit: no target order. A lost
  stop is the runner's to restore (every poll, at the plan's stop); the
  gate takes a `[protect]` stop only while no working stop covers the
  position. Profit is taken by the trail: the runner's, or your
  `modify_order` on the bracket stop toward the market. A discretionary
  close is a market `[exit]`, `partial_close_position` or `close_position`;
  never a limit or join `[exit]` (it can rest, and outlives the stop too:
  `[bracket-only]`). The runner cancels the legs once flat. A rules strategy
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
  the runner's: it moves the stop (past the target it holds at the target's R less
  `lock_giveback_r` (+0.5R at the 2R mark, every prop entry) until a 15m
  swing confirms beyond it, then trails behind it), and that trail is the edge: let it work.
  Before or past its target, act only on the open trade's read
  (`pullback-vs-reversal`, the prompt's "Trade read" line); never on one
  candle or by feel; never loosen the stop.
- **The read decides the action** (its definitions are there):
  - Healthy pullback → hold; tightening here stops a winner before the
    leg runs on.
  - Weakening (2+ signs; an HTF bias flip alone is one sign) → tighten:
    `modify_order` the bracket stop toward the market, at most to the
    read's trail level (the last confirmed 15m swing, the runner's own),
    never tighter. Price past that swing is the reversal read's question,
    never an automatic exit. Weakening and stalling at a key level or
    opposing liquidity → take the base hit at market.
  - Reversal (the read's) → exit at market (`close_position`), then let
    the full top-down flow (HTF bias, location, setup, entry, stop, target)
    decide any new direction.
  - Never cancel a leg, and never add a stop, target or limit `[exit]`.
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
trade_lifecycle short +3.1R, Trade read: 15m push FAILED, pushes fading -> weakening: modify_order the stop to the trail level 21418.25
trade_lifecycle long +1.4R, HTF bias FLIPPED, no 15m break -> one sign: hold
trade_lifecycle long +1.4R, reversal: 15m CHoCH down -> close_position; then the top-down flow decides anew
```
