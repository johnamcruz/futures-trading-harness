---
name: trade-session
description: One complete, harness-neutral trading cycle - risk gate, parallel analyst and risk roles, head-trader synthesis against the strategy library, journaled plan, risk verdict, execution, and position management. Use for /trade-session, autonomous runs, and plan-only (paper) cycles.
---

# Trade Session

One decision cycle for a symbol (default MNQ). In autonomous mode a cycle
starts after every closed bar of the configured timeframe (1 or 3 minutes),
so finish well inside one bar. Run it again for the next cycle; never loop
inside one run.

## When to Use

- The user asks to trade, or the autonomous runner starts a cycle.
- Plan-only mode (`paper`, `plan only`, or trading disabled): stop after the verdict.
  The `paper` tag on a journal entry does not stop an order; only
  `FTH_PAPER=1` (or trading disabled on the server) makes the gate refuse live
  entries. In plan-only mode never call an order tool.

## How It Works

### 1. State first

- `get_server_config`. Trading disabled → plan-only mode.
- **Know the account before deciding anything**: balance, today's realized
  P&L and room to the daily limits, open positions, working orders, and, if a
  prop attempt is running, its floor, cushion, progress to the target,
  sessions left, and size budget. The autonomous prompt states the balance,
  positions, working orders, and any attempt's numbers (as read just before
  the run); it does not carry today's P&L or the room to the daily limit, so
  read `get_account_snapshot` (`remainingBeforeLimit`) every cycle that may
  enter, and `node <root>/scripts/combine.js status` for an attempt. Every
  decision below (take, skip, size, manage, stand down) is made with these
  numbers.
- **If a position is open, manage it and end the cycle**: confirm the protective stop is working (`list_open_orders`), apply
  the plan's management (breakeven, trail, scale-out) through the
  trade-executor role, and journal any change. No new entries while a position
  is open. Protective stops move toward the market only. If the strategy's
  exit trails (`exit` in the scan) and the autonomous runner is running, it
  already moved the stop on this bar: don't touch it unless you are exiting.
  **Interactive, no runner:** nobody else manages the trade, so run this
  skill again after every closed bar while the position is open (fetch the
  bar with `bars.js`). On each: from `trailActivateR` of open profit, move the
  stop to `trailGivebackR` behind the best price since entry, rounded to the
  tick, toward the market only; if the bar already traded through that new
  level, close at market instead; after `maxBars` bars in the trade, close at
  market (time stop). The strategy bodies' "don't move the stop yourself"
  means: not while the runner trails it.
- **Fresh data or no decision**: the last closed bar in the bars file must be
  no older than one bar of its timeframe (plus a minute) at the cycle's time,
  and the file's timeframe must be the one you are trading (a scan of 1m bars
  says nothing about a 3m strategy). Stale or mismatched bars → manage open
  positions only, journal a note, end. On interactive use, check the contract
  is the front month (`search_contracts` / the roll guidance in
  `session-timing`) before planning.
- **Flat with working orders**: cancel leftovers from a closed trade (its stop
  or target) right away; they could fill into an unplanned position. Keep only
  a pending entry from your own plan. New entries wait until no order is
  working in the contract. The runner also cancels leftovers before each bar.
- **Flat, with an earlier entry today that has no review** (it closed or was
  cancelled between cycles): run trade-review (`trade-reviewer` role) first.
  The order gate refuses the next entry until every entry is reviewed.
- Daily stop or loss-streak cooldown in the briefing or journal → report and end.
  The gate also refuses entries after `FTH_MAX_ENTRIES_PER_DAY` (default 6)
  entries in a day; at the cap, manage and end.
- **A tool fails** (timeout, 429, 5xx, an empty reply): retry a read once
  after a few seconds; never retry an order call blindly. After a failed or
  timed-out order call, read `list_open_orders` and `get_account_snapshot`
  first: the order may have reached the exchange. `get_bars` allows 50
  requests per 30 s across all agents: use the bars file, don't refetch. If
  account state can't be read, place nothing new; report and end.
