---
name: gate-refusals
description: What a harness gate refusal means (a [code] or Blocked by trading harness message) and what to do for each - fix it, retry, stand aside or tell the user.
---

# Gate refusals

## When to Use

- The order gate refused an order call: a message in brackets
  (`[stop-defined]`, `[max-risk]`, ...) or `Blocked by trading harness`.

## How It Works

Find the message in the table and do what its row says. The broker's own
refusals and error replies are in the `broker-refusals` skill.

| Message | Meaning | Do |
|---|---|---|
| `Blocked by trading harness` | Order gate hook | Fix the listed cause or stand aside. |
| `[order-pending] customTag "…" is in use by an order of unknown outcome` | Your entry reuses the tag of an order still unsettled | Send it with another `customTag`, or none. |
| `[replay-clock]` | `FTH_REPLAY_NOW` (a replayed time) is set but the broker isn't a real replay broker, or the value isn't an ISO 8601 UTC time: no new entry | Don't retry. Exits, `[protect]` stops, stop moves, cancels and `close_position` still go. Tell the user to unset `FTH_REPLAY_NOW` or select a real replay broker. |
| `[roles-ran] … not returned yet: <roles>` | An autonomous cycle's entry before its roles reported: a full cycle needs `market-structure-analyst`, `trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` (phase 1 and phase 2) back this cycle, a lean one `risk-manager` twice; phase 2 started after phase 1 (and the analysts) returned, each in the foreground, since the last `trade-executor` call (trade-session skill). Also when the cycle's transcript can't be read | End the cycle (trade-session step 6): the refused `trade-executor` call ends the round, so the next entry needs every role again, then phase 2. Exits and stops still go. |
| `[stop-defined] Entry has no stop bracket` | The entry has no `stopLossBracket` with numeric whole ticks above 0 and type `stop` (or `trailing_stop`); a stop only in the rationale is not one | Send it with `stopLossBracket {ticks, type: "stop"}` (`order_plan` gives it). |
| `[account-required]` | `place_order` without `accountId` | Send it with the account's id. |
| `[combine] <account>: the account balance doesn't reconcile: the broker reports $X, but … gives $Y` | Each bar the runner checks the broker's balance against the day's opening balance plus every fill since (P&L less fees and commissions, from `search_trades`); they disagree, so the cushion every size comes from can't be trusted | No entry this bar; don't work around it or "correct" the balance. It clears on its own when a later snapshot reconciles (a broker that was slow to book a fill). If it stays, tell the user: the account's balance needs checking with the broker. Exits and `[protect]` stops always go. |
| `[combine] <account>: the account balance couldn't be checked against the broker's fills (…)` | `search_trades` failed or returned a fill the harness can't read, so the balance is unchecked | No entry until a snapshot can check it; exits and stops go. Don't retry the entry this bar. |
| `[contract-specs] <ROOT>: the broker's tick spec (…) differs from the static table` | The broker's tick size or value for that contract disagrees with the harness's own table (which the backtester uses): no entry is sized on numbers that can't both be right | Don't retry. Exits and stops still go. Tell the user: the table (`scripts/lib/trading/contracts.js`) or the broker is wrong. |
| `[contract-specs] no tick specs from the broker for <ROOT> yet` | The harness has no tick size and value from the broker for that contract (or, for a prop entry, for the other contract of its micro/mini family, e.g. NQ for MNQ): no entry is checked or sized without them | `search_contracts {searchText:"<ROOT>"}` (or `get_contract`) for the contract it names, then send the entry again. Exits, `[protect]` stops, stop moves, cancels and `close_position` never need them. |
| `[contract-specs] the replayed day's <ROOT> front month (<day>) is not looked up yet` | Replay only: that day's lookup of the contract hasn't succeeded (a lookup by month alone recorded its tick specs), so no entry is trusted on it | `search_contracts {searchText:"<ROOT>"}`, then send the entry again; if the lookup fails, stand aside. Exits, `[protect]` stops and `close_position` never need it. |
| `[policy] setup:<policy>: the latest verdict's setup is from <name>: <name> has status "paper": <policy> trades only its active strategies live` (or `is not a known strategy`, `is not one of <policy>'s strategies`) | A paper strategy stays paper inside a policy: the verdict is for a setup of a strategy that isn't active (or one the gate can't find), so no live entry from it. Hard: it can't be skipped | Stand aside; don't relabel the setup or wait it out. Activating a strategy is the user's call. Exits and `[protect]` stops always go. |
| `[strategy] setup:<name> trades <SELECTED> (the selected contract), not <ROOT>` | The user selected the other contract of that micro/mini family (the runner's `symbols`, or `FTH_SYMBOLS`); every strategy (a policy strategy too) trades only the selected one, never both | Plan and send the entry on the contract it names, or stand aside. Don't switch legs or change the selection; that is the user's. Exits and `[protect]` stops on either contract always go. |
| `[strategy] setup:<name> lists both <MICRO> and <MINI>, and neither is selected` | No contract of that index is selected, and the strategy lists both: which one to trade is the user's choice | Stand aside. Tell the user to select one contract per index (the runner's `symbols`, or `FTH_SYMBOLS`). Exits and stops still go. |
| `[strategy] FTH_SYMBOLS selects two contracts of one index` (or `is not a comma-separated list`) | The selected contracts are unreadable: every entry is refused (`order_plan` and `strategies_scan` refuse too) | Don't retry. Exits and stops still go. Tell the user to set one contract per index (e.g. `NQ` or `MNQ`). |
| `[strategy] FTH_SYMBOLS is not set in this autonomous run` | The runner sets it from its `symbols`, but it didn't reach the gate: most likely the harness's config was installed before it was forwarded. Every entry is refused (`order_plan` and `strategies_scan` refuse too) | Don't retry, and don't ask the user to change their symbols. Exits and stops still go. Tell the user to re-run `node scripts/install.js --target <harness>` (e.g. `codex`) and restart the runner. |
| `[max-order-size] the broker server's max order size is not recorded yet` (or `had no valid maxOrderSize`) | The harness hasn't seen a `get_server_config` answer with a whole-number `maxOrderSize`, so it can't check the entry's size | `get_server_config`, then send the entry again. If it still says no valid `maxOrderSize`, tell the user: the broker server must report one. Exits, `[protect]` stops, stop moves, cancels and closes never need it. |
| `[max-order-size] size N over the broker's max order size M` | The entry is larger than the broker server allows in one order | Send it at size M or less, or stand aside. Never split it into several orders. |
| `[max-risk] risk $X ... over setup:<name>'s risk.max_risk_usd $Y` | Size × stop ticks × tick value is over the strategy's per-trade cap | Reduce the size to the one the message gives; the stop is the strategy's (`order_plan`), never shrunk to fit. No size fits: skip the trade. |
| `[max-risk] setup:<name> caps risk at $Y ... but this entry's risk can't be computed` | The strategy has a cap and the gate can't measure the stop (no bracket, no tick specs, a bad bracket) | Send the stop as `stopLossBracket.ticks` (`order_plan` gives them). |
| `[order-pending] The outcome of an order is unknown` | An earlier order got no clear answer | No new entry. Read `search_orders` / `list_open_orders`; manage what's there. It clears when the broker lists the order or after 2 min; while `search_orders` fails it holds (tell the user), and an unreadable record named in the message is deleted by hand after checking the broker's orders. |
| `[partial-close]` | `partial_close_position` with no open position in the contract, a size that isn't a whole number of 1 or more, or more than the position (counting orders sent moments ago) | Re-read `list_open_positions`; close at most what is open, or `close_position`. |
| `... once recent orders fill` after a `close_position` / `partial_close_position` whose reply was an error | The close's outcome is unknown (the broker may have filled it): for 30 s the gate counts it, so a `[protect]` or `[exit]` for that position, or a stop move, is refused. Its stop can't be cancelled while the account still shows the position | Re-read `list_open_positions`. Still open: `close_position` again (it always goes). Gone: cancel the leftover orders. Don't cancel the stop of a position that is still open. |
| `[modify-entry] ... once recent orders fill` | The position this stop or target worked was just closed (or is about to be) by a recent order | Don't move it; cancel the leftover order once the account reads flat. |
| `order gate could not run (position … has no valid size …)` | The broker returned a position without a whole-number size: the account can't be read | No orders but `close_position` (never gated). Tell the user; it holds until the broker reports a size. |

## Examples

```text
place_order -> [stop-defined] (no stopLossBracket)
  send it again with stopLossBracket {ticks, type:"stop"}, as order_plan gives it
place_order -> [max-order-size] size 3 over the broker's max order size 2
  send it at size 2 or less, or stand aside; never as several orders
```
