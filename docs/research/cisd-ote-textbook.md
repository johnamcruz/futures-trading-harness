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
