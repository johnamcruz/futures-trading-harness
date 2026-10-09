---
name: orb
description: Opening range breakout strategy for equity index futures (15-minute range from 09:30 ET, ADX-gated, 3-minute trigger), ported from algoTraderBot. Use when price closes beyond the opening range or when planning the morning session.
version: 3
status: active
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m
sessions: [ny]          # New York session only (09:30-16:00 ET): the range forms at the 09:30 open
signal: rules
rules:
  long:
    - close crosses_above or_high
    - adx(14) >= 18
    - minute_et >= 588
    - minute_et < 960
    - atr(20) > 0
  short:
    - close crosses_below or_low
    - adx(14) >= 18
    - minute_et >= 588
    - minute_et < 960
    - atr(20) > 0
params:
  orbMinutes: 15
exit:
  trail_activate_r: 2
  trail_giveback_r: 0.5
risk:
  stop: atr:0.5
  min_rr: 2
source: algoTraderBot/strategies/orb.py
---

# Strategy: Opening Range Breakout (`setup:orb`)

Source: `algoTraderBot/strategies/orb.py` (ORB_BARS=5 × 3-min, ORB_ADX_GATE=18,
no breakouts after 16:00 ET, stop 0.5 × ATR(20), fixed-RR fallback 2R).

## When to Use

- After the 15-minute range from 09:30 ET has closed, until 16:00 ET (the
  source's cutoff), on MNQ/MES/MYM/M2K. The runner's sessions and
  `FTH_ENTRY_HOURS` decide the hours you actually trade.
- `scan` reports `orb` with `candidate: true` and a direction (the `rules` block above).

## How It Works

### Context filter (harness judgment)

- ADX(14) on 3-minute ≥ 18 (in the rules), ideally rising.
- Range size between 0.5 and 2.0 × ATR(14) on 15-minute. Tiny ranges fake
  out; huge ranges leave no room to target.
- Higher timeframe (1h) not strongly against the breakout direction.

**Trigger:** a 3-minute bar *closes* beyond the opening range high (long) or low
(short) after the previous close was inside. Wicks don't count. As in the
source, the first bar after the range (09:45 ET) is not judged: the earliest
trigger is the 09:48 bar (`minute_et >= 588`).

**Entry:** market on the trigger bar's close, as the source does.

**Stop:** 0.5 × ATR(20) from the fill (the scan's `stopDistance`, rounded to
ticks), as algoTraderBot places it.

**Exit:** no fixed target. Hold the stop until the trade is up 2R; from
then on the runner trails it 0.5R behind the best price (the `exit` block),
after every closed bar. While the runner runs, don't move the stop yourself (interactively, trail it by
the same rule after each bar: the trade-session skill); exit early only with an
`[exit]` order when the plan's invalidation happens.

### Skip when (harness judgment: the source takes every signal)

- Relative volume on the trigger bar < 1.0× the opening-range average.
- The breakout runs straight into prior-day or overnight high/low within 1R.
- A high-impact release is due within 15 minutes.
- The opening range has already been broken and failed in the other direction.

## Examples

```text
OR 21480.00–21500.00 (20 pts, 0.9 × 15m ATR). 09:51 ET 3m close 21503.25,
ADX 21 rising, rel-vol 1.6×. Prior-day high 21545.
Entry 21503.25, stop 21498.00 (0.5 × ATR20 = 5.25), risk 21 ticks = $10.50/MNQ.
Trail from +2R (21513.75); then the stop sits 0.5R behind the best high.
rationale: "setup:orb long close above OR high 21500, stop 21498.00, risk $10.50"
```

Record live stats here once 30+ reviews exist: n, win rate, expectancy.
