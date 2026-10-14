# Multi-timeframe setup catalog (pre-registered)

A research catalog: setups shaped the way a trader reads the market top-down
(a higher-timeframe **bias**, a mid-timeframe **location** or pullback, a
lower-timeframe **trigger**), built only from concepts the harness's skills
already teach, written as exact rules, and measured once on Train.

This section (everything above **Results**) was written and committed
before any of these rules was evaluated on data. The only data touched
before the commit was a four-day plumbing check of the fetch (MNQ, 3-minute
bars, May 3-7, 2021, a Train week): no rule was evaluated on it, and the
file was deleted.

Out of scope, being built on another branch, so not repeated here: a 1-hour
trend with a 15-minute pullback and a 3-minute entry (`trend_pullback`), and
a 15-minute trend with a 5-minute pullback and a 1-minute entry.

## Method (fixed before measuring)

- **Data.** MNQ 3-minute bars from the replay broker server, fetched with
  `backtest.js fetch --timeframe 3`, one fetch per front contract (June 2021
  through September 2023 contracts, each from its roll to the next, the
  Thursday eight days before the third Friday of the expiry month), each
  with `FTH_BROKER` set to the replay server, a fresh run id and a fresh
  temporary harness home, and the replay clock (`FTH_REPLAY_NOW`,
  `BACKTESTER_NOW`) at the chunk's end. The chunks are joined into one
  raw front-contract series (no back-adjustment, as
  `docs/LEARNED-RULEBOOK.md` section 4 prescribes). The higher timeframes
  (15 minutes, 1 hour, 4 hours) are built from the 3-minute bars by the
  rules language itself (`htf_*`, `htfc_*`, `mtf_bias`), causally.
- **Months.** Train only: 2021-05 to 2023-06, every month confirmed
  `train` by `scripts/lib/prop/splits.js` `roleOf`. No Select,
  Out-of-sample or Recent month is read.
- **Engine.** `scripts/backtest.js` on that file, one variant per run (so
  variants never compete for the one position), harness rules on
  (`gate: true`: the trend rule for `mtf: trend` variants, the entry
  windows, the loss-streak cooldown, the daily limits, end of day at 15:50
  ET), 1 contract, entries at the next bar's open, the backtester's own
  costs (1 tick of slippage on entries and stops, MNQ fees per side from
  the contract spec).
- **Outcome.** R after costs per trade: the trade's net dollars (fees and
  slippage included) over its initial risk in dollars (stop distance in
  ticks x $0.50 x 1 contract).
- **Statistics, per variant.** n, mean net R with a 95% day-block bootstrap
  interval (trading days resampled with replacement, 10,000 resamples,
  seed 20261013), profit factor (net), win rate (net > 0), trades per
  month, RTH (09:30-16:00 ET entry) vs overnight, and by year. One-sided
  p-value for mean net R <= 0 from the same bootstrap
  ((1 + resamples with mean <= 0) / (B + 1)).
- **Multiple testing.** Benjamini-Hochberg at q = 0.05 over all 27
  variants below (every variant counts, whether it trades or not; one with
  fewer than 30 trades gets p = 1).
- **Survives** when its BH-adjusted p is <= 0.05 **and** its interval's
  lower bound is above 0. Reported beside it, as `docs/LEARNED-RULEBOOK.md`
  R12 asks: whether the mean has the same sign in every year.
- **Prop simulation** for the top 3 variants by the interval's lower bound
  (whether or not they survive): the existing combine simulator
  (`scripts/lib/prop/challenge.js`, through `backtest.js --prop`) with a
  `paper` policy strategy listing only that variant, on the bundled 100K
  account profile, with `prop_portfolio`'s sizing and its 2R / 0.5R trail
  (a policy's trades exit by its trail; this is the simulator as it
  exists), attempts starting every 5 trading days inside Train: pass, blow
  and timeout rates.
- **Reference, outside the BH set.** The shipped `crt_1h` strategy, run
  the same way on the same file, reported beside family F1.

## The families, ranked by how directly they follow from the skills