- **Bars, interactively** (no runner bars file): `node <root>/scripts/bars.js
  --symbol <SYMBOL> --timeframe <3 or 1> --record` writes 2000 closed bars to
  `/tmp/fth/<SYMBOL>-<tf>m.json` and records the multi-timeframe read for the
  gate. Never paste a long `get_bars` reply into a file.

### 2. Parallel read

**Every cycle, first:** the multi-timeframe read on the bars file
(`node <root>/scripts/mtf.js <bars file>`, the `multi-timeframe-analysis`
skill). **The trend rule is enforced:** a trend strategy never enters
against the prevailing trend (the highest of 4h, 1h, 15m with a trend);
only a strategy with `mtf: reversal` may fade it. The scan already drops
such candidates and the order gate refuses them. In autonomous runs the
prompt states the recorded rule; interactively, `bars.js --record` (or
`mtf.js <bars file> --record --symbol <SYMBOL>`) records it (the gate refuses
trend entries unless the recorded bar closed less than 15 minutes ago: fetch
fresh bars, re-recording an old file doesn't help). Never
argue a trend strategy into a counter-trend trade. For the candidate's side: `aligned` → the strategy's normal size;
`pullback` → no entry until the trigger timeframe turns back; `mixed` → half
size, `floor(size / 2)`, and skip if that is 0 (with the size-1 micro rule of
position-sizing, every mixed read is a skip); `counter` → skip (a trend strategy can't take it), unless it is a
reversal strategy judged as the `multi-timeframe-analysis` skill says. Put the verdict in the plan entry.
A policy verdict (below) is already sized: don't halve it.

**The trigger is checked too.** The scan's `candidate` is the trigger: the
gate refuses a rules strategy's entry unless that strategy fired, on that
side, on a bar that closed less than 10 minutes ago, per the signal record
(the runner records every bar; interactively, `node <root>/scripts/strategies.js
scan <bars file> --symbol <SYMBOL> --record`). A different setup tag on the
same trade is refused: enter only on the strategy that fired.

**Lean cycle** (the prompt says "lean"; used for 1-minute bars so a cycle
fits inside one bar): no parallel analysts and no news fetch. Yourself, in
order: step 1, the multi-timeframe read, market-snapshot and
`strategies.js scan` on the bars file, and the blackouts
(`node <root>/scripts/blackouts.js list`). No candidate → note and end. A
candidate → `risk-manager` phase 1 and 2, then execute. Steps 3-7 apply,
with "the analysts" read as your own snapshot, scan, and multi-timeframe read.

**Full cycle** (default):

If the prompt names a bars file (the autonomous runner writes the bars that
just closed, e.g. `~/.futures-trading-harness/bars/MNQ-3m.json`), pass its path to every analyst:
they run market-snapshot and `strategies.js scan` on it instead of fetching
that timeframe again. Other timeframes they fetch with `bars.js`.

Run these roles at the same time with your harness's subagents (Claude Code:
the Agent tool; Qwen Code: the agent tool; Codex: the configured agent roles),
and wait for every result before step 3. On Qwen Code, named subagents run in
the background by default: launch them with `run_in_background: false`, and
always run `risk-manager` phase 2 and `trade-executor` in the foreground.
Without subagents, play each role yourself in turn. Pass symbol, contractId,
and the current time.

| Role (agent file) | Returns |
|---|---|
| `market-structure-analyst` | Bias, swings, levels, structure strategies in play |
| `trend-momentum-analyst` | Regime, indicator values, strategy scan results |
| `volume-liquidity-analyst` | VWAP, participation, liquidity, sweeps |
| `news-calendar-analyst` | Today's events, proposed blackouts. Premarket only: on trade cycles read `node <root>/scripts/blackouts.js list` instead, and run it only when no blackout was recorded for today's scheduled events |
| `risk-manager` (phase 1) | Account state, limits, budget, stand-down conditions |

### 3. Head-trader synthesis (you)

- Tabulate each analyst's bias and confidence. Trade only when at least two of
  the three market analysts agree and none is strongly opposed.
- Start from the computed regime (`regime` in market-snapshot, the same value
  `strategies.js scan` reports): trend-up, trend-down, range, or transition,
  plus volatility. Don't override it with a narrative; if the analysts disagree
  with it, say why in the plan.
- **A prop attempt with a policy strategy is running** (the prompt lists
  verdicts, or `combine.js status` names a policy strategy): the policy's
  verdict is the only trade. Plan exactly the verdict (`setup:<policy
  strategy>`, its contract and side, at most its size, its stop ticks) per the
  `prop-challenge-pacing` skill, or no trade when there is none or it says
  skip. Never plan the component strategy (e.g. `orb`) yourself; the gate
  refuses it. The rest of this step still decides whether the market permits
  it (events, red flags).
- Otherwise pick at most one strategy that is a `candidate` in the scan in
  this direction on the last closed bar (candidates are already in session and
  in regime: the trigger fired), or a manual strategy whose trigger you
  verified on closed bars and whose `regimes` fit; quote the trigger in the
  plan. The gate checks a rules strategy's trigger from the signal record;
  a manual strategy's trigger is yours and risk-manager's to verify. `show` it (strategy-library) and check every context
  filter and skip rule against the reports.
- No candidate, a failed skip rule, an event within 15 minutes, or an
  unanswered red flag → **no trade**: journal a short `note` with the reason
  and what would change it, and end.

### 4. Plan

`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}`:
thesis, trigger (what happened, price, time), entry, stop, exit, size
(position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's
P&L, and for a prop attempt the cushion and size budget), skip rules checked,
analyst agreement. Add the
tag `paper` in plan-only mode.

The exit follows the strategy's `exit` (shown in the scan):

- **Trailing:** stop only, no target order. The runner (or you, without one)
  trails it from `trailActivateR` with `trailGivebackR` give-back; read both
  from the scan's `exit`, don't assume them.
- **Target:** stop and target at `targetR` (or `risk.min_rr`) times the stop
  distance.
- **Target level:** with `exit.target` the scan gives `targetDistance`: the
  target is the signal bar's close ± that distance (e.g. a CRT range's far
  side).
