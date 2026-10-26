---
name: gate-refusals-positions
description: Use when the gate refuses managing a position (an exit by contract month, a trading-day change), or can't read one; close_position is never gated.
---

# Gate refusals: positions

## When to Use

- The gate refused a partial close, a stop or target move, or an `[exit]`
  or `[protect]` order (one naming the wrong contract month, or checked across
  a trading-day change), or couldn't read a position's size. `close_position`
  itself is never gated.

## How It Works

| Message | Meaning | Do |
|---|---|---|
| `[exposure] [exit]/[protect] order on <name>, but the open <ROOT> position is in <contract>` | The exit names a month with no position: it would open one. After a roll the root (`MNQ`) is the new month, and a position still in the old month is listed as `MNQ:2026-12`; on a day the front month can't be looked up, positions are listed by their month | Send the exit (or `partial_close_position`) with the `contractId` that `list_open_positions` shows for the position; `close_position` with it always goes. |
| `order gate could not run (the trading day changed while the call was checked ...)` | The check crossed 18:00 ET, the start of a new trading day, when the root may start naming a new month | Re-read `list_open_positions` and send it again with the name it shows now. `close_position` always goes. |
| `[partial-close]` | `partial_close_position` with no open position in the contract, a size that isn't a whole number of 1 or more, or more than the position (counting orders sent moments ago) | Re-read `list_open_positions`; close at most what is open, or `close_position`. |
| `... once recent orders fill` after a `close_position` / `partial_close_position` whose reply was an error | The close's outcome is unknown (the broker may have filled it): for 30 s the gate counts it, so a `[protect]` or `[exit]` for that position, or a stop move, is refused. Its stop can't be cancelled while the account still shows the position | Re-read `list_open_positions`. Still open: `close_position` again (it always goes). Gone: cancel the leftover orders. Don't cancel the stop of a position that is still open. |
| `[modify-entry] ... once recent orders fill` | The position this stop or target worked was just closed (or is about to be) by a recent order | Don't move it; cancel the leftover order once the account reads flat. |
| `order gate could not run (position … has no valid size …)` | The broker returned a position without a whole-number size: the account can't be read | No orders but `close_position` (never gated). Tell the user; it holds until the broker reports a size. |
| `[modify-size] …` | A size change that isn't an `[exit]`/`[protect]` decrease, or a stop cut leaving part of the position unprotected | To add, a new order; to cut a stop, reduce the position first, then the stop. |
| `[bracket-leg] …` | `cancel_order` of a leg (stop or target) of an open position. Hard | Keep it: adjust it with `modify_order`; to get out, `[exit]` or a close (the runner cancels the legs once flat). |
| `[bracket-only] …` | A separate order beside the brackets: a `[protect]` limit, a second stop (`[protect]` or `[exit]`) while stops cover the position, or a limit or join `[exit]`. Hard | Trail the bracket stop with `modify_order`; out now: a market `[exit]` or a close. No working stop: the `[protect]` stop goes. |
| `[composed-reprice] …` | A composed entry's limit moved worse than its record's entry | Keep it, improve it, or cancel it. |

## Examples

```text
partial_close_position size 3, position 2 -> [partial-close]
  re-read list_open_positions; close at most 2, or close_position
```
