---
name: trade_lifecycle
description: The trade lifecycle - each bar the model puts together its bias, location, setup, entry, stop, target and size from its skills, or passes; code verifies every read against the bar briefing and records the decision, so it learns from scored outcomes which combinations work. No combination is hard-coded.
version: 1
status: active                # the owner's call; the order gate enters it only on its compose record, every read re-checked (composed-reads)
instruments: [MNQ, MES, MYM, M2K]   # a micro covers its selected mini, as a rules strategy
timeframe: 3m                 # the base bars its reads are checked on (the runner's)
signal: composed              # the model composes the entry from its skills; compose_check verifies it
mtf: trend                    # the gate's trend rule: never counter (no entry against a trending 4h or 1h)
valid_bars: 2                 # a compose record, and its resting limit, stays valid 2 base bars after its bar's close (6 min on 3m)
risk:
  stop: structure             # the stop is the verified invalidation level the model names, one tick beyond it
  min_rr: 2                   # compose_check refuses a plan under it
  max_risk_usd: 300           # the hard cap per trade, inside and outside an attempt (the owner's: a normal trade risks about $200-300); in an attempt only the floor may go over it (the rulebook's floor stretch)
  stop_buffer_ticks: 1        # the stop goes this many ticks beyond the named level (D3)
  stop_floor_ticks: 8         # the closest stop: the larger of these ticks
  stop_floor_atr: 0.25        # and this multiple of ATR(20); a closer stop is refused, never widened (D13)
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
  skills; a valid setup is the trade, a pass only on a decisive reason
  (`confluence-counting`).
- Only with a `compose_check` record that is `OK` for this bar and side.
- Read `trade-lifecycle` before an entry: how to compose, send and read a refusal.

## How It Works

### The reads

One read per step at least, each in a closed form `compose_check` verifies
against the briefing (the forms: scripts/lib/trading/composed-reads.js): bias, location,
setup, entry, stop (`stop <source> <price>`) and target
(`target trail`, or `target <source> <price>`). Every directional read must agree with the side.
Which skill at each step is the model's choice; nothing here prescribes one.

### The plan

Code, never the model's arithmetic: a limit entry at the bar's close, the
stop `risk.stop_buffer_ticks` beyond the named level (at least the larger
of `risk.stop_floor_ticks` and `risk.stop_floor_atr` x ATR(20), refused if
closer, never widened), the target: with `target trail` (every side the
entry rule gives) the 2R mark, `risk.min_rr` times the stop from the entry
on the tick the trade's way, where the policy's exit arms its trail; else
the named level (none named the trade's way: the 2R mark `target 2r`; a
level named short of it is no room, never the mark), R:R at least `risk.min_rr`, and the stated size within
`risk.max_risk_usd`. The record expires `valid_bars` base bars after its
bar's close (two: 6 minutes on the 3m), so a cycle that runs past the next
close can still enter on the facts of its own bar; the runner cancels a limit
still resting then.

A cited setup: a setup read `<name> fired up|down` of a rules strategy its
policy lists (`momentum_continuation`) gives the plan that strategy's own
entry (at market from the bar's close), stop (its scan's distance; the stop
read is the level it sits beyond) and fixed-R target (`target 2r` for its
2R); every other step and check stands.

### Risk and target

A normal trade risks about $200-300, sized by the model from its sizing
skills: smaller, or a pass, is always allowed; never above $300, the hard
cap. In a prop attempt the ceiling is the lower of $300 and the account's
verdict; where $300 fits fewer than the rulebook's floor at the stop, code
may trade exactly the floor, up to the rulebook's floor stretch, while the
attempt is healthy (its RULEBOOK.md). The trail exits (the owner: always
trail): the 2R mark arms the trail, not the exit, and the policy's exit trails past it; a level
ahead is context, never the exit. `min_rr` 2 is the code's floor.

### Against the trend

Never (never counter): the trend rule refuses an entry against a trending
4h or 1h, whatever CHoCH the reads name.

## Examples

- Long MNQ at 21540.25: `1h bos up`, `above prior RTH range`, `at prior VAH`,
  `15m rejected prior VAH up`, `3m close top`, `3m momentum up`,
  `stop 15m low 21512.75`, `target trail`. The stop goes to
  21512.50 (one tick below): 111 ticks; the target is the 2R mark, 222 ticks,
  where the trail arms. The size is the size translation's (`order_plan`
  gives it, within the $300 cap); a larger size is refused.
- The same reads for a short: refused (every directional read is against it).