- **Time stop:** with `maxBars`, close at market after that many bars in the
  trade if neither the stop nor the target has filled.

Prices are on the tick (MNQ/MES 0.25). Round a stop away from the entry and a
target toward it; bracket ticks = `ceil(distance / tickSize)`, the same
numbers in the rationale and the brackets.

### 5. Verdict

`risk-manager` phase 2 with the plan. `VETO` → journal a note, end. In
plan-only mode, report the plan and verdict and end.

### 6. Execute

On `APPROVE`, hand the plan and verdict line to `trade-executor`. If the order
gate, the MCP gateway, or the server blocks it, report the block and end.
Never retry around a block.

After the fill: read `get_account_snapshot` and `list_open_orders`. Check the
filled size (a partial fill is a smaller position: its stop covers what
filled; cancel the rest of the entry if the plan doesn't still want it), the
fill price, and that the protective stop is working at the planned level. A
position without a working stop is fixed before anything else (the
trade-executor places it, or closes the position).

### 7. Report

Decision, plan, verdict, execution result, protective stop status, and what
to watch next. After the position closes, run trade-review.

## Examples

```text
Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium, scan: orb
candidate long), volume long (rel-vol 1.6x), no events until 14:00, risk budget
$40/trade. orb skip rules clear. Plan: long 21503.25, stop 21498.00 (1R =
21 ticks = $10.50), 1 MNQ; exit: trail from +2R (21513.75), giving back 0.5R.
Verdict APPROVE. Executed with a stop bracket only, stop working.
```
