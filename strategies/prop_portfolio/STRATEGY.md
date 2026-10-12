---
name: prop_portfolio
description: Prop-challenge policy strategy over every rules strategy on its timeframe (3 minutes) - a trained policy picks which setups to take on the Nasdaq, S&P, Dow, and Russell, at what size in micros or minis, and when to bank a trade, to pass the Topstep 100K combine without blowing it.
version: 1
status: active                # the owner's call: live and replay; until a bundle is shipped the sizing rules decide (How It Works, 4)
instruments: [MNQ, NQ, MES, ES, MYM, YM, M2K, RTY]   # four indexes, one shared account: bars from the micro (minis share its prices); trades the micro or the mini (contracts)
timeframe: 3m                 # the one setting for the bar size: every listed strategy must trade it (see How It Works); a bundle trades only the timeframe it was trained on
signal: policy                # a trained policy trades the setups of the strategies below
strategies: [ema_cross, supertrend, keltner, bos, cisd_ote, orb, vwap_reclaim, crt_1h, crt_4h, value_area, value_area_reentry, value_area_breakout]   # priority order: the first that fires on a bar is the setup
account: topstep_100k         # accounts/topstep_100k/ACCOUNT.md: $6,000 target, $3,000 trailing max loss, $2,000 daily limit
sizing:                       # risk from the headroom above the floor
  cushion_frac: 0.3           # a trade risks at most 30% of the cushion above the floor ...
  cap_usd: 1000               # ... and at most $1,000
  drawdown_halve_usd: 1500    # half that while the balance is $1,500 or more below its peak
  min_size_guard: 1.5         # one micro may risk up to 1.5x the budget; a mini never more than the budget
contracts: auto               # micro | mini | auto (minis once the size reaches one mini = 10 micros)
exit:
  trail_activate_r: 2         # hold the setup's own stop until +2R ...
  trail_giveback_r: 0.5       # ... then trail 0.5R behind the best price; past +2R the policy may bank it
risk:
  stop: strategy              # each setup keeps its own strategy's stop
  min_rr: 2
# policy: { bundle: prop_portfolio_topstep_100k }   # set by rl/ship.py's output once a bundle passes the gate
source: docs/RL-DESIGN.md; trained by rl/ (sweep -> retrain -> ship, rl/configs/*/prop_portfolio_topstep_100k_v1.json)
---

# Strategy: Prop Portfolio (`setup:prop_portfolio`)

A prop-challenge strategy. It trades the setups of the twelve 3-minute rules
strategies on four index futures (Nasdaq, S&P, Dow, Russell) against one
Topstep 100K combine, and a trained policy decides what to do with each one.
Without a `policy` bundle it takes every setup at the account's size budget
(the rules-only baseline the policy is measured against).

## When to Use

- A `topstep_100k` attempt is running (`node scripts/combine.js status`).
- The runner reports a `prop_portfolio` setup with a verdict: the strategy
  that fired, the side, the contract (the index's micro or mini: MNQ or NQ,
  MES or ES, MYM or YM, M2K or RTY), the largest size, and the stop in ticks.

## How It Works

1. On every closed bar of its timeframe (`timeframe: 3m`) the runner scans
   the twelve strategies in the order listed, on each index's bars. The
   first one with a setup (its own rules and stop) is this strategy's setup
   on that index. A strategy that doesn't list an index (vwap_reclaim lists
   only MNQ and MES) never fires there. The strategies don't trade on their
   own while the attempt runs. `timeframe` is the one setting for the bar
   size; every listed strategy must trade that timeframe (the strategies are
   ported with periods and stops in their own bars, so they are not re-run
   on other bars), and a bundle trades only the timeframe it was trained on.
2. One account, one position at a time: all four indexes share the
   attempt's cushion, so while a trade is open (or an entry is in flight) on
   one index, setups on the others wait (the gate refuses them, and training
   and backtests do the same). Each trade is then sized from the whole
   cushion, and a stopped trade never reaches the floor or the daily limit.
3. The size budget is 30% of the cushion above the trailing floor, at most
   $1,000, halved while the balance is $1,500 or more below its peak, and
   never a full stop's reach to the floor or the daily limit. Risking a share
   of the headroom shrinks the size as the cushion shrinks, so a losing run
   decays toward a timeout instead of reaching the floor. It is worked out in
   micros and traded as minis once it reaches one mini (`contracts: auto`),
   always rounding down. A bundle trained on minis only (`contracts: mini` in
   its training config) trades only once this document says the same.
4. The policy (once shipped) sees the account (cushion, progress, drawdown,
   day P&L, sessions left), the setup (which strategy, side, risk, micro or
   mini), and the market (session clock, ATR ratio, ADX), and answers skip,
   half, or full. Past +2R it answers hold or close on every bar. Until a
   bundle is shipped (no `policy:` line), every setup gets the full size its
   budget allows (step 3), or a skip when the budget can't fund one contract
   at its stop or the attempt blocks entries; the trail manages the trade.
5. A verdict is a ceiling: take it only when the priority order (the strategy-library skill) says so (it may skip it or halve it), and then exactly as given: `setup:prop_portfolio`, the verdict's
   contract and side, at most its size, with `stopLossBracket.ticks` equal to
   its stop ticks. The order gate refuses anything else, any entry while a
   position is open or an entry went in since the last account snapshot, and
   any entry once the attempt passes, hits a daily limit, or has a missed
   close.

## Examples

```text
Cushion $3,250: budget 0.3 x $3,250 = $975.
  NQ, a 40-tick stop (10 points): $20.74 a micro ($20 + $0.74 fees): 47 micros,
    traded as 4 NQ ($200 + $2.80 fees = $202.80 each, $811.20).
  ES, a 16-tick stop (4 points): $20.74 an MES ($20 + $0.74): 47 micros, 4 ES ($202.80 each).
  YM, a 40-tick stop (40 points): $20.74 an MYM: 4 YM ($202.80 each).
  RTY, a 40-tick stop (4.0 points): $20.74 an M2K: 4 RTY ($202.80 each).
Cushion $1,000, $2,000 below the peak: budget 0.3 x $1,000 / 2 = $150.
  YM, a 40-tick stop: 7 MYM ($145.18), under one mini, so micros.

prop_portfolio long setup on ES from supertrend: policy says full (max 4 ES, stop 16 ticks)
-> place_order ES buy 4, stopLossBracket.ticks 16,
   rationale "setup:prop_portfolio supertrend long, stop 16 ticks, policy full"
NQ setup on the next bar while the ES trade is open: the gate refuses it (one position at a time).
```
