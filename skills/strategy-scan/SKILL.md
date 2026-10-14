---
name: strategy-scan
description: Read strategy scans - candidates, why not, trend flags, confluence.
---

# Strategy Scan

## When to Use

- Reading a scan or recent fires.

## How It Works

### Read the library

With the harness tools (the `strategy-tools` skill):

```text
strategies_list {}                       name, status, signal, instruments
strategies_show {"name": "orb"}          the full STRATEGY.md
strategies_scan {"bars": "<bars file>", "symbol": "MNQ"}                 summary: candidates, then a line per strategy
strategies_scan {"bars": "<bars file>", "symbol": "MNQ", "name": "orb"}   one strategy's full result
strategies_list {"json": true}           machine-readable
strategies_recent {"bars": "<bars file>", "symbol": "MNQ", "count": 5}   what fired on each of the last 5 bars
```

`recent` answers the skip rules about recent signals ("fired the other way
in the last 5 bars"). A strategy's full scan result (`name`) has `detail`, the detectors' state:
a CRT's candle (`c1Open`/`c1High`/`c1Low`/`c1Close`) and why it did or didn't
fire, and cisd_ote's `cisd(15)`: the CISD level, the leg, the zone, the stop
and the swept level.

`strategies_scan` judges sessions at the current time (the harness clock: a
replay broker's replayed time when `FTH_REPLAY_NOW` is set); it takes no time
of its own (a person replaying a file runs the strategies script's scan with `--now`).
With `FTH_REPLAY_NOW` set but no real replay broker, or not an ISO 8601 UTC
time, the scan refuses (tell the user). It reads the
signal on the file's last closed bar, and only for the strategies whose
timeframe is the file's (the bars' spacing), as the runner does: on 3m bars
the 1m strategies are not in the result at all (a 1m strategy's signal comes
from 1m bars only). `name` on a strategy of another timeframe is refused,
naming both timeframes; fetch bars on that strategy's timeframe to scan it.
On bars no strategy trades (15m, say) the scan says so and lists the
timeframes the strategies trade: that is not "no setup", it is the wrong bars.
Read the result only when that last bar is fresh (no older than one bar plus
a minute).

The scan's summary gives the bar, the higher-timeframe trends, the
candidates first (side, entry reference, stop distance, min R:R, exit,
confluence), then one line per strategy: status, timeframe, direction,
candidate, and why not (the rules that did not hold, outside its sessions,
the regime, or what failed). The values that rules reading a broker field
saw on the bar appear in two places only: a candidate's `values:` (its side's
rules that held; for an `any(...)` group, the branches that held), and, when
no rule set fired, next to each rule that did not hold, `[field("a.b")=0.42]`
(`missing` when the bar has none; at most 6 per strategy, the rest counted).
A strategy that fired but failed a filter shows none. A field's meaning and
units are in the strategy's own document (`strategies_show`); never guess them. For one strategy's full result, call it with
`name`; `detail: true` returns every strategy's (large). The scan runs
market-snapshot with each strategy's `params`, and a full result reports:
`direction` (mechanical signal on the last closed bar),
`filtersFailed`, `inSession`, `regime` (the computed regime of these bars),
`inRegime` (fits the strategy's `regimes`: the trend-following strategies,
`orb`, `value_area_breakout` and `vwap_reclaim`, never trade a range, and the order gate refuses
their entries there too), `confluence` (on a strategy
that fired: the other strategies on its timeframe that fired the same side,
`with`, and the other side, `against`), `mtf` (the trend rule: the 4h,
1h, 15m trends, the `prevailing` one, and `longAllowed` / `shortAllowed` for
this strategy's style; its `reason` names the side it blocks, e.g. "longs are
against the prevailing 15m down trend …; shorts are with it"), `candidate`,
and `stopDistance`. Read the flag for the side the strategy fired: a short
with `shortAllowed: true` is with the trend, whatever the reason says about
longs. A trend strategy that fires against the prevailing trend is never a
candidate (`filtersFailed` says `mtf: ...`); only `mtf: reversal` strategies
may fade it. `signal: rules`
strategies also list each rule with `ok: true|false`, so you can explain why
one did or didn't fire. Strategies with `signal: manual` are listed
as candidates when in session; you evaluate their trigger from the body.

## Examples

```text
strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none (a candidate)
```
