# CISD + OTE, textbook vs the old port (pre-registered)

A census of the `cisd_ote` rewrite (version 4: the textbook CISD, the OTE
golden zone of its displacement leg, a completed 3m bounce) against the
version 3 port it replaces, on Train only.

This section (everything above **Results**) was written and committed
before any variant below was evaluated on Train data. The only data touched
before the commit was the fetch itself (bar counts and first and last
timestamps); no rule was evaluated on it.

## The rules (fixed before measuring)

The detector is `scripts/lib/trading/cisd.js` with its default parameters
(`PARAMS`), the zone `scripts/lib/trading/fib.js` `OTE`. In short (the
code and `tests/lib/cisd.test.js` are the exact statement):

- **Run**: at least 2 consecutive opposing completed candles (bearish for a
  bullish CISD); a doji ends a run.
- **CISD**: within 6 candles of the run's end, a completed candle closes
  beyond the open of the run's first candle. The newest qualifying run is
  the reference; a confirmed one is used up.
- **Sweep**: from the run's start to the confirmation, a candle traded
  below a key low at or under the CISD level and a close came back above it
  (bearish: above a key high at or over the level, a close back below).
  Key levels: the prior RTH day's high/low, the overnight high/low (in RTH
  only), the prior 18:00 ET session's high/low, each as it stood then.
- **Leg and zone**: origin = the run's extreme (the sweep extreme) through
  the confirmation; extreme = the far extreme since, extended by later 3m
  bars until the first touch of the zone. Zone = `fib.OTE` of the leg.
- **Entry (the bounce)**: a completed 3m bar after the CISD candle closed,
  that traded in the zone, closes back in the CISD's direction (beyond the
  zone's near edge, or with the trade, its close in the far third of its
  range, inside the zone). One entry per CISD. The backtester fills at the
  next bar's open.
- **Void / expiry**: a 3m close beyond the origin or 5% of the leg beyond
  the zone's far edge voids it; a newer CISD replaces it; it expires 12
  CISD-timeframe candles after the CISD.
- **Stop**: 0.1 x ATR(20) (3m) beyond the origin. **Target**: 2R bracket
  (`risk.min_rr`, no exit block).

## Variants (fixed before measuring)

| Variant | CISD timeframe | Sweep required | Notes |
| --- | --- | --- | --- |
| **N1** | 15m | yes | the shipped `cisd_ote` version 4, as committed |
| N2 | 3m | yes | `cisd_entry(3)`, `cisd_sweep(3) > 0`, `cisd_risk(3)` |
| N3 | 15m | no | N1 without the `cisd_sweep(15) > 0` rule |
| OLD | 12m (port) | no | `cisd_ote` version 3 from `origin/main` at this branch's base, run from that tree |

N1-N3 are the BH set; OLD is the reference, reported beside them, outside
the set. Every variant keeps `mtf: reversal`, `min_rr: 2` and no session
window, as N1.

## Method (fixed before measuring)

- **Data.** MNQ 3-minute bars from the replay broker server, fetched with
  `backtest.js fetch --timeframe 3` per front contract (June 2021 through
  September 2023 contracts, each from its roll to the next), joined raw
  (no back-adjustment), kept only where `scripts/lib/prop/splits.js`
  `roleOf(t).role === 'train'`: 2021-05-02 to 2023-06-30, 26 months. The
  same method as `docs/research/mtf-setup-catalog.md`.
- **Engine.** `scripts/backtest.js` on that file, one variant per run,
  harness rules on (`gate: true`: the entry windows, the loss-streak
  cooldown, the daily limits, end of day at 15:50 ET), 1 contract, entries
  at the next bar's open, the backtester's own costs (1 tick of slippage on
  entries and stops, MNQ fees per side from the contract spec).
- **Outcome.** R after costs per trade: net dollars over the initial risk
  in dollars (stop ticks x $0.50 x 1 contract).
- **Statistics, per variant.** n; mean net R with a 95% day-block bootstrap
  interval (10,000 resamples, seed 20261013); profit factor (net); win rate;
  trades per month; RTH (09:30-16:00 ET entry) vs overnight; long vs short;
  mean R by year. One-sided p for mean net R <= 0 from the same bootstrap,
  (1 + resamples with mean <= 0) / (B + 1); under 30 trades, p = 1.
- **Multiple testing.** Benjamini-Hochberg at q = 0.05 over N1-N3.
- **Survives** when its BH-adjusted p <= 0.05 **and** its interval's lower
  bound is above 0.
- **Prop simulation.** N1 and OLD, and any N variant that survives: the
  combine simulator (`backtest.js --prop`) with a `paper` copy of
  `prop_portfolio` listing only that variant, on the 100K account profile
  with `prop_portfolio`'s rulebook sizing and trail (a policy's trades exit
  by its trail, not the variant's 2R bracket), attempts every 5 trading
  days inside Train: pass, blow and timeout rates.
