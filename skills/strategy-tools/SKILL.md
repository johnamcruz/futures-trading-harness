---
name: strategy-tools
description: Use when calling a strategies_* harness tool.
---

# Strategy Tools

## When to Use

- Calling a strategies tool.

## How It Works

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `strategies_list` | `json`? | the registered strategies, one line each; `json`: every field (timeframe, sessions, file) as JSON on one line | `strategies.js list [--json]` |
| `strategies_show` | `name` | one STRATEGY.md | `strategies.js show <name>` |
| `strategies_validate` | none | each strategy ok or what is invalid | `strategies.js validate` |
| `strategies_scan` | `bars`, `symbol`, `name`?, `detail`?, `record`? | the scan of the last closed bar, at the harness clock, of the strategies on the bars' timeframe only (as the runner scans; `name` on a strategy of another timeframe is refused), as a summary: the candidates first (side, entry reference, the stop and target in points and in whole ticks for the symbol with one contract's dollars (at the broker's tick size and value; points only, saying so, until the contract has been looked up with `search_contracts` / `get_contract`), min R:R, exit, confluence), then one line per strategy (status, timeframe, direction, candidate, why not); `name`: that strategy's full result as JSON (each rule with `ok`, `detail`, `mtf`, `exit`); `detail`: every strategy's full result (large: prefer `name`); `record` also records the fired rules strategies; in an autonomous cycle whose bar briefing is current, the summary instead points to it (its `m3` candidates are this scan); `name`, `detail` or `record` still scan | `strategies.js scan <bars> --symbol MNQ [--record]` (the full JSON) |
| `strategies_recent` | `bars`, `symbol`, `count`? (1-50), `json`? | one line per bar (its open time, oldest first): each strategy and side that fired, or none; `json`: the same as JSON | `strategies.js recent <bars> --symbol MNQ --bars 5` |

## Examples

```text
strategies_scan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ"}
→ Scan of MNQ on the last closed bar (opened 2026-10-07T13:57:00.000Z): 9 strategies, 1 candidate. Regime trend-up. Trend 4h up, 1h up, 15m up, prevailing 4h up.
  Candidates:
    orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none
  Exact order numbers (stop and target prices and ticks, size, $ risk, place_order arguments) for a strategy and side you choose: order_plan.
  Every strategy (name | status | timeframe | direction | candidate | why not):
    cisd_ote | paper | 3m | - | no | no rule set fired (long: cisd_entry(15) > 0; short: cisd_entry(15) < 0)
    ...
strategies_scan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ", "name": "orb"}
→ orb's full result as JSON
```
