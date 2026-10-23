---
name: topstep_100k
description: The rulebook for this account - the numbers its policy strategies trade with and which of its rules the code enforces or the skills teach. Today's values; nothing is learned yet.
learned: none                   # none: today's values, carried over unchanged (docs/LEARNED-RULEBOOK.md, step 7)
daily_loss_soft: 1000           # dollars: no new entries for the rest of the day once the day is down this much
loss_streak_stop: 2             # losing trades in a row: no new entries for the rest of the session (a scratch neither ends nor extends the streak)
policies:                       # each policy strategy that trades this account (its STRATEGY.md names it; never restates these)
  prop_portfolio:
    sizing:                     # risk from the headroom above the floor
      cushion_frac: 0.3         # a trade risks at most this share of the cushion ...
      cap_usd: 1000             # ... and at most this many dollars
      drawdown_halve_usd: 1500  # half that while the balance is this far or more below its peak
      min_size_guard: 1.5       # one micro may risk up to this many times the budget; a mini never more than the budget
      stop_slippage_ticks: 1    # a stop's expected slippage, counted in each contract's risk
      clock_k: off              # pacing: a number k caps the risk at k x what the pass still needs per session left; off: none
      r_per_session: 0.3        # the R a session is expected to make, for clock_k
      min_contracts: 3          # the floor: fewer micro-equivalents than this (a mini counts as 10) at the stop is a skip
    exit:
      mode: target_then_trail   # target: out at the trade's own target; target_then_trail: past it, trailed; trail: the R trail below, no target
      trail_activate_r: off     # mode trail (or a trail on top of target): hold the stop until this many R ...
      trail_giveback_r: off     # ... then trail this many R behind the best price
      lock_giveback_r: 0.5      # target_then_trail: once the target is reached the stop locks at the target's R less this
      trail_by: structure       # target_then_trail: structure (behind the last confirmed swing on swing_tf) or r (trail_r behind the best price)
      trail_r: 1                # target_then_trail: R behind the best price (trail_by r, and structure's fallback until a swing is confirmed)
      swing_tf: 15m             # target_then_trail with trail_by structure: the swings the stop trails behind
    multipliers: []             # enforced size multipliers folded into the verdict: none yet
enforced: [daily_loss_soft, loss_streak_stop, sizing, exit, multipliers, target_stop, consistency_stop, one_position, hard_stops, trend_rule]
taught: [trend_fade, room, mtf_read, skip_rules, confluence, secondary_context, halving]
---

# Rulebook: `topstep_100k`

The one place for the numbers this account's policy strategies trade with
(docs/LEARNED-RULEBOOK.md, R1-R4). The frontmatter holds every value; nothing
else states one. The account loader takes the soft daily stop from here, and
the loss streak stop, and the strategy loader each policy's sizing, exit and multipliers, so the
runner, the sizing verdict, the order gate and the backtester all read them
from this file. A policy strategy listed here may not set them itself.

## When to Use

- To see or change what a policy strategy on this account risks, how it
  exits, how it paces, or when the day or the session stops: edit the frontmatter here, never the
  strategy or a skill.
- To see which rules the code holds (`enforced`) and which the skills teach
  (`taught`).

## How It Works

**Kinds (R4).** An `enforced` item is computed from facts the harness has
and held in code: the runner folds it into the verdict and the order gate
holds the order to it; the LLM can only lower the size. A `taught` item is a
judgment: the priority order in the `strategy-library` skill teaches it, at
the step named in `scripts/lib/trading/rulebook.js` (`ITEMS`). The loader
refuses an item classified as a kind no code or skill provides.

**The verdict's multiplier (R4).** Each verdict carries a `multiplier`: the
product of the policy's `multipliers` items, each the value its fact maps
to. A missing or stale fact sets its item to 0, so the setup is skipped. A
full verdict is sized at its multiplier; the gate refuses any action other
than `full` or `skip`, and a full verdict without a multiplier above 0 and at
most 1. There are no multiplier items yet, so every full verdict carries 1
and every skip 0: decisions are as before. No code supplies a fact yet (the runner and the backtester pass none), so an item added before its fact source exists skips every setup: it fails closed.

