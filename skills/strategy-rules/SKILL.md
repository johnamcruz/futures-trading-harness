---
name: strategy-rules
description: Use when writing a strategy's `rules` - conditions, groups, and the series they read.
---

# Strategy Rules

## When to Use

- Writing or changing a `signal: rules` strategy's `long:` / `short:` lists
  (the rest of the document: the `strategy-authoring` skill).

## How It Works

Write mechanical triggers as `rules`, not code. Every item in a side
must hold (AND); an item can be a group, `any: [...]` (one of them holds,
OR) or `all: [...]` (every one), nested three deep, so one strategy can take
two setups or two confirmations (see `value_area`: a POC rejection or
breakout, confirmed by a broker field or expansion). The scan shows each
group's `parts`, so you can see which branch held.

### Conditions and series

A condition is
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

### Completed candles

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

### Volume profile

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

### Look-back, sessions and broker fields

`[n]` looks back n bars: `highest(20)[1]` is the 20-bar high before this
bar (without it the current bar is included, so a close can never cross
above it). `minute_et` is the bar's open time in New York minutes (9:45 =
585). `prior_*` is the last completed RTH day and `overnight_*` this Globex
session before 9:30 ET up to the previous bar, as each bar saw them; a
session the bars start mid-way through has none (likewise `vwap_session`
and `vwap_rth`). The runner scans three trading days of bars, enough
for these and for long indicators to match a backtest. `vol_sma(n)` is the
average volume per bar.

`field("a.b.c")` reads a number the broker MCP
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
fields (the `strategy-backtest` skill says how to backtest on them).

### Limits

A value
that doesn't exist yet (indicator warm-up, no opening range yet) makes the
condition false and the scan marks it `missing`. At most 12 conditions per
side. A rules strategy with only `long` rules can't be used to sell into an
entry. `validate` reports typos, unknown keys and series. Only a pattern the
rules can't express (multi-bar zone logic like cisd_ote's) needs `manual` or
a new series in `scripts/lib/trading/rules.js` (with tests), used from the
rules like `cisd_entry(15)`.

## Examples

`close crosses_above highest(20)[1]` on MNQ 3m bars: on the bar before, the
20-bar high before it (`highest(20)[1]` then) was 21500.00 and it closed at
21499.75, its high 21499.75; on this bar the 20-bar high before it is still
21500.00 and it closes at 21500.25, one tick ($0.50 per MNQ contract) above:
the condition holds.
