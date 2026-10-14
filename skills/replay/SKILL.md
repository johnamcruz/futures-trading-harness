---
name: replay
description: Replay the live harness over history - the same runner, harness CLI, agents, skills, scripts, order gate and broker interface, cycle by cycle on a replay broker (backtester-mcp) that simulates only the data, the clock and the fills - to measure how the reasoning trader would have traded and how closely it followed its rules (the adherence scorecard). Use when the user wants to set up, run, resume, or read a replay of the autonomous trader; replay runs are the user's to start.
---

# Replay

A replay is the live harness run on replayed data. Nothing about the trader
changes: the runner builds each cycle as it does live (bars through the broker
adapter, the bars file, the trend and signal records, the strategy scan, a
policy's verdicts, the account), the harness CLI the runner config selects
(Qwen Code, Claude Code, Codex, opencode, or a custom one) runs the cycle with
the same agents and skills, and every order goes through the same order gate
to the broker. Only the data, the clock and the fills are simulated, by a replay
broker.

## When to Use

- The user wants to know how the autonomous trader would have done over a
  stretch of history (edge, win rate, R, how often it stands aside, which
  gate checks refuse it).
- Setting up a replay broker, starting a replay, resuming one, or reading its
  report.
- Turning a run into labels: each decision, the gate's answer, the outcome
  and the counterfactuals (step 10).
- Scoring how closely the trader followed its rules: the adherence
  scorecard (step 11), for a replay run or a live session (step 12), and
  its flagged decisions, the failures the code found, for review.
- Not inside an autonomous cycle: replays, like backtests, are
  the user's to start. An agent may explain and prepare the config.

## How It Works

1. **A replay broker.** A broker MCP server that reports `replay: true` and
   its replayed `serverTime` in `get_server_config`, registered in
   `~/.futures-trading-harness/brokers.json` with `"replay": true` and a
   `journalEnv`. backtester-mcp is one (its README has the entry): point
   `BACKTESTER_MCP_ENTRY` and `BACKTESTER_DATA_DIR` at it and your one-minute
   files in `~/.futures-trading-harness/.env`. The driver sets its clock,
   state folder, run id, window and journal per run; you don't.
2. **A config** (`mcp-configs/replay.example.json`): the runner config to
   replay (inline or a path), `overrides` (for example `account`: the replay
   broker's account id), `broker`, the window `start`/`end` (UTC), `everyNthBar`,
   `premarket`, `endOfDay` (the agents' review; end of day always flattens),
   `runId` and `workDir`.
3. **Isolation.** Each run gets its own fresh harness home,
   `<workDir>/<runId>`, never the live one: the driver refuses a run home that
   is or overlaps `~/.futures-trading-harness`, your `FTH_HOME`, or the
   repository. The run home holds the runner's state, records, logs, journal,
   the bars, a copy of `brokers.json`, a copy of the workspace's operator
   files (the harness CLI runs there, never in the live workspace), and the
   broker's state and clock under `replay/<runId>/`. Every live broker's
   variables are replaced in the run's processes, so nothing can reach a live
   account. The order gate is never relaxed: it judges every order at the
   replayed time.
4. **The loop**, one process per decision time (the replay clock is frozen
   per process): the broker's clock moves to the time (fills in between
   happen in the broker), then `autotrader.js --once` runs one pass of the
   live loop there with `FTH_REPLAY_NOW`. Decision times are the closes of
   the runner's bars inside its sessions (polled `barDelaySeconds` after the
   close), premarket at `premarketAt`, and end of day; holidays, weekends and
   early closes follow the harness calendar (earlier years get the CME rules
   from `exchange-calendar.js`).
   **No look-ahead.** The harness reads only bars closed by the replay
   clock, as live it could see nothing else. The runner's bars and `bars_fetch`
   drop any later bar the server sends. Every tool that reads a bars file
   (`strategies_scan`, `strategies_recent`, `order_plan`, `market_snapshot`,
   `mtf_read`, a daily file included) refuses a file that holds one, saying
   which bars and when they close. A later bar's briefing is not served.
   A direct broker `get_bars` (yours, or the order gate's regime check)
   returns what the replay server serves, so the server must cut at its
   clock: `scripts/check-broker-mcp.js` dates its calls at the replay clock
   and fails a server whose `get_bars` returns such a bar. Live, with no replay
   clock, nothing changes. `tests/e2e/no-look-ahead.test.js` proves it,
   along with the rules and backtest fill guarantees in `docs/BACKTESTING.md`.
   With several timeframe lanes (the runner
   config's `lanes`), the decision times are the union of every lane's
   closes, one time per close however many lanes close then (the live runner
   makes those one cycle), and each line lists its lanes (`lanes: [3, 1]`;
   one-lane runs have no such key). A "signal" lane's time with no fire and
   nothing open runs no cycle, as live. Each lane's last bar is kept in the
   run's runner state, so a pass at a 1m-only time never takes the last 3m
   bar for a new one.
5. **The store**, local only: `<run home>/replay/<runId>/<day>.jsonl`, one
   line per decision time (what ran, the cycle's result, prompt hash, tool
   calls, skills and orders from the cycle log, the gate's refusals, and the
   broker's fills since the previous time, with its round-trip metrics such
   as R, MAE and MFE, and `values`: the broker field values the rules of
   each strategy the scan ran read on each decision bar, by path, a missing
   one null), plus
   `manifest.json` (config hash, harness command, `source: "replay"`, and
   the `fingerprints` and `versions` of the agent that made each decision,
   with the broker's bar settings its `fingerprintEnv` lists in
   `mcp-configs/brokers.json`, each value as a digest keyed on the run
   home's own salt, so comparable within the run only, never a credential),
   `steps.log` (each step's output), and `bars-<day>.jsonl.gz`: every bar
   the run's passes read, with its contract and every field the broker put
   on it, appended as gzip JSON lines and kept with the run (never pruned;
   live sessions' archives are, past `FTH_BARS_ARCHIVE_DAYS`, default 90).
6. **Resume.** Run it again: completed days are skipped and an unfinished
   day continues after its last decision time (the broker's clock only moves
   forward). A changed config, harness or model needs a new `runId`.
7. **The report**: month by month, decision times, cycles, failed cycles,
   stand-aside rate, trades, win rate, mean R, expectancy, net, MAE and MFE in
   R, and the gate's refusals by check (`replay-clock` refusals are the
   replay's plumbing, counted apart). It also writes `report.md` in the run's
   folder.
   **The combine verdict**: each calendar month (by trading day, 17:00 CT,
   Topstep's daily reset) scored as a fresh prop attempt from the account's starting
   balance (fresh each month is the default; one month never carries into
   the next), by the same `combine.js` rules the backtester
   uses: PASS (and the day it passed: profit at the target at a day's end,
   with the best day at most `consistency_pct` of the profit), FAIL (the
   rule and the day: equity at the max-loss floor, which trails the
   end-of-day high for `trailing_eod`), or NOT YET (profit vs target, what
   consistency still needs, days traded); plus the max loss used vs the
   limit, the daily P&L path, and a year summary (months passed, failed,
   not yet). The firm's daily loss limit flattens the account there and
   stops the day, not the attempt (whichever of the daily limit and the
   floor is nearer is reached first); what was still open then, positions
   opened after it that day, and positions carried in from the month before
   are left out. Money is every fill's P&L less its fees.
   Intraday equity is approximated from each round trip's MAE, at its
   `maeTime` when the broker sends one (said in the output). Account: `--account <name>`, else the runner config's `account`
   when it names an account profile, else the policy strategies'
   account, else `topstep_100k`; the output says which and why. Report the verdict
   as replayed, never as a guarantee of a live result.

8. **Stops.** A cycle that made no decision (an infrastructure failure: no
   `CYCLE RESULT` line, a harness that failed or timed out) is recorded as
   an attempt (`retried`, folded into the time's line as `retries`), and its
   decision time runs again: counted once in the report, never skipped,
   except that a crash during the retry records the time as interrupted
   (never run twice). The agent's own `CYCLE RESULT: error` is a decision:
   recorded as live records it, a failed cycle, and the run goes on with no
   retry. A premarket run's failure is never a failed cycle (as live: the
   runner retries it). The run stops, saying why, after `maxConsecutiveErrors` failed
   cycles in a row (a time still due, in the manifest's `cycleRetry`, runs
   first on resume), when a step can't run, and while the run's kill switch
   (`<run home>/STOP`) is on: the runner sets it when a cycle changed the
   workspace's operator files or settings (the file's latest line says
   why). As live, the day under way still runs with no trade cycle, its
   housekeeping and end of day included (flat at the close); the run stops
   before the next day. Review the change, remove the file, and run again
   to resume there. A queued end-of-day retry is kept across any stop (the
   error limit included) and runs first on resume; a time already recorded
   never runs again. A day whose end of day was never verified flat waits
   for that resume: the runner flattens it before the next day trades. The
   settings-format stamp (`"$version"`) Qwen Code writes into the workspace
   `.qwen/settings.json` on start is not a change.
9. **The prop policy.** A policy strategy (for example `prop_portfolio`,
   `account: topstep_100k`) names a prop account; with an account in the
   runner config, every pass logs "topstep_100k: no attempt is started" until
   an attempt runs in the run home. The warning never stops a cycle, and
   without an attempt the policy owns no setups (its component strategies
   trade as before), so leaving it is a replay without the prop policy. To
   replay the policy, set `"prop": "topstep_100k"` in the replay config: a
   fresh run starts that attempt at `start`, before the first decision, so
   every trade of the window is inside it (a resumed run keeps the attempt it
   has). Its broker stops the day at that account's own daily loss limit
   (`daily_loss_limit` in its `ACCOUNT.md`, e.g. $2,000 for `topstep_100k`),
   not the replay server's default, so the room the agents size from is the
   firm's.
   The policy strategy must be `active` (`prop_portfolio` is): while an
   attempt runs, the order gate takes entries only from a policy strategy
   that trades it, and a policy owns its strategies' setups only when
   `active` (a `paper` one is plan only; in a paper-mode run it owns them,
   but nothing is placed), so with a `paper` policy every entry is refused.
   The policy strategy sizes each setup by its `sizing` rules: full within
   the budget, or skip.

10. **Labels.** `node scripts/replay.js labels <run dir>` turns a run into
   labels, a record of how the reasoning trader decided (any harness, any
   model), the input for measuring how closely it follows its rules: one
   per decision time and symbol in `<run dir>/labels.jsonl`, with
   `labels-summary.json`, never in the repository. Each holds the bar's
   candidates; the field values its line recorded (`values`; null with
   `valuesAbsent` for a run recorded before lines carried them, with
   `valuesError` when taking them failed) and the archived bar
   (`archivedBar`; `archiveError` when the archive can't be read or the
   bar's archiving failed, `archivePruned` when retention removed it);
   the teacher's action (`none`, `long`, `short` flat; `hold`,
   `tighten`, `exit` in a trade), its setup, its stop as a multiple of
   ATR(20) on bars closed by then, its size as a step of the budget
   (`--budget USD`; unknown without it); the gate's answer (refused intents
   kept and flagged; a refused try then an allowed retry is one decision);
   the trade's outcome from the fills; and, for a skipped candidate or one
   on a bar no cycle ran, the counterfactual: the strategy's own trade with
   the brackets `order_plan` would place, filled by the backtester's
   simulated broker (next-open fill plus a tick, stop before target in a
   bar, flat at end of day; pass the data the run replayed with
   `--bars MNQ=<file>`, else the run home's bars). Label a run only once
   it is finished: the labels hold what came after each decision, and the
   command refuses an unfinished run unless `--out` names a folder outside
   its run home. A run counts as finished once the driver ran every
   decision time of its window (`finished` in its manifest); a run made
   before the driver recorded that has no flag and can only be labelled
   with `--out` (resuming it is refused once skills changed: they are in
   its config hash). A refused try followed by one that went through is one
   decision (the refused tries counted); an intent the gate or the broker
   refused gets its candidates' counterfactual too. Candidates are only
   what the teacher could trade (a paper strategy is left out unless the
   run is in paper mode, where no flat decision is a skip); a flat cycle
   with a resting order or a manage-only cycle is no skip, and the
   strategies a failed policy screen names are no candidates. Decisions the
   mechanical action space can't express (limit or stop entries, a target
   other than the strategy's own exit as `order_plan` places it, adds,
   partial exits) are counted as uncloneable, by reason.
   Read the printed counts (taken, unknownOutcome (an entry whose call
   timed out with no broker record or fill: never counted as taken), skipped, refused, wins, losses,
   skipped-would-have-won and -lost, uncloneable, unmapped, unsimulated)
   before drawing conclusions from a run. An exit by `close_position` shows only when
   the harness's transcript names tool calls (Claude Code, Codex, Qwen
   Code, opencode); a custom harness printing plain text shows it as a
   hold.
11. **Scorecard.** `node scripts/replay.js scorecard <run dir>` scores every
   decision against the priority order (`strategy-library`): the facts the
   trader had at that time, from the run's own records (the scan's candidates
   and verdict, the trend rule per side, the room and the multi-timeframe read
   from the briefing rebuilt with the runner's own code on the bars closed by
   then, confluence, the session window, the attempt); the decision the
   order's mechanical steps expect (no trade, or take at most the verdict's
   size, halved once; a step it can't compute leaves it `unchecked`, and the
   skip rules and secondary context are left to judgment; an entry is judged
   against the setup it traded, a skip against the best one on the bar; a
   take that a judgment step can still turn down, a pullback, a reversal
   fading the trend, or halving a size the record doesn't give, scores
   neither a skip nor an entry right or wrong); what the trader did
   and the reasons its CYCLE RESULT gave, each checked against the facts
   (`true`, `false`, or `unchecked` when no fact can check it; a clause it
   doesn't recognize is `unparsed`, never counted as right; a claim about a
   setup the bar didn't have is `incidental`, reported apart and never the
   category). Each decision
   gets a category: `right`, `wrong-side entry`, `bad size` (over the ceiling,
   or an entry where the order says no trade), `early close` (an exit the
   trader sent before the plan's exit was reached; a partial exit, one past
   the time stop, or one after giving back most of a large best is
   `unchecked`), `excessive abstention` (a skip where the order
   says take, on false grounds or none), `wrong stated reason` (the right
   decision, a false reason), `risk-rule rejection` (the gate or the broker
   refused the entry), or `unchecked` (a judgment skip, a failed cycle, facts
   missing). It writes `scorecard.jsonl` (one record per decision, with the
   trade's R and dollars, a skipped setup's counterfactual, and the account
   pacing: cushion, daily-limit headroom, balance check),
   `scorecard-summary.json` and `scorecard.md` (agreement overall, by step
   and by strategy, the categories, the wrong-reason rate, trades, skipped
   setups, the account by day). Every failure carries a severity (`high`: a
   wrong-side entry, or an entry where the order says no trade; `medium`: a
   size over the ceiling, an early close, an excessive abstention, a refused
   entry, or a false hard-stop reason such as the window or the trend rule;
   `low`: any other false reason on a right decision), and the report counts
   the failures per type, per session day and per run, with rates.
   Everything is decided by code from the record, never by a model.
   **Session timing:** a false claim about the window ("opening print until
   10:00" in the opening drive, "session closed" or "opens 18:00" at 10:48)
   is a session-timing misread, counted apart inside its category.
   **Field check:** for a strategy whose rules read broker fields
   (`field("a.b")`), its field conditions are checked on the values the
   decision line recorded; an entry on a setup the scan did not fire whose
   own side fails is a `wrong-side entry` (the other side, all on fields,
   holds) or a `bad size` (the order says no trade), and a fired setup the
   values contradict is a recording `mismatch`, never the trader's failure.
   **Claim checks:** when a cycle record carries its own reason checks
   (`reasonChecks`; no cycle records them yet), a right decision that still
   states a claim its own check found false is a `wrong stated reason`;
   without them it reads "not checked". **Missing data:** values absent (a
   session recorded before they were), a values error, an archive error or a
   pruned archive are counted, never filled in. It also writes
   `flagged.jsonl` and `flagged.md`: one entry per failure, with what the
   trader saw (pointers, relative to the run home, to the decision line, the
   cycle record, the prompt's hash and the scan line, and the facts), what it
   did and said, what the code found, and one sentence to review it by.
   Scoring a run is a look at its days (`scripts/lib/prop/looks.js`):
   `--purpose reasoning-fix` (the default for a run in Recent and the only
   look Recent allows, e.g. the June 1-5, 2026 replay), `tuning` (the
   default elsewhere) or `judging` (it needs `--ledger <file>`, the look
   ledger the evaluator also uses: JSON lines, one look per line; an older
   ledger written as one JSON list still reads and is converted to lines on
   its next look. Each allowed look is appended to a ledger given, so the
   scorecard's and the evaluator's looks spend one budget. Use the one
   existing look ledger; never create, empty, replace or edit a ledger to
   get more looks, and if the ledger is missing or refused, stop and report
   it), `--candidate <name>`; a look the schedule refuses (a reserve
   half-year, a held-out quarter not judged) stops it before anything is
   read, and a live session is no look. On a reasoning-fix look every
   market outcome is hidden (owner, 2026-10-13): no trade results, no
   skipped setup's counterfactual, no account balance or P&L, and an exit
   is never scored from its excursion, and a dollar amount in any text (an
   entry block, a verdict reason, the trader's own words) reads `$…`; only
   the reasoning and fact
   failures show. A tuning look, or a live session, shows everything. Like
   labels, it is written in the run's own
   folder only once the run is finished, else to `--out` outside its run
   home; `--bars` as for labels. Read `unchecked` and `unparsed` as
   unmeasured, never as agreement; a false reason is a misread of a fact the
   trader was given.
12. **Live sessions.** The live runner records every trading day the same
   way, in `<FTH_HOME>/sessions/<trading day>/` (`source: "live"`): one line
   per decision point (premarket, end of day and its retries, and every
   closed bar at one of replay's trade times, a cycle or no cycle; with
   several lanes, the lanes whose bars closed in `lanes`), the
   runner config the session started with, and, once
   end of day verified the account flat, the day's fills on that end of
   day's line and the broker's journal for the day. `report`, `labels` and
   `scorecard` take a session's folder as they take a run's:
   `node scripts/replay.js scorecard ~/.futures-trading-harness/sessions/2026-10-07`.
   A session is finished once its end of day is done and its fills are
   known; a fills read that failed is retried by the runner (the manifest's
   `fillsPending`), and until then score it only with `--out` outside the
   harness home. Score live and replay decisions apart (the manifest's
   `source`): live is its own split. What still differs from a replay:
   (a) a line only for a bar the runner polled (none with the kill switch on
   unless it keeps housekeeping: an account, not paper mode, the day already
   traded; none for a bar not published in time), where a replay records
   each trade time; (b) a bar too old to start a cycle (a slow previous
   cycle) is a line with no cycle, marked `stale`; (c) a line's time is when
   the pass ran, not the close plus the poll delay, its `step` is always
   `{ code: 0, timedOut: false }`, and every bar counts (no `everyNthBar`);
   (d) fills are read once, at end of day; (e) the lines' refusals come from
   the gate log in force (`FTH_GATE_LOG`), the labels' from
   `<FTH_HOME>/logs/gate-log.jsonl`; (f) a restart on another config,
   harness or model is a new version of the same session (`versions`, its
   config in `autotrader-<since>.json`); the labels and the scorecard read
   each line with the config in force at its time (timeframe, paper mode,
   symbols), so a day started in paper mode and restarted live is labelled
   right on both halves (`--bars` then needs one-minute data: it is
   aggregated at each timeframe the session used). The fills retry runs only while the runner is idle
   (flat, its end of day done or the market closed), one day at a time.

A trade cycle is a full harness cycle with the model: count the decision
times (`points`) before a long run; `--max-cycles` stops cleanly, and the
next run resumes. One driver runs a run at a time (a lock in its folder).
Bars the agents fetch (`bars_fetch`) go to the run home's own
`<run home>/bars-scratch`, never a folder a live session or another run
reads; the driver still refuses to start while the live runner runs.

What a replay can't seal off (say so when reporting results):

- **The web.** The live allowlists keep web search and the calendar sites,
  which answer with today's pages, after the replayed time. For a sealed run,
  use a runner config whose harness has no web tools (a custom command or
  `extraArgs`).
- **Codex** can read files outside its workspace, including the replay
  broker's data folder; and its gateway gets only the variables the installer
  listed for the broker chosen at install time, so a Codex replay's entries
  are refused (fail closed) until it is installed for the replay broker.
- **The model's memory.** It may know what happened in a window before its
  knowledge cutoff: judge the trader on windows after it.

## Examples

```bash
cp mcp-configs/replay.example.json replay.json        # set runId, workDir, broker, window, account
node scripts/replay.js points --config replay.json    # decision times per day (holidays skipped)
node scripts/replay.js run --config replay.json --max-cycles 50
node scripts/replay.js run --config replay.json       # resumes after the last decision time done
node scripts/replay.js report ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03   # --account topstep_50k: score another account
node scripts/replay.js labels ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03 --budget 200 --bars MNQ=~/data/MNQ-1m.parquet
node scripts/replay.js scorecard ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03 --bars MNQ=~/data/MNQ-1m.parquet
node scripts/replay.js scorecard ~/.futures-trading-harness/sessions/2026-10-07   # a live trading day, scored the same way
```

```text
month    times  cycles  failed  stand-aside  trades  win rate  mean R (n)  expectancy  net      MAE R  MFE R  refusals by check
2024-03  2520   2541    0       91.3%        38      44.7%     0.21 (38)   $9.42       $357.96  -0.48  1.12   plan-required 6, mtf-trend 3

Combine verdict: topstep_100k (the policy strategies' account (prop_flow_1m, prop_portfolio)); each month a fresh attempt from $100000.00: ...
2024-03  NOT YET: profit $357.96 of $6000.00 ($5642.04 to go), 14 of 21 day(s) traded
         max loss used $612.50 of $3000.00 (closest to the floor on 2024-03-12); intraday from MAE on 38 of 38 closing fill(s)
Summary: 0 passed, 0 failed, 1 not yet, of 1 month(s).
```