- **Decision rule.** Nothing here promotes anything: `cisd_ote` stays
  `paper` whatever the result; the owner decides. A variant that survives
  is a candidate for Select, not a finding.

## Results

To be filled in after the census, below this line, without changing
anything above it.

**Verdict: nothing survives, and the textbook version scored worse than
the old port on Train.** No N variant's BH-adjusted p is under 0.05 (all
0.946) and no interval's lower bound is above zero. The textbook
`cisd_ote` (N1) lost -0.113R a trade after costs, against the old port's
-0.001R, and passed no prop attempt, against the port's 8.5%; the 3m-CISD
and no-sweep variants lost too. Shown these results, the owner chose to
replace the port with the textbook version anyway (the definition, not
this score, is the decision). `cisd_ote` stays `paper` until a census and
the owner promote it.

Census run on 247,635 MNQ 3-minute bars (2021-05-02 to 2023-06-30, ten
front contracts joined raw, every bar `train` by `roleOf`), as the method
says. The backtester's data audit flagged 473 missing bars in 109 gaps (the
largest 97 bars, 2022-11-30) and 18 opens more than 8 ATR from the prior
close (the rolls and holiday reopenings); nothing was repaired.

Columns: n trades; mean R after costs with its 95% day-block interval;
profit factor of net dollars (it can exceed 1 while the mean R is
negative: R weighs every trade the same, dollars weigh the wide stops
more); win rate (net > 0); trades per Train month; RTH and overnight
trades with their mean R; long and short; mean R by year; BH-adjusted p
over N1-N3.

| Variant | n | mean net R [95% CI] | PF | win | per month | RTH n / mean | ON n / mean | long n / mean | short n / mean | 2021 / 2022 / 2023 | BH q |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 (shipped) | 277 | -0.113 [-0.253, 0.032] | 1.01 | 34% | 10.7 | 164 / -0.044 | 113 / -0.214 | 117 / -0.010 | 160 / -0.188 | -0.02 / -0.17 / -0.12 | 0.946 |
| N2 (3m CISD) | 466 | -0.097 [-0.211, 0.020] | 0.93 | 32% | 17.9 | 290 / -0.030 | 176 / -0.208 | 217 / -0.138 | 249 / -0.062 | -0.07 / -0.02 / -0.26 | 0.946 |
| N3 (no sweep) | 1793 | -0.038 [-0.098, 0.020] | 0.98 | 34% | 69.0 | 393 / -0.052 | 1400 / -0.035 | 856 / -0.003 | 937 / -0.071 | -0.09 / 0.00 / -0.04 | 0.946 |
| OLD (v3 port, reference) | 1089 | -0.001 [-0.091, 0.090] | 1.03 | 35% | 41.9 | 280 / -0.065 | 809 / 0.021 | 354 / 0.017 | 735 / -0.011 | -0.04 / -0.00 / 0.06 | not in the set |

Exits: N1's trades ended at the 2R target 60 times, at the stop 159 and
at end of day 58 (median stop 34.75 points: the 15m leg's origin is far
from a 3m bounce, so a 2R target is often not reached by 15:50 ET). OLD's
ended on its trail 322 times, at the stop 672 and at end of day 95
(median stop 22.75 points).

### Prop simulation

N1 and OLD (no N variant survived), each as the only strategy of a `paper`
copy of `prop_portfolio` (its rulebook's sizing and trail; the trail, not
the 2R bracket, exits every trade), on the 100K account profile, 106
attempts of 30 sessions starting every 5 trading days in Train (they
overlap, so they are not 106 independent tries):

| Variant | pass | blow | timeout | median sessions to pass | average profit | trades per attempt | expectancy (R) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | 0% (0) | 0% | 100% | - | -$634 | 13.8 | -0.146 |
| OLD | 8.5% (9) | 0% | 91.5% | 9 | $26 | 48.1 | 0.014 |

No blows (the sizing protects the account), and no pass rate near the 40%
the promotion gate asks for.

### What it says, read with care

- The textbook rules trade about a quarter as often as the port (10.7
  against 41.9 a month) and did worse on Train; neither has an edge after
  costs. The port's mean is zero, not positive.
- Requiring the key-level sweep (N1 against N3) cut trades by 85% and did
  not raise the mean: on this definition the sweep is not the filter it
  is taught as. A hypothesis for a next round, not a finding: the sweep
  window (from the run's start) is narrow, and the levels (prior RTH,
  overnight in RTH, prior session) are three of many a trader would use.
- Overnight trades are the worst part of N1 and N2 (-0.21R); RTH alone is
  near zero (N1 -0.044R on 164, N2 -0.030R on 290). Post hoc, with no
  interval or test: where a next round might look, nothing more.
- N1's shorts (-0.19R) did worse than its longs (-0.01R) over a period
  that rose then fell; the code is symmetric (tests/lib/cisd.test.js), so
  this is the sample, not the rules.
