---
name: cisd_ote
description: Textbook CISD + OTE displacement and pullback - a strong completed 15-minute or 60-minute candle closes through the open of the run before it (a change in state of delivery); enter on the 3-minute bounce from the displacement leg's OTE zone, stop beyond the leg's origin. A prior key-level sweep is confluence, never required. Paper until a census and the owner promote it.
version: 4
status: paper                 # textbook rewrite of the old port: paper until the census (docs/research/cisd-ote-textbook.md) and the owner promote it
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m                 # the trigger: the bounce is read on completed 3-minute bars
signal: rules
mtf: reversal                 # may fade the prevailing higher-timeframe trend (the trend rule, multi-timeframe-analysis)
rules:
  long:
    - cisd_entry(15) > 0      # the bounce from a bullish 15m (or, with cisdHigherMinutes, 60m) CISD's OTE zone
  short:
    - cisd_entry(15) < 0
params:                       # the CISD hypotheses (scripts/lib/trading/cisd.js PARAMS; these are its defaults)
  cisdMinRun: 2               # a run is at least 2 consecutive opposing candles
  cisdMaxWait: 6              # the close through the run's open comes within 6 candles of the run's end
  cisdExpiry: 12              # the zone is good for 12 CISD candles (3 hours on 15m) after the CISD
  cisdVoidTol: 0.05           # a close more than 5% of the leg beyond the zone's far edge voids it
  cisdBufferAtr: 0.1          # the stop sits 0.1 x ATR(20) of 3m bars beyond the leg's origin
  cisdMinBody: 0.6            # the CISD candle is a strong displacement: body at least 0.6 of its range, the close in its extreme third,
  cisdMinRangeAtr: 1          # ... and a range at least 1.0 x ATR(14) of that timeframe's candles, or a body engulfing the prior one
  cisdHigherMinutes: 60       # the 60m CISD is taken too; when both bounce on one bar, the 60m one (the higher timeframe) wins
risk:
  stop: cisd_risk(15)         # from the bounce's close to beyond the leg's origin (the run's extreme), of the CISD that fired
  min_rr: 2                   # no exit block: the target is min_rr (2R), as a bracket
source: the owner's CISD definition (change in state of delivery; the cisd skill) and the OTE golden zone (the fib-retracement skill), rewritten from the version 3 port of the original bot (strategies/cisd_ote.py, cisd_ote_detect.py); detector in scripts/lib/trading/cisd.js, fib levels in scripts/lib/trading/fib.js
---

# Strategy: CISD + OTE (`setup:cisd_ote`)

Read the `cisd` skill (what a CISD is, and how to read it by timeframe) and
the `fib-retracement` skill (the OTE zone and the bounce) first: this
strategy is the two put together, mechanically.

## When to Use

- After a run of 15-minute candles, when a completed 15-minute candle
  closes back through the open of the run's first candle (a displacement),
  and price then pulls back into the leg's OTE zone.
