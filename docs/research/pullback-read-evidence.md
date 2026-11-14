# The pullback read: what was measured (2026-11)

The numbers cited by the Evidence line of `pullback-vs-reversal`, in one place. Three read-only studies on real NQ
3m bars (built on the harness at main 70859b515, its own functions: `pullback-read.js`, `structure-events.js`,
`candle-facts.js`, `exit-trail.js`, `replay/trend-capture.js legsOf`), each pre-registered before its outcomes were
computed. Locked in all three and not varied: the strict side (the 4h AND the 1h both trend the side), the
`target_then_trail` exit, the 0.5 x ATR(20) stop, $300 sizing, 09:30-12:00 ET, never counter. Net of 2 ticks a side;
intervals are session-bootstrap 95%. The studies' scripts and outputs are kept outside the repository (no bulk real
data in the repo).

None of this is an edge. The skill teaches the pullback as a read of the present candle; these numbers say what was
measured and what was not.

## 1. Pullback entries (2026-11-13)

On the 1h side (each row also reported for the 4h + 1h side):

- A 15m reversal candle (a hammer or an engulfing) that printed the pullback low, entered at its close: -0.18R a trade
  [-0.43, +0.06] on the 1h side; -0.28R on the 4h + 1h side.
- No pullback entry beat entering with the trend robustly, and none approached the combine's pass math.

## 2. The 15m setup inside the strict side (2026-11-14)

1,336 sessions, 2021-05-17 to 2026-07-20, halves split at 2023-12-14. "% into leg": where the entry sat in the
`legsOf` trend leg (median).

| Entry | n | Net R a trade [95% CI] | % into leg | Price vs VWAP at entry (ATR(14), its way) |
|---|---|---|---|---|
| The 15m break back the side's way (BOS or CHoCH), at the 15m close | 141 | -0.20 [-0.49, +0.12] | 79% | +2.36 |
| The first 3m break back the side's way (BOS or CHoCH) inside the open 15m pullback, within 0.5 ATR(14) of VWAP or EMA20 | 69 | +0.05 [-0.44, +0.69] | 64% | -0.07 |

- The 3m row is not significant, depends on one trade (-0.12R without its best) and decays with entry delay:
  +0.05R at the close, -0.09R one minute late, -0.24R three minutes late.
- It counted the first 3m BOS or CHoCH. A BOS-only timing, a 3m CISD, and either one together with a 15m CISD or a 15m
  reaction at the level were not measured.

## 3. The 15m read inside the strict side: pullback, range or reversal (2026-11-14)

The outcome of each 15m pullback moment over the next hour: resumption (A), range (B) or reversal (C).

- No visible fact at the 15m close separated A from B or C beyond where price sits in the leg (its depth, and the
  distance to the extreme and to the origin in 15m ATR). A model on that geometry alone: AUC 0.78 (A vs B) and 0.90
  (A vs C) on the second half; adding any single fact changed it by -0.006 to +0.004 (every interval spans 0).
- The 15m regime label inside a pullback: AUC 0.44 for A vs B (below 0.5).
- Candles alone (engulfing, hammer, wick, a two-candle sequence, the reaction at a level, an engulfing at a broken
  level) did not separate A from B or C. The engulfing at a broken level as a trade: n 74, -0.05R (a wick stop) or
  -0.49R (0.5 x ATR(20)), entered 69% into the leg.
- The rising-three / mat-hold shape: 30 moments, 7 trades in five years: too few to test.

## 4. Elsewhere in the repository

- Depth alone (buying a 50% or 62% retrace with the 4h trend) lost after costs: `docs/research/mtf-setup-catalog.md`,
  F5.
- A limit back at the broken level earned less than the setup's own entry on both halves and missed the best runners:
  `docs/research/retest-entry-study.md`.
