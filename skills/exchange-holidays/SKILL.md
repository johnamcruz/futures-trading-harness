---
name: exchange-holidays
description: Use when checking for an exchange holiday or an early close.
---

# Exchange Holidays

## When to Use

- Premarket: is today closed or an early close?
- The gate refused an entry for a closed day, an early close or the calendar's end.

## How It Works

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

## Examples

Friday 2026-11-27, the day after Thanksgiving, is an early close: an entry
at 12:30 ET can go, the gate refuses one at 13:05 ET, and the runner is
flat at 12:50 ET. Thursday 2026-11-26 is closed: no trading at all.
