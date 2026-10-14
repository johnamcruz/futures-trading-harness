---
name: tool-arguments
description: Use when calling a harness tool, for its arguments.
---

# Tool Arguments

The harness's operations are tools on the MCP server `harness` (Claude Code
shows them as `mcp__harness__<tool>`, other harnesses by server and tool
name). Each runs the same code as a script in `<root>/scripts/` and returns
what that script prints, except that the results that can be large come back
compact by default (the scan as a summary, recent fires as lines, JSON on one
line), with an argument for the full form. Agents call the tools, in
autonomous and interactive runs alike; a person at a terminal runs the
scripts. None places, changes, or cancels an order.

## When to Use

- Calling any harness tool: its arguments, the paths it reads, what it
  refuses; skill_lookup's row.
- When a step says to record something for the order gate (`record: true`).

## How It Works

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `skill_lookup` | `skill`?, `role`?, `query`? | a skill in full: one your skill index lists, read only when the cycle needs it. With `role` (your role's name), in an autonomous cycle, the lookup is recorded: when your prompt says the bar requires a skill of your index, your report counts for an entry only once you looked it up in the call that reports. An unknown skill is refused. No `skill`: the list (`query` filters). Read-only | `skill-lookup.js --skill <name> [--role <role>] \| --query <text>` |

- `bars` and `daily` are bars files by absolute path (no `~`): the runner's bars
  file (the prompt names it, under the bar directory) or a `bars_fetch`
  file under `<FTH_HOME>/bars-scratch` (use the path `bars_fetch` returns:
  each harness home, a replay's run home included, has its own). Nothing
  else is read: another path, a symlink, or
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

## Examples

```text
skill_lookup {"skill": "absorption", "role": "volume-liquidity-analyst"}
```
