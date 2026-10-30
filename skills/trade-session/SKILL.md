---
name: trade-session
description: Use when running one trading cycle - /trade-session, an autonomous run's cycle, or plan-only (paper).
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

### 0. Load the skills

Before any decision, load `trade-session` (this skill),
`multi-timeframe-analysis` and `trade-lifecycle` with the skill tool (a
rules entry: `strategy-library`, `strategy-scan`, `strategy-gate-checks`
too). The order gate refuses an entry until each is loaded (an errored load doesn't
count); one already in your prompt counts: don't reload it (no skill tool:
skill_lookup). Load `trader-process`
too: its checklist is the order you decide in. Load `htf-to-ltf` every cycle as
well: the alignment labels for each side and the reversal rule. Load
`confluence-counting` every cycle too: the count. Load the others
as a step names them.

### 1. State first

- `get_server_config`. Trading disabled → plan-only mode. The harness
  records its `maxOrderSize`: the gate refuses any entry until it has, and
  any entry over it (exits and stops are never held back by it).
- **Know the account before deciding anything**: balance, today's realized
  P&L and room to the daily limits, open positions, working orders, and, if a
  prop attempt is running, its floor, cushion, progress to the target,
  sessions left, and size budget. The autonomous prompt states the balance,
  positions, working orders, and any attempt's numbers (as read just before
  the run); it does not carry today's P&L or the room to the daily limit, so
  read `get_account_snapshot` (`remainingBeforeLimit`) every cycle that may
  enter, and the harness tool `combine_status` for an attempt. Every
  decision below (take, skip, size, manage, stand down) is made with these
  numbers.
- **A position is open**: manage it by `manage-position` (in the prompt);
  then end.
- **Fresh data or no decision**: the last closed bar in the bars file must be
  no older than one bar of its timeframe (plus a minute) at the cycle's time,
  and the file's timeframe must be the one you are trading (a scan of 1m bars
  says nothing about a 3m strategy). Stale or mismatched bars → manage open
  positions only, journal a note, end. On interactive use, check the contract
  is the front month (`search_contracts` / the roll guidance in
  `contract-roll`) before planning.
- **Flat with working orders**: the `leftover-orders` skill.
- **Flat, with an earlier entry today that has no review** (it closed or was
  cancelled between cycles): the runner reviews it next bar.
  The order gate refuses the next entry until every entry is reviewed.
- Daily stop or loss-streak cooldown in risk-manager phase 1, the prompt, or the journal → report and end.
  The gate also refuses entries after `FTH_MAX_ENTRIES_PER_DAY` (default 6)
  entries in a day; at the cap, manage and end.
- **A tool fails** (timeout, 429, 5xx, an empty reply): retry a read once
  after a few seconds; never retry an order call blindly. After a failed or
  timed-out order call, read `list_open_orders` and `get_account_snapshot`
  first: the order may have reached the exchange. `get_bars` allows 50
  requests per 30 s across all agents: use the bars file, don't refetch. If
  account state can't be read, place nothing new; report and end.
- **Bars, interactively** (no runner bars file): the harness tool
  `bars_fetch` (`{"symbol": "<SYMBOL>", "timeframe": <3 or 1>, "record": true}`)
  writes the runner's default count of closed bars to
  `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json` (this harness home's own;
  use the path it returns) and records the multi-timeframe read for the gate
  (the `bar-briefing` skill). Never paste a long `get_bars` reply into a file.

### 2. Parallel read

**Every cycle, first:** the bar briefing (`bar_briefing {"symbol": "<SYMBOL>"}`,
the `bar-briefing` skill): this bar's analysis by timeframe, computed once by
the runner (the multi-timeframe read with the alignment per side, the trend
rule, the setups to check, the snapshot's levels, VWAP,
participation and liquidity, the session window), each part with its version
and how long it holds. Read it once per role and reuse it: no role re-runs
`market_snapshot`, `mtf_read` or `strategies_scan` for what it holds. Without a current briefing (interactively, or when the tool says none or old), the multi-timeframe read on the bars file
(`mtf_read` with the bars file, the `timeframe-sources` skill). **The trend rule is enforced:** no entry against the prevailing trend
(the highest of 4h, 1h, 15m with a trend), long or short alike: a composed
one only on a true CHoCH its way at or above the trend's frame
(`trade-lifecycle`), a rules one only with `mtf: reversal`. In autonomous runs the
prompt states the recorded rule; interactively, `bars_fetch` with `record`
(or `mtf_read` with `record` and `symbol`) records it (the gate refuses
trend entries unless the recorded bar closed less than 15 minutes ago: fetch
fresh bars, re-recording an old file doesn't help). Put the read for the side in the plan entry. A policy
verdict is a ceiling, never an order.

**The trigger is checked too.** A composed entry's is this bar's compose
record (`trade-lifecycle`). A rules strategy's (none active): the scan's
`candidate` on that side, on a bar that closed at most 3 bars of its own
timeframe ago and never more than 45 minutes ago (3 min on 1m, 9 min on 3m), per the
signal record (interactively, `strategies_scan` with `record: true`); enter
only on the strategy that fired.

**Lean cycle** (the prompt says "lean"): the `lean-cycle` skill.

**Full cycle** (default): read the `role-round` skill (the roles, their
reports, `[roles-ran]`; an analyst on its own timeframe: `runner-lanes`).

### 3. Head-trader synthesis (you)

Decide top-down in the `trader-process` skill's order (HTF, context,
location, setup, confluence, entry, risk, decision, management) and write
its PLAN block before your result line; the checks below fill its lines.
It orders the thinking and adds no filter.

- **The priority order** (the `strategy-library` skill, "The priority order"):
  the rule for every setup, a policy verdict too. Apply its steps in order.
- **Compose first** (`confluence-counting`): trend side, a reaction at a
  key level, the trigger closed → `compose_check`, never your own R:R.
  OK → take: full, half on serious, pass on decisive against.
  In a prop attempt the translated size is full; phase 2 cuts it only on a pacing rule.
- **Every decision**: read the `setup-judgment` and `day-context` skills;
  before an entry, `trade-plan` too (the order gate refuses an entry until
  `setup-judgment` and `trade-plan` were read). An open trade: `manage-position`.
- No setup (no candidate, no `compose_check` OK), a failed skip rule, or an event within 15 minutes
  → **no trade**: journal a short `note` with the reason
  and what would change it, and end.
- Runner runs the entry (prompt says): OK → `planned`, skip 4-6.

### 4. Plan

The `trade-plan` skill: the plan entry, the exit, ticks, and `order_plan`.

### 5. Verdict

`risk-manager` phase 2 with the plan. `VETO` → journal a note, end. In
plan-only mode, report the plan and verdict and end. Its report ends with a
`FACTS:` line (the briefing facts its verdict rests on); hand it on with the
verdict line, unchanged.

### 6. Execute

On `APPROVE`, hand the plan and verdict line to `trade-executor`. If the order
gate, the MCP gateway, or the server blocks it, report the block and end.
Never retry around a block.

After placing: the `entry-outcome` skill.

### 7. Report

Decision, plan, verdict, execution result, protective stop status, and what
to watch next. After the position closes, run trade-review.

## Examples

```text
Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium), volume
long (rel-vol 1.6x), no events until 14:00. compose_check long OK. Plan (numbers
from the record): limit long 21540.25, stop 21512.50 (111 ticks = $55.50),
target 21598.00 (231 ticks, 2.08R), 1 MNQ.
Verdict APPROVE. Executed with stop and target brackets, stop working.
```