| Rank | Family | Bias | Location | Trigger | Style |
| --- | --- | --- | --- | --- | --- |
| 1 | F1 1h liquidity sweep and reversal (owner's) | 4h not with the sweep (variant C) | the hour trades beyond the previous hour's high or low | 3m close back inside, or a 3m structure shift | reversal |
| 2 | F7 Session-level sweep with the 1h bias | 1h (or 4h) trend | sweep of the overnight or prior-day low (high) | 3m close back above with a 3m shift | trend |
| 3 | F3 1h trend, VWAP pullback | 1h trend | pullback to RTH (or session) VWAP | 3m shift back with the trend | trend |
| 4 | F4 4h bias, value-area reentry | 4h trend | dip below the prior day's VAL (above VAH), two closes back inside | the second close inside | trend |
| 5 | F9 Break and retest of a higher-timeframe level | 1h trend | a prior-day, overnight or value-area level broken, then retested | 3m shift off the retest | trend |
| 6 | F6 Higher-timeframe sweep plus CISD/OTE | the hour (or 4h) sweeping a level | the CISD/OTE zone | the `cisd_ote` detector's entry | reversal |
| 7 | F2 4h CRT, 15m reclaim, 3m shift | the 4h candle raiding the previous one | a 15m candle that swept and closed back inside | 3m shift | reversal |
| 8 | F5 4h bias, 1h OTE or discount | 4h trend | retrace into 62% (or 50%) of the last 8-hour leg | 3m shift | trend |
| 9 | F8 4h and 1h bias, initial-balance break | 4h (and 1h) trend | the initial balance's edge | 3m close through it, or a retest | trend |

27 variants (3 per family). Every rule below is in the rules language
(`scripts/lib/trading/rules.js`); `htf_*(m)` and `mtf_bias(m)` read only
completed m-minute candles, `htfc_*(m)` the candle in progress up to and
including the signal bar, and every other series only bars up to the
signal bar. Entries fill at the next bar's open. The full YAML of every
variant, both sides, is in the appendix; the text below gives the long
side (the short side is its mirror).

Common pieces:

- **3m shift** (market-structure: a close beyond recent structure):
  `close crosses_above highest(3)[1]` (or `highest(5)[1]` where stated).
- **Structural stop**: the distance from the signal close to the
  structure that invalidates the idea, plus 0.25 x ATR(20)
  (market-structure step 5: "beyond that swing plus a buffer"). Rules keep
  it between 0.5 and 3 ATR (`<dist> >= 0.25 * atr(20)` and
  `<dist> <= 2.75 * atr(20)`), so a one-tick stop never makes an outsized R.
- **Room**: where a family targets a level, a rule requires the level to
  be at least k x the stop away (strategy-library priority order, step 3).

### F1. 1h liquidity sweep and reversal (rank 1, the owner's family)

- **Rationale.** liquidity-concepts: "Sweep: price trades through the level
  and closes back inside within 1-3 bars ... Stops were taken; often
  reverses", and "reversal setups need a sweep first"; market-structure: a
  CHoCH (the first close beyond structure against the move) is the early
  reversal sign; multi-timeframe-analysis step 4: a reversal is judged
  against the timeframe above its range candle (for an hourly range, the
  4-hour).
- **Bias** (variant C only): `mtf_bias(240) >= 0` for a long (the 4-hour
  is not down, i.e. not with the sweep of a low).
- **Location**: the hour in progress has traded below the previous
  completed hour's low: `htfc_low(60) < htf_low(60)`.
- **Trigger**: A and B: a 3m close back above the level, on the bar that
  closed below it or wicked through it (`close > htf_low(60)`, and
  `close[1] <= htf_low(60)` or `low <= htf_low(60)`). C: a 3m structure
  shift back above while above the level (`close crosses_above
  highest(5)[1]`, `close > htf_low(60)`).
- **Stop**: below the sweep's extreme plus 0.25 ATR:
  `close - htfc_low(60) + 0.25 * atr(20)`.
- **Target**: A and C: the opposite side of the previous hour's range,
  `htf_high(60) - close`, required to be at least 1.5R; B: 2R. Time stop
  40 bars (2 hours).
- **Variants**: A reclaim, far-side target; B reclaim, 2R; C structure
  shift with the 4h filter, far-side target.
- **How it differs from `crt_1h`.** `crt_1h` is a detector
  (`scripts/lib/trading/crt.js`): it requires the previous hour's range to
  be at least 3 ATR, the sweep to go at most half that range beyond it and
  to be at most 10 bars old, a shift beyond the 5-bar extreme, 2R to the
  far side, one setup per candle, and 08:00-15:30 ET only. F1 drops the
  range-size, depth, age and one-per-candle conditions, trades the whole
  session, takes the first close back inside (A, B) rather than a shift,
  and lets the target be 1.5R (A, C) or a fixed 2R (B).
- **1-minute variant.** Not run: it needs a second fetch of every Train
  month at 1 minute (about three times the 3-minute data), and the 1-minute
  trigger is a different claim; it is listed for a later round.

### F7. Session-level sweep with the higher-timeframe bias (rank 2)

- **Rationale.** liquidity-concepts: the prior day's and overnight highs
  and lows are where stops rest, and a sweep "often reverses";
  `crt_1h`'s own context section: "a raid of the hourly low while the
  4-hour trend is up ... is the A setup: the raid is the pullback, and the
  target is with the trend"; multi-timeframe-analysis: with-trend setups
  after a pullback, "wait for the trigger timeframe to turn back (a shift,
  a reclaim)".
- **Bias**: `mtf_bias(60) > 0` (A, B) or `mtf_bias(240) > 0` (C).
- **Location**: the last five 3m bars traded below the overnight low (A, C:
  `lowest(5) < overnight_low`) or the prior RTH day's low (B:
  `lowest(5) < prior_low`), and the close is back above it.
- **Trigger**: 3m shift, `close crosses_above highest(3)[1]`.
- **Stop**: `close - lowest(5) + 0.25 * atr(20)`. **Target**: 2R, time stop
  40 bars.
- **Sessions**: A and C 09:35-11:30 ET (the opening drive, session-timing),
  B 09:35-15:00 ET.

### F3. 1h trend with a VWAP pullback (rank 3)

- **Rationale.** vwap-volume-profile: "Price above a rising RTH VWAP, with
  pullbacks holding it: buyers in control; buy pullbacks to VWAP";
  multi-timeframe-analysis: the 1-hour is the bias timeframe.
