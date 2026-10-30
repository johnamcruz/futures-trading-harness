---
name: topstep_100k
description: The rulebook for this account - the numbers its policy strategies trade with and which of its rules the code enforces or the skills teach. Today's values; nothing is learned yet.
learned: none                   # none: today's values, carried over unchanged (docs/LEARNED-RULEBOOK.md, step 7)
daily_loss_soft: 1000           # dollars: no new entries for the rest of the day once the day is down this much
loss_streak_stop: 2             # losing trades in a row: no new entries for the rest of the session (a scratch neither ends nor extends the streak)
policies:                       # each policy strategy that trades this account (its STRATEGY.md names it; never restates these)
  prop_portfolio:
    entry:                      # the entry rule on a composed entry (entry-rule.js), held by compose_check and the gate; off: no check
      bias_frames: [4h, 1h]     # off, or [4h, 1h], [4h] or [1h] only (never the 15m): the first that trends sets the side, none against it, none trending: no entry
      bias_agree: neutral-15m-declared  # on: every bias frame trends the side's way; off: the first that trends sets the side; neutral-15m-declared: every one that trends is the side's way, none against, and with all ranging the 15m trend and the declared trend the side's way
      regime_against: off       # on: no entry while the m3 regime trends against the side
      leg_turned: off           # on: an m3 regime not trending the side's way needs a true 3m BOS, CHoCH or compression break its way
    sizing:                     # risk from the headroom above the floor
      cushion_frac: 0.3         # a trade risks at most this share of the cushion ...
      cap_usd: 1000             # ... and at most this many dollars
      drawdown_halve_usd: 1500  # half that while the balance is this far or more below its peak
      min_size_guard: 1.5       # one micro may risk up to this many times the budget; a mini never more than the budget
      stop_slippage_ticks: 1    # a stop's expected slippage, counted in each contract's risk
      clock_k: off              # pacing: a number k caps the risk at k x what the pass still needs per session left; off: none
      r_per_session: 0.3        # the R a session is expected to make, for clock_k
      min_contracts: 3          # the floor: fewer micro-equivalents than this (a mini counts as 10) at the stop is a skip
      floor_stretch_max_usd: 500  # the composed cap fits fewer than the floor: exactly the floor, at most this all in, while the attempt is healthy
      near_target_usd: 500      # once the target is this much profit away or less, a trade is the floor (min_contracts), never more; off: full size to the target
    exit:
      mode: target_then_trail   # target: out at the trade's own target; target_then_trail: past it, trailed; trail: the R trail below, no target
      trail_activate_r: off     # mode trail (or a trail on top of target): hold the stop until this many R ...
      trail_giveback_r: off     # ... then trail this many R behind the best price
      lock_giveback_r: 1.5      # target_then_trail: once the target is reached the stop locks at the target's R less this
      trail_by: structure       # target_then_trail: structure (behind the last confirmed swing on swing_tf) or r (trail_r behind the best price)
      trail_r: 1                # target_then_trail: R behind the best price (trail_by r, and structure's fallback until a swing is confirmed)
      swing_tf: 15m             # target_then_trail with trail_by structure: the swings the stop trails behind
      ratchet: off              # target_then_trail: on lifts the lock to the best R reached less lock_giveback_r; off (opt in only): the lock above
    multipliers: []             # enforced size multipliers folded into the verdict: none yet
