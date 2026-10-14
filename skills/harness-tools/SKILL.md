---
name: harness-tools
description: The harness's own operations as MCP tools on the `harness` server - strategies, the order arithmetic for a chosen setup, bars, the market snapshot, the multi-timeframe read, news blackouts, prop challenge status, lessons, reconcile, and the check of stated reasons - with their arguments and the command-line script each mirrors. Agents use the tools (autonomous and interactive); people run the scripts. Use whenever a skill or role says to read bars, scan strategies, snapshot indicators, record a read or a blackout, or check the prop attempt.
---

# Harness Tools

The harness's operations are tools on the MCP server `harness` (Claude Code
shows them as `mcp__harness__<tool>`, other harnesses by server and tool
name). Each runs the same code as a script in `<root>/scripts/` and returns
what that script prints, except that the results that can be large come back
compact by default (the scan as a summary, recent fires as lines, JSON on one
line), with an argument for the full form. Agents call the tools, in
autonomous and interactive runs alike; a person at a terminal runs the
scripts. None places, changes, or cancels an order.

## When to Use

- Any time a skill or role needs bars in a file, a strategy scan, indicator
  numbers, the multi-timeframe read, the news blackouts, the prop attempt's
  state, the journal's lessons, or a day's reconcile.
- When a step says to record something for the order gate (`record: true`).
- To know which script a person would run for the same result.

## How It Works

