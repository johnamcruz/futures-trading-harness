---
name: premarket
description: Read-only premarket preparation - parallel analyst, news, and risk roles, then a game plan with levels, strategies in play, risk budget, and order-gate news blackouts. Use before the session opens or when the user asks for a plan of the day. Places no orders.
---

# Premarket

## When to Use

- Before 09:30 ET, at the start of an autonomous day, or on request.

## How It Works

1. `get_server_config`; `search_contracts` for the symbol (active contract,
   tickSize, tickValue).
2. Run in parallel (as in trade-session step 2): the three market analysts,
   `news-calendar-analyst` for today's date, and `risk-manager` phase 1.
3. Blackouts: add each proposed window with the append-only script (it can't
   remove a window, so blackouts only ever restrict trading):
   `node <root>/scripts/blackouts.js" add --start <ISO> --end <ISO> --reason "<event>"`.
4. Game plan (you, as head trader):
   - Bias per timeframe and where analysts disagree.
   - Key levels table (price, what, source).
   - Strategies in play: from `strategies.js list`, the active ones for this
     symbol whose sessions are today, with the exact trigger each needs.
     Strategies to avoid today, with reasons.
   - Risk budget and stand-down conditions; event windows.
5. `journal_add {kind:"note", contractId, tags:["premarket", "<SYMBOL>"]}` with
   the game plan, then show it.

## Examples

```text
MNQ premarket 2026-10-08: daily range 20900-21700, 1h uptrend, ONH 21655 /
ONL 21580, PDH 21640. CPI 08:30 (blackout 08:20-08:40 ET). In play: orb (ADX
gate), ema_cross after 09:35. Avoid cisd_ote longs below PDH. Budget $40/trade,
$160/day; stop after 2 losses.
```
