---
name: gate-refusals-limits
description: Use when the gate refuses an entry with [combine], [prop-account-attempt], [policy], [min-contracts], [strategy], [max-order-size] or [max-risk].
---

# Gate refusals: limits

## When to Use

- The gate refused an entry with `[combine]`, `[prop-account-attempt]`,
  `[policy]`, `[min-contracts]`, `[strategy]`, `[max-order-size]` or `[max-risk]`.

## How It Works

| Message | Meaning | Do |
|---|---|---|
| `[combine] <account>: the account balance doesn't reconcile: the broker reports $X, but … gives $Y` | Each bar the runner checks the broker's balance against the day's opening balance plus every fill since (P&L less fees and commissions, from `search_trades`); they disagree, so the cushion every size comes from can't be trusted | No entry this bar; don't work around it or "correct" the balance. It clears on its own when a later snapshot reconciles (a broker that was slow to book a fill). If it stays, tell the user: the account's balance needs checking with the broker. Exits and `[protect]` stops always go. |
| `[combine] <account>: N losing trades in a row this session, at the loss streak stop (loss_streak_stop N): no new entries until the next session` | The rulebook's loss streak stop: that many losses in a row this session (from the broker's closing fills; a win ends the streak, a scratch neither) | Stand aside for the rest of the session; don't retry or wait it out: it lifts only at the next session. Write the lesson from the losses. Exits and `[protect]` stops always go. |
| `[combine] <account>: the account balance couldn't be checked against the broker's fills (…)` | `search_trades` failed or returned a fill the harness can't read, so the balance is unchecked | No entry until a snapshot can check it; exits and stops go. Don't retry the entry this bar. |
| `[prop-account-attempt] account <id> is a <profile> prop account and no <profile> attempt is running` (or its marker or profile is invalid) | The user marked the account a prop account: no entry without its attempt (floor, daily limits). Hard, any mode | Stand aside; don't switch accounts. Starting it (`node scripts/combine.js start --account <profile>`) or fixing the marker is the user's: tell them. Exits and stops go. |
| `[policy] setup:<policy>: the latest verdict's setup is from <name>: <name> has status "paper": <policy> trades only its active strategies live` (or `is not a known strategy`, `is not one of <policy>'s strategies`) | A paper strategy stays paper inside a policy: the verdict is for a setup of a strategy that isn't active (or one the gate can't find), so no live entry from it. Hard: it can't be skipped | Stand aside; don't relabel the setup or wait it out. Activating a strategy is the user's call. Exits and `[protect]` stops always go. |
| `[min-contracts] setup:<policy>: size <n> <ROOT> is under the floor of <m> contracts` | A prop entry is at least the rulebook's `min_contracts` (a mini counts as 10 micros). Hard | Size at the verdict's full size if it is `<m>` or more; else skip. Never a tighter stop, never split. Exits, stops, cancels and closes go. |
| `[strategy] setup:<name> trades <SELECTED> (the selected contract), not <ROOT>` | The user selected the other contract of that micro/mini family (the runner's `symbols`, or `FTH_SYMBOLS`); every strategy (a policy strategy too) trades only the selected one, never both | Plan and send the entry on the contract it names, or stand aside. Don't switch legs or change the selection; that is the user's. Exits and `[protect]` stops on either contract always go. |
| `[strategy] setup:<name> lists both <MICRO> and <MINI>, and neither is selected` | No contract of that index is selected, and the strategy lists both: which one to trade is the user's choice | Stand aside. Tell the user to select one contract per index (the runner's `symbols`, or `FTH_SYMBOLS`). Exits and stops still go. |
| `[strategy] FTH_SYMBOLS selects two contracts of one index` (or `is not a comma-separated list`) | The selected contracts are unreadable: every entry is refused (`order_plan` and `strategies_scan` refuse too) | Don't retry. Exits and stops still go. Tell the user to set one contract per index (e.g. `NQ` or `MNQ`). |
| `[strategy] FTH_SYMBOLS is not set in this autonomous run` | The runner sets it from its `symbols`, but it didn't reach the gate: most likely the harness's config was installed before it was forwarded. Every entry is refused (`order_plan` and `strategies_scan` refuse too) | Don't retry, and don't ask the user to change their symbols. Exits and stops still go. Tell the user to re-run `node scripts/install.js --target <harness>` (e.g. `codex`) and restart the runner. |
| `[max-order-size] the broker server's max order size is not recorded yet` (or `had no valid maxOrderSize`) | The harness hasn't seen a `get_server_config` answer with a whole-number `maxOrderSize`, so it can't check the entry's size | `get_server_config`, then send the entry again. If it still says no valid `maxOrderSize`, tell the user: the broker server must report one. Exits, `[protect]` stops, stop moves, cancels and closes never need it. |
| `[max-order-size] size N over the broker's max order size M` | The entry is larger than the broker server allows in one order | Send it at size M or less, or stand aside. Never split it into several orders. |
| `[max-risk] risk $X ... over setup:<name>'s risk.max_risk_usd $Y` | Size × stop ticks × tick value is over the strategy's per-trade cap | Reduce the size to the one the message gives; the stop is the strategy's (`order_plan`), never shrunk to fit. No size fits: skip the trade. |
| `[max-risk] setup:<name> caps risk at $Y ... but this entry's risk can't be computed` | The strategy has a cap and the gate can't measure the stop (no bracket, no tick specs, a bad bracket) | Send the stop as `stopLossBracket.ticks` (`order_plan` gives them). |

## Examples

```text
place_order -> [max-order-size] size 3 over the broker's max order size 2
  send it at size 2 or less, or stand aside; never as several orders
```
