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
  account profile, with `prop_portfolio`'s sizing and trail (its account's rulebook)
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
  reversal sign; htf-to-ltf: a reversal is judged
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
  target is with the trend"; htf-to-ltf: with-trend setups
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
  timeframe-sources: the 1-hour is the bias timeframe.
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
  rotation runs with the higher timeframe (htf-to-ltf:
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
  Continuation"; htf-to-ltf, "levels flow down": the daily and session
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

(Note added later: the `cisd_ote_dir` and `cisd_ote_risk` series this
family's rules use were removed with `cisd_ote` version 4, the textbook
rewrite (docs/research/cisd-ote-textbook.md); the F6 rules below no
longer compile. The census (Results) ran them before that.)

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

**Errata to the pre-registered text** (from review; the text above is
left as committed, and no rule or result depends on these):

- Gap 2 ("Higher-timeframe indicators") lists only `htf_*` and
  `mtf_bias` as what exists on the higher timeframes. It leaves out
  `htfc_*(m)` (the candle in progress) and `crt_dir(m)`, `crt_risk(m)`,
  `crt_target(m)` (the CRT detector on the m-minute candle). The gap
  stands: there is still no EMA, ATR or swing point on those timeframes.
- Gap 6 ("Daily bias") says a daily trend never gets its EMA votes.
  Wrong: `ema` seeds from the first value, so the close-vs-EMA20 vote is
  cast (and the structure vote too); only the EMA20-vs-EMA50 vote is
  missing, since 240 hours hold about 10 daily candles and that vote
  needs 50. So `mtf_bias(1440)` is a two-vote read on few candles: weak,
  not absent.
- Two lines (the method's prop simulation and the prop simulation
  results) were reworded after the census, when R1 (the rulebook as the
  single source) landed, to name the rulebook as the trail's source
  instead of restating its values. The trail used is unchanged.

**Verdict: nothing survives.** Every variant's BH-adjusted p is 1.000 (the
smallest raw one-sided p is F8B's 0.082), and no 95% interval's lower bound is above zero. No
strategy document is written; every family stays in this catalog only.

Census run on 244,916 MNQ 3-minute bars (2021-05-02 to 2023-06-30, ten
front contracts joined raw), as the method above says. The backtester's
data audit flagged 435 missing bars in 108 gaps (the largest 97 bars,
2022-11-30) and 18 opens more than 8 ATR from the prior close (the
rolls and holiday reopenings); nothing was repaired.

Columns: n trades; mean R after costs with its 95% day-block interval;
profit factor of net dollars (it can exceed 1 while the mean R is
negative, because R weighs every trade the same while dollars weigh the
wide-stop trades more); win rate (net > 0); trades per Train month; RTH
(entry 09:30-16:00 ET) and overnight trades with their mean R; mean R by
year; BH-adjusted p over the 27 variants.

| Variant | n | mean net R [95% CI] | PF | win | per month | RTH n / mean | ON n / mean | 2021 / 2022 / 2023 | BH q |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1A | 2232 | -0.133 [-0.201, -0.065] | 0.94 | 28% | 85.8 | 9 / 0.788 | 2223 / -0.137 | -0.16 / -0.03 / -0.32 | 1.000 |
| F1B | 2420 | -0.081 [-0.136, -0.027] | 0.96 | 35% | 93.1 | 5 / -0.227 | 2415 / -0.081 | -0.09 / -0.02 / -0.20 | 1.000 |
| F1C | 887 | -0.156 [-0.235, -0.075] | 0.83 | 35% | 34.1 | 317 / -0.147 | 570 / -0.161 | -0.10 / -0.11 / -0.34 | 1.000 |
| F2A | 515 | -0.098 [-0.214, 0.022] | 0.85 | 32% | 19.8 | 142 / -0.066 | 373 / -0.111 | -0.07 / -0.07 / -0.20 | 1.000 |
| F2B | 1080 | -0.024 [-0.097, 0.048] | 0.94 | 39% | 41.5 | 345 / -0.033 | 735 / -0.020 | 0.01 / 0.02 / -0.16 | 1.000 |
| F2C | 390 | -0.095 [-0.230, 0.044] | 0.88 | 33% | 15.0 | 98 / 0.017 | 292 / -0.133 | -0.04 / -0.09 / -0.19 | 1.000 |
| F3A | 379 | 0.025 [-0.093, 0.143] | 0.98 | 44% | 14.6 | 379 / 0.025 | 0 / - | 0.06 / 0.10 / -0.16 | 1.000 |
| F3B | 248 | 0.037 [-0.108, 0.187] | 1.01 | 45% | 9.5 | 248 / 0.037 | 0 / - | 0.09 / 0.09 / -0.14 | 1.000 |
| F3C | 1450 | -0.111 [-0.171, -0.050] | 0.82 | 35% | 55.8 | 230 / -0.107 | 1220 / -0.112 | -0.10 / -0.10 / -0.15 | 1.000 |
| F4A | 50 | -0.216 [-0.611, 0.249] | 0.70 | 24% | 1.9 | 50 / -0.216 | 0 / - | -0.20 / -0.07 / -0.49 | 1.000 |
| F4B | 35 | -0.131 [-0.568, 0.390] | 0.98 | 29% | 1.3 | 35 / -0.131 | 0 / - | -0.23 / -0.15 / 0.04 | 1.000 |
| F4C | 14 | 0.423 (under 30: no interval) | 0.89 | 36% | 0.5 | 14 / 0.423 | 0 / - | 1.28 / 0.05 / -1.02 | 1.000 |
| F5A | 792 | -0.160 [-0.277, -0.041] | 0.79 | 26% | 30.5 | 137 / -0.207 | 655 / -0.150 | -0.27 / -0.00 / -0.31 | 1.000 |
| F5B | 883 | -0.171 [-0.279, -0.058] | 0.75 | 25% | 34.0 | 143 / -0.224 | 740 / -0.161 | -0.27 / -0.06 / -0.25 | 1.000 |
| F5C | 395 | -0.164 [-0.324, 0.012] | 0.77 | 25% | 15.2 | 61 / -0.014 | 334 / -0.191 | -0.31 / -0.10 / -0.05 | 1.000 |
| F6A | 316 | 0.021 [-0.136, 0.180] | 1.11 | 35% | 12.2 | 95 / -0.069 | 221 / 0.060 | 0.06 / -0.05 / 0.10 | 1.000 |
| F6B | 323 | 0.071 [-0.099, 0.249] | 1.13 | 37% | 12.4 | 114 / -0.001 | 209 / 0.111 | 0.13 / 0.07 / -0.02 | 1.000 |
| F6C | 259 | 0.008 [-0.170, 0.188] | 1.10 | 35% | 10.0 | 85 / -0.093 | 174 / 0.058 | -0.06 / 0.01 / 0.07 | 1.000 |
| F7A | 35 | 0.112 [-0.255, 0.496] | 1.24 | 49% | 1.3 | 35 / 0.112 | 0 / - | 0.35 / 0.26 / -0.73 | 1.000 |
| F7B | 5 | -0.517 (under 30: no interval) | 0.18 | 20% | 0.2 | 5 / -0.517 | 0 / - | -1.02 / -1.01 / 1.48 | 1.000 |
| F7C | 64 | 0.098 [-0.185, 0.401] | 1.44 | 47% | 2.5 | 64 / 0.098 | 0 / - | 0.06 / 0.23 / -0.20 | 1.000 |
| F8A | 61 | -0.455 [-0.724, -0.156] | 0.38 | 20% | 2.3 | 61 / -0.455 | 0 / - | -0.41 / -0.43 / -0.68 | 1.000 |
| F8B | 38 | 0.281 [-0.117, 0.699] | 1.17 | 50% | 1.5 | 38 / 0.281 | 0 / - | 0.42 / 0.15 / 0.18 | 1.000 |
| F8C | 100 | -0.145 [-0.416, 0.149] | 0.74 | 30% | 3.8 | 100 / -0.145 | 0 / - | -0.21 / -0.09 / -0.13 | 1.000 |
| F9A | 41 | -0.051 [-0.402, 0.313] | 0.62 | 44% | 1.6 | 41 / -0.051 | 0 / - | 0.23 / -0.13 / -0.56 | 1.000 |
| F9B | 59 | -0.242 [-0.527, 0.059] | 0.54 | 34% | 2.3 | 59 / -0.242 | 0 / - | 0.24 / -0.41 / -0.27 | 1.000 |
| F9C | 57 | -0.032 [-0.356, 0.313] | 0.86 | 40% | 2.2 | 57 / -0.032 | 0 / - | -0.25 / 0.19 / -0.20 | 1.000 |
| `crt_1h` (reference) | 241 | -0.074 [-0.239, 0.098] | 1.17 | 35% | 9.3 | 212 / -0.060 | 29 / -0.172 | -0.38 / -0.01 / 0.14 | not in the set |

Only F8B (38 trades, interval from -0.12 to 0.70) has a positive mean in
all three years. That is no more than chance: with no edge, a variant's
yearly means are each positive about half the time, so all three are
positive with odds of about 1 in 8, and 27 variants would give about 3
such variants (27 / 8).

### F1 beside `crt_1h`

- F1 trades far more often than `crt_1h` (34 to 93 trades a month against
  9) and does worse: every F1 variant's interval lies wholly below zero,
  while `crt_1h`'s straddles it. A plain "hour swept, close back inside"
  is a losing trade after costs here. A hypothesis, not a finding: the
  conditions F1 drops (an hourly range of at least 3 ATR, a sweep at most
  half the range deep and at most 10 bars old, one setup per candle, New
  York hours) are what keep `crt_1h` near break-even. They were not
  tested one at a time, so which of them matter (if any) is unknown.
- **The session matters more than the trigger.** A and B trade the whole
  session, and the gate's daily limits (3 losing trades, 6 entries per
  trading day, by default) are used up overnight, where the 3-minute ATR
  is small: an overnight stop is often a few points, so a round trip's
  fees and one tick of slippage are 0.1-0.2R. Only 9 (A) and 5 (B) of
  their trades are in RTH.
