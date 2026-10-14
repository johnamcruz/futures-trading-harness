---
name: strategy-backtest
description: Use when backtesting a strategy or comparing bar sources.
---

# Strategy Backtest

## When to Use

- Before a strategy is paper-traded, or when its rules or a broker field
  change (writing it: the `strategy-authoring` skill).

## How It Works

1. Backtest it before paper trading (the user, or the `strategy-researcher`
   role in an interactive authoring session; never a trading run):
   `node <root>/scripts/backtest.js --data <bars.parquet|.xlsx|.csv> --symbol MNQ --strategy <name>`
   (docs/BACKTESTING.md). Check that it fires where you expect (`trades.csv`)
   and that its R statistics hold up with harness rules on. A strategy that
   reads broker fields (`field(...)`) needs the broker's bars at its own
   timeframe: fetch them first,
   `node <root>/scripts/backtest.js fetch --contract MNQ --from <date> --to <date> --timeframe <its minutes> --out <file>.jsonl`,
   and backtest on that file (`--timeframe <its minutes>`). The backtester
   refuses to build its bars from finer ones that carry broker fields, and
   reports each field's coverage (the share of bars carrying it): under 100%
   it warns, and those bars can't fire the field's conditions.
   Before a rule leans on a broker field, check that the field predicts
   anything: `node <root>/scripts/field-study.js --data <bars>.jsonl --symbol MNQ --fields <path>[,<path>] --horizons 1,3,5,15 --by hour,session --out <dir>`
   measures how the field at bar t lines up with the move after t (never
   the same bar's), with intervals and the cost line (docs/BACKTESTING.md,
   "The field-forward study"). It runs freely on Train months only and
   refuses any other month unless the user gives `--held-out-look "<reason>"`;
   never pass that flag yourself. A field with no edge after costs is no
   reason for a rule.
   A field meant as a confirmation (a rule that takes an event only when the
   field agrees) is checked as one: add `--event expansion:1.5,breakout:20,strategy:<name>`
   and the study compares the event's follow-through when the field agrees,
   disagrees or is neutral, with intervals and the cost line
   (docs/BACKTESTING.md, "The field-confluence study"). Keep the confirmation
   only if agree beats disagree and neutral with an interval that excludes
   zero, on Train; held-out months judge it by calibration (R11-R13), never
   by rerunning the study there.
2. When a field's values are in doubt (a new build of the replay server's
   store, or replay against recorded live minutes), compare the two sources
   before trusting a backtest on them (the user, or the
   `strategy-researcher` role in an interactive authoring session; never a
   trading run): `scripts/compare-bars.js` aligns the
   bars by time, lists bars only in one source and bars whose prices differ,
   and gives each field's coverage, differences, share within tolerance,
   correlation and sign agreement (docs/BACKTESTING.md, "Comparing bar
   sources"). Two store builds over a week, fetched to files first:
   `node <root>/scripts/compare-bars.js --a <old>.jsonl --b <new>.jsonl --prefix <subtree> --by hour --fail-below corr=0.99,within=0.99`.
   Recorded live minutes against the replay server (live is the reference):
   `node <root>/scripts/compare-bars.js --a <live>.jsonl --b broker:<replay broker> --contract MNQ --from <ISO> --to <ISO> --fail-below bars=1,coverage=1,corr=0.99,within=0.99`.
   Exit 1 means a field missed a threshold, or nothing was compared: read
   the worst bars (or the bars only in one source) before trusting either
   source. The tool only measures; it gives no field a
   meaning.

## Examples

A trade in `trades.csv` with a 5.25-point MNQ stop risks 21 ticks, $10.50 a
contract: that is its 1R, and a 10.50-point move in its favour is +2R.
