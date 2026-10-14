---
name: strategy-authoring
description: Write a new trading strategy as a STRATEGY.md document - frontmatter schema, required sections, validation, and promotion from paper to active. Use when the user describes a strategy idea, ports one from code or a backtest, or edits an existing strategy.
---

# Strategy Authoring

## When to Use

- "Add a strategy that ..." or porting a strategy from code or a backtest.
- Changing an existing strategy's rules or status.

## How It Works

1. Copy `strategies/_template/STRATEGY.md` to `strategies/<name>/STRATEGY.md`
   (or to a folder in `FTH_STRATEGIES_DIRS` for private strategies). `<name>`
   is lowercase with `_` or `-`; it becomes the journal tag `setup:<name>`.
2. Frontmatter (checked by code):

   | Field | Meaning |
   |---|---|
   | `name`, `description` | Folder name; what/when, ≥ 40 chars |
   | `status` | `paper` (new), `active` (live entries allowed), `disabled` |
   | `instruments` | Contract roots, e.g. `[MNQ, MES]`. A `rules` strategy trades one leg of each micro/mini family it lists (MNQ/NQ, MES/ES, MYM/YM, M2K/RTY, MGC/GC, SIL/SI): the selected one (the runner's `symbols`, or `FTH_SYMBOLS`), never the other, so list one leg per family (listing MNQ covers a selected NQ). With no leg selected, exactly the roots listed (listing both legs of a family, neither until one is selected). The order gate, `order_plan`, the scan, and the backtester (its symbols) all match this way. The contract ordered sets the tick specs and the dollars (`max_risk_usd` on an NQ entry is measured at NQ's $5.00 a tick). `manual` and `policy` strategies trade exactly the roots listed |
   | `timeframe` | Trigger timeframe, e.g. `3m` |
   | `sessions` | Optional windows, entries only inside: named sessions `asia` (18:00-03:00 ET), `london` (03:00-09:30 ET), `ny` (09:30-16:00 ET), or `"HH:MM-HH:MM@Zone"`. Without it the strategy trades the whole market session, from 18:00 ET until 16:00 ET the next day (closed only 16:00-18:00 ET and weekends; no position is carried past 16:00 ET) |
   | `signal` | `rules` (trigger written in `rules`, checked by code) or `manual` (agents judge the body). Every shipped single-setup strategy, the ported ones included, is `rules`; the prop strategies (`prop_*`) are `policy` (below) |
   | `regimes` | Optional list of regimes the strategy fits: `trend-up`, `trend-down`, `trend`, `range`, `transition`, `high-vol`, `normal-vol`, `low-vol` (any match fits). Out-of-regime strategies are never scan candidates |
   | `mtf` | `trend` (the default) or `reversal`. A trend strategy never enters against the prevailing higher-timeframe trend (the highest of 4h, 1h, 15m with one): the scan drops the signal, the backtester skips it, and the order gate refuses the entry. Set `reversal` only when the setup is a raid or exhaustion at a higher-timeframe level that fades that trend by design (`crt_1h`, `crt_4h`, `ofi_absorption`, `value_area_reentry`); say why in the body. Policy strategies have no `mtf`: each setup keeps its strategy's |
   | `regime_gate` | Optional `true`: the MCP gateway also refuses entries when the live regime (from that strategy's timeframe bars) doesn't fit |
   | `rules` | With `signal: rules`: `long:` and/or `short:` lists of conditions, all of which must hold on the closed bar |
   | `params` | Optional overrides of the snapshot and rules series (e.g. `orbMinutes: 30`); periods must be whole numbers |
   | `filters` | Optional `adx_min`, `adx_max`, `adx_slope_min`, `max_vwap_distance_atr`; checked by the scan only, not at order time |
   | `exit` | Optional: `trail_activate_r` + `trail_giveback_r` (trail the stop from +NR, giving back MR; trend setups use 2 / 0.5), `target_r` (fixed target), `target` (a distance expression from the signal close, or `{ long, short }`, e.g. `crt_target(60)`: a target at a level instead of R), `max_bars` (time stop). Without it the target is `risk.min_rr`. The backtester and the live runner apply it |
   | `signal: policy` | A policy strategy: the prop challenge as a strategy (see `strategies/prop_portfolio`). `strategies` lists the rules strategies whose setups it trades, in priority order, all on its timeframe; `account` names `accounts/<name>/ACCOUNT.md` (the gate enforces its floor, daily limits, and size budget); its numbers live in its account's rulebook, `accounts/<account>/RULEBOOK.md` (`policies.<name>`: `sizing`, `exit`, `multipliers`, every key stated, a limit turned off only by `off`), the one place for them: a policy may not state them in its STRATEGY.md, and one the rulebook doesn't list is refused (the loader refuses both); `sizing` sets risk per trade from the cushion (`cushion_frac` ≤ 1, `cap_usd`, `clock_k`, `r_per_session`, `min_size_guard`, `drawdown_halve_usd`: halve the budget while the balance is at least that far below its peak, `stop_slippage_ticks`: the stop's expected slippage counted in each contract's risk, at least 1, the default and the backtester's fill slippage); `contracts` is `micro`, `mini`, or `auto` (minis once the size reaches one mini); its `exit` needs a trail (it exits every trade the policy strategy takes); each verdict is `full` (sized at the rulebook's multiplier) or `skip`; `risk.stop: strategy` keeps each setup's own stop. Each setup is taken at the largest size the budget allows, or skipped. `priority` (optional, a whole number 1 to 99, 1 first) orders policy strategies whose setups come in the same cycle on different runner lanes (timeframes): the lower number keeps its setup and the other is skipped as "lower priority" (equal or unset: the one on 3m or slower goes first), settled per runner, that is per account (a runner trades one account): a setup on another of its symbols collides too, and so does another policy's entry verdict from an earlier cycle while it is still open (unexpired, unused). Only policy strategies have these keys |
   | `risk` | `stop` (`atr:<k>` = k × ATR(20), a distance expression such as `0.5 * atr(20)` or `cisd_risk(15)`, a map `{ long: <expr>, short: <expr> }` when each side's stop sits somewhere else (beyond a swept low or high, as in `crt_1h`), `structure`, `swing`, `manual`), `min_rr`, optional `max_risk_usd`. The order gate checks that a stop exists and, when `max_risk_usd` is set, refuses an entry whose risk (size × stop ticks × the broker's tick value) is over it, or whose risk it can't compute (a market entry with its stop only in the rationale: give `stopLossBracket.ticks`); `min_rr` is applied by the agents (risk-manager), not by code. In a policy strategy, only its own `max_risk_usd` applies to its entries, not its components' |
   | `source`, `version` | Where it came from; bump version on rule changes |

3. Body (read by the agents): `## When to Use`, `## How It Works` (context
   filter, trigger, entry/stop/targets, skip when), `## Examples` with
   tick-correct numbers and a sample rationale.
4. Port faithfully. When porting code, copy the exact rules and parameters and
   flag suspected bugs to the user instead of silently fixing them.
5. Validate: the harness tool `strategies_validate` (a person runs the
   strategies script's `validate`).
6. Promote only on evidence: paper-trade it (reviews tagged `paper`), run
   setup-expectancy, and set `status: active` only with the user's approval.
7. Write mechanical triggers as `rules`, not code. Every item in a side
   must hold (AND); an item can be a group, `any: [...]` (one of them holds,
   OR) or `all: [...]` (every one), nested three deep, so one strategy can take
   two setups or two confirmations (see `value_area`: a POC rejection or
   breakout, confirmed by a broker field or expansion). The scan shows each
   group's `parts`, so you can see which branch held. A condition is
   `<expr> <op> <expr>` with `>`, `>=`, `<`, `<=`, `crosses_above`,
   `crosses_below`. Expressions use series and numbers joined by `+`, `-`, and
   `number *`: `open high low close volume`, `ema(n) sma(n) atr(n) adx(n)
   highest(n) lowest(n) vol_sma(n)` (n up to 500; adx up to 250), `supertrend supertrend_dir`, `keltner_upper/mid/lower`,
   `vwap_session vwap_rth or_high or_low swing_high swing_low`,
   `prior_high prior_low prior_close overnight_high overnight_low`, `rth_open`
   (today's 09:30 ET open, until 16:00 ET), `rth_high rth_low` (today's RTH
   high and low so far), `ib_high ib_low` (today's initial balance, the
   first hour, from the bar that completes it), `adr(n)` (the average RTH
   range of the last n complete days), `minute_et`,
   the CISD on completed m-minute candles (`scripts/lib/trading/cisd.js`; the
   `cisd` skill): `cisd_dir(m) cisd_level(m) cisd_sweep(m) ote_top(m)
   ote_bot(m) in_ote(m)` and the OTE bounce `cisd_entry(m)` with its stop
   distance `cisd_risk(m)` (m a whole number of the bars: 3, 15, 60 on 3m), and
   higher-timeframe candles `htf_open(m) htf_high(m) htf_low(m) htf_close(m)`
   (the previous m-minute candle) and `htfc_open(m) htfc_high(m) htfc_low(m)`
   (the one in progress, up to this bar); m divides a day (60 = 1 hour, 240 =
   4 hours, candles aligned to the 18:00 ET open: 18, 22, 02, 06, 10, 14 ET).
   `htfc_low(60) < htf_low(60)` says this hour swept the last hour's low.
   `crt_dir(m) crt_risk(m) crt_target(m)` are the Candle Range Theory sweep
   detector on m-minute candles (one setup per candle, tuned by the
   `crt*` params; see `crt_1h`). `mtf_bias(m)` is the m-minute trend as of
   the last m-minute candle completed before the bar (1 up, -1 down, 0 range;
   the `multi-timeframe-analysis` skill): `mtf_bias(240) >= 0` keeps a long
   out of a 4-hour downtrend.
   Completed candles (`htfd_*`, d = done): the last m-minute candle
   completed by the bar's close, never the one forming. On the bar that
   closes a candle it is that candle (`htf_*` still shows the one before
   until the next opens). m is 3, 5, 15 or 60 (any that divides a day), made
   of whole bars: `htfd_close(5)` on 3m bars has no value (never
   approximated). `htfd_open(m) htfd_high(m) htfd_low(m) htfd_close(m)
   htfd_volume(m)`, `htfd_prev_high(m) htfd_prev_low(m)` (the candle before
   it), `htfd_body(m) htfd_upper_wick(m) htfd_lower_wick(m)` (shares of its
   range, 0-1), `htfd_close_loc(m)` (1 top third, 0 middle, -1 bottom),
   `htfd_range_atr(m)` (range in that timeframe's ATR(14) as of the candle
   before), `htfd_vol_ratio(m)` (volume against the 20 candles before);
   patterns `htfd_doji(m) htfd_hammer(m) htfd_shooting_star(m)
   htfd_inside(m) htfd_outside(m)` (1 or 0) and `htfd_engulfing(m)
   htfd_displacement(m)` (1 bullish, -1 bearish, 0), each defined in
   `scripts/lib/trading/candle-facts.js` (hypotheses, not edges). How it met
   a level, `htfd_rejected(m, level)` (1: traded below and closed back
   above, -1: above and back below), `htfd_broke(m, level)` (1 up, -1 down:
   closed beyond with most of the body beyond), `htfd_touched(m, level)` (1:
   traded at it otherwise). The level is a name from the one fixed
   vocabulary, `LEVEL_ARGS` in `scripts/lib/trading/rules.js` (listed in its
   header; e.g. `prior_high`, `vwap_session`, `session_poc`, `ib_low`, and
   `previous_high previous_low`: the candle before it); validation refuses
   any other name, and a second argument on any other function. A fixed
   level counts when it was complete by the candle's open, that is its last
   bar closed at or before the open, at its value then (the opening range
   that completes at 09:45 ET counts for the candle opening at 09:45; one
   the candle's own bars made, or one formed later, gives no relation); a
   moving one (`vwap_*`, `session_*`) at the candle's close. At a new
   session's first candle (18:00 ET, Sunday's open) the last session's
   opening range, IB, overnight range and `rth_open` give no relation; its
   prior day is the RTH day that just closed. The briefing reads them the
   same way. The bar size is the
   strategy's `timeframe` (never guessed).
   `htfd_next_swing_high(m) htfd_next_swing_low(m)`: the next swing target,
   the nearest confirmed m-minute swing above (below) the close that no bar
   has traded beyond since; any bar trading beyond it (its high above a
   swing high, its low below a swing low) takes it, so it never crosses
   (compare with `htfd_high`, not the target). A 60m rejection of
   the prior day's high: `htfd_rejected(60, prior_high) < 0`; its target:
   `exit.target: close - htfd_next_swing_low(60)`.
   Volume profile (bar-based; the `vwap-volume-profile` skill): `prior_poc
   prior_vah prior_val` (the last complete RTH day, fixed for the day),
   `session_poc session_vah session_val` (this Globex session, developing),
   `vp_poc(n) vp_vah(n) vp_val(n)` (the last n bars), and the nearest node
   above or below the close, `prior_hvn_above prior_lvn_below` (and
   `_hvn_below`, `_lvn_above`, `session_*`, `hvn_above(n)` ...). Use nodes
   as targets and distances, not crosses: they move as price passes them.
   Tune with params `vpRows` (default 100), `vpRowSize` (points per row
   instead), `vpValueArea` (70), `vpNodePct` (9), `vpTroughPct` (7),
   `vpThreshold` (1).
   `[n]` looks back n bars: `highest(20)[1]` is the 20-bar high before this
   bar (without it the current bar is included, so a close can never cross
   above it). `minute_et` is the bar's open time in New York minutes (9:45 =
   585). `prior_*` is the last completed RTH day and `overnight_*` this Globex
   session before 9:30 ET up to the previous bar, as each bar saw them; a
   session the bars start mid-way through has none (likewise `vwap_session`
   and `vwap_rth`). The runner scans three trading days of bars, enough
   for these and for long indicators to match a backtest. `vol_sma(n)` is the
   average volume per bar. `field("a.b.c")` reads a number the broker MCP
   server put on its bars, by dotted path (a digit segment reads a key such
   as `"5"`; `field("a.b")[1]` is the previous bar's): the harness gives it no
   meaning, so the strategy's body says what the field is and which broker
   setting turns it on. The scan shows the values its field rules read on
   the bar (`field("a.b")=0.42`) for a candidate and for a rule set that did
   not fire (next to each rule that did not hold), never for a strategy that
   fired but failed a filter; a field's meaning and units are in the
   strategy's own document, so write them there. A missing field or a null
   makes the condition false, so a bar without it never fires; nothing
   estimates it. Bars the
   backtester builds from shorter ones, and CSV files, carry no broker
   fields (step 8 says how to backtest on them). A value
   that doesn't exist yet (indicator warm-up, no opening range yet) makes the
   condition false and the scan marks it `missing`. At most 12 conditions per
   side. A rules strategy with only `long` rules can't be used to sell into an
   entry. `validate` reports typos, unknown keys and series. Only a pattern the
   rules can't express (multi-bar zone logic like cisd_ote's) needs `manual` or
   a new series in `scripts/lib/trading/rules.js` (with tests), used from the
   rules like `cisd_entry(15)`.
8. Backtest it before paper trading (the user, or the `strategy-researcher`
   role in an interactive authoring session; never a trading run):
   `node <root>/scripts/backtest.js --data <bars.parquet|.xlsx|.csv> --symbol MNQ --strategy <name>`
   (docs/BACKTESTING.md). Check that it fires where you expect (`trades.csv`)
   and that its R statistics hold up with harness rules on. A strategy that
   reads broker fields (`field(...)`) needs the broker's bars at its own
   timeframe: fetch them first,
   `node <root>/scripts/backtest.js fetch --contract MNQ --from <date> --to <date> --timeframe <its minutes> --out <file>.jsonl`,
   and backtest on that file (`--timeframe <its minutes>`). The backtester
   refuses to build its bars from finer ones that carry broker fields, and
   reports each field's coverage (the share of bars carrying it): under 100%
   it warns, and those bars can't fire the field's conditions.
   Before a rule leans on a broker field, check that the field predicts
   anything: `node <root>/scripts/field-study.js --data <bars>.jsonl --symbol MNQ --fields <path>[,<path>] --horizons 1,3,5,15 --by hour,session --out <dir>`
   measures how the field at bar t lines up with the move after t (never
   the same bar's), with intervals and the cost line (docs/BACKTESTING.md,
   "The field-forward study"). It runs freely on Train months only and
   refuses any other month unless the user gives `--held-out-look "<reason>"`;
   never pass that flag yourself. A field with no edge after costs is no
   reason for a rule.
   A field meant as a confirmation (a rule that takes an event only when the
   field agrees) is checked as one: add `--event expansion:1.5,breakout:20,strategy:<name>`
   and the study compares the event's follow-through when the field agrees,
   disagrees or is neutral, with intervals and the cost line
   (docs/BACKTESTING.md, "The field-confluence study"). Keep the confirmation
   only if agree beats disagree and neutral with an interval that excludes
   zero, on Train; held-out months judge it by calibration (R11-R13), never
   by rerunning the study there.
9. When a field's values are in doubt (a new build of the replay server's
   store, or replay against recorded live minutes), compare the two sources
   before trusting a backtest on them (the user, or the
   `strategy-researcher` role in an interactive authoring session; never a
   trading run): `scripts/compare-bars.js` aligns the
   bars by time, lists bars only in one source and bars whose prices differ,
   and gives each field's coverage, differences, share within tolerance,
   correlation and sign agreement (docs/BACKTESTING.md, "Comparing bar
   sources"). Two store builds over a week, fetched to files first:
   `node <root>/scripts/compare-bars.js --a <old>.jsonl --b <new>.jsonl --prefix <subtree> --by hour --fail-below corr=0.99,within=0.99`.
   Recorded live minutes against the replay server (live is the reference):
   `node <root>/scripts/compare-bars.js --a <live>.jsonl --b broker:<replay broker> --contract MNQ --from <ISO> --to <ISO> --fail-below bars=1,coverage=1,corr=0.99,within=0.99`.
   Exit 1 means a field missed a threshold, or nothing was compared: read
   the worst bars (or the bars only in one source) before trusting either
   source. The tool only measures; it gives no field a
   meaning.

## Examples

```yaml
---
name: donchian_break
description: 20-bar Donchian breakout on MNQ/MES 3-minute bars with an ADX trend filter, written entirely as rules.
version: 1
status: paper
instruments: [MNQ, MES]
timeframe: 3m
sessions: ["09:45-15:00@America/New_York"]
signal: rules
rules:
  long:
    - close crosses_above highest(20)[1]
    - adx(14) >= 20
    - close > vwap_rth
  short:
    - close crosses_below lowest(20)[1]
    - adx(14) >= 20
    - close < vwap_rth
risk:
  stop: atr:1
  min_rr: 2
source: user idea, 2026-10-08
---
```

See `strategies/vwap_reclaim/STRATEGY.md` for a complete rules strategy.
