---
name: confluence-counting
description: What counts for, against or neutral in trader-process step 5 - six items, each counted once - so the confluence counts are the same every time and testable. Correlated strategies firing together count as one; a strategy's own trigger is never confluence for itself. A read; the priority order decides.
---

# Confluence Counting

## When to Use

- Trader-process step 5: `5 Confluence: for <n>, against <n>, neutral <n>: <main ones>`.

## How It Works

A read, never a veto: the priority order (strategy-library) decides take,
skip and size; the gate and the rulebook are untouched. The counts never
overrule it. A missing field is `unknown` and counts neutral.

**Six items**, each in exactly one bucket, so for + against + neutral = 6:

| # | Item | For | Against | Neutral |
|---|---|---|---|---|
| 1 | HTF read, `candidate.alignment` | `aligned` | `counter` | `pullback`, `mixed`, null |
| 2 | Other strategies, `candidate.confluence.with` / `candidate.confluence.against` | any with it | any against it | none |
| 3 | VWAP, `candidate.vwapSide` | its side | the other side | `at` |
| 4 | Reaction at the nearest level (`levels-and-reactions`) | rejection or sweep its way | acceptance against it | none yet |
| 5 | Bar momentum and participation (`momentum-and-volume`, `absorption`) | with it | against it | thin or mixed |
| 6 | Its own `candidate.values` | - | - | always |

**Rules.**

- **Correlated fires count as one.** Strategies whose triggers read the
  same indicator or structure event fire largely together. Same-side
  fires from correlated strategies within a few bars are ONE confluence.
  `candidate.confluence` is this bar; earlier bars, `strategies_recent`.
- **A strategy's own trigger is never confluence for itself**: its
  `candidate.values` are its own rules' readings (item 6, neutral).
- **Indicators together are one item**: EMA, ADX and SuperTrend readings
  count together in item 5, never separately; a structure break counts in
  item 4.
- **Not counted**: the trend rule, the regime fit, the room, the window,
  the news: the priority order's own steps or the gate's.

## Examples

```text
Take: vwap_reclaim long: 1 aligned, 2 orb with it, 3 above VWAP, 4 rejection, 5 momentum: for; 6 neutral.
  5 Confluence: for 5, against 0, neutral 1. Priority order: room -> take.
Skip: orb long: 1 mixed, 4 none yet, 5 thin, 6: neutral; 2 cisd_ote short, 3 below VWAP: against.
  5 Confluence: for 0, against 2, neutral 4. Priority order (step 6, the other side): skip.
Loser: for 4, against 0, neutral 2; vwap_reclaim long at 21522.75, stop 21516.50
  (6.25 pts = 25 ticks, $12.50 on 1 MNQ). -25 ticks, -$12.50. A high count is odds, not a promise.
```
