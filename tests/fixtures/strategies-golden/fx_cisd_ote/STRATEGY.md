---
name: fx_cisd_ote
description: A test fixture strategy - the rules of the retired cisd_ote strategy (2026-10-14), kept so the decision goldens and the code it exercises (the rules language, bar fields, detectors) stay pinned. Test use only.
version: 4
status: paper                 # textbook rewrite of the old port: paper until the census (docs/research/cisd-ote-textbook.md) and the owner promote it
instruments: [MNQ, MES, MYM, M2K]
timeframe: 3m                 # the trigger: the bounce is read on completed 3-minute bars
signal: rules
mtf: trend                    # with the prevailing HTF trend (a pullback ending), or either way with none (a range); a fade is refused by the trend rule
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
source: tests/fixtures/strategies-golden (test fixture; loaded with FTH_STRATEGIES_DIRS)
---

# Strategy: Fixture cisd_ote (`setup:fx_cisd_ote`)

A fixture: the rules of the retired `cisd_ote` strategy (strategies/README.md,
"Retired strategies"), unchanged, so the decision goldens and the code they
exercise stay pinned. Never shipped; never traded.

## When to Use

- Tests only, loaded with `FTH_STRATEGIES_DIRS=tests/fixtures/strategies-golden`.

## How It Works

The frontmatter's rules, as the retired strategy had them.

## Examples

```text
fx_cisd_ote: fires where the retired cisd_ote fired, with the same stop
```
