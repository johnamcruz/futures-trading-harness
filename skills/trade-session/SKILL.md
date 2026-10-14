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

### 0. Load the skills

Before any decision, load `trade-session` (this skill),
`multi-timeframe-analysis`, and `strategy-library` with the skill tool. The
order gate refuses an entry from a session whose transcript doesn't show each
one loaded (a load that returned an error, such as a skill not found, doesn't
count: load it again by the name the error lists). Load `trader-process` too:
its checklist is the order you decide in. Load `htf-to-ltf` every cycle as
well: the alignment labels for each side and the reversal rule. Load the others
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
- **If a position is open, manage it and end the cycle**: confirm the protective stop is working (`list_open_orders`); an entry order on the position's side (one that would add to it) still working without a stop bracket (one the gate never checked, e.g. placed outside the harness; tell by its `order_placed` record, as for a flat account below) is cancelled first, and the cancel confirmed, since a fill would add size beyond the stop. The position's own stop and target (bracket legs, `[protect]` and `[exit]` orders, on the opposite side) are never cancelled here; apply
  the plan's management (breakeven, trail, scale-out) through the
  trade-executor role, and journal any change. No new entries while a position
  is open. Protective stops move toward the market only. If the strategy's
  exit trails (`exit` in the scan) and the autonomous runner is running, it
  already moved the stop on this bar: don't touch it unless you are exiting.
  **Interactive, no runner:** nobody else manages the trade, so run this
  skill again after every closed bar while the position is open (fetch the
  bar with `bars_fetch`). On each: from `trailActivateR` of open profit, move the
  stop to `trailGivebackR` behind the best price since entry, rounded to the
  tick, toward the market only; if the bar already traded through that new
  level, close at market instead; after `maxBars` bars in the trade, close at
  market (time stop). Each stop move and close goes through the
  trade-executor role, as all management does. The strategy bodies' "don't move the stop yourself"
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
  a pending entry from your own plan that carries its stop bracket. An order
  list may not show a bracket before the entry fills, so tell by the entry's
  own `order_placed` journal record (`journal_read {kind:"order_placed"}`, kind
  only, no `contractId` filter: the
  one whose `data.result.orderId` is the order; its `data.request` has
  `stopLossBracket` when the bracket went with it); step 6's note on a
  working entry adds context. An entry without one, or with no such record,
  is cancelled first, the cancel
  confirmed (the `order-mechanics` skill), and a `result:nofill` review journalled: cancelling an
  entry only reduces risk. New entries wait until no order is working in the
  contract. The runner also cancels leftovers before each bar.
