---
name: prop_portfolio_3m
description: Prop-challenge policy strategy over every 3-minute rules strategy - a trained policy picks which setups to take, at what size in micros or minis, and when to bank a trade, to pass the Topstep 100K combine without blowing it.
version: 1
status: paper                 # paper until a validated bundle is shipped and the user activates it
instruments: [MNQ, NQ]        # the Nasdaq family: bars from MNQ; trades MNQ or NQ (contracts)
timeframe: 3m
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
# policy: { bundle: prop_portfolio_3m_topstep_100k }   # set by rl/ship.py's output once a bundle passes the gate
source: docs/RL-DESIGN.md; trained by rl/ (sweep -> retrain -> ship, rl/configs/*/prop_portfolio_3m_topstep_100k_v1.json)
---

# Strategy: Prop Portfolio 3m (`setup:prop_portfolio_3m`)

A prop-challenge strategy. It trades the setups of the nine 3-minute rules
strategies on the Topstep 100K combine, and a trained policy decides what to
do with each one. Without a `policy` bundle it takes every setup at the
account's size budget (the rules-only baseline the policy is measured
against).

## When to Use

- A `topstep_100k` attempt is running (`node scripts/combine.js status`).
- The runner reports a `prop_portfolio_3m` setup with a verdict: the strategy
  that fired, the side, the contract (MNQ or NQ), the largest size, and the
  stop in ticks.

## How It Works

1. On every closed 3-minute bar the runner scans the nine strategies in the
   order listed. The first one with a setup (its own rules and stop) is this
   strategy's setup. The strategies don't trade on their own while the
   attempt runs.
2. The size budget is 30% of the cushion above the trailing floor, at most
   $1,000, halved while the balance is $1,500 or more below its peak, and
   never a full stop's reach to the floor or the daily limit. Risking a share
   of the headroom shrinks the size as the cushion shrinks, so a losing run
   decays toward a timeout instead of reaching the floor. It is worked out in
   micros and traded as minis once it reaches one mini (`contracts: auto`),
   always rounding down.
3. The policy (once shipped) sees the account (cushion, progress, drawdown,
   day P&L, sessions left), the setup (which strategy, side, risk, micro or
   mini), and the market (session clock, ATR ratio, ADX), and answers skip,
   half, or full. Past +2R it answers hold or close on every bar.
4. Place exactly the verdict: `setup:prop_portfolio_3m`, the verdict's
   contract and side, at most its size, with `stopLossBracket.ticks` equal to
   its stop ticks. The order gate refuses anything else, and any entry once
   the attempt passes, hits a daily limit, or has a missed close.

## Examples

```text
Cushion $3,250: budget 0.3 x $3,250 = $975. A 40-tick stop risks $20.74 a micro
($20 + $0.74 fees): 47 micros, traded as 4 NQ ($200 + $2.80 fees = $202.80 each, $811.20).

prop_portfolio_3m long setup from supertrend: policy says full (max 4 NQ, stop 40 ticks)
-> place_order NQ buy 4, stopLossBracket.ticks 40,
   rationale "setup:prop_portfolio_3m supertrend long, stop 40 ticks, policy full"
```
