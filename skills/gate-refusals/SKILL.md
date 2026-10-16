---
name: gate-refusals
description: Use when the gate refuses an order for itself - its stop, account, tick specs, a pending order, the replay clock.
---

# Gate refusals

## When to Use

- The order gate refused an order call: a message in brackets
  (`[stop-defined]`, `[contract-specs]`, ...) or `Blocked by trading harness`.

## How It Works

Find the message in the table and do what its row says. The broker's own
refusals and error replies are in the `broker-refusals` skill.
The other rows: the account, prop, strategy and size limits in the
`gate-refusals-limits` skill, partial closes, stop moves and exits by contract month in `gate-refusals-positions`,
the cycle's roles and FACTS in `gate-refusals-cycle`.

| Message | Meaning | Do |
|---|---|---|
| `Blocked by trading harness` | Order gate hook | Fix the listed cause or stand aside. |
| `[order-pending] customTag "…" is in use by an order of unknown outcome` | Your entry reuses the tag of an order still unsettled | Send it with another `customTag`, or none. |
| `[replay-clock]` | `FTH_REPLAY_NOW` (a replayed time) is set but the broker isn't a real replay broker, or the value isn't an ISO 8601 UTC time: no new entry | Don't retry. Exits, `[protect]` stops, stop moves, cancels and `close_position` still go. Tell the user to unset `FTH_REPLAY_NOW` or select a real replay broker. |
| `[stop-defined] Entry has no stop bracket` | The entry has no `stopLossBracket` with numeric whole ticks above 0 and type `stop` (or `trailing_stop`); a stop only in the rationale is not one | Send it with `stopLossBracket {ticks, type: "stop"}` (`order_plan` gives it). |
| `[account-required]` | `place_order` without `accountId` | Send it with the account's id. |
| `[contract-specs] <ROOT>: the broker's tick spec (…) differs from the static table` | The broker's tick size or value for that contract disagrees with the harness's own table (which the backtester uses): no entry is sized on numbers that can't both be right | Don't retry. Exits and stops still go. Tell the user: the table (`scripts/lib/trading/contracts.js`) or the broker is wrong. |
| `[contract-specs] no tick specs from the broker for <ROOT> yet` | The harness has no tick size and value from the broker for that contract (or, for a prop entry, for the other contract of its micro/mini family, e.g. NQ for MNQ): no entry is checked or sized without them | `search_contracts {searchText:"<ROOT>"}` (or `get_contract`) for the contract it names, then send the entry again. Exits, `[protect]` stops, stop moves, cancels and `close_position` never need them. |
| `[contract-specs] the replayed day's <ROOT> front month (<day>) is not looked up yet` | Replay only: that day's lookup of the contract hasn't succeeded (a lookup by month alone recorded its tick specs), so no entry is trusted on it | `search_contracts {searchText:"<ROOT>"}`, then send the entry again; if the lookup fails, stand aside. Exits, `[protect]` stops and `close_position` never need it. |
| `[order-pending] The outcome of an order is unknown` | An earlier order got no clear answer | No new entry. Read `search_orders` / `list_open_orders`; manage what's there. It clears when the broker lists the order or after 2 min; while `search_orders` fails it holds (tell the user), and an unreadable record named in the message is deleted by hand after checking the broker's orders. |
| `[loss-streak] N losses in a row. Cooling down for M min more` | Losses in a row today: a cooldown | Stand aside until it ends; write a lesson. Exits and stops still go. |
| `[briefing-age] Stale data: …` (or no bar briefing) | The briefing's bar is past the signal age | End the cycle (trade-session step 6); the next bar decides. Exits and stops still go. |

## Examples

```text
place_order -> [stop-defined] (no stopLossBracket)
  send it again with stopLossBracket {ticks, type:"stop"}, as order_plan gives it
```
