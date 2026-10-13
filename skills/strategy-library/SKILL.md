---
name: strategy-library
description: Find, read, and apply the harness strategies - STRATEGY.md files with code-checked frontmatter and an LLM-read body - and scan bars for strategy candidates with the harness tools. Use whenever choosing, checking, or tagging a trade, and to locate the harness root ($FTH_ROOT).
---

# Strategy Library

Strategies are Markdown documents, not code. Each lives at
`strategies/<name>/STRATEGY.md` (plus any folder in `FTH_STRATEGIES_DIRS`).

## When to Use

- Before any plan: which strategies apply to this symbol, now?
- When tagging an order: the tag `setup:<name>` must name an active strategy.
- When a path in the harness is needed (a strategy file, the runner's logs):
  find the harness root, written `<root>` below.

## How It Works

### Find the harness root (`<root>`)

The absolute path of the folder that contains `strategies/` and `scripts/`. In order:

1. The autonomous prompt or the session briefing ("Harness root (FTH_ROOT): /abs/path").
2. The `FTH_ROOT` environment variable (`echo $FTH_ROOT`).
3. The parent of the `workspace/` folder you were started in, or two
   directories above this skill's folder for a plugin install.

Always write absolute paths (a bars file, a strategy file).

### Read the library

With the harness tools (the `harness-tools` skill):

```text
strategies_list {}                       name, status, signal, instruments
strategies_show {"name": "orb"}          the full STRATEGY.md
strategies_scan {"bars": "<bars file>", "symbol": "MNQ"}                 summary: candidates, then a line per strategy
strategies_scan {"bars": "<bars file>", "symbol": "MNQ", "name": "orb"}   one strategy's full result
strategies_list {"json": true}           machine-readable
strategies_recent {"bars": "<bars file>", "symbol": "MNQ", "count": 5}   what fired on each of the last 5 bars
```

`recent` answers the skip rules about recent signals ("fired the other way
in the last 5 bars"). A strategy's full scan result (`name`) has `detail`, the detectors' state:
a CRT's candle (`c1Open`/`c1High`/`c1Low`/`c1Close`) and why it did or didn't
fire, and cisd_ote's `hadSweep` and displacement.

`strategies_scan` judges sessions at the current time (the harness clock: a
replay broker's replayed time when `FTH_REPLAY_NOW` is set); it takes no time
of its own (a person replaying a file runs the strategies script's scan with `--now`).
With `FTH_REPLAY_NOW` set but no real replay broker, or not an ISO 8601 UTC
time, the scan refuses (tell the user). It reads the
signal on the file's last closed bar and doesn't know the file's timeframe:
read results only for strategies whose timeframe is the file's (a 3m strategy
on 1-minute bars, or the reverse, is not a signal), and only when that last
bar is fresh (no older than one bar plus a minute).

The scan's summary gives the bar, the higher-timeframe trends, the
candidates first (side, entry reference, stop distance, min R:R, exit,
confluence), then one line per strategy: status, timeframe, direction,
candidate, and why not (the rules that did not hold, outside its sessions,
the regime, or what failed). For one strategy's full result, call it with
`name`; `detail: true` returns every strategy's (large). The scan runs
market-snapshot with each strategy's `params`, and a full result reports:
`direction` (mechanical signal on the last closed bar),
`filtersFailed`, `inSession`, `regime` (the computed regime of these bars),
`inRegime` (fits the strategy's `regimes`: the trend-following strategies, `ema_cross`, `supertrend`, `keltner`, `bos`,
`orb`, `value_area_breakout` and `vwap_reclaim`, never trade a range, and the order gate refuses
their entries there too), `confluence` (on a strategy
that fired: the other strategies on its timeframe that fired the same side,
`with`, and the other side, `against`), `mtf` (the trend rule: the 4h,
1h, 15m trends, the `prevailing` one, and `longAllowed` / `shortAllowed` for
this strategy's style; its `reason` names the side it blocks, e.g. "longs are
against the prevailing 15m down trend …; shorts are with it"), `candidate`,
and `stopDistance`. Read the flag for the side the strategy fired: a short
with `shortAllowed: true` is with the trend, whatever the reason says about
longs. A trend strategy that fires against the prevailing trend is never a
candidate (`filtersFailed` says `mtf: ...`); only `mtf: reversal` strategies
may fade it. `signal: rules`
strategies also list each rule with `ok: true|false`, so you can explain why
one did or didn't fire. Strategies with `signal: manual` are listed
as candidates when in session; you evaluate their trigger from the body.

### Apply a strategy

1. `strategies_show` it and read the whole body.
2. A trade needs, in order (and then the priority order below sizes or skips it): the trigger has fired on a closed bar (scan
   lists it as a candidate, or the manual trigger described in the body), every
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

### The priority order: the rule for every setup

The rule for every setup (a rules strategy's candidate or a policy
verdict). A verdict is a ceiling on size, never an order. Contradicting
facts mean no trade; confluence means trade. Go down the list; a higher step
wins, and each step can only lower the size, never raise it: the size is the
smaller of the verdict's (or position-sizing's) and what the steps allow.
Wherever a step halves, half is `floor(size / 2)`, and 0 means no trade (so
at size 1 every halving is a skip). Halvings don't compound: however many
steps halve, the size is halved once.

1. **Hard stops → no trade**: the candidate is `blocked` (a news blackout
   or the news unknown, a no-entry window), a phase-1 stand-down, or a gate
   refusal.
2. **The trend rule**: a trend strategy against the prevailing trend → no
   trade (the scan and the gate refuse it anyway). A reversal strategy may
   fade it only at a higher-timeframe level, at half size and the nearest
   target.
3. **Room**: the first level in its way (`inTheWay`, in its own R) comes
   before the room it needs (`needR`) → no trade.
4. **The multi-timeframe read for its side**: `aligned` → full;
   `pullback` → no trade until the trigger timeframe turns back with the
   bias (a shift, a reclaim), then full; `mixed` → half; `counter` on a
   non-reversal setup → no trade.
5. **The strategy's own context filter and skip rules** (its STRATEGY.md)
   → any skip rule hit: no trade.
6. **Confluence**: another strategy firing the other side → no trade;
   confluence with it supports the full size; none changes nothing alone.
7. **Secondary context** (the VWAP side, the lunch lull, participation):
   cuts to half, never vetoes alone.

Every other skill and role applies this order; none restates it.

### What the code enforces (order gate and MCP gateway)

Live entries are blocked unless `setup:<name>` names a valid strategy with
`status: active`, the contract root is in `instruments`, and the time is inside
`sessions`. A rules strategy trades one leg of a micro/mini family it lists:
the selected contract (the runner's `symbols`, or `FTH_SYMBOLS`). Listing MNQ,
it trades NQ when NQ is selected, and then never MNQ ("setup:bos trades NQ
(the selected contract), not MNQ"): trade the selected contract, don't switch
legs. With no leg selected it trades exactly what it lists (listing both legs
of a family, neither until one is selected). A policy strategy trades the
selected contract too: its verdict is sized in that leg only (MNQ selected: so
many MNQ, never switched to NQ), and the other leg is refused; its `contracts`
mode picks the leg only when none is selected. Every other check
uses the contract ordered: its broker tick specs, and its size and
`risk.max_risk_usd` in its own dollars (one NQ at a 40-tick stop risks
$200.00; one MNQ, $20.00). Exits and protective stops on either leg always go. `paper` strategies can only be paper-traded. A rules strategy
enters only on its own trigger (`trigger-fired`): the signal record must show
it fired on that side on a bar that closed less than 10 minutes ago (the
runner records every bar; interactively `strategies_scan` with `record: true`,
whose `symbol` is a contract root such as `MNQ`; refused while the
autonomous runner is running, which records the symbols it trades). The gate does
**not** judge a manual strategy's trigger, the skip rules, or that the order
is the plan's: those are yours and risk-manager's. It does refuse an order that contradicts its
own rationale (`order-consistency`): write the side right after the tag
(`setup:orb long ...`), the stop and target as prices on the tick, and
brackets the same distance as those prices.
While a prop attempt runs, only its policy strategy's verdict can enter.
A policy trades only its `active` strategies: a `paper` one stays paper
inside it (the runner passes over its setup, and the gate refuses an entry
whose verdict names a strategy that isn't active or that it doesn't know,
`[policy] ... has status "paper"`); the backtester's prop runs leave it out
the same way, while still counting its signal as agreement or disagreement,
as the live scan does.
The trend rule is a hard gate check (`mtf-trend`): a trend strategy's entry
against the recorded prevailing trend, or without a fresh record, is refused.

## Examples

```text
strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stopDistance 5.25, minRR 1.5 (a candidate)
strategies_show orb → skip rule "relative volume < 1.0x" → volume analyst reports 0.8x → no trade.

strategies_scan → cisd_ote short, a candidate, stopDistance 18.5 → read the
body's skip rules (sweep before the displacement?) → none apply → plan it.
```