| Tool | Arguments | What it returns | Script (people) |
|---|---|---|---|
| `bars_fetch` | `symbol`, `timeframe` (minutes 1-60, or `"daily"`), `count`?, `record`?, `name`? | writes closed bars to `<FTH_HOME>/bars-scratch/<SYMBOL>-<tf>m.json`, this harness home's own scratch folder (`-1d.json` daily; with `name`, `<SYMBOL>-<tf>m-<name>.json`, a file of your own) and returns that path, the contract, and when the last bar closed; `record` also records the multi-timeframe read | `bars.js --symbol MNQ --timeframe 3 [--daily] [--count N] [--record]` |
| `strategies_list` | `json`? | the registered strategies, one line each; `json`: every field (timeframe, sessions, file) as JSON on one line | `strategies.js list [--json]` |
| `strategies_show` | `name` | one STRATEGY.md | `strategies.js show <name>` |
| `strategies_validate` | none | each strategy ok or what is invalid | `strategies.js validate` |
| `strategies_scan` | `bars`, `symbol`, `name`?, `detail`?, `record`? | the scan of the last closed bar, at the harness clock, of the strategies on the bars' timeframe only (as the runner scans; `name` on a strategy of another timeframe is refused), as a summary: the candidates first (side, entry reference, the stop and target in points and in whole ticks for the symbol with one contract's dollars (at the broker's tick size and value; points only, saying so, until the contract has been looked up with `search_contracts` / `get_contract`), min R:R, exit, confluence), then one line per strategy (status, timeframe, direction, candidate, why not); `name`: that strategy's full result as JSON (each rule with `ok`, `detail`, `mtf`, `exit`); `detail`: every strategy's full result (large: prefer `name`); `record` also records the fired rules strategies; in an autonomous cycle whose bar briefing is current, the summary instead points to it (its `m3` candidates are this scan); `name`, `detail` or `record` still scan | `strategies.js scan <bars> --symbol MNQ [--record]` (the full JSON) |
| `strategies_recent` | `bars`, `symbol`, `count`? (1-50), `json`? | one line per bar (its open time, oldest first): each strategy and side that fired, or none; `json`: the same as JSON | `strategies.js recent <bars> --symbol MNQ --bars 5` |
| `order_plan` | `bars`, `symbol`, `strategy`, `side`, `accountId`? | a calculator for the order of a trade you chose (strategy and side are yours; it never picks, ranks, or advises): when that strategy is a candidate on that side on the last closed bar (or, for a policy strategy, its live verdict), one line showing its working (entry reference, the stop and target in points and whole ticks, prices on the tick with a long's stop below the entry and a short's above, how the size was derived, $ risk) and the exact `place_order` arguments as JSON; refused, with the reason, when it isn't a candidate now, its rules fired the other side, the bars aren't the strategy's timeframe, their last bar closes more than a minute after the harness clock or is older than the gate's signal age, (a policy strategy) the verdict is for another bar than the last closed one or than the last bar recorded for its timeframe (the gate's check), or the broker's tick specs for the contract aren't recorded yet (`search_contracts` / `get_contract` for it first, then call it again). It places nothing | `strategies.js plan <bars> --symbol MNQ --strategy orb --side long [--account-id 7]` |
| `market_snapshot` | `bars`, `params`?, `symbol`? | the indicator and level snapshot (JSON, on one line; profile levels on the tick of `symbol`, default the root the bars file is named for) | `market-snapshot.js <bars> [--symbol=MNQ] [--name=value]` |
| `mtf_read` | `bars`, `timeframes`?, `daily`?, `json`?, `record`?, `symbol`? | the multi-timeframe read; `record` (with `symbol`) records it; in an autonomous cycle whose bar briefing is current, the default read instead points to it (its `m15` and `h1` hold the frames and the alignment, `m3` `trendRule` the trend rule); `daily`, other `timeframes` or `json` still read | `mtf.js <bars> [--tf=15,60,240] [--daily=<file>] [--json] [--record --symbol MNQ]` |
| `blackouts_list` | none | the news blackout windows | `blackouts.js list` |
| `blackouts_add` | `start`, `end` (ISO with a zone), `reason` | adds a window (append-only, at most 12 hours) | `blackouts.js add --start <ISO> --end <ISO> --reason <text>` |
| `combine_status` | `account`?, `json`? | each started prop attempt and the policy verdicts; an `account` that isn't a profile (a run id, the broker's account) reads every started attempt and says so | `combine.js status [--account <name>] [--json]` |
| `lessons` | `top`?, `json`? | the instincts the journal's reviews add up to | `lessons.js [--top 10] [--json]` |
| `reconcile` | `day` (YYYY-MM-DD), `timeframe`?, `json`? | the day's signals against what was traded | `reconcile.js --day <day> [--timeframe 3] [--json]` |
| `bar_briefing` | `symbol` (a root, or a contract by month), `json`? | the bar briefing the autonomous runner built for the bar this cycle decides, opening with a plain-language summary (price and 1R, trend rule, alignment, regime, VWAP, news, the room above and below, a line per timeframe for its last completed candle, the next swing targets, each setup with its facts), times in ET, distances in points and R (1R is a setup's own stop, else the reference stop, 0.5 x ATR(20) of the briefing's own bars, named by its timeframe: `oneR`). `m3`, every bar: price, the bar (OHLC, range in ATR), ET time and the session window with its scope (`windowText`: market open or closed, entries allowed or not, until when; also `windowEntries`, `windowRefusal`, `marketOpen`; from the gate's own clock config), the next news blackout (`news`), regime (tags, metrics), EMA9/20/50/200, ADX, SuperTrend, Keltner, ATR(14), VWAP (which applies, side, distance, crosses), participation, the skip-rule counters (`context`), `referenceStop`, swings and liquidity (equal highs and lows marked taken or not), `lastBreak` (BOS or CHoCH with its age), `sweeps` (key levels first; only levels that existed before), `htfLevels` (the 15m and 1h swings against price, and the last one a 3m close broke), `untested1hSwings`, `nearestLiquidity` (the three nearest levels each side; `at`, the round number price sits on, only when it sits on one; `roundNumbers`, why there are none, only when the family's configured step was refused), today so far, the overnight range, the session profile and its nodes, `location`, `candles` (per timeframe, 3m, 5m, 15m and 1h, the last COMPLETED candle, never the one forming: OHLCV, its close time, body and wick shares, close third, range in that timeframe's ATR, volume against its average, a pattern label (doji, hammer, shooting star, bullish or bearish engulfing, inside, outside, displacement, or none), and the key levels it met as `rejected` (traded through, closed back), `broke` (closed beyond, most of the body beyond) or `touched`, a fixed level as it stood when the candle opened (never one its own bars made, nor one formed later), a moving one (VWAP, the session profile) at its close, plus the round numbers in its range (on its family's step; none without one), its previous candle and the CRT range, at most four, strongest first (`moreLevels`: the rest); a timeframe that isn't whole base bars, 5m from 3m bars, is built from a 1m lane's bars when one runs (the candle ending at this close only once its last 1m bar is in), else `unavailable` with the reason (left out of the summary when no 1m lane runs), never approximated), `swingTargets` (the next swing high above and low below on the base bars, 15m and 1h, in points, ticks and R), `candidates` (each with its stop, exit, the first level in its way in R, the room it needs, and its context as `facts`: the trend rule and the multi-timeframe read for its side, room, confluence, VWAP side, window; `null`: the scan failed or the bar wasn't scanned; `blocked` in a no-entry window (named, with its end), a news blackout, or with the news unknown), `trendRule`. `m15`, until the next 15m close: `frame` (trend, bias, close, EMA20/50, swing pattern, ADX, ATR, and the last 20 candles' range with its mid), `alignment`, `lastBreak` (times are candle opens; `knownAt` is the breaking candle's close), `indicators` (EMA9/20, regime, ADX, SuperTrend, Keltner). `h1`, until the next 1h close: the 1h and 4h frames, `lastBreak`. `day`, until the first bar after 16:00 ET: the prior RTH day and its profile. Each part has a version and changes only on expiry. Reuse it; don't recompute what it holds. When it answers that there is no current briefing, or that it is old, read the bars yourself. With `timeframe` (`"15m"`, `"1h"`; only when the caller gave you one: the runner config puts some analysts on their own timeframe): that timeframe's briefing, `bar` (the `m3` facts on its own bars, valid until its next bar close, with a pointer to the runner's `candles` and `swingTargets` (the session's levels, one value each), the last bar before the 16:00 ET break until the first bar after the open; 1R and ATR named by its timeframe; no trend rule: the gate's current one is the runner's briefing's; no session facts (today, overnight, VWAP, session profile, `location`: `sessionLevels` points to the runner's briefing, their one value), so its levels and room are its own bars' (a lane's, whose setups are traded, add the runner's session levels, its values); setups only when a lane trades those bars, else in the runner's briefing) and the runner's parts that change no faster (`m15` up to 15m, `h1` up to 1h, `day`); its bars file is named in it. Your report on it may be reused until that close, so it may be up to one of its bars old | `briefing.js --symbol MNQ [--timeframe 15m] [--json]` |
| `reason_check` | `symbol`, `reasons` (your decision line: CYCLE RESULT or VERDICT, with phase 2's FACTS line, at most 2000 characters), `json`? | each reason you stated checked against the facts of the bar you decide (this cycle's bar briefing: the session window and whether it allows entries, so a claim that the session is closed, in premarket or opens later is checked too (in an entry's result a window claim is UNCHECKED: it is no ground for an entry), the trend rule per side, the candidates, the room in R against `needR`, the multi-timeframe read per side; the policy verdicts on that bar; the started prop attempts): `TRUE`, `FALSE` (with the fact) or `UNCHECKED` per claim, `JUDGMENT` and `UNPARSED` clauses for you to check, and each setup's priority-order steps as the facts answer them; a FACTS line's claims each `TRUE`, `FALSE` or `UNCHECKED` against the briefing, as the order gate checks them. Read-only: it decides nothing; without a current briefing it checks nothing and says so | `reason-check.js --symbol MNQ --reasons "<line>" [--json]` |
| `skill_lookup` | `skill`?, `role`?, `query`? | a skill of the harness in full: one a role's prompt lists in its skill index (its `role-index`), looked up only when the cycle needs it. With `role` (your role's name) in an autonomous cycle the lookup is recorded: where the bar's briefing makes a skill in your index required (your prompt says when), your report counts for an entry only once you looked it up during one of your calls this cycle. An unknown skill is refused. No skill: lists every skill (`query` filters). Read-only | `skill-lookup.js --skill <name> [--role <role>] \| --query <text>` |

- `bars` and `daily` are bars files by absolute path (no `~`): the runner's bars
  file (the prompt names it, under the bar directory) or a `bars_fetch`
  file under `<FTH_HOME>/bars-scratch` (use the path `bars_fetch` returns:
  each harness home, a replay's run home included, has its own, and
  `/tmp/fth` is no longer read). Nothing else is read: another path, a symlink, or
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

Only the user's commands stay scripts: starting, stopping, or recording a day
of a prop attempt (`combine.js start | stop | record-day`), backtests,
and replays. In a trading run (autonomous or interactive) ask the
user to run those. The one exception is authoring: the `strategy-researcher`
role, which the user starts interactively for a new strategy, may run a
backtest itself (the `strategy-authoring` skill); no trading role does.

## Examples

```text
bars_fetch {"symbol": "MNQ", "timeframe": 15, "count": 160}
→ wrote 160 15-minute bars for MNQ (tick 0.25, $0.5/tick) to /home/u/.futures-trading-harness/bars-scratch/MNQ-15m.json; last bar 2026-10-07T13:45:00.000Z, closed 2026-10-07T14:00:00.000Z

market_snapshot {"bars": "/home/u/.futures-trading-harness/bars-scratch/MNQ-15m.json"}
strategies_scan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ"}
→ Scan of MNQ on the last closed bar (opened 2026-10-07T13:57:00.000Z): 9 strategies, 1 candidate. Regime trend-up. Trend 4h up, 1h up, 15m up, prevailing 4h up.
  Candidates:
    orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none
  Exact order numbers (stop and target prices and ticks, size, $ risk, place_order arguments) for a strategy and side you choose: order_plan.
  Every strategy (name | status | timeframe | direction | candidate | why not):
    cisd_ote | paper | 3m | - | no | no rule set fired (long: cisd_entry(15) > 0; short: cisd_entry(15) < 0)
    ...
strategies_scan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ", "name": "orb"}
→ orb's full result as JSON
order_plan {"bars": "/home/u/.futures-trading-harness/bars/MNQ-3m.json", "symbol": "MNQ", "strategy": "vwap_reclaim", "side": "long", "accountId": 7}
→ vwap_reclaim long: 1 MNQ at market (entry ref 21503.25) | stop 21498.00, below the entry: 5.25 pts = 21 ticks ($10.50/MNQ contract), stopLossBracket.ticks 21 | target 21513.75 (2R): 42 ticks, takeProfitBracket.ticks 42 | risk $10.50 = 1 x 21 ticks x $0.50/tick (before fees) | size 1: the minimum; no account budget sizes a rules strategy (position-sizing: size 1 until the setup has 30+ reviewed trades)
  place_order arguments: {"accountId":7,"contractId":"MNQ","side":"buy","type":"market","size":1,"stopLossBracket":{"ticks":21,"type":"stop"},"takeProfitBracket":{"ticks":42,"type":"limit"},"rationale":"setup:vwap_reclaim long at market from 21503.25 (the signal bar's close), stop 21498.00 (21 ticks), target 21513.75 (42 ticks), 1 MNQ risks $10.50"}
mtf_read {"bars": "/home/u/.futures-trading-harness/bars-scratch/MNQ-3m.json", "daily": "/home/u/.futures-trading-harness/bars-scratch/MNQ-1d.json"}
blackouts_add {"start": "2026-10-07T12:25:00Z", "end": "2026-10-07T12:40:00Z", "reason": "CPI 08:30 ET"}
combine_status {}
reason_check {"symbol": "MNQ", "reasons": "CYCLE RESULT: no-trade - opening print window until 10:00 ET; no prop attempt running"}
→ Reasons checked against this bar's facts:
  - FALSE no-entry-window: "opening print window until 10:00 ET" - the opening drive window allows entries (09:57 ET)
  - FALSE no-attempt: "no prop attempt running" - the my_50k attempt is active
  The priority order, step by step, as the facts answer it:
  - orb short: 1 hard stops pass (no hard stop); 2 trend rule pass (the trend rule allows a short); 3 room no-trade (VWAP (rth) at 0.4R before the 2R it needs); ...
  2 reasons FALSE: name each, drop them, and make the decision again from the facts.
```

A person does the same at a terminal: `node <root>/scripts/bars.js --symbol
MNQ --timeframe 15 --count 160`.
