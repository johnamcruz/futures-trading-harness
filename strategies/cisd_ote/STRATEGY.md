---
name: cisd_ote
description: Textbook CISD + OTE reversal - after a sweep of a key level, a completed 15-minute candle closes through the open of the run that swept it (a change in state of delivery); enter on the 3-minute bounce from the displacement leg's OTE zone, stop beyond the sweep extreme. Paper until its census and the owner promote it.
version: 4
status: paper                 # textbook rewrite of the old port: paper until the census (docs/research/cisd-ote-textbook.md) and the owner promote it
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m                 # the trigger: the bounce is read on completed 3-minute bars
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:
  long:
    - cisd_entry(15) > 0      # the bounce from a bullish 15m CISD's OTE zone (the (15) is the CISD timeframe)
    - cisd_sweep(15) > 0      # that CISD followed a sweep of a key low
  short:
    - cisd_entry(15) < 0
    - cisd_sweep(15) > 0
params:                       # the CISD hypotheses (scripts/lib/trading/cisd.js PARAMS; these are its defaults)
  cisdMinRun: 2               # a run is at least 2 consecutive opposing candles
  cisdMaxWait: 6              # the close through the run's open comes within 6 candles of the run's end
  cisdExpiry: 12              # the zone is good for 12 CISD candles (3 hours on 15m) after the CISD
  cisdVoidTol: 0.05           # a close more than 5% of the leg beyond the zone's far edge voids it
  cisdBufferAtr: 0.1          # the stop sits 0.1 x ATR(20) of 3m bars beyond the sweep extreme
risk:
  stop: cisd_risk(15)         # from the bounce's close to beyond the leg's origin (the sweep extreme)
  min_rr: 2                   # no exit block: the target is min_rr (2R), as a bracket
source: the owner's CISD definition (change in state of delivery; the cisd skill) and the OTE golden zone (the fib-retracement skill), rewritten from the version 3 port of the original bot (strategies/cisd_ote.py, cisd_ote_detect.py); detector in scripts/lib/trading/cisd.js, fib levels in scripts/lib/trading/fib.js
---

# Strategy: CISD + OTE (`setup:cisd_ote`)

Read the `cisd` skill (what a CISD is, and how to read it by timeframe) and
the `fib-retracement` skill (the OTE zone and the bounce) first: this
strategy is the two put together, mechanically.

## When to Use

