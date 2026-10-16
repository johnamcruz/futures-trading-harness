---
name: session-timing
description: Use when timing an entry - the trading day, its sessions, and the windows that allow entries.
---

# Session Timing

## When to Use

- Before any entry: is this a good time for this setup?

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
Bar data still comes from the Globex session,
so the session VWAP, session volume profile and overnight range start at
18:00 ET.
Named sessions: `asia` 18:00–03:00, `london` 03:00–09:30,
`ny` 09:30–16:00. One (the firm's) trading day runs from the 18:00 ET open to the 16:00 ET
close and is named by the date it ends on (Sunday evening and Monday are
Monday's day); midnight changes nothing. Everything counted by the day uses
it: losses and entries for the gate, end of day, the prop attempt's closes,
the journal's day, and the holiday calendar. Equity index futures (NQ/ES/YM/RTY and micros):

| Window (ET) | Character | Harness |
|---|---|---|
| 18:00 (Sun–Thu) | The firm's trading day starts (its daily reset); Globex open | Session opens; daily counters reset |
| 18:00–03:00 | Asia (`asia`), thinner | Entries allowed; overnight setups ran negative (Train, docs/research/mtf-setup-catalog.md): full confluence only |
| 03:00–09:30 | London (`london`); often sets the overnight range | Mark ONH/ONL |
| 09:30–09:35 | Opening print, widest spreads; five minutes only | No entries (gate) until 09:35 |
| 09:35–11:00 | Opening drive; best trend window (`ny` from 09:30) | Entries allowed |
| 11:00–11:30 | Late morning; the drive fades | Trade only a clean setup |
| 11:30–13:30 | Lunch lull; low volume, false breaks | Reduce or stand aside |
| 13:30–15:45 | Afternoon; entries allowed until 15:45 | Normal rules |
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

Metals (MGC) and crude (MCL) have their own sessions: crude reacts to EIA
inventory (Wednesday 10:30 ET); gold to US data and rates.

News windows: the `news-blackouts` skill; holidays and early closes: the
`exchange-holidays` skill; the quarterly roll: the `contract-roll` skill.

## Examples

Tuesday 10:00 ET is inside the session (it opened Monday 18:00 ET): the
opening drive, entries allowed until 11:00 ET. Tuesday 15:47 ET is into the
close: no entries.
