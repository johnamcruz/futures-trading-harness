---
name: trade_lifecycle
description: The trade lifecycle - each bar the model puts together its bias, location, setup, entry, stop, target and size from its skills, or passes; code verifies every read against the bar briefing and records the decision, so it learns from scored outcomes which combinations work. No combination is hard-coded.
version: 1
status: active                # the owner's call; the order gate enters it only on its compose record, every read re-checked (composed-reads)
instruments: [MNQ, MES, MYM, M2K]   # a micro covers its selected mini, as a rules strategy
timeframe: 3m                 # the base bars its reads are checked on (the runner's)
signal: composed              # the model composes the entry from its skills; compose_check verifies it
mtf: trend                    # the gate's trend rule applies as to any trend strategy (D2's verified reversal is a reads rule, never this one)
risk:
  stop: structure             # the stop is the verified invalidation level the model names, one tick beyond it
  min_rr: 2                   # compose_check refuses a plan under it
  max_risk_usd: 100           # required for signal: composed: the gate's risk cap per trade
source: the owner's trade-lifecycle design (the model learns which skills to combine from the market)
---

# Strategy: Trade Lifecycle (`setup:trade_lifecycle`)

The one strategy the model trades: not a pattern, but the trader process.
At each bar the head trader reads bias, location, setup and entry from
whichever skills fit, names the level that proves it wrong and the level it
targets, and states its size, or passes. `compose_check` checks every read
against the bar briefing, works out the plan in code, and records it with the
context, so the outcomes teach which combinations work in which market.

## When to Use

- Every bar of a runner cycle: the model composes a candidate from its
  skills, or passes (a pass is a good decision and is scored as one).
- Only with a `compose_check` record that is `OK` for this bar and side.

## How It Works

### The reads

One read per step at least, each in a closed form `compose_check` verifies
against the briefing (the forms: scripts/lib/trading/composed-reads.js): bias, location,
setup, entry, stop (`stop <source> <price>`) and target
(`target <source> <price>`). Every directional read must agree with the side.
Which skill at each step is the model's choice; nothing here prescribes one.

### The plan

Code, never the model's arithmetic: a limit entry at the bar's close, the
stop one tick beyond the named level (at least the larger of 8 ticks and
0.25 x ATR(20), refused if closer, never widened), the target on the named
level, R:R at least `risk.min_rr`, and the stated size within
`risk.max_risk_usd`. The record expires at the next base-bar close.

## Examples

- Long MNQ at 21540.25: `1h bos up`, `above prior RTH range`, `at prior VAH`,
  `15m rejected prior VAH up`, `3m close top`, `3m momentum up`,
  `stop 15m low 21512.75`, `target 1h swing 21598.00`. The stop goes to
  21512.50 (one tick below): 111 ticks, $55.50 a contract; the target is 231
  ticks, 2.08R.
- The same reads for a short: refused (every directional read is against it).
