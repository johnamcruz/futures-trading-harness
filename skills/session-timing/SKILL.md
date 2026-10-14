---
name: session-timing
description: Futures session clock for CME equity index, metals, and energy - Globex vs RTH, opening drive, lunch lull, close, prop-firm cut-offs, and scheduled news. Use when timing an entry, choosing strategies for the time of day, or setting news blackouts.
---

# Session Timing

## When to Use

- Before any entry: is this a good time for this strategy?
- Premarket: build today's news blackout list.

## How It Works

All times America/New_York (ET) unless marked CT. The harness follows the
prop firm's trading day, not CME's: it starts at 18:00 ET (the firm's
daily reset), and the harness trades it until 16:00 ET the next day, Sunday
evening to Friday afternoon (a hard rule in the order gate), stopping before
the firm's own flatten deadline, which comes after 16:00 ET. The market is open that whole time,
09:30-16:00 ET included: a time
like 10:00 ET is inside the session, not before it, and so is 08:00 ET (the
18:00 ET open was the evening before; 09:30 ET is only the RTH cash open).
16:00 to 18:00 ET is treated as closed (no entries, no positions), and so
are weekends. Every position is flat by the runner's end of day (`eodAt`,
15:50 ET by default), well before the firm's own flatten deadline.
(Background only: CME's Globex keeps trading until 17:00 ET; the harness
never trades 16:00-18:00 ET.) Bar data still comes from the Globex session,
so the session VWAP, session volume profile and overnight range start at
18:00 ET.
Named sessions for strategies: `asia` 18:00–03:00, `london` 03:00–09:30,
`ny` 09:30–16:00. One (the firm's) trading day runs from the 18:00 ET open to the 16:00 ET
close and is named by the date it ends on (Sunday evening and Monday are
Monday's day); midnight changes nothing. Everything counted by the day uses
it: losses and entries for the gate, end of day, the prop attempt's closes,
the journal's day, and the holiday calendar. Equity index futures (NQ/ES/YM/RTY and micros):

| Window (ET) | Character | Harness |
|---|---|---|
| 18:00 (Sun–Thu) | The firm's trading day starts (its daily reset); Globex open | Session opens; daily counters reset |
| 18:00–03:00 | Asia (`asia`), thinner | Trade only strategies built for it |
| 03:00–09:30 | London (`london`); often sets the overnight range | Mark ONH/ONL |
| 08:30 | US data (CPI, NFP, PPI, retail sales, claims) | Blackout 08:25–08:40 |
| 09:30–09:35 | Opening print, widest spreads; five minutes only | No entries (gate) until 09:35 |
| 09:35–11:00 | Opening drive; best trend and ORB window (`ny` from 09:30) | Entries allowed; primary window for ORB |
| 10:00 | ISM, JOLTS, consumer confidence | Blackout 09:55–10:10 |
| 11:00–11:30 | Late morning; the drive fades | Trade only a clean setup |
| 11:30–13:30 | Lunch lull; low volume, false breaks | Reduce or stand aside |
| 13:30–15:45 | Afternoon; entries allowed until 15:45 | Normal rules |
| 14:00 | FOMC statement (8×/yr), 14:30 presser | Blackout 13:55–15:00 |
| 15:45–16:00 | Into the close | No entries (gate); end of day flattens at 15:50 |
| 16:00–18:00 | Daily break (the harness's day is over; the firm's own flatten deadline falls in it) | Closed: no entries, no positions (hard rule); the harness is flat by 15:50 ET (runner), 16:00 ET at the latest |

By default only three windows forbid entries by the clock: the opening
print (09:30-09:35), into the close (15:45-16:00), and the daily break
(16:00-18:00, the market closed). The opening drive is not the opening
print: from 09:35 entries are allowed. The gate's configured windows apply
in their place (`FTH_NO_ENTRY_WINDOWS`, and `FTH_ENTRY_HOURS`, entries only
inside its windows), and the bar briefing reads the same config, so it says
what the gate will do. It states the window with its scope, never just its
name: `m3` `window` (the name), `windowUntil`, `windowEntries` (`allowed` or
`none`), `windowRefusal` (the gate's reason, when none), `marketOpen`, and
`windowText`, which the summary's `Session:` line shows, e.g. "opening drive
(market open, entries allowed) until 11:00 ET" or "opening print (market
open, no entries) until 09:35 ET"; its end is when that answer changes. Take
a window's end from it; never infer one (the opening type due at 10:00 ET
and the initial balance at 10:30 ET are reads of the open, not entry
windows). A window that allows entries doesn't lift the gate's other
refusals: the briefing states news blackouts on its own `News` line, and
the gate states holidays and early closes when it refuses an entry (the
briefing's window doesn't know them).

**Holidays and early closes.** The harness treats every exchange holiday
as closed (New Year's Day, MLK Day, Presidents Day, Good Friday, Memorial
Day, Juneteenth, Independence Day, Labor Day, Thanksgiving, Christmas), even
where CME runs a short session: no trading at all that day. The day after
Thanksgiving and Christmas Eve are early closes (13:00 ET). The harness
carries this calendar for 2026-2027
(`scripts/lib/trading/exchange-calendar.js`).
The runner config (`closedDates`, `earlyCloseDates`) and the gate's
`FTH_CLOSED_DATES` / `FTH_EARLY_CLOSE_DATES` add days to it, never remove
one (trading days, YYYY-MM-DD of the day they end on). The gate refuses
entries on a closed day and after 13:00 ET on an early-close day, and the
runner flattens at `earlyCloseEodAt` (default 12:50 ET). After the
calendar's last day the gate refuses every entry (market-hours: "The
exchange calendar ends ..."); the runner warns once a day for the 30 days
before it. Configured dates extend it only a whole year at a time (every
holiday and every early close of the year). Tell the user; never work around it. Premarket checks the calendar; if
CME announces a change that isn't listed, tell the user and plan as if it
were (no entries after 12:45 ET, flat by 12:50 ET).

**Contract roll.** Equity index futures expire quarterly (H Mar, M Jun, U
Sep, Z Dec) on the third Friday; volume moves to the next contract about
eight days earlier (the roll, the Thursday or Friday before). Trade the
front month by its plain name (`MNQ`): the harness maps it to the contract the
broker marks active, once per trading day, so after the roll `MNQ` is the new
month and the old one shows as `MNQ:2026-12`. Exit a position by the name
`list_open_positions` shows for it: the gate matches the exact month, so an
exit by another month (or by the root, for an old-month position) is refused,
since it would open a new position. Bars from before the
roll come from the old contract at a different price (the spread between
months): levels, VWAP, and swings that straddle the roll day are not
comparable; prefer the new contract's own bars for levels on roll days.

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