- **Post-hoc, outside the BH set (not pre-registered):** F1A and F1B with
  `crt_1h`'s hours (08:00-15:30 ET) were run to make the comparison fair:
  F1A 1,935 trades, -0.080R [-0.160, -0.000]; F1B 2,135 trades, -0.114R
  [-0.171, -0.059]. Still worse than `crt_1h`. It changes nothing above.

### Prop simulation (top 3 by the interval's lower bound)

F3A (-0.093), F2B (-0.097) and F6B (-0.099), each as the only strategy of
a `paper` policy with `prop_portfolio`'s sizing and trail (from the rulebook), on
the 100K account profile, 105 attempts of 30 sessions starting every 5
trading days in Train (the attempts overlap, so they are not 105
independent tries):

| Variant | pass | blow | timeout | median sessions to pass | average profit |
| --- | --- | --- | --- | --- | --- |
| F3A | 2.9% (3) | 0% | 97.1% | 20 | -$38 |
| F2B | 6.7% (7) | 0% | 93.3% | 12 | -$722 |
| F6B | 10.5% (11) | 0% | 89.5% | 15 | $726 |

No blows, but no pass rate near the 40% the promotion gate asks for:
with no edge, the sizing protects the account and the attempts run out
of time.

### What the census says, read with care

These are not findings (nothing survived); they are where a next round
might look, each to be pre-registered and measured again on Train
before it is believed:

