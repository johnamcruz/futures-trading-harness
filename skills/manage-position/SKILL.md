---
name: manage-position
description: Use when a position is open - its stop, the plan's management, the open-trade line.
---

# Manage Position

## When to Use

- A position is open (`trade-session` steps 1 and 3).

## How It Works

- **If a position is open, manage it and end the cycle**: confirm the protective stop is working (`list_open_orders`); an entry order on the position's side (one that would add to it) still working without a stop bracket (one the gate never checked, e.g. placed outside the harness; tell by its `order_placed` record, as for a flat account below) is cancelled first, and the cancel confirmed, since a fill would add size beyond the stop. The position's own stop and target (bracket legs, `[protect]` and `[exit]` orders, on the opposite side) are never cancelled here; apply
  the plan's management (the STOP line below, scale-out) through the
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
  `setup:prop_portfolio`): the runner's code floor (`trade-plan`) moves the
  stop; let it work. You tighten on top of it, never looser.
- **Every managed cycle, one line** (before the CYCLE RESULT line), on its
  own line, never inside the PLAN's line 9: `STOP <price|hold>: <reason>`, the
  reason's first word protected-swing, choch-against,
  displacement-against, weakening or hold. Missing = hold, a logged
  process failure. Tighter than the working stop → `modify_order` the
  bracket stop that cycle (trade-executor); equal or looser → no call.
  Levels: the prompt's "Manage read".
- **The Position line** (code facts: cite its numbers, never recompute, never
  the broker snapshot's R): now = R at the last close; MFE = the best
  closed-bar extreme, its price and bar; MAE = the worst, never above 0;
  giveback = MFE less now, in R and as a share of MFE; working stop = its R and
  how far a fill there is off the best; target reached and the lock; code floor = what
  the stop rests on (the initial stop, a 15m swing, or the lock).
  - Giveback in a 3m pullback, the 15m swing intact, no 15m CHoCH → hold.
  - "The stop rests at the lock" → the exposure, never an exit signal.
  - A large giveback share alone → hold; it is not a weakening sign.
- **The read decides** (displacement measures strength, structure
  determines confirmation, the protected swing determines invalidation:
  `displacement`, `bos-vs-choch`, `pullback-vs-reversal`):
  - 15m BOS the trade's way → a tick beyond its protected swing (that is
    the room): protected-swing.
  - 15m CHoCH against (the Trade read's `reversal: 15m CHoCH`) →
    `warning_giveback_r` behind the best (the Manage read's warning
    giveback); not an exit: choch-against.
  - A displaced 15m candle against (the Break quality line's word, a read),
    or weakening (2+ signs; an HTF flip alone is one) → the same giveback:
    a warning, never an exit. Weakening and stalling at a key level or
    opposing liquidity → take the base hit at market.
  - A 15m close through the protected swing (Manage read: BROKEN; the
    Trade read's `reversal: 15m BOS`) → the reversal: `close_position`,
    then the full top-down flow decides anew.
  - Healthy pullback, a 3m swing or CHoCH, one candle against → hold.
  - A level the Manage read says is past the price → hold (the floor
    stands); never a stop through the market.
- **An open trade** (the prompt's Position line, then its "Open trade" line) is
  managed before any new entry: its setup, initial stop and risk, the working
  stop and target in R, where it stands now, its best and worst so far, and
  bars held. "NO
  working stop" is the first thing to fix. A rules strategy's (none
  active): the line compares it with the strategy's backtested winners (how far they ran, how deep 80% of them
  dipped, how often +1R was given back): a trade already deeper than most
  winners went, or one that reached +1R in a strategy that often gives it
  back, is weaker than its R says. Manage it by its `exit` (trail, target,
  time stop); never loosen the stop. Giveback alone decides nothing
  (measured: a deep giveback recovers about as often as not): act on
  structure, the read above. A trade past its time stop is the case to act
  on; say what you did and why in the cycle result.

## Examples

```text
trade_lifecycle long +2.1R, past its target, no new 15m structure -> STOP hold: hold
trade_lifecycle short +2.6R, 3m CHoCH up, 15m still down -> STOP hold: hold (a pullback)
trade_lifecycle long +3.0R, 15m BOS up, protected swing 21517.00, working 21505.00
  -> STOP 21516.75: protected-swing; modify_order the stop to 21516.75
trade_lifecycle long, Position: 1R 10 pts, now +1.8R, MFE +2.15R, giveback 0.35R (16%), working stop
  21485.00 (-1R); 15m CHoCH down, protected swing holds, warning giveback 21511.50 (tighter)
  -> STOP 21511.50: choch-against; modify_order (not an exit)
trade_lifecycle long +1.4R, Manage read: protected swing BROKEN by a close
  -> STOP hold: hold (out at market); close_position
trade_lifecycle long +1.2R, warning giveback 21499.75, working 21500.50 -> STOP hold: hold (not tighter)
trade_lifecycle long, Position: now +3.34R, MFE +4.16R, giveback 0.82R (20%), the stop rests at the lock (+0.34R),
  no 15m CHoCH, weakening 0 of 5 -> STOP hold: hold. (2021-09-01: this one came back and stopped at +0.33R. The hold
  is still the read: the same facts came before 5R and 6R runs on other days, and no rule that exits here pays.)
```
