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
well: the side rule (the bias: 4h + 1h) and the alignment labels. Load
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
(`mtf_read` with the bars file, the `timeframe-sources` skill). **The trend rule is enforced (never counter):** no entry against a
trending 4h or 1h, any setup, whatever CHoCH; both ranging, none against
the 15m (in an attempt the side rule, `htf-to-ltf`). In autonomous runs the
prompt states the recorded rule; interactively, `bars_fetch` with `record`
(or `mtf_read` with `record` and `symbol`) records it (the gate refuses
entries unless the recorded bar closed less than 15 minutes ago: fetch
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

Last line of the PLAN block, every PLAN, an open trade's too: your own read
from the bars and facts, not the labels copied (a label its last break or
candle contradicts can be a `transition`, `trend-vs-range`); read it first,
write it last; it is recorded; no code decides from it:
`STATE: 4h <f> | 1h <f> | 15m <f> | frames <agree|disagree> | class <c> | cites <names>`,
`<f>` is `up`, `down`, `range`, `transition` or `unknown`; `<c>`, the
market now at this candle, is `trend-up`, `trend-down`, `chop` or
`unclear`; `<names>`, the facts it rests on, comma list, from `4h-trend`,
`1h-trend`, `15m-trend`, `trend-rule`, `regime`, `day-type`, `day-so-far`,
`pullback`, `1h-break`, `15m-break`, `3m-break`; `none` when none supports
it. No other words.

A `Pullback` line printed: your PLAN's `4 Setup` line is the read chain:
side; 15m pullback; 15m turn (CISD, BOS, CHoCH back or reaction at the level; a CISD
strong or weak); 3m (BOS or
CISD, near value or not); verdict (strong setup: enter, watch or wait)
(`pullback-vs-reversal`). The setup is the 15m turn: a live 15m CISD, a
15m BOS, a 15m CHoCH back or a 15m reaction at the level, the side's way; a live strong 15m
CISD on the CISD line is the turn even when the last 15m candle line shows
no pattern; a 15m BOS far past
value (no 3m BOS or CISD near it): late, not an entry. Close to the level
is the read: `long; 15m pullback to 21500.00 (stopped at 21502.25, no
touch); 15m turn: rejected the RTH VWAP up, long-wick; 3m: BOS up, near
value; strong setup: enter`: no exact touch, no named candle: no wait;
a 15m rejection of the RTH VWAP or a 15m swing inside the zone (within
about 0.25 × the 15m ATR of the broken level) is the reaction.

**The decision follows your STATE read** (the head trader's own, the last
line of its PLAN; taught: the gate and `compose_check` do not read it):

- The class follows the printed `Market state` line: the 3m state
  (code applies the order once: chop, trend, ranging), the Pullback read
  and the 4h + 1h beside it; your STATE frames stay your own read; yours
  off the line: the class stays the line's, say why in the PLAN.

| 3m state | 4h + 1h | class | action |
|---|---|---|---|
| trend, their way | aligned | that trend class | setups the side's way |
| ranging | aligned | the side's trend class (a range day inside the trend) | setups at the range edge or on a breakout, the side's way |
| a pullback their way (trend or ranging) | aligned | that trend class (a 3m trend against inside it is the pullback, not a new trend) | wait for the 15m turn (a live strong 15m CISD, a 15m BOS, a 15m CHoCH back or a 15m reaction at the level); enter on the first 3m BOS or CISD the side's way near value (`pullback-vs-reversal` steps 4-7) |
| trend against them | aligned | `unclear` | no trade, never counter |
| trend or ranging | not aligned | `unclear` | no trend trade |
| chop | any | `chop` | sit out (a 3m CHoCH then CHoCH back, a failed reversal; inside a pullback read it is the watch; the 15m breaking or trending its way: the 15m continuation, a trend); chop ends: a CHoCH then a BOS or CISD the same way, or a close beyond the range (the IB; before 10:30 only a BOS or CISD ends it) |

Trending: consistent BOS, directional displacement, follow-through. Chop:
alternating BOS/CHoCH, overlapping candles, failed continuation
(`trend-vs-range`).

- A take: `class` on its side (`trend-up` long, `trend-down` short), your
  4h and 1h too (`up` long, `down` short).
- `compose_check` still runs first (its record is the evidence the pass is
  scored on). Then `chop`, `unclear`, or a trend class your 4h and 1h
  don't show (`trend-down` with 4h and 1h `range`) → pass, naming that
  read (your step 8, not a decisive against).

- **The priority order** (the `strategy-library` skill, "The priority order"):
  the rule for every setup, a policy verdict too. Apply its steps in order.
- **Compose first** (`confluence-counting`): the side rule's side, the
  setup (15m) at a key level closed → `compose_check`, never your own
  R:R. OK → take: in a prop attempt the full verdict size; pass only on a
  decisive against, or your own STATE read off the setup's side (above).
  Not in a prop attempt: the `position-sizing` skill.
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
target trail (the 2R mark 21595.75, 222 ticks, arms it), 1 MNQ.
Verdict APPROVE. Executed with stop and target brackets, stop working.
```
