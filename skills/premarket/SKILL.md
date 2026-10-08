---
name: premarket
description: Read-only premarket preparation - parallel analyst, news, and risk roles, then a game plan with levels, strategies in play, risk budget, and order-gate news blackouts. Use before the session opens or when the user asks for a plan of the day. Places no orders.
---

# Premarket

## When to Use

- At the start of the trading day (the runner runs it at 18:05 ET, after the
  18:00 ET open), or on request. It prepares the whole trading day, which
  ends at 16:00 ET the next afternoon: the Asia, London, and New York
  sessions and that day's 08:30 ET data.

## How It Works

1. `get_server_config`; `search_contracts` for the symbol (active contract,
   tickSize, tickValue); the account (the cycle prompt's account line, else
   `get_account_snapshot`, and `node <root>/scripts/combine.js status` for a
   running prop attempt): today's game plan is sized from its balance, the
   room to the daily limits, and for an attempt the cushion and budget.
2. Run in parallel (as in trade-session step 2): the three market analysts,
   `news-calendar-analyst` for the trading day's date (the date it ends on,
   as the prompt says), and `risk-manager` phase 1.
3. Blackouts: add each proposed window with the append-only script (it can't
   remove a window, so blackouts only ever restrict trading):
   `node <root>/scripts/blackouts.js add --start <ISO> --end <ISO> --reason "<event>"`.
4. Game plan (you, as head trader):
   - Bias per timeframe from the multi-timeframe read
     (`node <root>/scripts/mtf.js <bars> --daily=<daily bars>`, see the
     `multi-timeframe-analysis` skill): one line per timeframe, the alignment
     for longs and shorts, and where analysts disagree.
   - Key levels table (price, what, source).
   - Strategies in play: from `node <root>/scripts/strategies.js list --json`
     (status, sessions, instruments), the active ones for this
     symbol whose sessions are today, with the exact trigger each needs.
     Strategies to avoid today, with reasons.
   - Risk budget and stand-down conditions; event windows.
   - The calendar: a CME holiday or an early close today (from the news
     analyst) that the runner config doesn't list → tell the user (it goes in
     `closedDates` / `earlyCloseDates`) and plan for it (see `session-timing`).
     A contract roll this week → the active contract from `search_contracts`,
     and levels from before the roll read with care.
5. `journal_add {kind:"note", contractId, tags:["premarket", "<SYMBOL>"]}` with
   the game plan, then show it.

## Examples

```text
MNQ premarket 18:05 ET for the trading day 2026-10-08: daily range
20900-21700, 1h uptrend, PDH 21640 / PDL 21480, settlement 21610. CPI 08:30
tomorrow (blackout 08:25-08:40 ET). In play: ema_cross and supertrend all
session; orb in ny only (ADX gate). Avoid cisd_ote longs below PDH. Budget
$40/trade, $160/day; stop after 2 losses.
```