enforced: [daily_loss_soft, loss_streak_stop, sizing, exit, multipliers, target_stop, consistency_stop, one_position, hard_stops, trend_rule, entry_rule]
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
  `lock_giveback_r` is 1.5 (the owner's, 2026-10-24): at a 2R target the
  stop locks at +0.5R, room for an ordinary pullback in a trend; at 0.5 it
  locked at +1.5R and closed winners on a 1R pullback before the leg ran on.

  `ratchet` (target_then_trail only) is off by default (the owner,
  2026-10-24: opt in only). With `ratchet: on`, the lock rises with the
  trade: it is the best R reached (closed bars' extremes, as the R trail
  reads them; at least the target's R) less `lock_giveback_r`, never below
  the entry, so past its target the stop stands at most `lock_giveback_r`
  from the best R (the exit can give back more: a bar through the stop
  closes at its close, and a live stop fills with slippage). The stop is the farther in profit of that lock and
  the trail and never loosens. A bar that sets a stop already through its
  own extreme closes the trade at its close, as the trail does. The owner
  asked for it after a short ran to +4.7R and closed at +2.29R behind a
  15m swing: "implement that ratchet since we shouldn't have give back too
  much when we caught 4.7r", with the giveback kept at 1.5: "3.2r is
  good". Worked on that MNQ short (entry 14530.50, 1R 24.50 points = 98
  ticks, $49.00 a micro; tick 0.25, $0.50 a tick; its target at 2R,
  14481.50), with `ratchet: on` (R to 3 places; ticks and dollars exact):

  | Best reached | Best R | Ratchet stop | Locked |
  |---|---|---|---|
  | 14481.50 (the target) | 2.000 | 14518.25 | +0.500R, 49 ticks, $24.50 a micro |
  | 14457.00, then back to 14481.50 | 3.000 | 14493.75 | +1.500R, 147 ticks, $73.50 a micro |
  | 14415.25 | 4.704 | 14452.00 | +3.204R, 314 ticks, $157.00 a micro |
  | 14408.00 | 5.000 | 14444.75 | +3.500R, 343 ticks, $171.50 a micro |

  A swing trail farther in profit than the ratchet still wins. With `off`
  the stop stays at 14518.25 past the target until the trail passes it.
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
over $300 all in, so those setups skip, unless the floor stretch below
takes them. The run's Monte Carlo
(prop/model-score.js) sizes with the same limits (the cap, the broker's max
order size, the contract the run traded, the floor stretch).

**The floor stretch.** `floor_stretch_max_usd` (the owner's, 2026-10-24:
"up to $500 if healthy") is part of `sizing`, so it is `enforced`: where
the composed cap fits fewer than the floor at the stop, the order is
exactly the floor when the floor risks at most this all in and the attempt
is healthy; never more than the floor, never above this. The floor is in
the order's own contracts: 3 micros, or 1 mini (a mini counts as 10
micros, so its floor is 1 contract), and a mini's floor may stretch too
(the owner's, 2026-10-24: "Allow 1 mini too"). Healthy (the owner's:
"balance ≥ attempt start AND no loss yet this session. One loss today drops
back to the $300 cap for the rest of the day"): the balance at or above the
attempt's starting balance (no deficit), and no losing trade yet this
trading day (the snapshot's count of the day's losing trades is 0). A win
after a loss doesn't bring it back: the cap holds for the rest of that day,
and the next trading day starts at 0 again. An attempt state or a day's
count that can't be read is not healthy. Every other limit still holds: the verdict, the size budget
(the room to the floor and the daily limit, the drawdown halving), the
broker's max order size; one that allows fewer than the floor is a skip,
as before. All in, 3 MNQ fit $500 up to a 330-tick stop
((330 + 1) x $0.50 + $0.74 = $166.24, 3: $498.72; 331 ticks: $500.22,
a skip), 3 MES up to 131 ticks ((131 + 1) x $1.25 + $0.74 = $165.74,
3: $497.22; 132: $500.97), 1 NQ up to 98 ((98 + 1) x $5 + $2.80 =
$497.80; 99: $502.80). The size translation, `order_plan`, compose_check,
the gate (`[max-risk]` takes exactly the stretched floor, nothing else
over the cap) and the backtester and the attempt simulator apply the one
rule (`prop/size-translate.js` `floorStretch`). `off` turns it off. It
never asks for a wider stop: the stop is the record's.

**Near the target.** `near_target_usd` (owner-approved 2026-10-28) is part
of `sizing`, so it is `enforced`: once the profit to the target (the
target alone: the consistency rule is the account's) is at most this, a trade is the floor
(`min_contracts`, in the order's own contracts), never more and never above
the verdict; the floor rules hold as everywhere (one that doesn't fit the
cap is the floor stretch's, else a skip). The size translation, the gate
and the attempt simulator and backtester apply it (`combine.js`
`nearTarget`, `prop/size-translate.js`), and phase 2's `target` cut reads
the same band (`prop/phase2-cut.js`). `off` turns it off.

**The entry rule.** `entry` (`scripts/lib/trading/entry-rule.js`) holds
the owner's top-down flow on a composed entry ("We stick to our top down
flow - htf bias, location, setup, entry, stop and target"; "never trade
against the HTF bias"), checked by the reads checker on the cycle bar's
briefing, so `compose_check` says NOT OK and the gate's `[composed-reads]`
re-check refuses the same entry; any other entry under the policy (one
not on a compose record) is checked on the briefing by the gate's
`[entry-rule]`, so no entry route skips it. Every key is stated; `off` is no check,
and with every key off an entry is checked as before (the trend rule, D2):

- `bias_frames` (a list of 4h and/or 1h, highest first, e.g. `[4h, 1h]`; never the 15m): the first listed
  frame that trends is the bias and the side must be its way; no listed
  frame may trend against the side (the 15m never stands in against the
  1h); none trending is no bias, so no entry. The frames are this file's,
  never the model's pick.
- `bias_agree` (with `bias_frames` listed), strictest first: `on`: every
  listed frame must trend the side's way, so a long needs the 4h and the
  1h both up and a short both down; a range, a trend against, or a trend
  the briefing doesn't hold on either is no trade. `off`: `bias_frames` as
  above. `neutral-15m-declared` (BG): when the 4h or the 1h trends, the
  side is the way of every one that trends and neither trends against it;
  when both range, the side is the 15m trend's way, and only when the
  "Trend declared?" facts read declared for that side (the `m3` regime
  with the side, and the close past the RTH VWAP, the EMA20 and the RTH
  open its way, each above 0 ATR; the overnight range is not part of it).
  A trend, a 15m trend or declared facts the briefing doesn't hold: no
  trade.
  With `on` or `neutral-15m-declared`, a composed plan's setup is the 15m or higher (the owner's
  "Yes enforce 15min setup", 2026-10-29: the 4h and 1h set the side, the
  15m holds the setup the side's way, the 3m only times the entry): a TRUE
  setup read pointing the side on the 15m, 1h or 4h, else NOT OK. Stated
  exemption: a cited setup's `fired` read (`momentum_continuation`: its
  setup is the prevailing HTF trend plus its momentum candle). The 15m
  trend itself may still run against the side (a 15m pullback).
- `regime_against: on`: no entry while the `m3` regime (`regime.js`, the
  `trend-vs-range` skill's) trends against the side.
- `leg_turned: on`: while the `m3` regime doesn't trend the side's way, the
  reads must state the leg turned back: a true `3m choch`, `3m bos` or
  `3m compression break` the side's way (`pullback-vs-reversal`).

A fact a key on needs and the briefing lacks refuses (it only ever refuses
more). `bias_frames: [4h, 1h]` is the owner's call (2026-10-29: "We should
be using HTF bias, so our trades should be aligned with the 1h and 4h HTF
trend"; "Don't counter trade against the prevailing trend"), and
`bias_agree: neutral-15m-declared` the owner's pick (2026-10-29: "Fix it
accordingly while thinking like a quant") from the pre-registered
alignment study (six bias rules by two timings, on the same census; split
at 2022-11-23, chosen on the first half, confirmed on the second; 30-session
real-start attempts, 0 blows required). The strict `on` was the worst bias
cell: on the census plans (B0) it took 0.33 trades a weekday, a 47.4%
false-start share, +0.014R a trade and a 2.4% pass on the first half, then
43.8%, -0.177R and 0% on the second, catching 1.6% and 1.9% of the big
legs' R. `neutral-15m-declared` on the same plans: 0.94 trades a
weekday, 42.6%, +0.180R and a 7.9% pass, then 1.01, 40.2% (-3.6 pp,
interval -9.3 to +2.5), -0.032R (+0.145 over strict, interval -0.110 to
+0.415) and 0.3%, catching 7.0% and 8.2%; on the momentum candidates
(S2), 10.1% then 7.3% pass against strict's 1.3% and 0%, false starts
+1.1 pp then -3.3 pp (interval -7.5 to +0.5). 0 blows in every cell. By
its own pre-registered test the second half confirms it on S2, not on B0
(B0's false-start interval reaches +2.5 pp, past the +2 pp bound): the
rule trades two to three times as often for no measured rise in false starts,
which is what the pass rate needs, not a proven per-trade edge. Any trend
against the side still refuses, so every D2 reversal against the 4h or
the 1h stays refused. `on` stays available. The trail target
(`target trail`) still needs the 4h and the 1h both the side's way; an
entry the looser rule adds names its target level. `regime_against` and
`leg_turned` stay `off`. Exits, protective stops and stop moves are never
checked by it.

Measured on the practice-train setup census (the standard plans today's
gate takes, 2021-04 to 2024-06, the decision bar's briefing rebuilt; split
at 2022-11-23, chosen on the first half, confirmed on the second,
pre-registered), with the hybrid exit, per trade and in the 30-session
combine (real starts, one position at a time): today 0.023R / 18.7% pass,
then 0.000R / 10.8%. Only trends the side's way: 20% of the trades,
-0.007R / 0% pass, then +0.046R / 10.3%. `regime_against` with
`leg_turned`: 54% of the trades, 0.022R / 5.7%, then +0.038R (+0.038
over today, interval +0.004 to +0.074) / 8.4%. `bias_frames: [4h, 1h]`: 66%, 0.011R / 13.0%,
then -0.033R / 1.6%. The 1h not against: 96%, no change either half.
No filter raised the pass rate on either half (fewer trades make fewer
passes in 30 sessions); 0 blows everywhere. The regime's effect turned
from cost to gain between the halves: a regime dependence, not an edge.
The census measures standard plans, not the model's choices: the replay
runs' losses against the regime (runs 1 and 3) are the model's.

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
| `policies.prop_portfolio.entry` | the owner's top-down flow (2026-10-27); `bias_frames: [4h, 1h]` the owner's, `bias_agree: neutral-15m-declared` the owner's pick from the alignment study (2026-10-29), not learned | the practice-train census and the alignment study above, two halves (model-free) | not measured | not learned |
| `policies.prop_portfolio.sizing.clock_k` | starting value, not learned; tuned by the 30-day Monte Carlo (phase 2) | not measured | not measured | not learned |
| `policies.prop_portfolio.sizing.min_contracts` | the owner's floor (2026-10-23), not learned | not measured | not measured | not learned |
| `policies.prop_portfolio.sizing.floor_stretch_max_usd` | the owner's stretch (2026-10-24), not learned | not measured | not measured | not learned |

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
