---
name: strategy-library
description: Find, read, and apply the harness strategies - STRATEGY.md files with code-checked frontmatter and an LLM-read body - and scan bars for strategy candidates. Use whenever choosing, checking, or tagging a trade, and to locate the harness root ($FTH_ROOT) for its scripts.
---

# Strategy Library

Strategies are Markdown documents, not code. Each lives at
`strategies/<name>/STRATEGY.md` (plus any folder in `FTH_STRATEGIES_DIRS`).

## When to Use

- Before any plan: which strategies apply to this symbol, now?
- When tagging an order: the tag `setup:<name>` must name an active strategy.
- When a script path is needed: find the harness root, written `<root>` below.

## How It Works

### Find the harness root (`<root>`)

The absolute path of the folder that contains `scripts/strategies.js`. In order:

1. The autonomous prompt or the session briefing ("Harness root (FTH_ROOT): /abs/path").
2. The `FTH_ROOT` environment variable (`echo $FTH_ROOT`).
3. The parent of the `workspace/` folder you were started in, or two
   directories above this skill's folder for a plugin install.

Always write the absolute path in commands (`node /abs/path/scripts/strategies.js list`).
Autonomous runs only permit these scripts by absolute path.

### Read the library

```bash
node <root>/scripts/strategies.js list           # name, status, signal, instruments
node <root>/scripts/strategies.js show orb       # the full STRATEGY.md
node <root>/scripts/strategies.js scan /tmp/fth/MNQ-3m.json --symbol MNQ
```

`scan` runs market-snapshot with each strategy's `params` and reports, per
strategy: `direction` (mechanical signal on the last closed bar),
`filtersFailed`, `inSession`, `regime` (the computed regime of these bars),
`inRegime` (fits the strategy's `regimes`), `candidate`, and `stopDistance`. `signal: rules`
strategies also list each rule with `ok: true|false`, so you can explain why
one did or didn't fire. Strategies with `signal: manual` are listed with
`candidate: true` when in session; you evaluate their trigger from the body.

### Apply a strategy

1. `show` it and read the whole body.
2. A trade needs, in order: the trigger has fired on a closed bar (scan
   `candidate: true`, or the manual trigger described in the body), every
   context filter holds, no "Skip when" rule applies, and planned R:R ≥
   `risk.min_rr`.
3. Stop from `risk.stop`: `atr:<k>` → the scan's `stopDistance` (k × ATR(20));
   `structure`/`swing` → beyond the level the body names. Round to tick size.
4. Tag the plan and the order `setup:<name>`.

### What the code enforces (order gate and MCP gateway)

Live entries are blocked unless `setup:<name>` names a valid strategy with
`status: active`, the contract root is in `instruments`, and the time is inside
`sessions`. `paper` strategies can only be paper-traded.

## Examples

```text
scan → orb: direction long, inSession true, filtersFailed [], candidate true, stopDistance 5.25
show orb → skip rule "relative volume < 1.0x" → volume analyst reports 0.8x → no trade.

scan → cisd_ote: signal manual, candidate true → read the body, check 12m bars
for a sweep + displacement; none → no trade.
```
