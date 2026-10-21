---
name: confluence-counting
description: Trader-process step 5 - count what is for, against or neutral, each item once, the same way every time; the count decides take or pass.
---

# Confluence Counting

## When to Use

- Trader-process step 5: `5 Confluence: for <n>, against <n>, neutral <n>: <main ones>`.

## How It Works

**The count decides**, on the trend rule's side: for at least against + 2
→ take, sized by conviction within the verdict's ceiling; else pass. No
against read is a pass alone; the hard steps stay hard (strategy-library).
A missing field is `unknown` and counts neutral.

**Six items**, each in exactly one bucket, so for + against + neutral = 6:

| # | Item | For | Against | Neutral |
|---|---|---|---|---|
| 1 | HTF read, `m15.alignment` for its side (HTF breaks included) | `aligned` | `counter` | `pullback`, `mixed`, null |
| 2 | Setup-timeframe structure: a CISD, OTE, a 3m or 5m break (`cisd`, `bos-vs-choch`) | any its way | any against it | none |
| 3 | VWAP, `m3.vwap.side` | its side | the other side | `at` |
| 4 | Reaction at the nearest level (`levels-and-reactions`, `rejection`) | rejection or sweep its way | acceptance against it | none yet |
| 5 | Momentum, participation and indicators (`momentum-and-volume`, `absorption`) | all with it | all against it | mixed or thin |
| 6 | Other reads of a fact already counted | - | - | always |

**Rules.**

- **Other reads of the same fact count once** (item 6): a pattern on the
  candle that made item 4's rejection, a CISD or a sweep on that candle, a
  second timeframe of the same reaction.
- **Indicators together are one item**: EMA, ADX and SuperTrend readings
  count together in item 5, never separately.
- **An HTF structure break is read in item 1**: a 15m or 1h break its way (`bos-vs-choch`;
  `m15.lastBreak.last`, `h1.lastBreak.last`), or its absence, is part of
  the HTF read, never an item of its own.
- **A reaction counts once in item 4.** A rejection on several timeframes
  is one reaction, not one per timeframe.
- **Context, never a pass alone**: the first level ahead, the VWAP
  distance (no edge in the census), an analyst's read against.
- **Not counted**: the trend rule, the regime fit, the window, the news:
  the priority order's own steps or the gate's.

## Examples

```text
Take: long: 6 neutral (15m pattern hammer, the candle of 4); 1 aligned, 2 15m cisd up, 3 vwap above,
  4 15m rejected prior vah up, 5 momentum: for. 5 Confluence: for 5, against 0, neutral 1.
  -> take.
Skip: long: 1 mixed, 4 none yet, 5 thin, 6: neutral; 2 3m choch down, 3 vwap below: against.
  5 Confluence: for 0, against 2, neutral 4. -> pass.
Loser: for 4, against 0, neutral 2; long at 21540.25, stop 21512.50
  (27.75 pts = 111 ticks, $55.50 on 1 MNQ). -111 ticks, -$55.50. A high count is odds, not a promise.
```
