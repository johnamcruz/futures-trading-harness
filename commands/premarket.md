---
description: Read-only premarket preparation - runs the structure, trend, volume, news, and risk agents in parallel, then writes a game plan and news blackouts. Places no orders.
argument-hint: "[SYMBOL=MNQ] [account id]"
---

# /premarket

Prepare the session for `$ARGUMENTS` (default symbol MNQ). Read-only: no
orders in this command.

## Steps

1. `get_server_config` and `search_contracts` for the symbol (take
   `activeContract=true`; note contractId, tickSize, tickValue).
2. **In one message, launch these five agents in parallel** with the Agent
   tool, passing the symbol, contractId, and current time:
   - `market-structure-analyst`
   - `trend-momentum-analyst`
   - `volume-liquidity-analyst`
   - `news-calendar-analyst` (today's date and the symbol)
   - `risk-manager` ("Phase 1 risk state", with the account id if given)
3. When all five return, write blackouts: merge the news analyst's proposed
   JSON into `~/.futures-trading-harness/blackouts.json` (create the folder;
   keep existing future entries; drop entries that ended more than a day ago).
   Only add restrictions; never remove a future blackout.
4. Synthesize the **game plan** (you are the head trader):
   - Bias per timeframe and where the analysts agree or disagree.
   - Key levels table (price, what, source analyst).
   - Playbooks in play today, with the exact trigger price/condition each needs,
     and playbooks to avoid (with the reason).
   - Risk budget from the risk manager; stand-down conditions.
   - Event windows.
5. Save it with `journal_add {kind:"note", contractId, tags:["premarket", "<SYMBOL>"]}`.
   This is not a trade plan; `/trade-plan` or `/trade-session` writes those.
6. Show the game plan to the user.