- The variants whose mean is above zero, all with intervals that
  straddle it: the with-trend pullbacks in RTH (F3A, 379 trades, +0.025R;
  F3B, 248, +0.037R; 1h trend, VWAP touch, 3m shift; 2023 negative in
  both), the HTF sweep before a CISD/OTE entry (F6A, 316, +0.021R; F6B,
  323, +0.071R; F6C, 259, +0.008R), and, with higher means on small
  samples, the session-level sweep with the bias (F7A, 35 trades,
  +0.112R; F7C, 64, +0.098R), the initial-balance retest (F8B, 38,
  +0.281R), and F4C (14 trades, +0.423R, too few for an interval). The
  small-sample ones are the likeliest to be noise.
- The same F3 rules over the whole session with the session VWAP (F3C)
  lose -0.11R: as for F1, the overnight trades and the daily limits they
  use up decide the result.
- Fading the hourly sweep with a fixed rule (F1) and buying an 8-hour
  discount with the 4-hour trend (F5) lose clearly after costs.
- Several location families (F4, F7, F8, F9) fire 1-4 times a month:
  too few trades in 26 months to say anything either way.

No family survived, so there is no "How the agent trades it" section,
and the continuation-versus-reversal choice the owner asked to have
spelled out has no measured setup to choose between yet.

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

(Uses the removed `cisd_ote_*` series: see the note under F6.)

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
