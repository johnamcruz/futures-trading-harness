---
name: prop_portfolio
description: Prop-challenge policy strategy, the account layer - it sizes each setup of the strategies it lists on the Nasdaq, S&P, Dow, and Russell from the attempt's budget in the selected contract (or skips it), and exits each trade by its rulebook's exit (today the trade's own stop until its own target, then a trail past it). Its trades are trade_lifecycle's records, which may cite momentum_continuation.
version: 3
status: active                # the owner's call; its setups are trade_lifecycle's compose records; no live trading until the owner says trade_lifecycle is correct
instruments: [MNQ, NQ, MES, ES, MYM, YM, M2K, RTY]   # four indexes, one shared account: bars from the micro (minis share its prices); trades the selected one (the micro or the mini; `contracts` only with none selected)
timeframe: 3m                 # the one setting for the bar size: every listed strategy must trade it (see How It Works)
signal: policy                # trades the setups of the strategies below on the account
strategies: [trade_lifecycle, momentum_continuation] # the model's own composed trade, and the setup it may cite (traded only through its record)
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
can't fund, and exits every trade by its rulebook's exit.

**Its trades are `trade_lifecycle`'s**, the composed trade the model
builds from its skills (docs/COMPOSED-ENTRY.md, section 3.7). It also lists
`momentum_continuation`, a setup that trade may cite (`<name> fired
up|down`): a rules strategy listed beside a composed one gets no verdict of
its own; the record citing it takes its entry (market), stop and target.
Each compose record on an index is its setup:
`order_plan` sizes the record here (the verdict, once per record) and the
model's stated size goes at or under it. Both stay `active`; practice runs
on the replay broker, and there is no live trading until the owner says
`trade_lifecycle` is correct.

## When to Use

- A `topstep_100k` attempt is running (`node scripts/combine.js status`).
- The runner reports a `prop_portfolio` setup with a verdict: the strategy
  that fired, the side, the contract (the selected one, the runner's symbols:
  MNQ or NQ, MES or ES, MYM or YM, M2K or RTY), the largest size, and the stop in ticks.

## How It Works

1. Its setup on an index is the model's compose record for the bar
   (`trade_lifecycle`: the reads, the record's stop ticks and side). A
   `paper` component stays paper inside it: the gate refuses its entry.
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
   so 1), or a skip when the budget can't fund the rulebook's `min_contracts` at its stop, the
   attempt blocks entries (its soft daily stop, its loss streak stop:
   `loss_streak_stop` losing trades in a row stop new entries for the
   session), or the multiplier is 0. The rulebook's `exit` manages every
   trade: exit mode `target` keeps the trade's own stop and target (the compose
   record's brackets), with a trail on top only when the rulebook sets one;
   `target_then_trail` holds the stop to the trade's own target and then, in
   place of the exit there, holds the stop at its R less the rulebook's
   `lock_giveback_r` until a `swing_tf` swing confirms beyond it, then trails
   behind that swing (with `trail_by: r`, by R), so a winner can run; exit mode `trail` puts
   the R trail in place of the target.
5. A verdict is a ceiling: take it only when the priority order (the
   strategy-library skill) says so, and then exactly as given:
   `setup:prop_portfolio`, the verdict's contract and side, at most its
   size, with `stopLossBracket.ticks` equal to its stop ticks. The order
   gate refuses anything else.

## Examples

```text
A trade_lifecycle long record on NQ sized full (multiplier 1, max 4 NQ,
stop 40 ticks); the model stated 2:
-> place_order NQ buy 2 limit at the record's reference, stopLossBracket.ticks 40,
   rationale "setup:prop_portfolio long trade_lifecycle ..." (order_plan gives it)
place_order NQ sell 1, rationale "[exit] flatten the open long" -> goes (exits are never refused).
```
