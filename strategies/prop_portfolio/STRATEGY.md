---
name: prop_portfolio
description: Prop-challenge policy strategy over every rules strategy on its timeframe (3 minutes) - it sizes each setup on the Nasdaq, S&P, Dow, and Russell from the attempt's budget in the selected contract (or skips it), and trails every trade, to pass its account's combine without blowing it.
version: 1
status: active                # the owner's call: live and replay; the sizing rules decide each verdict (How It Works, 4)
instruments: [MNQ, NQ, MES, ES, MYM, YM, M2K, RTY]   # four indexes, one shared account: bars from the micro (minis share its prices); trades the selected one (the micro or the mini; `contracts` only with none selected)
timeframe: 3m                 # the one setting for the bar size: every listed strategy must trade it (see How It Works)
signal: policy                # trades the setups of the strategies below on the account
strategies: [cisd_ote, orb, vwap_reclaim, crt_1h, crt_4h, value_area, value_area_reentry, value_area_breakout]   # priority order: the first active one that fires on a bar is the setup (a paper one stays paper)
account: topstep_100k         # accounts/topstep_100k/ACCOUNT.md: $6,000 target, $3,000 trailing max loss, $2,000 daily limit
contracts: auto               # micro | mini | auto (minis once the size reaches one mini = 10 micros); only with no contract selected
# sizing, exit and the verdict's multipliers: in its account's rulebook (RULEBOOK.md beside ACCOUNT.md, policies.prop_portfolio), the one place for them
risk:
  stop: strategy              # each setup keeps its own strategy's stop
  min_rr: 2
source: harness design (the prop challenge as a strategy); the learned-rulebook design (to come) will tune its numbers
---

# Strategy: Prop Portfolio (`setup:prop_portfolio`)

A prop-challenge strategy. It trades the setups of the eight 3-minute rules
strategies on four index futures (Nasdaq, S&P, Dow, Russell) against one
Topstep 100K combine. It takes every setup at the account's size budget, or
skips one the budget can't fund, and its trail exits every trade.

## When to Use

- A `topstep_100k` attempt is running (`node scripts/combine.js status`).
- The runner reports a `prop_portfolio` setup with a verdict: the strategy
  that fired, the side, the contract (the selected one, the runner's symbols:
  MNQ or NQ, MES or ES, MYM or YM, M2K or RTY), the largest size, and the stop in ticks.

## How It Works

1. On every closed bar of its timeframe (`timeframe: 3m`) the runner scans
   the eight strategies in the order listed, on each index's bars. The
   first `active` one with a setup (its own rules and stop) is this
   strategy's setup on that index. A `paper` strategy (none today: the
   owner activated value_area) stays paper inside it: its setup is passed
   over, and the gate refuses an
   entry whose verdict names it. A strategy that doesn't list an index (vwap_reclaim lists
   only MNQ and MES) never fires there. The strategies don't trade on their
   own while the attempt runs. `timeframe` is the one setting for the bar
   size; every listed strategy must trade that timeframe (the strategies are
   ported with periods and stops in their own bars, so they are not re-run
   on other bars).
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
   place for them; this file never restates them. Risking a share
   of the headroom shrinks the size as the cushion shrinks, so a losing run
   decays toward a timeout instead of reaching the floor. It is worked out in
   micros and traded in the selected contract (MNQ selected: micros; NQ
   selected: minis), always rounding down; with none selected, as minis once
   it reaches one mini (`contracts: auto`).
4. The verdict: every setup gets the full size its budget allows (step 3),
   times the verdict's multiplier (the rulebook's enforced items; none yet,
   so 1), or a skip when the budget can't fund one contract at its stop, the
   attempt blocks entries, or the multiplier is 0. The trail (the rulebook's
   `exit`) manages every trade; nothing closes it early once it trails.
5. A verdict is a ceiling: take it only when the priority order (the strategy-library skill) says so (it may skip it or halve it), and then exactly as given: `setup:prop_portfolio`, the verdict's
   contract and side, at most its size, with `stopLossBracket.ticks` equal to
   its stop ticks. The order gate refuses anything else, any entry while a
   position is open or an entry went in since the last account snapshot, and
   any entry once the attempt passes, hits a daily limit, or has a missed
   close.

## Examples

```text
Cushion $3,250: budget cushion_frac x $3,250 = $975 (under cap_usd).
Each contract's risk is its stop plus a tick of expected slippage, plus fees both ways.
  NQ, a 40-tick stop (10 points): $21.24 a micro (41 x $0.50 = $20.50 + $0.74 fees): 45 micros,
    traded as 4 NQ (41 x $5 = $205 + $2.80 fees = $207.80 each, $831.20).
  ES, a 16-tick stop (4 points): $21.99 an MES (17 x $1.25 = $21.25 + $0.74): 44 micros,
    4 ES (17 x $12.50 = $212.50 + $2.80 = $215.30 each).
  YM, a 40-tick stop (40 points): $21.24 an MYM: 4 YM ($207.80 each).
  RTY, a 40-tick stop (4.0 points): $21.24 an M2K: 4 RTY ($207.80 each).
Cushion $1,000, $2,000 below the peak (past drawdown_halve_usd): budget cushion_frac x $1,000 / 2 = $150.
  YM, a 40-tick stop: 7 MYM ($148.68), under one mini, so micros.

prop_portfolio long setup on ES from orb: sizing says full (multiplier 1, max 4 ES, stop 16 ticks)
-> place_order ES buy 4, stopLossBracket.ticks 16,
   rationale "setup:prop_portfolio orb long, stop 16 ticks, verdict full"
NQ setup on the next bar while the ES trade is open: the gate refuses it (one position at a time).
```