- Stronger after a sweep of a key level (the prior RTH day's high or low,
  the overnight high or low in RTH, the prior session's high or low):
  confluence the scan reports (`cisd_sweep(15)`), never required.
- Any session: the source doesn't gate by time. The order gate's entry
  windows and daily limits still apply.

## How It Works

The detector is `scripts/lib/trading/cisd.js` (the rules series
`cisd_entry(15)`, `cisd_risk(15)`, and `cisd_sweep(15)` as confluence; the briefing's `cisd`
block shows the same facts per timeframe). Every step reads completed
candles only.

1. **CISD on 15m or 60m.** A run of at least `cisdMinRun` consecutive
   bearish candles; then, within `cisdMaxWait` candles, a completed candle
   closes above the open of the run's first candle: a bullish CISD at that
   level. Bearish: the mirror (bullish run, close below its first open).
   Both timeframes are read (`cisdHigherMinutes: 60`); when a 15m and a 60m
   bounce fire on the same 3m bar, the 60m one is the trade (its stop).
2. **A strong displacement (required).** The candle that closes through
   the level must be strong (hypotheses, `scripts/lib/trading/cisd.js`):
   body at least `cisdMinBody` of its range, its close in the extreme third
   the CISD's way, and either a range of at least `cisdMinRangeAtr` x
   ATR(14) of that timeframe's candles or a body engulfing the prior
   candle's. A doji, a small body, long wicks or a close mid-range is a
   weak CISD: no zone, no fib, no entry (the briefing's `displacement`).
3. **The sweep (confluence, not required).** From the run's start to the
   confirmation, a candle traded below a key low at or under the level and
   a close came back above it (`cisd_sweep(15)`; bearish: a key high). A
   CISD after a sweep is stronger confluence; the rules don't ask for it.
4. **The OTE zone.** The displacement leg runs from the origin (the run's
   extreme: the lowest low from the run's start to the confirmation, the
   sweep extreme when there was a sweep) to the
   extreme (the highest high since, extended while price keeps making new
   highs before it first retraces into the zone). The zone is `fib.OTE` of
   that leg (`scripts/lib/trading/fib.js`; the `fib-retracement` skill).
5. **The bounce (the entry).** On 3-minute bars after the CISD's candle closed:
   price trades into the zone, then a completed 3m bar that traded in the
   zone closes back in the trade direction: above the zone's top, or
   bullish with its close in the upper third of its range and inside the
   zone (bearish: the mirror). Enter on that close; one entry per CISD.
6. **Void and expiry.** A 3m close beyond the origin, or beyond the zone's
   far edge by more than `cisdVoidTol` of the leg, voids the zone; so does
   a newer CISD. The zone expires `cisdExpiry` candles of its timeframe
   after the CISD.
7. **Stop:** `cisdBufferAtr` x ATR(20) beyond the origin (the run's
   extreme). **Target:** `min_rr` (2R), as a bracket: no exit block.

Why 15m for the CISD and 3m for the trigger: the definition leans on key
levels and the higher-timeframe context, and a 3m CISD (two red candles and
a green close) fires many times a session on noise. A 15m CISD is the
top-down pairing the `cisd` skill teaches (the 15m shift, the
3m entry), and its leg is wide enough that a 3m bounce inside the zone can
be told from a slice through it. The 60m CISD is the higher-timeframe
shift; it is preferred when both fire. The CISD timeframes are the `(15)`
in the rules and the stop and `cisdHigherMinutes`; `cisd_entry(3)` /
`cisd_risk(3)` is the 3m variant the census also measures.

### Skip when (judgment: the mechanics take every signal)

- The higher timeframe is cleanly against the CISD, no key level was
  swept, and the CISD is the only reversal sign (the `cisd` skill:
  confluence, not a standalone).
- The first level ahead of the bounce is closer than 1R (levels-and-reactions).
- Risk to the origin is above the position-sizing budget at size 1.

## What changed from version 3 (the port), and why

Version 3 was a line-for-line port of the original bot's `cisd_ote` (12m
candles, a displacement-quality filter, a 50%-70.5% fib band measured from
the leg's origin, which is a 29.5%-50% retracement, a market entry when a
3m bar touched the band's bottom, and the stop at the pivot). Replaced, on
the owner's decision, by the textbook definition:

- **CISD** is the close through the open of the run's first candle, on 15m
  or 60m, by a strong displacement candle (was 12m, with a 0.3 body-ratio
  and 0.4 close-strength filter and a 50% tolerance).
- **The zone** is the OTE golden zone of the displacement leg, `fib.OTE`
  (was the 29.5%-50% retracement: a shallower pullback than OTE).
- **The entry** is a completed 3m bounce from the zone (was a touch of the
  band's bottom and a market entry on the next bar).
- **The sweep** is of a key level and reported as confluence, never
  required (was optional, of any 3-bar pivot). The owner's call: the
  strategy is a basic displacement and pullback; the census's pre-registered
  N1 required the sweep, the shipped rules are its variant N3.
- **Symmetric.** Version 3 used the band's bottom as the entry limit for
  both sides, so a short needed price to reach the band's far side from
  below (the source's asymmetry, kept for parity). The rewrite mirrors
  every step.
- **Target** 2R as a bracket (was a 2R / 0.5R trail).

The old port's parity tests against the bot's output went with the port
(tests/lib/parity.test.js keeps `orb`); the census compares the two
versions on Train (docs/research/cisd-ote-textbook.md): the textbook
version scored worse than the port there, and the owner chose to replace
the port anyway; it stays paper.

## Examples

```text
Take (long). MNQ, 15m: two bearish candles from 09:45 ET (run open 21512.00);
the 10:00 candle trades to 21478.25, under the overnight low 21480.50, and
closes back above it; the 10:15 candle (O 21479.00, H 21517.75, L 21478.50,
body 0.92 of its range, closing in its top third, engulfing the 10:00 body)
closes 21515.25 > 21512.00: bullish
CISD, after a sweep of the overnight low (confluence). Leg: origin 21478.25, extreme
21530.25 (d = 52.00). OTE (fib.OTE of the leg, on the tick as the briefing shows
it): 21489.25-21498.00, mid 21493.50.
3m: the 11:00 bar trades to 21492.50 (in the zone) and closes 21500.25,
above the zone's top: the bounce.
ATR(20) 10.00 -> stop 21478.25 - 1.00 = 21477.25. Risk 23.00 pts = 92 ticks
= $46.00/MNQ. Target 2R = 21546.25.
rationale: "setup:cisd_ote long, 15m CISD (ON low swept), OTE bounce, stop 21477.25, risk $46.00"

Skip. 15m bearish CISD at 21640.00, but its candle is a doji (body 0.08 of its
range, closing mid-range): a weak displacement, no zone, no fib. No entry.
Skip. 15m bearish CISD at 21640.00, strong; price pulls back into the zone,
then a 3m bar closes beyond the zone's far edge by more than cisdVoidTol of
the leg: the zone is void before any bounce. No entry.

Loser. Same long as above: the 11:21 bar closes 21490.00, back in the zone;
the 11:30 bar trades to 21477.00, through the stop 21477.25: -1R, $46.00
plus costs. The zone held for one bar; the leg's origin didn't.
```
