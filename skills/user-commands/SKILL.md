---
name: user-commands
description: Commands only the user runs, and scripts.
---

# User Commands

## When to Use

- To know which script a person would run for the same result.

## How It Works

Only the user's commands stay scripts: starting, stopping, or recording a day
of a prop attempt (`combine.js start | stop | record-day`), backtests,
and replays. In a trading run (autonomous or interactive) ask the
user to run those. The one exception is authoring: the `strategy-researcher`
role, which the user starts interactively for a new strategy, may run a
backtest itself (the `strategy-authoring` skill); no trading role does.

| Tool | Script (people) |
|---|---|
| `lessons` | `lessons.js [--top 10] [--json]` |
| `reconcile` | `reconcile.js --day <day> [--timeframe 3] [--json]` |

## Examples

A person does the same at a terminal: `node <root>/scripts/bars.js --symbol
MNQ --timeframe 15 --count 160`.