- **Bias**: `mtf_bias(60) > 0`; B adds `mtf_bias(240) >= 0` and a rising
  VWAP, `vwap_rth > vwap_rth[10]`.
- **Location**: a pullback that touched VWAP in the last five bars and held
  it: `lowest(5) <= vwap_rth`, `close > vwap_rth` (C: `vwap_session`).
- **Trigger**: 3m shift, `close crosses_above highest(3)[1]`.
- **Stop**: `close - lowest(5) + 0.25 * atr(20)`. **Target**: 2R, time stop
  40 bars.
- **Sessions**: A, B 10:00-15:00 ET (RTH VWAP needs half an hour to mean
  something, as `vwap_reclaim` holds); C the whole session with the
  session VWAP.

### F4. 4h bias with a value-area reentry (rank 4)

- **Rationale.** vwap-volume-profile: "Open outside the prior value area,
  then back inside for two closes: rotation to the far side is likely (the
  80% rule)"; here the reentry is taken only with the 4-hour bias, so the
  rotation runs with the higher timeframe (multi-timeframe-analysis:
  "levels flow down").
- **Bias**: `mtf_bias(240) > 0`; C adds `mtf_bias(60) > 0`.
- **Location**: a dip below the prior RTH day's VAL in the last ten bars
  (`lowest(10) < prior_val`), between 09:35 and 15:00 ET, still below the
  POC (`close < prior_poc`).
- **Trigger**: the second 3m close back inside, completed on this bar:
  `close > prior_val`, `close[1] > prior_val`, `close[2] <= prior_val`.
- **Stop**: `close - lowest(10) + 0.25 * atr(20)` (at most 3 ATR).
- **Target**: A, C: the far side of value, `prior_vah - close`, at least 2R;
  B: the POC, `prior_poc - close`, at least 1.5R. Time stop 80 bars.

### F9. Break and retest of a higher-timeframe level (rank 5)

- **Rationale.** liquidity-concepts: "Break: a candle closes beyond the
  level and the next pullback holds it (old resistance becomes support).
  Continuation"; multi-timeframe-analysis step 5: the daily and session
  levels flow down to the trigger timeframe. The continuation twin of F7.
