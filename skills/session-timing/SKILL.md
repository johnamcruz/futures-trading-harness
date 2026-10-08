---
name: session-timing
description: Futures session clock for CME equity index, metals, and energy - Globex vs RTH, opening drive, lunch lull, close, Topstep cut-offs, and scheduled news. Use when timing an entry, choosing strategies for the time of day, or setting news blackouts.
---

# Session Timing

## When to Use

- Before any entry: is this a good time for this strategy?
- Premarket: build today's news blackout list.

## How It Works

All times America/New_York (ET) unless marked CT. The harness trades the
Topstep session, 18:00 ET to 16:00 ET, Sunday evening to Friday afternoon
(a hard rule in the order gate): nothing from 16:00 to 18:00 ET or on
weekends, and every position flat by end of day (`eodAt`, by 16:00 ET).
Named sessions for strategies: `asia` 18:00–03:00, `london` 03:00–09:30,
`ny` 09:30–16:00. Equity index futures (NQ/ES/YM/RTY and micros):

| Window (ET) | Character | Harness |
|---|---|---|
| 18:00 (Sun–Thu) | Globex open; trading day starts (17:00 CT) | Session opens; daily counters reset |
| 18:00–03:00 | Asia (`asia`), thinner | Trade only strategies built for it |
| 03:00–09:30 | London (`london`); often sets the overnight range | Mark ONH/ONL |
| 08:30 | US data (CPI, NFP, PPI, retail sales, claims) | Blackout ±5–10 min |
| 09:30–09:35 | Opening print, widest spreads | No entries (gate) |
| 09:35–11:00 | Opening drive; best trend and ORB window (`ny` from 09:30) | Primary window for ORB |
| 10:00 | ISM, JOLTS, consumer confidence | Blackout ±5 min |
| 11:30–13:30 | Lunch lull; low volume, false breaks | Reduce or stand aside |
| 14:00 | FOMC statement (8×/yr), 14:30 presser | Blackout 13:55–15:00 |
| 15:45–16:00 | Into the close | No entries (gate); end of day flattens at 15:50 |
| 16:00–18:00 | Daily break | Closed: no entries, no positions (hard rule) |
| 16:10 ET / 15:10 CT | Topstep's own flatten | The harness is flat by 16:00 ET |

Metals (MGC) and crude (MCL) have their own sessions: crude reacts to EIA
inventory (Wednesday 10:30 ET); gold to US data and rates.

**Blackouts.** The order gate reads `~/.futures-trading-harness/blackouts/blackouts.json`
(or `FTH_BLACKOUTS_FILE`): a JSON array of `{ "start": ISO-8601, "end":
ISO-8601, "reason": "CPI" }`. During premarket, after confirming the
day's calendar, add the high-impact events with a 5–10 minute buffer on each
side using `node <root>/scripts/blackouts.js add --start <ISO> --end <ISO> --reason <event>`.
The script is append-only; never edit the file by hand.

## Examples

```json
[
  { "start": "2026-10-14T12:20:00Z", "end": "2026-10-14T12:40:00Z", "reason": "CPI 08:30 ET" },
  { "start": "2026-10-28T17:55:00Z", "end": "2026-10-28T19:00:00Z", "reason": "FOMC 14:00 ET" }
]
```
