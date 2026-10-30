# The exit trail past the target (pre-registered)

A record of the study behind the rulebook's `target_then_trail` exit
(`accounts/<name>/RULEBOOK.md`, "The exit"; the code is
`scripts/lib/trading/exit-trail.js`).

## The question

The structure trail stands behind the latest confirmed `swing_tf` swing,
and `swingSeries` carries that swing forward, even one confirmed before
the entry. So the `trail_r` fallback (`fellBack`) never fires once the
bars hold a swing: past the target the stop holds at the lock (+0.5R at
the 2R mark with `lock_giveback_r` 1.5) until a 15m swing confirms beyond
it, then trails behind that swing. Is that worse than a fallback that
works, or than the ratchet?

## The arms

- **OFF**: today's code, as above (the ratchet off).
- **Ratchet 1.5** and **ratchet 1.2**: `ratchet: on`, the lock the best R
  reached less a 1.5R or 1.2R giveback.
- **FB-FRESH** and **FB-PROFIT**: two arms in which the `trail_r` fallback
  fires: until a qualifying swing exists, the stop trails 1R behind the best
  price (best − 1R). FB-FRESH: a swing counts only if it was confirmed after
  the entry. FB-PROFIT: a swing counts only if its trail sits beyond the
  lock (+0.5R). In both, the stop never moves back.

## The method

- Entries: 3,954 mechanical BG-chain entries from 2021-05-24, the S2
  (`momentum_continuation`) entries included, each exited under every arm
  by the harness's own `limitOutcome`.
- Monte Carlo: 2,000 paths of 30 sessions on the 100k account.
- Half A chooses, half B confirms. The thresholds, fixed before measuring:
  - half A (rule 2): a pass rate at least 2pp over OFF's;
  - half B: a pass rate at least 1pp over OFF's, blows at most OFF's, and a
    mean R at least OFF's less 0.02R.

## Results

| Arm | Pass A | Pass B | Mean R A | Mean R B | 5R+ runners, raw entries | 5R+ runners, traded stream |
|---|---|---|---|---|---|---|
| OFF | 6.30% | 5.95% | +0.069 | +0.041 | 169 | 57 |
| Ratchet 1.5 | 4.90% | 7.05% | +0.036 | +0.015 | 38 | 17 |
| Ratchet 1.2 | 4.45% | 5.05% | +0.023 | −0.007 | 17 | 5 |
| FB-FRESH | 6.95% | 4.90% | +0.050 | +0.020 | 53 | 21 |
| FB-PROFIT | 2.40% | 5.15% | +0.015 | −0.001 | 6 | 1 |

The raw-entry count is over all 3,954 entries; the traded-stream count is
over the entries the Monte Carlo's attempts actually took. 0 blows in every
arm.

## Decision

Keep OFF. No arm passes half A: the ratchets and FB-PROFIT pass less often
than OFF, and FB-FRESH fails rule 2 (+0.65pp, under the 2pp it needs). Holding
at the lock lets 5R+ trends run (169 runners on the raw entries, 57 on the
traded stream, against at most 53 and 21); the ratchet and the working
fallbacks cut them and lower the mean R on both halves.

## Caveats

- The entries are mechanical, not the model's.
- Fills are on 3m bars.