- **Bias**: `mtf_bias(60) > 0`.
- **Location**: a level L (A the prior RTH day's high `prior_high`, B the
  overnight high `overnight_high`, C the prior day's VAH `prior_vah`)
  broken: some close 3 to 10 bars ago above L (an `any` of
  `close[3] > L` ... `close[10] > L`); retested: `lowest(10) <= L`; held:
  `lowest(10) >= L - 0.5 * atr(20)` and `close > L`.
- **Trigger**: 3m shift, `close crosses_above highest(3)[1]`.
- **Stop**: `close - lowest(10) + 0.25 * atr(20)`. **Target**: 2R, time stop
  40 bars. **Sessions**: 09:35-15:00 ET.

### F6. Higher-timeframe sweep plus CISD/OTE (rank 6)

- **Rationale.** liquidity-concepts: "Reversal setups (cisd_ote strategy)
  need a sweep first"; `cisd_ote`'s own "When to Use": after a sweep of a
  liquidity pool, when price displaces the other way. The owner's example
  "1h CRT sweep, 15m CISD, 3m OTE": the shipped detector's displacement is
  on its 12-minute zone timeframe and its entry the OTE pullback on 3m, so
  the 1-hour sweep is the added context.
- **Bias / location**: the hour (A, C) or the 4-hour candle (B) in progress
  has swept the previous one's low: `htfc_low(60) < htf_low(60)`
  (`htfc_low(240) < htf_low(240)`); C adds `mtf_bias(240) >= 0`.
- **Trigger**: `cisd_ote_dir > 0` (the shipped detector).
- **Stop**: `cisd_ote_risk`. **Exit**: `cisd_ote`'s own, the 2R / 0.5R trail.

### F2. 4h CRT with a 15m reclaim and a 3m shift (rank 7)

- **Rationale.** `crt_4h` (Candle Range Theory on the 4-hour candle) and
  multi-timeframe-analysis's top-down read: the 4-hour raid is the bias
  event, a 15-minute candle that swept the level and closed back inside is
  the mid-timeframe confirmation, a 3m shift the entry.
- **Location**: `htfc_low(240) < htf_low(240)`; the last completed 15m
  candle swept and closed back inside: `htf_low(15) < htf_low(240)`,
  `htf_close(15) > htf_low(240)`; `close > htf_low(240)`.
- **Trigger**: `close crosses_above highest(5)[1]`.
- **Stop**: `close - htfc_low(240) + 0.25 * atr(20)` (at most 5 ATR).
- **Target**: A, C the far side of the previous 4-hour candle,
  `htf_high(240) - close`, at least 2R; B 2R. C adds `mtf_bias(240) >= 0`.
  Time stop 80 bars.

### F5. 4h bias with a 1h OTE or discount pullback (rank 8)

- **Rationale.** market-structure step 4: "Within a trend, buy pullbacks
  into discount (below 50% of the dealing range)"; `cisd_ote`'s optimal
  trade entry: a retrace into the 0.62-0.79 zone of the leg. The dealing
  range is the last 160 3m bars (8 hours: an hourly-scale leg).
- **Bias**: `mtf_bias(240) > 0`; C adds `mtf_bias(60) > 0`.
- **Location**: a real leg (`highest(160) - lowest(160) >= 6 * atr(20)`)
  whose high is at least 10 bars old (`highest(10) < highest(160)`), a
  pullback that didn't break the leg's low (`lowest(10) > lowest(160)`)
  and reached 62% of it (A, C: `lowest(10) <= 0.38 * highest(160) + 0.62 *
  lowest(160)`) or 50% (B).
- **Trigger**: `close crosses_above highest(3)[1]`.
- **Stop**: `close - lowest(10) + 0.25 * atr(20)`. **Target**: the leg's high,
  `highest(160) - close`, at least 2R. Time stop 80 bars.

### F8. 4h and 1h bias with an initial-balance break (rank 9)

- **Rationale.** session-timing: the opening drive and the initial balance
  (09:30-10:30 ET) set the day's first range; liquidity-concepts: a close
  beyond a level is a break, and a retest that holds confirms it;
  vwap-volume-profile: a breakout bar needs participation.
- **Bias**: `mtf_bias(240) > 0` and `mtf_bias(60) > 0` (C: the 4-hour only).
- **Location / trigger**: from 10:30 to 15:00 ET. A, C: a 3m close through
  the IB high (`close crosses_above ib_high`) on above-average volume
  (`volume > vol_sma(20)`), at most 0.5 ATR past it. B: the retest, a close
  above the IB high whose last five bars touched it and held within 0.5
  ATR, and a 3m shift.
- **Stop**: A, C `close - ib_high + 0.5 * atr(20)`; B
  `close - lowest(5) + 0.25 * atr(20)`. **Target**: 2R, time stop 40 bars.

## What the rules language can't yet express

Each gap below was met with an approximation in the variants above, or
left out:

1. **Order of events.** "A sweep, then a shift, then a pullback" has no
   sequence operator or "bars since" function. Windows (`lowest(10)`) and
   look-backs (`close[3]`) approximate it; they can't say the leg's low
   came before its high (F5), or that the sweep came before the reclaim
   (F2's 15m candle).
2. **Higher-timeframe indicators.** Only the previous candle's OHLC
   (`htf_*`) and the trend vote (`mtf_bias`) exist on 15m, 1h and 4h: no
   15m EMA, ATR, swing points, or the candle two back. A 15m EMA20 pullback
   can only be approximated by a 3m EMA100.
3. **Swing points above the trigger timeframe.** `swing_high` and
   `swing_low` are on the strategy's own bars only, so a 1-hour dealing
   range (premium/discount, OTE) is approximated by a rolling 160-bar
   high and low.
4. **CISD on a chosen timeframe.** `cisd_ote_dir` is fixed to the source
   bot's 12-minute zone; a 15m CISD (the owner's example) can't be named.
   A true CISD (a close beyond the open of the last opposing run of
   candles) has no rule either; a 3m close beyond the 3- or 5-bar extreme
   stands in for it.
5. **Fair value gaps.** No FVG series (liquidity-concepts teaches them).
6. **Daily bias.** `mtf_bias(1440)` parses, but the trend read keeps 240
   hours of candles, so a daily trend never gets its EMA votes; the daily
   context of `crt_4h` can't be a rule.
7. **Min and max.** No `min()`/`max()`, so a stop of "the larger of the
   structure and 0.5 ATR" becomes two bounding conditions instead.
8. **Equal highs and lows, round numbers, weekly levels.** Liquidity pools
   the skills name, with no series.
9. **Relative volume by time of day.** The skill's relative volume is
   against the same time of day; `vol_sma(n)` is the last n bars.
10. **One trade per setup.** A rule can't remember it already fired for this
    sweep; the engine's one position at a time and the daily limits are the
    only brake (crt_1h's detector has one per candle built in).

## Results

To be filled in after the census, below this line, without changing
anything above it.

## Appendix: every variant's rules

Generated from one source so the long and short sides mirror exactly.
Every variant is `timeframe: 3m`, `instruments: [MNQ]`, `signal: rules`,
`status: paper`; `mtf: reversal` where shown, otherwise the trend rule
applies.

### F1A `mtf_f1a_sweep1h`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(60) < htf_low(60)
    - close > htf_low(60)
    - any:
        - close[1] <= htf_low(60)
        - low <= htf_low(60)
    - close - htfc_low(60) >= 0.25 * atr(20)
    - close - htfc_low(60) <= 2.75 * atr(20)
    - htf_high(60) - close >= 1.5 * close - 1.5 * htfc_low(60) + 0.375 * atr(20)
  short:
    - htfc_high(60) > htf_high(60)
    - close < htf_high(60)
    - any:
        - close[1] >= htf_high(60)
        - high >= htf_high(60)
    - htfc_high(60) - close >= 0.25 * atr(20)
    - htfc_high(60) - close <= 2.75 * atr(20)
    - close - htf_low(60) >= 1.5 * htfc_high(60) - 1.5 * close + 0.375 * atr(20)
exit:
  target:
    long: htf_high(60) - close
    short: close - htf_low(60)
  max_bars: 40
risk:
  stop:
    long: close - htfc_low(60) + 0.25 * atr(20)
    short: htfc_high(60) - close + 0.25 * atr(20)
  min_rr: 1.5
```

### F1B `mtf_f1b_sweep1h`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(60) < htf_low(60)
    - close > htf_low(60)
    - any:
        - close[1] <= htf_low(60)
        - low <= htf_low(60)
    - close - htfc_low(60) >= 0.25 * atr(20)
    - close - htfc_low(60) <= 2.75 * atr(20)
  short:
    - htfc_high(60) > htf_high(60)
    - close < htf_high(60)
    - any:
        - close[1] >= htf_high(60)
        - high >= htf_high(60)
    - htfc_high(60) - close >= 0.25 * atr(20)
    - htfc_high(60) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - htfc_low(60) + 0.25 * atr(20)
    short: htfc_high(60) - close + 0.25 * atr(20)
  min_rr: 2
```

### F1C `mtf_f1c_sweep1h`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(60) < htf_low(60)
    - close > htf_low(60)
    - close crosses_above highest(5)[1]
    - mtf_bias(240) >= 0
    - close - htfc_low(60) >= 0.25 * atr(20)
    - close - htfc_low(60) <= 2.75 * atr(20)
    - htf_high(60) - close >= 1.5 * close - 1.5 * htfc_low(60) + 0.375 * atr(20)
  short:
    - htfc_high(60) > htf_high(60)
    - close < htf_high(60)
    - close crosses_below lowest(5)[1]
    - mtf_bias(240) <= 0
    - htfc_high(60) - close >= 0.25 * atr(20)
    - htfc_high(60) - close <= 2.75 * atr(20)
    - close - htf_low(60) >= 1.5 * htfc_high(60) - 1.5 * close + 0.375 * atr(20)
exit:
  target:
    long: htf_high(60) - close
    short: close - htf_low(60)
  max_bars: 40
risk:
  stop:
    long: close - htfc_low(60) + 0.25 * atr(20)
    short: htfc_high(60) - close + 0.25 * atr(20)
  min_rr: 1.5
```

### F2A `mtf_f2a_crt4h15`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(240) < htf_low(240)
    - htf_low(15) < htf_low(240)
    - htf_close(15) > htf_low(240)
    - close > htf_low(240)
    - close crosses_above highest(5)[1]
    - close - htfc_low(240) >= 0.25 * atr(20)
    - close - htfc_low(240) <= 4.75 * atr(20)
    - htf_high(240) - close >= 2 * close - 2 * htfc_low(240) + 0.5 * atr(20)
  short:
    - htfc_high(240) > htf_high(240)
    - htf_high(15) > htf_high(240)
    - htf_close(15) < htf_high(240)
    - close < htf_high(240)
    - close crosses_below lowest(5)[1]
    - htfc_high(240) - close >= 0.25 * atr(20)
    - htfc_high(240) - close <= 4.75 * atr(20)
    - close - htf_low(240) >= 2 * htfc_high(240) - 2 * close + 0.5 * atr(20)
exit:
  target:
    long: htf_high(240) - close
    short: close - htf_low(240)
  max_bars: 80
risk:
  stop:
    long: close - htfc_low(240) + 0.25 * atr(20)
    short: htfc_high(240) - close + 0.25 * atr(20)
  min_rr: 2
```

### F2B `mtf_f2b_crt4h15`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(240) < htf_low(240)
    - htf_low(15) < htf_low(240)
    - htf_close(15) > htf_low(240)
    - close > htf_low(240)
    - close crosses_above highest(5)[1]
    - close - htfc_low(240) >= 0.25 * atr(20)
    - close - htfc_low(240) <= 4.75 * atr(20)
  short:
    - htfc_high(240) > htf_high(240)
    - htf_high(15) > htf_high(240)
    - htf_close(15) < htf_high(240)
    - close < htf_high(240)
    - close crosses_below lowest(5)[1]
    - htfc_high(240) - close >= 0.25 * atr(20)
    - htfc_high(240) - close <= 4.75 * atr(20)
exit:
  target_r: 2
  max_bars: 80
risk:
  stop:
    long: close - htfc_low(240) + 0.25 * atr(20)
    short: htfc_high(240) - close + 0.25 * atr(20)
  min_rr: 2
```

### F2C `mtf_f2c_crt4h15`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(240) < htf_low(240)
    - htf_low(15) < htf_low(240)
    - htf_close(15) > htf_low(240)
    - close > htf_low(240)
    - close crosses_above highest(5)[1]
    - close - htfc_low(240) >= 0.25 * atr(20)
    - close - htfc_low(240) <= 4.75 * atr(20)
    - htf_high(240) - close >= 2 * close - 2 * htfc_low(240) + 0.5 * atr(20)
    - mtf_bias(240) >= 0
  short:
    - htfc_high(240) > htf_high(240)
    - htf_high(15) > htf_high(240)
    - htf_close(15) < htf_high(240)
    - close < htf_high(240)
    - close crosses_below lowest(5)[1]
    - htfc_high(240) - close >= 0.25 * atr(20)
    - htfc_high(240) - close <= 4.75 * atr(20)
    - close - htf_low(240) >= 2 * htfc_high(240) - 2 * close + 0.5 * atr(20)
    - mtf_bias(240) <= 0
exit:
  target:
    long: htf_high(240) - close
    short: close - htf_low(240)
  max_bars: 80
risk:
  stop:
    long: close - htfc_low(240) + 0.25 * atr(20)
    short: htfc_high(240) - close + 0.25 * atr(20)
  min_rr: 2
```

### F3A `mtf_f3a_vwappb`

```yaml
sessions: ["10:00-15:00@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - lowest(5) <= vwap_rth
    - close > vwap_rth
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - highest(5) >= vwap_rth
    - close < vwap_rth
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F3B `mtf_f3b_vwappb`

```yaml
sessions: ["10:00-15:00@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - lowest(5) <= vwap_rth
    - close > vwap_rth
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
    - vwap_rth > vwap_rth[10]
    - mtf_bias(240) >= 0
  short:
    - mtf_bias(60) < 0
    - highest(5) >= vwap_rth
    - close < vwap_rth
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
    - vwap_rth < vwap_rth[10]
    - mtf_bias(240) <= 0
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F3C `mtf_f3c_vwappb`

```yaml
rules:
  long:
    - mtf_bias(60) > 0
    - lowest(5) <= vwap_session
    - close > vwap_session
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - highest(5) >= vwap_session
    - close < vwap_session
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F4A `mtf_f4a_vare4h`

```yaml
rules:
  long:
    - mtf_bias(240) > 0
    - minute_et >= 575
    - minute_et < 900
    - lowest(10) < prior_val
    - close > prior_val
    - close[1] > prior_val
    - close[2] <= prior_val
    - close < prior_poc
    - close - lowest(10) <= 2.75 * atr(20)
    - prior_vah - close >= 2 * close - 2 * lowest(10) + 0.5 * atr(20)
  short:
    - mtf_bias(240) < 0
    - minute_et >= 575
    - minute_et < 900
    - highest(10) > prior_vah
    - close < prior_vah
    - close[1] < prior_vah
    - close[2] >= prior_vah
    - close > prior_poc
    - highest(10) - close <= 2.75 * atr(20)
    - close - prior_val >= 2 * highest(10) - 2 * close + 0.5 * atr(20)
exit:
  target:
    long: prior_vah - close
    short: close - prior_val
  max_bars: 80
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F4B `mtf_f4b_vare4h`

```yaml
rules:
  long:
    - mtf_bias(240) > 0
    - minute_et >= 575
    - minute_et < 900
    - lowest(10) < prior_val
    - close > prior_val
    - close[1] > prior_val
    - close[2] <= prior_val
    - close < prior_poc
    - close - lowest(10) <= 2.75 * atr(20)
    - prior_poc - close >= 1.5 * close - 1.5 * lowest(10) + 0.375 * atr(20)
  short:
    - mtf_bias(240) < 0
    - minute_et >= 575
    - minute_et < 900
    - highest(10) > prior_vah
    - close < prior_vah
    - close[1] < prior_vah
    - close[2] >= prior_vah
    - close > prior_poc
    - highest(10) - close <= 2.75 * atr(20)
    - close - prior_poc >= 1.5 * highest(10) - 1.5 * close + 0.375 * atr(20)
exit:
  target:
    long: prior_poc - close
    short: close - prior_poc
  max_bars: 80
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 1.5
```

### F4C `mtf_f4c_vare4h`

```yaml
rules:
  long:
    - mtf_bias(240) > 0
    - minute_et >= 575
    - minute_et < 900
    - lowest(10) < prior_val
    - close > prior_val
    - close[1] > prior_val
    - close[2] <= prior_val
    - close < prior_poc
    - close - lowest(10) <= 2.75 * atr(20)
    - prior_vah - close >= 2 * close - 2 * lowest(10) + 0.5 * atr(20)
    - mtf_bias(60) > 0
  short:
    - mtf_bias(240) < 0
    - minute_et >= 575
    - minute_et < 900
    - highest(10) > prior_vah
    - close < prior_vah
    - close[1] < prior_vah
    - close[2] >= prior_vah
    - close > prior_poc
    - highest(10) - close <= 2.75 * atr(20)
    - close - prior_val >= 2 * highest(10) - 2 * close + 0.5 * atr(20)
    - mtf_bias(60) < 0
exit:
  target:
    long: prior_vah - close
    short: close - prior_val
  max_bars: 80
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F5A `mtf_f5a_ote4h`

```yaml
rules:
  long:
    - mtf_bias(240) > 0
    - highest(160) - lowest(160) >= 6 * atr(20)
    - highest(10) < highest(160)
    - lowest(10) > lowest(160)
    - lowest(10) <= 0.38 * highest(160) + 0.62 * lowest(160)
    - close crosses_above highest(3)[1]
    - close - lowest(10) >= 0.25 * atr(20)
    - close - lowest(10) <= 2.75 * atr(20)
    - highest(160) - close >= 2 * close - 2 * lowest(10) + 0.5 * atr(20)
  short:
    - mtf_bias(240) < 0
    - highest(160) - lowest(160) >= 6 * atr(20)
    - lowest(10) > lowest(160)
    - highest(10) < highest(160)
    - highest(10) >= 0.62 * highest(160) + 0.38 * lowest(160)
    - close crosses_below lowest(3)[1]
    - highest(10) - close >= 0.25 * atr(20)
    - highest(10) - close <= 2.75 * atr(20)
    - close - lowest(160) >= 2 * highest(10) - 2 * close + 0.5 * atr(20)
exit:
  target:
    long: highest(160) - close
    short: close - lowest(160)
  max_bars: 80
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F5B `mtf_f5b_ote4h`

```yaml
rules:
  long:
    - mtf_bias(240) > 0
    - highest(160) - lowest(160) >= 6 * atr(20)
    - highest(10) < highest(160)
    - lowest(10) > lowest(160)
    - lowest(10) <= 0.5 * highest(160) + 0.5 * lowest(160)
    - close crosses_above highest(3)[1]
    - close - lowest(10) >= 0.25 * atr(20)
    - close - lowest(10) <= 2.75 * atr(20)
    - highest(160) - close >= 2 * close - 2 * lowest(10) + 0.5 * atr(20)
  short:
    - mtf_bias(240) < 0
    - highest(160) - lowest(160) >= 6 * atr(20)
    - lowest(10) > lowest(160)
    - highest(10) < highest(160)
    - highest(10) >= 0.5 * highest(160) + 0.5 * lowest(160)
    - close crosses_below lowest(3)[1]
    - highest(10) - close >= 0.25 * atr(20)
    - highest(10) - close <= 2.75 * atr(20)
    - close - lowest(160) >= 2 * highest(10) - 2 * close + 0.5 * atr(20)
exit:
  target:
    long: highest(160) - close
    short: close - lowest(160)
  max_bars: 80
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F5C `mtf_f5c_ote4h`

```yaml
rules:
  long:
    - mtf_bias(240) > 0
    - highest(160) - lowest(160) >= 6 * atr(20)
    - highest(10) < highest(160)
    - lowest(10) > lowest(160)
    - lowest(10) <= 0.38 * highest(160) + 0.62 * lowest(160)
    - close crosses_above highest(3)[1]
    - close - lowest(10) >= 0.25 * atr(20)
    - close - lowest(10) <= 2.75 * atr(20)
    - highest(160) - close >= 2 * close - 2 * lowest(10) + 0.5 * atr(20)
    - mtf_bias(60) > 0
  short:
    - mtf_bias(240) < 0
    - highest(160) - lowest(160) >= 6 * atr(20)
    - lowest(10) > lowest(160)
    - highest(10) < highest(160)
    - highest(10) >= 0.62 * highest(160) + 0.38 * lowest(160)
    - close crosses_below lowest(3)[1]
    - highest(10) - close >= 0.25 * atr(20)
    - highest(10) - close <= 2.75 * atr(20)
    - close - lowest(160) >= 2 * highest(10) - 2 * close + 0.5 * atr(20)
    - mtf_bias(60) < 0
exit:
  target:
    long: highest(160) - close
    short: close - lowest(160)
  max_bars: 80
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F6A `mtf_f6a_sweepcisd`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(60) < htf_low(60)
    - cisd_ote_dir > 0
  short:
    - htfc_high(60) > htf_high(60)
    - cisd_ote_dir < 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: cisd_ote_risk
  min_rr: 2
```

### F6B `mtf_f6b_sweepcisd`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(240) < htf_low(240)
    - cisd_ote_dir > 0
  short:
    - htfc_high(240) > htf_high(240)
    - cisd_ote_dir < 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: cisd_ote_risk
  min_rr: 2
```

### F6C `mtf_f6c_sweepcisd`

```yaml
mtf: reversal
rules:
  long:
    - htfc_low(60) < htf_low(60)
    - cisd_ote_dir > 0
    - mtf_bias(240) >= 0
  short:
    - htfc_high(60) > htf_high(60)
    - cisd_ote_dir < 0
    - mtf_bias(240) <= 0
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: cisd_ote_risk
  min_rr: 2
```

### F7A `mtf_f7a_sessweep`

```yaml
sessions: ["09:35-11:30@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - lowest(5) < overnight_low
    - close > overnight_low
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - highest(5) > overnight_high
    - close < overnight_high
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F7B `mtf_f7b_sessweep`

```yaml
sessions: ["09:35-15:00@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - lowest(5) < prior_low
    - close > prior_low
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - highest(5) > prior_high
    - close < prior_high
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F7C `mtf_f7c_sessweep`

```yaml
sessions: ["09:35-11:30@America/New_York"]
rules:
  long:
    - mtf_bias(240) > 0
    - lowest(5) < overnight_low
    - close > overnight_low
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
  short:
    - mtf_bias(240) < 0
    - highest(5) > overnight_high
    - close < overnight_high
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F8A `mtf_f8a_ibbreak`

```yaml
rules:
  long:
    - minute_et >= 630
    - minute_et < 900
    - mtf_bias(240) > 0
    - mtf_bias(60) > 0
    - close crosses_above ib_high
    - volume > vol_sma(20)
    - close - ib_high <= 0.5 * atr(20)
  short:
    - minute_et >= 630
    - minute_et < 900
    - mtf_bias(240) < 0
    - mtf_bias(60) < 0
    - close crosses_below ib_low
    - volume > vol_sma(20)
    - ib_low - close <= 0.5 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - ib_high + 0.5 * atr(20)
    short: ib_low - close + 0.5 * atr(20)
  min_rr: 2
```

### F8B `mtf_f8b_ibbreak`

```yaml
rules:
  long:
    - minute_et >= 630
    - minute_et < 900
    - mtf_bias(240) > 0
    - mtf_bias(60) > 0
    - close > ib_high
    - lowest(5) <= ib_high
    - lowest(5) >= ib_high - 0.5 * atr(20)
    - close crosses_above highest(3)[1]
    - close - lowest(5) >= 0.25 * atr(20)
    - close - lowest(5) <= 2.75 * atr(20)
  short:
    - minute_et >= 630
    - minute_et < 900
    - mtf_bias(240) < 0
    - mtf_bias(60) < 0
    - close < ib_low
    - highest(5) >= ib_low
    - highest(5) <= ib_low + 0.5 * atr(20)
    - close crosses_below lowest(3)[1]
    - highest(5) - close >= 0.25 * atr(20)
    - highest(5) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(5) + 0.25 * atr(20)
    short: highest(5) - close + 0.25 * atr(20)
  min_rr: 2
```

### F8C `mtf_f8c_ibbreak`

```yaml
rules:
  long:
    - minute_et >= 630
    - minute_et < 900
    - mtf_bias(240) > 0
    - close crosses_above ib_high
    - volume > vol_sma(20)
    - close - ib_high <= 0.5 * atr(20)
  short:
    - minute_et >= 630
    - minute_et < 900
    - mtf_bias(240) < 0
    - close crosses_below ib_low
    - volume > vol_sma(20)
    - ib_low - close <= 0.5 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - ib_high + 0.5 * atr(20)
    short: ib_low - close + 0.5 * atr(20)
  min_rr: 2
```

### F9A `mtf_f9a_lvlretest`

```yaml
sessions: ["09:35-15:00@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - close > prior_high
    - lowest(10) <= prior_high
    - lowest(10) >= prior_high - 0.5 * atr(20)
    - any:
        - close[3] > prior_high
        - close[4] > prior_high
        - close[5] > prior_high
        - close[6] > prior_high
        - close[7] > prior_high
        - close[8] > prior_high
        - close[9] > prior_high
        - close[10] > prior_high
    - close crosses_above highest(3)[1]
    - close - lowest(10) >= 0.25 * atr(20)
    - close - lowest(10) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - close < prior_low
    - highest(10) >= prior_low
    - highest(10) <= prior_low + 0.5 * atr(20)
    - any:
        - close[3] < prior_low
        - close[4] < prior_low
        - close[5] < prior_low
        - close[6] < prior_low
        - close[7] < prior_low
        - close[8] < prior_low
        - close[9] < prior_low
        - close[10] < prior_low
    - close crosses_below lowest(3)[1]
    - highest(10) - close >= 0.25 * atr(20)
    - highest(10) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F9B `mtf_f9b_lvlretest`

```yaml
sessions: ["09:35-15:00@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - close > overnight_high
    - lowest(10) <= overnight_high
    - lowest(10) >= overnight_high - 0.5 * atr(20)
    - any:
        - close[3] > overnight_high
        - close[4] > overnight_high
        - close[5] > overnight_high
        - close[6] > overnight_high
        - close[7] > overnight_high
        - close[8] > overnight_high
        - close[9] > overnight_high
        - close[10] > overnight_high
    - close crosses_above highest(3)[1]
    - close - lowest(10) >= 0.25 * atr(20)
    - close - lowest(10) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - close < overnight_low
    - highest(10) >= overnight_low
    - highest(10) <= overnight_low + 0.5 * atr(20)
    - any:
        - close[3] < overnight_low
        - close[4] < overnight_low
        - close[5] < overnight_low
        - close[6] < overnight_low
        - close[7] < overnight_low
        - close[8] < overnight_low
        - close[9] < overnight_low
        - close[10] < overnight_low
    - close crosses_below lowest(3)[1]
    - highest(10) - close >= 0.25 * atr(20)
    - highest(10) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```

### F9C `mtf_f9c_lvlretest`

```yaml
sessions: ["09:35-15:00@America/New_York"]
rules:
  long:
    - mtf_bias(60) > 0
    - close > prior_vah
    - lowest(10) <= prior_vah
    - lowest(10) >= prior_vah - 0.5 * atr(20)
    - any:
        - close[3] > prior_vah
        - close[4] > prior_vah
        - close[5] > prior_vah
        - close[6] > prior_vah
        - close[7] > prior_vah
        - close[8] > prior_vah
        - close[9] > prior_vah
        - close[10] > prior_vah
    - close crosses_above highest(3)[1]
    - close - lowest(10) >= 0.25 * atr(20)
    - close - lowest(10) <= 2.75 * atr(20)
  short:
    - mtf_bias(60) < 0
    - close < prior_val
    - highest(10) >= prior_val
    - highest(10) <= prior_val + 0.5 * atr(20)
    - any:
        - close[3] < prior_val
        - close[4] < prior_val
        - close[5] < prior_val
        - close[6] < prior_val
        - close[7] < prior_val
        - close[8] < prior_val
        - close[9] < prior_val
        - close[10] < prior_val
    - close crosses_below lowest(3)[1]
    - highest(10) - close >= 0.25 * atr(20)
    - highest(10) - close <= 2.75 * atr(20)
exit:
  target_r: 2
  max_bars: 40
risk:
  stop:
    long: close - lowest(10) + 0.25 * atr(20)
    short: highest(10) - close + 0.25 * atr(20)
  min_rr: 2
```
