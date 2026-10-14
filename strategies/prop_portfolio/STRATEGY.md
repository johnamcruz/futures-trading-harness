---
name: prop_portfolio
description: Prop-challenge policy strategy, the account layer - it sizes each setup of the strategies it lists on the Nasdaq, S&P, Dow, and Russell from the attempt's budget in the selected contract (or skips it), and trails every trade. It lists none today; its one component will be trade_lifecycle.
version: 2
status: active                # the owner's call; with no components it has no setups, so no entries, until trade_lifecycle is built (docs/COMPOSED-ENTRY.md)
instruments: [MNQ, NQ, MES, ES, MYM, YM, M2K, RTY]   # four indexes, one shared account: bars from the micro (minis share its prices); trades the selected one (the micro or the mini; `contracts` only with none selected)
timeframe: 3m                 # the one setting for the bar size: every listed strategy must trade it (see How It Works)
signal: policy                # trades the setups of the strategies below on the account
strategies: []                # none since 2026-10-14 (every rules strategy retired); trade_lifecycle when it is built
account: topstep_100k         # accounts/topstep_100k/ACCOUNT.md: $6,000 target, $3,000 trailing max loss, $2,000 daily limit
contracts: auto               # micro | mini | auto (minis once the size reaches one mini = 10 micros); only with no contract selected
# sizing, exit and the verdict's multipliers: in its account's rulebook (RULEBOOK.md beside ACCOUNT.md, policies.prop_portfolio), the one place for them
risk:
  stop: strategy              # each setup keeps its own strategy's stop
  min_rr: 2
source: harness design (the prop challenge as a strategy); the learned-rulebook design (to come) will tune its numbers
---

# Strategy: Prop Portfolio (`setup:prop_portfolio`)

The account layer of the prop challenge: one 100K combine on four
index futures (Nasdaq, S&P, Dow, Russell). It sizes each setup of the
strategies it lists at the account's size budget, or skips one the budget
can't fund, and its trail exits every trade.

**Today it lists no strategies.** It stays active (the account layer); every rules strategy it
traded was retired on 2026-10-14 (strategies/README.md, "Retired
strategies"). Its one component will be `trade_lifecycle`, the composed
trade the model builds from its skills (docs/COMPOSED-ENTRY.md, phase C).
Until then it has no setups and no verdicts, so the order gate refuses every
entry under it; exits and protective stops still go, and the runner keeps
trailing an open position by its remembered exit plan.

## When to Use

- A `topstep_100k` attempt is running (`node scripts/combine.js status`).
- The runner reports a `prop_portfolio` setup with a verdict: the strategy
  that fired, the side, the contract (the selected one, the runner's symbols:
  MNQ or NQ, MES or ES, MYM or YM, M2K or RTY), the largest size, and the stop in ticks.
  None arrives while it lists no strategies.

## How It Works

1. On every closed bar of its timeframe (`timeframe: 3m`) the runner scans
   the strategies it lists, in order, on each index's bars. The first
   `active` one with a setup (its own rules and stop) is this strategy's
   setup on that index. A `paper` component stays paper inside it: its
   setup is passed over, and the gate refuses an entry whose verdict names
   it. With none listed there is no setup.
2. One account, one position at a time: all four indexes share the
   attempt's cushion, so while a trade is open (or an entry is in flight) on
   one index, setups on the others wait (the gate refuses them, and
   backtests do the same). Each trade is then sized from the whole
   cushion, and a stop filled within its expected slippage (step 3) never
   reaches the floor or the daily limit.
3. The size budget is a share of the cushion above the trailing floor
   (`cushion_frac`), under a dollar cap (`cap_usd`), halved while the
   balance is far enough below its peak (`drawdown_halve_usd`), and never a
   full stop's reach to the floor or the daily limit, counting the stop's
   expected slippage (`stop_slippage_ticks`) and fees both ways in each
   contract's risk. Every one of these numbers is in the account's rulebook
   (`RULEBOOK.md` beside its ACCOUNT.md, `policies.prop_portfolio`), the one
   place for them; this file never restates them. It is worked out in
   micros and traded in the selected contract, always rounding down; with
   none selected, as minis once it reaches one mini (`contracts: auto`).
4. The verdict: every setup gets the full size its budget allows (step 3),
   times the verdict's multiplier (the rulebook's enforced items; none yet,
   so 1), or a skip when the budget can't fund one contract at its stop, the
   attempt blocks entries, or the multiplier is 0. The trail (the rulebook's
   `exit`) manages every trade.
5. A verdict is a ceiling: take it only when the priority order (the
   strategy-library skill) says so, and then exactly as given:
   `setup:prop_portfolio`, the verdict's contract and side, at most its
   size, with `stopLossBracket.ticks` equal to its stop ticks. The order
   gate refuses anything else.

## Examples

```text
Today: no strategies listed, so no setup and no verdict.
place_order NQ buy 1, rationale "setup:prop_portfolio ..." -> refused by the order gate (no verdict).
place_order NQ sell 1, rationale "[exit] flatten the open long" -> goes (exits are never refused).

With a component (trade_lifecycle, to come): a long setup sized full
(multiplier 1, max 4 NQ, stop 40 ticks)
-> place_order NQ buy 4, stopLossBracket.ticks 40,
   rationale "setup:prop_portfolio trade_lifecycle long, stop 40 ticks, verdict full"
```
