---
name: harness-tools
description: How the harness tools take arguments and what they refuse, and which skill has each tool's row.
---

# Harness Tools

The harness's operations are tools on the MCP server `harness` (Claude Code
shows them as `mcp__harness__<tool>`, other harnesses by server and tool
name). Each runs the same code as a script in `<root>/scripts/` and returns
what that script prints, except that the results that can be large come back
compact by default (the scan as a summary, recent fires as lines, JSON on one
line), with an argument for the full form. Agents call the tools, in
autonomous and interactive runs alike; a person at a terminal runs the
scripts. None places, changes, or cancels an order.

## When to Use

- Any time a skill or role needs bars in a file, a strategy scan, indicator
  numbers, the multi-timeframe read, the news blackouts, the prop attempt's
  state, the journal's lessons, or a day's reconcile.
- When a step says to record something for the order gate (`record: true`).
- To know which script a person would run for the same result.

## How It Works

### Which skill has each tool's row

Each tool's row (its arguments, what it returns, the script a person runs)
is below, except these (look the skill up when you need it):

- `bar_briefing`, `bars_fetch`, `market_snapshot`, `mtf_read`: the
  `bar-briefing` skill.
- `order_plan`: the `order-plan` skill.
- `reason_check`: the `reason-check` skill.
- `combine_status`: the `prop-challenge-pacing` skill.

### Arguments, paths and refusals (every tool)

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `strategies_list` | `json`? | the registered strategies, one line each; `json`: every field (timeframe, sessions, file) as JSON on one line | `strategies.js list [--json]` |
| `strategies_show` | `name` | one STRATEGY.md | `strategies.js show <name>` |
| `strategies_validate` | none | each strategy ok or what is invalid | `strategies.js validate` |
| `strategies_scan` | `bars`, `symbol`, `name`?, `detail`?, `record`? | the scan of the last closed bar, at the harness clock, of the strategies on the bars' timeframe only (as the runner scans; `name` on a strategy of another timeframe is refused), as a summary: the candidates first (side, entry reference, the stop and target in points and in whole ticks for the symbol with one contract's dollars (at the broker's tick size and value; points only, saying so, until the contract has been looked up with `search_contracts` / `get_contract`), min R:R, exit, confluence), then one line per strategy (status, timeframe, direction, candidate, why not); `name`: that strategy's full result as JSON (each rule with `ok`, `detail`, `mtf`, `exit`); `detail`: every strategy's full result (large: prefer `name`); `record` also records the fired rules strategies; in an autonomous cycle whose bar briefing is current, the summary instead points to it (its `m3` candidates are this scan); `name`, `detail` or `record` still scan | `strategies.js scan <bars> --symbol MNQ [--record]` (the full JSON) |
| `strategies_recent` | `bars`, `symbol`, `count`? (1-50), `json`? | one line per bar (its open time, oldest first): each strategy and side that fired, or none; `json`: the same as JSON | `strategies.js recent <bars> --symbol MNQ --bars 5` |
| `blackouts_list` | none | the news blackout windows | `blackouts.js list` |
| `blackouts_add` | `start`, `end` (ISO with a zone), `reason` | adds a window (append-only, at most 12 hours) | `blackouts.js add --start <ISO> --end <ISO> --reason <text>` |
| `lessons` | `top`?, `json`? | the instincts the journal's reviews add up to | `lessons.js [--top 10] [--json]` |
| `reconcile` | `day` (YYYY-MM-DD), `timeframe`?, `json`? | the day's signals against what was traded | `reconcile.js --day <day> [--timeframe 3] [--json]` |
| `skill_lookup` | `skill`, `role`? | a skill of the harness in full: one a role's prompt lists in its skill index (its `role-index`), looked up only when the cycle needs it. With `role` (your role's name) in an autonomous cycle the lookup is recorded: where the bar's briefing makes a skill in your index required (your prompt says when), your report counts for an entry only once you looked it up during one of your calls this cycle. An unknown skill is refused. Read-only | `skill-lookup.js --skill <name> [--role <role>]` |

- `bars` and `daily` are bars files by absolute path (no `~`): the runner's bars
  file (the prompt names it, under the bar directory) or a `bars_fetch`
  file under `<FTH_HOME>/bars-scratch` (use the path `bars_fetch` returns:
  each harness home, a replay's run home included, has its own, and
  `/tmp/fth` is no longer read). Nothing else is read: another path, a symlink, or
  a file that isn't `.json` or `.csv` is refused (Parquet and Excel files
  are the user's, for backtests).
- `symbol` is a contract root in capitals (`MNQ`, `MES`).
- No tool takes a time: the harness clock decides (a replay broker's time
  in a replay). No tool takes an output path or an environment.
- In a replay, a bars file with a bar that closes after the replay clock is
  refused: `[<script>] the bars file <path>: N bar(s) close after the replay
  clock (...)`, and so is a file whose bars are all at one time (when they
  close can't be told). `bars_fetch` writes only closed bars, and the runner's bars
  file holds only those too. Read one of those files instead; don't retry the
  same file. A briefing of a later bar is not served.
- An unknown argument is refused, with the arguments the tool takes.
- Give numbers as JSON numbers (`"timeframe": 3`) and flags as `true` or
  `false`. A number or flag sent as a string (`"3"`, `"true"`) is read as
  the number or flag the tool takes (surrounding spaces ignored), then
  checked the same way (a timeframe of `"90"` is still refused); `"1.5"`
  where a whole number is taken, or any other string, is not.
- A refusal or failure comes back as an error result: `[<script>] <why>`,
  as the script prints it. Read it, don't retry the same call blindly.
- A reply over 256 KB is refused with how to narrow it (fewer bars, a lower
  `count`, no `json` or `detail`). Read a result from the reply itself: some
  harnesses move a long reply to a file you may not be allowed to read, so
  ask for the compact form (or `name` for one strategy), not the full one.
- In an autonomous run `record` is ignored, not refused: the call succeeds
  with its normal result plus a line `[<script>] note: record ignored - the
  autonomous runner records ...`. The result is correct; nothing was
  recorded because the runner records every bar's read and signals itself.
  Don't retry or doubt the read over it; just leave `record` off. Outside an
  autonomous run, `record` is refused whenever the autonomous runner is
  running, for the same reason.

Only the user's commands stay scripts: starting, stopping, or recording a day
of a prop attempt (`combine.js start | stop | record-day`), backtests,
and replays. In a trading run (autonomous or interactive) ask the
user to run those. The one exception is authoring: the `strategy-researcher`
role, which the user starts interactively for a new strategy, may run a
backtest itself (the `strategy-authoring` skill); no trading role does.

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
blackouts_add {"start": "2026-10-07T12:25:00Z", "end": "2026-10-07T12:40:00Z", "reason": "CPI 08:30 ET"}
```

A person does the same at a terminal: `node <root>/scripts/bars.js --symbol
MNQ --timeframe 15 --count 160`.
