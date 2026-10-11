---
name: harness-tools
description: The harness's own operations as MCP tools on the `harness` server - strategies, bars, the market snapshot, the multi-timeframe read, news blackouts, prop challenge status, lessons, and reconcile - with their arguments and the command-line script each mirrors. Agents use the tools (autonomous and interactive); people run the scripts. Use whenever a skill or role says to read bars, scan strategies, snapshot indicators, record a read or a blackout, or check the prop attempt.
---

# Harness Tools

The harness's operations are tools on the MCP server `harness` (Claude Code
shows them as `mcp__harness__<tool>`, other harnesses by server and tool
name). Each runs the same code as a script in `<root>/scripts/` and returns
what that script prints. Agents call the tools, in autonomous and interactive
runs alike; a person at a terminal runs the scripts. None places, changes, or
cancels an order.

## When to Use

- Any time a skill or role needs bars in a file, a strategy scan, indicator
  numbers, the multi-timeframe read, the news blackouts, the prop attempt's
  state, the journal's lessons, or a day's reconcile.
- When a step says to record something for the order gate (`record: true`).
- To know which script a person would run for the same result.

## How It Works

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `bars_fetch` | `symbol`, `timeframe` (minutes 1-60, or `"daily"`), `count`?, `record`? | writes closed bars to `/tmp/fth/<SYMBOL>-<tf>m.json` (`-1d.json` daily) and returns that path, the contract, and when the last bar closed; `record` also records the multi-timeframe read | `bars.js --symbol MNQ --timeframe 3 [--daily] [--count N] [--record]` |
| `strategies_list` | `json`? | the registered strategies | `strategies.js list [--json]` |
| `strategies_show` | `name` | one STRATEGY.md | `strategies.js show <name>` |
| `strategies_validate` | none | each strategy ok or what is invalid | `strategies.js validate` |
| `strategies_scan` | `bars`, `symbol`, `record`? | the scan of the last closed bar, at the harness clock; `record` also records the fired rules strategies | `strategies.js scan <bars> --symbol MNQ [--record]` |
| `strategies_recent` | `bars`, `symbol`, `count`? (1-50) | what fired on each of the last bars | `strategies.js recent <bars> --symbol MNQ --bars 5` |
| `market_snapshot` | `bars`, `params`? | the indicator and level snapshot (JSON) | `market-snapshot.js <bars> [--name=value]` |
| `mtf_read` | `bars`, `timeframes`?, `daily`?, `json`?, `record`?, `symbol`? | the multi-timeframe read; `record` (with `symbol`) records it | `mtf.js <bars> [--tf=15,60,240] [--daily=<file>] [--json] [--record --symbol MNQ]` |
| `blackouts_list` | none | the news blackout windows | `blackouts.js list` |
| `blackouts_add` | `start`, `end` (ISO with a zone), `reason` | adds a window (append-only, at most 12 hours) | `blackouts.js add --start <ISO> --end <ISO> --reason <text>` |
| `combine_status` | `account`?, `json`? | each started prop attempt and the policy verdicts | `combine.js status [--account <name>] [--json]` |
| `lessons` | `top`?, `json`? | the instincts the journal's reviews add up to | `lessons.js [--top 10] [--json]` |
| `reconcile` | `day` (YYYY-MM-DD), `timeframe`?, `json`? | the day's signals against what was traded | `reconcile.js --day <day> [--timeframe 3] [--json]` |

- `bars` and `daily` are bars files by absolute path (no `~`): the runner's bars
  file (the prompt names it, under the bar directory) or a `bars_fetch`
  file under `/tmp/fth`. Nothing else is read: another path, a symlink, or
  a file that isn't `.json`, `.csv`, `.parquet` or `.xlsx` is refused.
- `symbol` is a contract root in capitals (`MNQ`, `MES`).
- No tool takes a time: the harness clock decides (a replay broker's time
  in a replay). No tool takes an output path or an environment.
- An unknown argument is refused, with the arguments the tool takes.
- A refusal or failure comes back as an error result: `[<script>] <why>`,
  as the script prints it. Read it, don't retry the same call blindly.
- A reply over 256 KB is refused with how to narrow it (fewer bars, a lower
  `count`, no `json`).
- `record` is refused in autonomous runs: the runner records every bar's
  read and signals itself.

Only the user's commands stay scripts: starting, stopping, or recording a day
of a prop attempt (`combine.js start | stop | record-day`), backtests,
training, and replays. Ask the user to run those.

## Examples

```text
bars_fetch {"symbol": "MNQ", "timeframe": 15, "count": 160}
→ wrote 160 15-minute bars for MNQ (tick 0.25, $0.5/tick) to /tmp/fth/MNQ-15m.json; last bar 2026-10-07T13:45:00.000Z, closed 2026-10-07T14:00:00.000Z

market_snapshot {"bars": "/tmp/fth/MNQ-15m.json"}
strategies_scan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ"}
mtf_read {"bars": "/tmp/fth/MNQ-3m.json", "daily": "/tmp/fth/MNQ-1d.json"}
blackouts_add {"start": "2026-10-07T12:25:00Z", "end": "2026-10-07T12:40:00Z", "reason": "CPI 08:30 ET"}
combine_status {}
```

A person does the same at a terminal: `node <root>/scripts/bars.js --symbol
MNQ --timeframe 15 --count 160`.