- **Flat, with an earlier entry today that has no review** (it closed or was
  cancelled between cycles): run trade-review (`trade-reviewer` role) first.
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
  writes the runner's default count of closed bars (5000 3-minute, 15000
  1-minute) to `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json` (this harness
  home's own; use the path it returns) and records the
  multi-timeframe read for the gate (the `harness-tools` skill). Never paste
  a long `get_bars` reply into a file.

### 2. Parallel read

**Every cycle, first:** the bar briefing (`bar_briefing {"symbol": "<SYMBOL>"}`,
the `harness-tools` skill): this bar's analysis by timeframe, computed once by
the runner (the multi-timeframe read with the alignment per side, the trend
rule, the scan's candidates and confluence, the snapshot's levels, VWAP,
participation and liquidity, the session window), each part with its version
and how long it holds. Read it once per role and reuse it: no role re-runs
`market_snapshot`, `mtf_read` or `strategies_scan` for what it holds. Without a current briefing (interactively, or when the tool says none or old), the multi-timeframe read on the bars file
(`mtf_read` with the bars file, the `timeframe-sources` skill). **The trend rule is enforced:** a trend strategy never enters
against the prevailing trend (the highest of 4h, 1h, 15m with a trend);
only a strategy with `mtf: reversal` may fade it. The scan already drops
such candidates and the order gate refuses them. In autonomous runs the
prompt states the recorded rule; interactively, `bars_fetch` with `record`
(or `mtf_read` with `record` and `symbol`) records it (the gate refuses
trend entries unless the recorded bar closed less than 15 minutes ago: fetch
fresh bars, re-recording an old file doesn't help). Never
argue a trend strategy into a counter-trend trade. The read for the candidate's side
sets its size by the priority order (strategy-library, step 4). Put the read in the plan entry.
A policy verdict (below) is a ceiling: the priority order halves or skips it
like any setup.

**The trigger is checked too.** The scan's `candidate` is the trigger: the
gate refuses a rules strategy's entry unless that strategy fired, on that
side, on a bar that closed at most 3 bars of its own timeframe ago, and
never more than 45 minutes ago (3 min on 1m, 9 min on 3m, 45 min on 15m
and 1h), per the signal record
(the runner records every bar; interactively, `strategies_scan` with the
bars file, `symbol`, and `record: true`). A different setup tag on the
same trade is refused: enter only on the strategy that fired.

**Lean cycle** (the prompt says "lean"; used for 1-minute bars so a cycle
fits inside one bar): no parallel analysts and no news fetch. Yourself, in
order: step 1, the bar briefing (without one: the multi-timeframe read,
`market_snapshot` and `strategies_scan` on the bars file), and the blackouts
(`blackouts_list`). No candidate → note and end (`candidates: null`, the
scan failed or the bar wasn't scanned, counts as none). A candidate →
`risk-manager` phase 1 and 2, then execute. Steps 3-7 apply, with "the
analysts" read as the bar briefing (without one, your own snapshot, scan and
multi-timeframe read); the two-of-three-analysts rule in step 3 doesn't
apply: the briefing's alignment for the side and the trend rule decide.
In an autonomous run the order gate refuses an entry (`[roles-ran]`) until
`risk-manager` has returned twice this cycle (phase 1 and phase 2), or once
(phase 2) when the prompt gives phase 1 under "Cached reports" (for the
cycle's first entry only: after a `trade-executor` call, phase 1 and 2 again).

**Full cycle** (default):

If the prompt names a bars file (the autonomous runner writes the bars that
just closed, e.g. `<FTH_HOME>/bars/MNQ-3m.json`, by absolute path), pass the
symbol and that path to every analyst: they start from the bar briefing and
use the file only for what it lacks (other timeframes with `bars_fetch`).
Each report opens with a `Data:` line: the briefing versions it used, or,
without a current briefing, the tools it called. A report with no `Data:`
line, or naming another bar's `m3` version while this bar's briefing is
current, didn't read this bar: run that analyst again once; if it still
doesn't, stand aside. An old briefing (the tool says so) counts as none:
the roles read the bars themselves. A report the prompt gives under "Cached
reports" names an earlier bar's versions by design: the runner checked that
the parts it rests on (`m15`, `h1`, `day`) are still current, so it counts.

**An analyst on its own timeframe.** When the prompt says "Each analyst
reads its own timeframe" (the runner config's `agents`, e.g. a 15m trend
analyst and a 1h structure analyst), give that analyst its timeframe with the
symbol ("timeframe 15m"): it reads `bar_briefing` with that `timeframe` (its
own bar and the runner's m15, h1 and day parts it
shares) and the bars file named there, and its `Data:` line names those
versions (`bar15m@...`, then the shared parts). The analysts the prompt
doesn't name read the runner's bars and briefing as above. Such a report,
served under "Cached reports", holds until its own timeframe's next bar
close, so it may be up to one of its bars old (a 1h report at 10:50 can be
from 10:00): take this bar's facts (the trigger, the VWAP side, the
candidates, the trend rule) from the runner's bar briefing, never from it.
You merge every analyst's latest report and decide once for the cycle.

Run these roles at the same time with your harness's subagents, and wait for
every result before step 3. Always delegate to a harness role by its agent name
(risk-manager, trade-executor, …), never to a generic, forked, or other-CLI
agent: autonomous runs may allow only the harness roles. A role's call is that
role's own analysis (the order gate counts it as its report): never ask a role
to read, load or summarize skills or files for you; load skills yourself (your
skill tool, or without one read their `SKILL.md`). Launch each so you wait
for its result (not left running in the background), and always run
`risk-manager` phase 2 and `trade-executor` in the foreground. Without
subagents (interactively), play each role yourself in turn; in an autonomous
run there is no stand-in: without the roles' reports, no entry. Pass symbol,
contractId, and the current time.

**Cached reports.** The autonomous runner keeps each role's last report and
gives it again under "Cached reports" in the prompt while what it rests on
holds: in a one-symbol cycle, an analyst's report while the bar briefing
parts it was built on are current (until the next 15m close); `risk-manager`
phase 1 while the account is unchanged (no fill, order, balance or attempt
change, same day, and no `trade-executor` call in the cycle that wrote it).
Don't launch a role whose report the prompt gives (where the harness can, it
refuses the launch; in a trade cycle it also refuses roles outside the desk,
such as `strategy-researcher`): use that report for its
15m-and-up view, and take this bar's 3m facts (the trigger, the VWAP side,
the candidates) from the bar briefing. Phase 2 reviews this bar's plan and
is never cached. Cached reports count for the cycle's first entry only: after a
`trade-executor` call, the next entry needs every role again, and where the
harness refuses a cached role's launch (opencode) that is the next cycle: a
`trade-executor` call ends this cycle's entries.

