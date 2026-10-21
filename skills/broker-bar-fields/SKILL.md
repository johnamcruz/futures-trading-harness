---
name: broker-bar-fields
description: Use when a briefing has broker bar fields. Confirmation only.
---

# Broker Bar Fields

## When to Use

- The briefing's summary has a `Broker bar fields` line: fields the
  broker added to its last 3 bars (`m3.brokerFields`).
- Weighing whether a price-action read has more behind it than price and
  volume show.

## How It Works

A read, never a veto and never a setup: the priority order
(strategy-library) decides take, skip and size; the gate and the rulebook
are untouched. Thresholds are hypotheses; a missing field is `unknown`.

**What they are.** The broker computes them; the harness passes them
through untouched and gives them no meaning. The line lists each field by
its dotted path with its value on each of the last 3 bars, oldest first
(`null`: that bar had no value); the JSON (`bar_briefing` with `json`) has
them in full as `m3.brokerFields` (`paths`, `bars`; `omitted`: a bar's
fields too large to keep).

**Their meaning is the broker's.** What a field measures, its units and its
windows come from the broker's own documentation of its server. The
harness states none, and neither does this skill. Never guess one from its
name, and never work one out from OHLCV. A field whose meaning you were
not given is `unknown`; so is one that is null or missing.

**Reading one whose meaning you were given.** Read it against price, never
alone:

- **Confirms**: it agrees with the move on this bar and the bars before,
  and price progresses with it (`momentum-and-volume`).
- **Against**: it points one way while price makes no progress, or the
  other way while price moves (`absorption`).
- **No read**: the bars disagree, it sits near its neutral value, or it is
  `unknown`.

**Confirmation only.** It is part of participation in the count
(`confluence-counting`, with volume): FOR when it confirms the
read's side, AGAINST when it is against it, neutral otherwise. It never
makes a setup, never moves a stop and never sizes a trade.

**Evidence**: none measured.

## Examples

```text
Confirms: a long read at the opening range high; 3m momentum up; a field documented as
  rising with buying reads 0.38 / 0.51 / 0.42 while price rose 6.25 pts. Item 5 FOR.
Against: a short read at prior VAL; the same field reads -0.62 / -0.58 / -0.66 while the
  closes hold 21480.00 / 21480.50 / 21480.25. Item 5 AGAINST the short.
Unknown: a field with no documented meaning, or no Broker bar fields line: the read rests
  on price and volume.
```
