---
name: strategy-gate-checks
description: What the gate checks of a strategy entry - status, instruments, sessions, leg, trigger age, order consistency, policies, retired lanes.
---

# Strategy Gate Checks

## When to Use

- When tagging an order: the tag `setup:<name>` must name an active strategy.

## How It Works

### What the code enforces (order gate and MCP gateway)

Live entries are blocked unless `setup:<name>` names a valid strategy with
`status: active`, the contract root is in `instruments`, and the time is inside
`sessions`. A rules strategy trades one leg of a micro/mini family it lists:
the selected contract (the runner's `symbols`, or `FTH_SYMBOLS`). Listing MNQ,
it trades NQ when NQ is selected, and then never MNQ ("setup:orb trades NQ
(the selected contract), not MNQ"): trade the selected contract, don't switch
legs. With no leg selected it trades exactly what it lists (listing both legs
of a family, neither until one is selected). A policy strategy trades the
selected contract too: its verdict is sized in that leg only (MNQ selected: so
many MNQ, never switched to NQ), and the other leg is refused; its `contracts`
mode picks the leg only when none is selected. Every other check
uses the contract ordered: its broker tick specs, and its size and
`risk.max_risk_usd` in its own dollars (one NQ at a 40-tick stop risks
$200.00; one MNQ, $20.00). Exits and protective stops on either leg always go. `paper` strategies can only be paper-traded.
A retired strategy (`bos`, `keltner`, `ema_cross`, `supertrend`;
strategies/README.md, "Retired strategies") is no setup: its tag is refused,
saying so, and a position it opened is still exited and protected with
`[exit]` or `[protect]`. While the runner's lane on a timeframe lists one, no
entry on that timeframe goes, under any tag (`retired-lane`): that lane only
manages what is open. A rules strategy
enters only on its own trigger (`trigger-fired`): the signal record must show
it fired on that side on a bar that closed at most 3 bars of the strategy's
own timeframe ago and never more than 45 minutes ago (3 min on 1m, 9 min on
3m, 45 min on 15m and 1h; the
runner records every bar; interactively `strategies_scan` with `record: true`,
whose `symbol` is a contract root such as `MNQ`; refused while the
autonomous runner is running, which records the symbols it trades). The gate does
**not** judge a manual strategy's trigger, the skip rules, or that the order
is the plan's: those are yours and risk-manager's. It does refuse an order that contradicts its
own rationale (`order-consistency`): write the side right after the tag
(`setup:orb long ...`), the stop and target as prices on the tick, and
brackets the same distance as those prices.
While a prop attempt runs, only its policy strategy's verdict can enter.
A policy trades only its `active` strategies: a `paper` one stays paper
inside it (the runner passes over its setup, and the gate refuses an entry
whose verdict names a strategy that isn't active or that it doesn't know,
`[policy] ... has status "paper"`); the backtester's prop runs leave it out
the same way, while still counting its signal as agreement or disagreement,
as the live scan does.
The trend rule is a hard gate check (`mtf-trend`): a trend strategy's entry
against the recorded prevailing trend, or without a fresh record, is refused.

## Examples

```text
Last recorded 3m bar 2 min old, orb long on it → fresh; 12 min old, or orb not on it → refused.
```