Every other role runs every full cycle: each carries skills the decision needs
(market structure and liquidity, trend and momentum, VWAP, volume profile and
session timing, sizing and pacing), and neither the prompt's facts (the
trend rule, which strategies fired) nor the bar briefing are their reports:
the briefing is their input, not their analysis. In an autonomous run the order
gate refuses an entry (`[roles-ran]`) until `market-structure-analyst`,
`trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` have
returned as subagents this cycle or were given under "Cached reports",
`risk-manager` twice (phase 1, then phase 2 once phase 1 and the analysts
that ran have returned; phase 2 alone when phase 1 was cached), each in the foreground (a
background launch hasn't reported), and since the last `trade-executor` call:
each entry has its own round of reports. The refusal names the roles that
were missing; the refused `trade-executor` call itself ends the round, so
report the block and end the cycle (step 6): the next cycle runs every role
again, except those its prompt gives under "Cached reports". The gate also
checks the `FACTS:` line of the phase-2 report that approved the entry
against the bar briefing (`[phase2-facts]`): a fact the briefing contradicts,
fewer than two facts it checks (with a current briefing), or facts it can't
check, refuses the entry. Report that block with the fact
it names, and end the cycle the same way.

| Role (agent file) | Returns |
|---|---|
| `market-structure-analyst` | Bias, swings, levels, structure strategies in play |
| `trend-momentum-analyst` | Regime, indicator values, strategy scan results |
| `volume-liquidity-analyst` | VWAP, participation, liquidity, sweeps |
| `news-calendar-analyst` | Today's events, proposed blackouts. Premarket only: on trade cycles read `blackouts_list` instead, and run the analyst only when no blackout was recorded for today's scheduled events |
| `risk-manager` (phase 1) | Account state, limits, budget, stand-down conditions |

### 3. Head-trader synthesis (you)

Decide top-down in the `trader-process` skill's order (HTF, context,
location, setup, confluence, entry, risk, decision, management) and write
its PLAN block before your result line; the checks below fill its lines.
It orders the thinking and adds no filter: the priority order decides.

