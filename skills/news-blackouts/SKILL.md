---
name: news-blackouts
description: Use when building today's news blackouts - the event times, their windows, and blackouts_add.
---

# News Blackouts

## When to Use

- Premarket: build today's news blackout list.

## How It Works

The scheduled events that move equity index futures (ET; the clock: the
`session-timing` skill):

| Window (ET) | Character | Harness |
|---|---|---|
| 08:30 | US data (CPI, NFP, PPI, retail sales, claims) | Blackout 08:25–08:40 |
| 10:00 | ISM, JOLTS, consumer confidence | Blackout 09:55–10:10 |
| 14:00 | FOMC statement (8×/yr), 14:30 presser | Blackout 13:55–15:00 |

Metals (MGC) and crude (MCL) have their own sessions: crude reacts to EIA
inventory (Wednesday 10:30 ET); gold to US data and rates.

**Blackouts.** The order gate reads `~/.futures-trading-harness/blackouts/blackouts.json`
(or `FTH_BLACKOUTS_FILE`): a JSON array of `{ "start": ISO-8601, "end":
ISO-8601, "reason": "CPI" }`. During premarket, after confirming the
day's calendar, add the high-impact events from 5 minutes before to 10
minutes after (FOMC: 13:55 to 15:00 ET) with the harness tool `blackouts_add`
(`{"start": "<ISO>", "end": "<ISO>", "reason": "<event>"}`).
It is append-only; never edit the file by hand.

## Examples

```json
[
  { "start": "2026-10-14T12:25:00Z", "end": "2026-10-14T12:40:00Z", "reason": "CPI 08:30 ET" },
  { "start": "2026-10-28T17:55:00Z", "end": "2026-10-28T19:00:00Z", "reason": "FOMC 14:00 ET" }
]
```