**The loss streak stop.** After `loss_streak_stop` losing trades in a row
in a session, no new entries until the next session: the verdict skips, the
gate refuses (combine.entryBlock), and the backtester and the attempt
simulator skip as well. A loss is a trade closed below its entry before fees
(live: the broker's closing fills, one trade per round trip), a win ends the
streak, and a scratch (closed at its entry) neither ends nor extends it. It
counts round trips (each trade's closing fills together), where the gate's
timed loss-streak cooldown counts closing fills one by one; the loss, win and
scratch rule is the same. Exits and protective orders always
go. Two losses in a row is the point where the day is more likely tilted
than unlucky: standing down keeps the soft daily stop and the floor out of
reach.

**The exit.** Three modes, each tunable by the 30-day Monte Carlo, the same
rule in the runner, the backtester and the attempt simulator (which re-exits
each trade from its recorded path, prop/attempts.js exitAs):

- `target`: out at the trade's own target, a real level at 2:1 to 3:1 (the
  compose record's bracket), a trail on top only when `trail_activate_r` and
  `trail_giveback_r` are R.
- `target_then_trail` (today's): the original stop holds until the trade's
  own target is reached; from there the trade is not closed but trailed, so a
  runner can make more R. The stop locks at the target's R less
  `lock_giveback_r` and never goes below it, and trails behind the last
  swing confirmed on `swing_tf` candles (`trail_by: structure`, from closed
  bars only), or `trail_r` behind the best price (`trail_by: r`, and the
  structure trail's fallback until a swing is confirmed). Live, the runner
  cancels the entry's target order when it first manages the trade and moves
  the stop at each closed bar; a target reached before then fills there.
- `trail`: hold the stop until `trail_activate_r`, then trail
  `trail_giveback_r` behind the best price, in place of the target. Kept only
  as a tunable: our research found this tight trail cut the edge.

**Pacing.** `clock_k` is the pacing knob the phase-2 search tunes: a number k
caps each trade's risk at k x what the pass still needs per session left (in
R at `r_per_session`), so a lead slows the attempt and a deficit can't push
the size past the budget. It is `off` today, and it works the same for the
composed trade (its verdict and the gate size from these values).

**The floor.** `min_contracts` (the owner's, 2026-10-23: a trade too small
can't pass in 30 sessions) is the fewest contracts a prop entry trades, in
micro-equivalents: a mini counts as its family's ratio (10 micros), so in
`micro` and `auto` mode it is 3 micros and any whole mini clears it. When
the budget or the room fits fewer at the setup's stop, the verdict is
`skip` ("3 MNQ at this stop risk $X, over the $Y budget ...: skip; never
a tighter stop"); the size is never rounded up past the budget. The gate
refuses an entry below it (`[min-contracts]`); a phase-2 cut below it is no
trade. Exits,
protective stops, stop moves, cancels and closes always go. The one-contract
guard (`min_size_guard`) only matters with a floor of 1: above it, the one
contract the guard allows is under the floor. The backtester and the attempt
simulator skip the same setups, so the Monte Carlo is sized as live.

**The size at entry.** In an attempt the size the model states (its compose
record) is a suggestion: `prop/size-translate.js`, the one place, translates
it at entry to the correct size from these values alone: the largest the
verdict, the size budget now, the composed strategy's dollar cap and the
broker's max order size allow, never under the floor (under it: no trade)
and never with a tighter stop. `order_plan` builds the order at it, the gate
accepts exactly it (or phase 2's smaller cut) and refuses any other size.
The cap is counted all in, as the budget is: a contract's stop plus
`stop_slippage_ticks` at its tick value, plus the fees both ways. With the
floor at 3 and the composed $300 cap, a stop wider than 197 ticks on MNQ
((197 + 1) x $0.50 + $0.74 = $99.74 a contract) or 78 ticks on MES
((78 + 1) x $1.25 + $0.74 = $99.49) can't be traded: 3 contracts would risk
over $300 all in, so those setups skip. The run's Monte Carlo
(prop/model-score.js) sizes with the same limits (the cap, the broker's max
order size, the contract the run traded).

**Evidence (R3).** Nothing here is learned yet. Each value is today's,
carried over unchanged when the rulebook was created; the search and the
calibration (docs/LEARNED-RULEBOOK.md, sections 5 and 6) will replace each
one with its evidence.

| Value | Today's source | Training-window effect | Stability across years | Learned |
| --- | --- | --- | --- | --- |
| `daily_loss_soft` | this account's profile | not measured | not measured | not learned |
| `loss_streak_stop` | starting value, not learned; tuned by the 30-day Monte Carlo (phase 2) | not measured | not measured | not learned |
| `policies.prop_portfolio.sizing` | `prop_portfolio`'s STRATEGY.md | not measured | not measured | not learned |
| `policies.prop_portfolio.exit` | starting value, not learned; the 30-day Monte Carlo decides between the modes (phase 2) | not measured | not measured | not learned |
| `policies.prop_portfolio.sizing.clock_k` | starting value, not learned; tuned by the 30-day Monte Carlo (phase 2) | not measured | not measured | not learned |
| `policies.prop_portfolio.sizing.min_contracts` | the owner's floor (2026-10-23), not learned | not measured | not measured | not learned |

`prop_portfolio` lists no strategies since 2026-10-14 (every rules strategy
retired, strategies/README.md): it has no setups, so it sizes nothing until
its one component, `trade_lifecycle`, is built (docs/COMPOSED-ENTRY.md).
Its sizing numbers here are unchanged; its exit now holds the stop to the
trade's own target and trails past it (`target_then_trail`). The retired `prop_flow_1m`'s entry went with
it.

Every sizing key is stated for every policy: the loader refuses an entry
that leaves one out: the code has no default (`combine.js` `SIZING_KEYS`
only names the keys), so a key left out sizes nothing rather than loosen
risk unseen. A limit is turned off only by the word `off`
(as `clock_k` is here): 0, an empty value, a negative number or text is refused, never read as
off. Each policy is sized only from here: a policy on this account that
isn't listed is refused, and so is the account when this file is missing,
malformed, or names another account.

## Examples

```text
node scripts/combine.js status
  prop_portfolio size budget: cushion_frac x the cushion, at most cap_usd,
  halved while the balance is drawdown_halve_usd or more below its peak.

A verdict: prop_portfolio long setup from its component: full, multiplier 1,
  at most 4 NQ with a 40-tick stop. A multiplier item whose fact is missing
  would make it a skip.
```