- **Read each setup's facts first** (the briefing's summary, and `facts`,
  `inTheWay`, `needR` and `blocked` in `m3` `candidates`: what the trend rule
  says for its side, the multi-timeframe read for its side, the first level
  in its way in its own R against the room it needs, confluence, the VWAP
  side, the window; `values`, also in the "fired on this bar" line: the
  broker fields its fired side's rules read, on this bar (an `any(...)`
  group's held branches only), where a field's meaning and units are in the
  strategy's own document). They are context, not a verdict: judge the setup by its
  strategy's STRATEGY.md (`strategies_show`: its context filter and skip
  rules) and the rules below (the trend rule, the alignment table in `htf-to-ltf`,
  its min R:R). A setup the trend rule allows, `aligned` for its side, with
  room past what it needs and confluence with it is the opportunity this
  harness looks for, when the rest of this step agrees and it isn't
  `blocked`: the strategy's normal size (position-sizing and the prop
  budget), and let its own exit work (don't bank before its trail or
  target). The priority order below decides: a policy strategy's verdict
  too.
- **The priority order** (the `strategy-library` skill, "The priority order"):
  the rule for every setup, a policy verdict too. Apply its steps in order;
  the size is the smaller of the verdict's (or position-sizing's) and what
  they allow.
- Tabulate each analyst's bias and confidence. Trade only when at least two of
  the three market analysts agree and none is strongly opposed.
- Start from the computed regime (the briefing's `m3` `regime`, the same value
  market-snapshot and `strategies_scan` report): trend-up, trend-down, range, or transition,
  plus volatility. Don't override it with a narrative; if the analysts disagree
  with it, say why in the plan.
