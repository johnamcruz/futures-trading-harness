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
node <root>/scripts/strategies.js list --json    # machine-readable
```

`scan` judges sessions at the current time; pass `--now <ISO>` to judge them
at another time (e.g. the bar's close when replaying a file). It reads the
signal on the file's last closed bar and doesn't know the file's timeframe:
read results only for strategies whose timeframe is the file's (a 3m strategy
on 1-minute bars, or the reverse, is not a signal), and only when that last
bar is fresh (no older than one bar plus a minute).

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
   `risk.min_rr` (a trailing exit has no target: there, `trailActivateR` ≥
   `min_rr` stands in for it).
3. Stop from `risk.stop`: `atr:<k>` or a distance expression (e.g.
   cisd_ote's `cisd_ote_risk`) → the scan's `stopDistance`;
   `structure`/`swing` → beyond the level the body names. Round the stop
   away from the entry to the tick (a long's stop down, a short's up), the
   target toward it; bracket ticks = `ceil(distance / tickSize)`.
   `atr:<k>` means k × ATR(20) on the strategy's bars.
4. Tag the plan and the order `setup:<name>`.

### What the code enforces (order gate and MCP gateway)

Live entries are blocked unless `setup:<name>` names a valid strategy with
`status: active`, the contract root is in `instruments`, and the time is inside
`sessions`. `paper` strategies can only be paper-traded. The gate does
**not** check that the trigger fired or that the order is the plan's: those
are yours and risk-manager's. It does refuse an order that contradicts its
own rationale (`order-consistency`): write the side right after the tag
(`setup:orb long ...`), the stop and target as prices on the tick, and
brackets the same distance as those prices.
While a prop attempt runs, only its policy strategy's verdict can enter.

## Examples

```text
scan → orb: direction long, inSession true, filtersFailed [], candidate true, stopDistance 5.25
show orb → skip rule "relative volume < 1.0x" → volume analyst reports 0.8x → no trade.

scan → cisd_ote: direction short, candidate true, stopDistance 18.5 → read the
body's skip rules (sweep before the displacement?) → none apply → plan it.
```
