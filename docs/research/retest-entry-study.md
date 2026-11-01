# Entering on a retest after the setup (pre-registered)

A record of the study behind the `breakout` skill's evidence line: after a
15m setup on the bias's side, does waiting for a pullback or a retest of
the setup's level beat entering at the setup?

## The setup

- 563 BG-side 15m setups (a CHoCH, a BOS or a CISD) from 2021-05-24, in the
  09:35 to 12:00 ET window: 284 on half A, 279 on half B.
- The stop is locked in every arm: compose's stop, a tick beyond the setup
  candle's far side.
- The exit is the shipped `target_then_trail`, through the harness's own
  `limitOutcome`.
- One position at a time per stream. Monte Carlo: 2,000 paths of 30 sessions
  on the 100k account.

## The arms

- **E0**: at the setup, on the next 3m bar (the entry when the study ran; the shipped entry is
  now a limit at the setup's close: Caveats).
- **E1**: a limit at the broken level, resting for 10 3m bars.
- **E2**: a limit at 50% of the setup candle's range.
- **E3**: a limit at the 62% retracement (OTE).
- **E4**: retest and hold. Price trades back to the level, then a 3m bar
  closes back on the side's side of it (added by amendment before any
  result).

A limit fills only on a bar that trades a tick through it. A setup whose
limit never fills is a miss, scored 0R.

## Results

| Arm | Total R per setup offered, A | B | Fill rate, A |
|---|---|---|---|
| E0 | +0.126 | +0.025 | 100% |
| E1 | +0.064 | −0.069 | 68% |
| E2 | +0.039 | −0.128 | 65% |
| E3 | −0.024 | −0.085 | 54% |
| E4 | +0.007 | −0.040 | 33% |

- Every retest arm earned less than E0 on both halves.
- The setups the limits (E1 to E3) missed averaged +0.66R to +0.92R under
  E0. The breakouts that never came back were the best ones.
- Blows: 0 in every arm.

## Decision

No arm passes the pre-registered rule (half A: a pass rate 2pp over E0's
and a total R at least E0's). Keep the taught entry: the 15m setup is the
entry, shipped as a limit at the setup's close (Caveats). A retest that
holds is support, never a wait.

## Caveats

- Limit fills are optimistic (no queue position).
- E0 was scored as a market-like fill at the next 3m bar. The live compose
  entry is a limit at the setup bar's close, which fills only if a later bar
  trades back to it within the record's `valid_bars`.
- The setups are mechanical, not the model's.