- After price swept a key level (the prior RTH day's high or low, the
  overnight high or low in RTH, the prior session's high or low) and a
  completed 15-minute candle closed back through the open of the run that
  made the sweep.
- Any session: the source doesn't gate by time. The order gate's entry
  windows and daily limits still apply.

## How It Works

The detector is `scripts/lib/trading/cisd.js` (the rules series
`cisd_entry(15)`, `cisd_sweep(15)`, `cisd_risk(15)`; the briefing's `cisd`
block shows the same facts per timeframe). Every step reads completed
candles only.

1. **CISD on 15m.** A run of at least `cisdMinRun` consecutive bearish
   15-minute candles; then, within `cisdMaxWait` candles, a completed
   candle closes above the open of the run's first candle: a bullish CISD
   at that level. Bearish: the mirror (bullish run, close below its first
   open).
2. **The sweep (required).** From the run's start to the confirmation, a
   candle traded below a key low at or under the level and a close came
   back above it (`cisd_sweep(15) > 0`; bearish: a key high).
3. **The OTE zone.** The displacement leg runs from the origin (the sweep
   extreme: the lowest low from the run's start to the confirmation) to the
   extreme (the highest high since, extended while price keeps making new
   highs before it first retraces into the zone). The zone is `fib.OTE` of
   that leg (`scripts/lib/trading/fib.js`; the `fib-retracement` skill).
4. **The bounce (the entry).** On 3-minute bars after the 15m CISD closed:
   price trades into the zone, then a completed 3m bar that traded in the
   zone closes back in the trade direction: above the zone's top, or
   bullish with its close in the upper third of its range and inside the
   zone (bearish: the mirror). Enter on that close; one entry per CISD.
5. **Void and expiry.** A 3m close beyond the origin, or beyond the zone's
   far edge by more than `cisdVoidTol` of the leg, voids the zone; so does
   a newer CISD. The zone expires `cisdExpiry` 15m candles after the CISD.
6. **Stop:** `cisdBufferAtr` x ATR(20) beyond the origin (the sweep
   extreme). **Target:** `min_rr` (2R), as a bracket: no exit block.

Why 15m for the CISD and 3m for the trigger: the definition leans on key
levels and the higher-timeframe context, and a 3m CISD (two red candles and
a green close) fires many times a session on noise. A 15m CISD after a key
sweep is the top-down pairing the `cisd` skill teaches (the 15m shift, the
3m entry), and its leg is wide enough that a 3m bounce inside the zone can
be told from a slice through it. The CISD timeframe is the `(15)` in the
rules and the stop; `cisd_entry(3)` / `cisd_sweep(3)` / `cisd_risk(3)` is
the 3m variant the census also measures.

### Skip when (judgment: the mechanics take every signal)

- The higher timeframe is cleanly with the swept side and the CISD is the
  only reversal sign (the `cisd` skill: confluence, not a standalone).
- The first level ahead of the bounce is closer than 1R (levels-and-reactions).
- Risk to the origin is above the position-sizing budget at size 1.

## What changed from version 3 (the port), and why

Version 3 was a line-for-line port of the original bot's `cisd_ote` (12m
candles, a displacement-quality filter, a 50%-70.5% fib band measured from
the leg's origin, which is a 29.5%-50% retracement, a market entry when a
3m bar touched the band's bottom, and the stop at the pivot). Replaced, on
the owner's decision, by the textbook definition:

- **CISD** is the close through the open of the run's first candle, on 15m
  (was 12m, with a body-ratio and close-strength filter and a 50% tolerance
  the definition doesn't have).
- **The zone** is the OTE golden zone of the displacement leg, `fib.OTE`
  (was the 29.5%-50% retracement: a shallower pullback than OTE).
- **The entry** is a completed 3m bounce from the zone (was a touch of the
  band's bottom and a market entry on the next bar).
- **The sweep** is required, and it is of a key level (was optional, of any
  3-bar pivot).
- **Symmetric.** Version 3 used the band's bottom as the entry limit for
  both sides, so a short needed price to reach the band's far side from
  below (the source's asymmetry, kept for parity). The rewrite mirrors
  every step.
- **Target** 2R as a bracket (was a 2R / 0.5R trail).

The old port's parity tests against the bot's output went with the port
(tests/lib/parity.test.js keeps `orb`); the census compares the two
versions on Train (docs/research/cisd-ote-textbook.md).

## Examples

```text
Take (long). MNQ, 15m: two bearish candles from 09:45 ET (run open 21512.00);
the 10:00 candle trades to 21478.25, under the overnight low 21480.50, and
closes back above it; the 10:15 candle closes 21515.25 > 21512.00: bullish
CISD after a sweep of the overnight low. Leg: origin 21478.25, extreme
21530.25 (d = 52.00). OTE (fib.OTE of the leg): 21489.17-21498.01, mid 21493.59.
3m: the 11:00 bar trades to 21492.50 (in the zone) and closes 21500.25,
above the zone's top: the bounce.
ATR(20) 10.00 -> stop 21478.25 - 1.00 = 21477.25. Risk 23.00 pts = 92 ticks
= $46.00/MNQ. Target 2R = 21546.25.
rationale: "setup:cisd_ote long, 15m CISD after the ON low sweep, OTE bounce, stop 21477.25, risk $46.00"

Skip. 15m bearish CISD at 21640.00, but no key high was swept (cisd_sweep(15)
= 0): a CISD without the sweep is not this setup. No entry.

Loser. Same long as above: the 11:21 bar closes 21490.00, back in the zone;
the 11:30 bar trades to 21477.00, through the stop 21477.25: -1R, $46.00
plus costs. The zone held for one bar; the sweep low didn't.
```