- **A prop attempt with a policy strategy is running** (the prompt lists
  verdicts, or `combine_status` names a policy strategy): the policy
  strategy's verdict is the only trade there can be. Plan it (`setup:<policy
  strategy>`, its contract and side, its stop ticks, at most its size) per the
  `prop-challenge-pacing` skill only when the priority order says take, at
  the size it allows; no trade when there is none, it says skip, or the
  order says no. Never plan the component strategy (e.g. `orb`) yourself; the
  gate refuses it.
- **Today's premarket plan and the news** (the prompt's "premarket plan"
  and blackout lines): start from the plan's bias and levels, and say in the
  plan if the day so far has invalidated it. A blackout in force means no
  entries; one coming soon means a trade entered now must have room to work
  before it, or be skipped.
- **The day so far** (the prompt's "day:" line, market-snapshot `day`):
  the open against the prior day, the opening type, the initial balance
  (IB) and how far the day has extended past it, the day type, and how much
  of the average daily range (ADR) is used. Read it before choosing a setup:
  a trend day (one side extended two IBs, or one from a narrow IB), often
  after an open outside the prior range and an open-drive, is traded with it
  (fading needs a reversal setup at a higher-timeframe level); a normal
  variation day (one side extended, less) has made its move and often
  rotates back; an open inside the prior value area that stays
  inside the IB is balance (fade the edges, small targets, stand aside in
  the middle); a neutral day (both sides extended) is two-sided. With 80% or
  more of the ADR used, the room left for a target is small: say so, and
  prefer the nearest target.
- **Track record.** Each strategy that fired carries its record: the
  recorded backtest (overall, in this regime, at this hour, when there are
  enough trades) and your reviewed live trades. Weigh the signal by it: a
  strategy with no recorded edge, a negative slice for this regime or hour,
  or live results well under its backtest is a smaller trade or no trade;
  say which in the plan. Under 30 trades is anecdotal, not evidence. No
  record ("no backtest recorded") is the weakest case, not a neutral one, and
  a STALE record (the strategy changed since) doesn't describe it.
- **An open trade** (the prompt's "Open trade" line) is managed before any
  new entry: its setup, initial stop and risk, the working stop and target in
  R, where it stands now, its best and worst so far, and bars held. "NO
  working stop" is the first thing to fix. The line compares it with the
  strategy's backtested winners (how far they ran, how deep 80% of them
  dipped, how often +1R was given back): a trade already deeper than most
  winners went, or one that reached +1R in a strategy that often gives it
  back, is weaker than its R says. Manage it by its strategy's exit
  (`exit` in its STRATEGY.md: trail, target, time stop); never loosen the
  stop. A trade that gave back most of a large best (e.g. best +2R, now
  +0.3R) or is past its time stop is the case to act on; say what you did and
  why in the cycle result.
- **Confluence.** Several strategies firing the same side on the bar (the
  scan's `confluence.with`, the prompt's "fired on this bar" line) is a
  stronger setup: say so in the plan, and prefer it over a lone signal. Strategies firing
  both sides (`confluence.against`) is a conflict: stand aside (the priority
  order, step 6: no exception). The backtest reports results by confluence
  (`byConfluence`); trust it over a feeling that agreement helps.
- Otherwise pick at most one strategy that is a `candidate` in the scan in
  this direction on the last closed bar (candidates are already in session and
  in regime: the trigger fired), or a manual strategy whose trigger you
  verified on closed bars and whose `regimes` fit; quote the trigger in the
  plan. The gate checks a rules strategy's trigger from the signal record;
  a manual strategy's trigger is yours and risk-manager's to verify. `show` it (strategy-library) and check every context
  filter and skip rule against the reports.
- **Check every reason against the facts** before you decide (a plan, a
  skip, or no trade): state the decision and its reasons, then call
  `reason_check {"symbol": "<SYMBOL>", "reasons": "<your CYCLE RESULT line>"}`
  once. It checks each reason against the bar briefing (the session window
  and whether it allows entries, the trend rule per side, the candidates
  and verdict, the room in R against the room needed, the multi-timeframe
  read for the side) and the attempt line, and lists each setup's
  priority-order steps as the facts answer them: judge each step on its
  own. A reason marked FALSE: name it, drop it, and decide again from the
  facts. Check UNCHECKED and UNPARSED reasons yourself; they aren't false
  for that alone. The order gate's checks still come first and don't
  change.
- No candidate, a failed skip rule, an event within 15 minutes, or an
  unanswered red flag → **no trade**: journal a short `note` with the reason
  and what would change it, and end.

### 4. Plan

`journal_add {kind:"plan", contractId, tags:["setup:<name>", "<SYMBOL>", "regime:<primary>"]}`:
thesis, trigger (what happened, price, time), entry, stop, exit, size
(position-sizing, or the policy verdict), $ risk, the account it was sized from (balance, today's
P&L, and for a prop attempt the cushion and size budget), skip rules checked,
analyst agreement, and what each role reported that the plan rests on: the
structure bias and the level the entry and stop sit against
(market-structure); the VWAP side, the value area or POC, the nearest
liquidity in the trade's way (the candidate's `inTheWay` in the briefing's
`m3` `candidates`: the first level in its direction in points and R, where
1R is its own stop; with `order_plan`'s stop, check there is room to the
target or the trail's activation, and a level closer than 1R is a skip under
the skip rules that name it), and the session window (the briefing's `m3`
`windowText`: whether entries are allowed and until when; volume-liquidity, session-timing); the regime and momentum (trend-momentum); the
multi-timeframe alignment for the side (aligned, pullback, mixed, counter)
and the size it implies; and risk-manager phase 1's budget and pace. A plan
that can't name them isn't ready. Add the
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

Tick sizes and values are the broker's: the harness records them when
`search_contracts` or `get_contract` returns the contract, and the gate,
`order_plan` and the scan use only those. A tool that says there are no tick
specs from the broker for a contract yet means: look the contract up with
`search_contracts` (or `get_contract`) first, then ask again; never supply
tick numbers of your own.

Prices are on the tick (MNQ/MES 0.25). Round a stop away from the entry and a
target toward it; bracket ticks = `ceil(distance / tickSize)`, the same
numbers in the rationale and the brackets. The scan's distances are price
points, not ticks: its summary shows both (`stop 5.25 pts = 21 ticks`).

**The exact numbers come from `order_plan`**, not from your own arithmetic:
once you have chosen the strategy and the side (the steps above: the trigger,
the trend rule, the skip rules, the account), call it with them, e.g.
`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "orb", "side": "long"}`.
It is a calculator, not a second opinion: it doesn't choose the setup, the
side, or whether to trade. It shows its working (the entry reference, the
stop and target in points and in whole ticks, the stop below a long's entry
and above a short's, how the size was derived, the dollar risk) and gives
the `place_order` arguments with the `setup:<name> <side>` rationale. Put its
stop price, ticks, size, and $ risk in the plan, and explain the plan in your
own words (why the stop sits there, the R multiple, the exit). Don't
compute stop prices, ticks, size, or dollar risk by hand. A refusal (the
strategy isn't a candidate now, or its rules fired the other side) means no
entry on that strategy and side; never work around it. For a policy verdict,
call it with the policy strategy's name: it plans exactly the verdict, on
bars whose last closed bar is the verdict's, and refuses (as the gate does)
a verdict for an older bar than the last one recorded: no entry until the
next setup's verdict. Its size is the starting size:
1 for a rules strategy (position-sizing's size-1 rule) and, for a policy,
the verdict's cut to the attempt's size budget now, which is the most a
policy entry may have. A different size from
your plan changes only `size`, and the risk scales with it: smaller for a
`mixed` read or a reversal fade, and, for a rules strategy, larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual
strategy has no order_plan (its stop is your read of STRATEGY.md): work its
numbers by the rules above and position-sizing.

### 5. Verdict

`risk-manager` phase 2 with the plan. `VETO` → journal a note, end. In
plan-only mode, report the plan and verdict and end. Its report ends with a
`FACTS:` line (the briefing facts its verdict rests on); hand it on with the
verdict line, unchanged.

### 6. Execute

On `APPROVE`, hand the plan and verdict line to `trade-executor`. If the order
gate, the MCP gateway, or the server blocks it, report the block and end.
Never retry around a block.

After placing: read `get_account_snapshot` and `list_open_orders` once.
Filled: check the filled size (a partial fill is a smaller position: its stop
covers what filled; cancel the rest of the entry if the plan doesn't still
want it), the fill price, and that the protective stop is working at the
planned level. A position without a working stop is fixed before anything
else (the trade-executor places a `[protect]` stop, or closes the position).
Not filled yet (a resting limit or stop, or a market order the broker hasn't
filled): with its stop bracket attached,
journal a note that the entry is working (its order
id, and that its stop bracket is attached), report it,
and stop there (in an autonomous cycle, end the cycle; interactively, until
the next check); the next cycle or check verifies the fill and the stop
first. Every entry carries its stop bracket (the gate refuses an entry
without one, a check autonomous runs can't skip). Refused (`success: false`
with an `errorCode` other than 6 (`OrderPending`) or 7 (`UnknownError`), its
brackets included, or a `Blocked by ...`): the
trade-executor reports it with the message; journal it, give the user that
message verbatim, and end (cycle result `blocked`); never send the entry
again without its bracket. Any other error (codes 6 and 7 included, a lost
reply, a timeout, a message that a position may be open) is an unknown outcome, not a refusal:
the trade-executor reads positions and orders at once, protects or closes
any position without a covering stop first, and never re-sends the entry.
Flat after a successful reply (the broker reports the entry closed or not
filled): journal its review with the broker's message: `result:nofill`
only when nothing shows the order filled. If the reply or the broker's
message says a position was opened or closed, or `search_trades` shows any
fill for the order, the usual review of a closed trade. If it can't be told
yet (fills can be reported late), no review this cycle: the next cycle's
flat-with-an-unreviewed-entry step decides from `search_trades`.
Never wait or poll for the fill (the `order-mechanics` skill).

### 7. Report

Decision, plan, verdict, execution result, protective stop status, and what
to watch next. After the position closes, run trade-review.

## Examples

```text
Cycle 10:21 ET MNQ: flat. Structure long (high), trend long (medium, scan: orb
candidate long), volume long (rel-vol 1.6x), no events until 14:00, risk budget
$40/trade. orb skip rules clear. Plan (numbers from order_plan): long 21503.25,
stop 21498.00 (1R = 5.25 pts = 21 ticks = $10.50), 1 MNQ; exit: trail from +2R
(21513.75), giving back 0.5R.
Verdict APPROVE. Executed with a stop bracket only, stop working.
```
