---
name: replay
description: Use when the user wants to set up, run or read a replay of the trader on history. User-run.
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
  and the counterfactuals (the `replay-labels` skill).
- Scoring how closely the trader followed its rules: the adherence
  scorecard (the `replay-scorecard` skill), for a replay run or a live
  session (the `live-session-records` skill), and its flagged decisions,
  the failures the code found, for review.
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
   `runId` and `workDir`. Optional `practice` (`{ "mode": "setup-focus",
   "setupTf": 15, "quietSample": 0.15, "seed": 1 }`) makes a practice run
   setup-focused: a model cycle only on the bars after a 15m (or 5m, 1h)
   candle reacted at a key level, a seeded sample of quiet bars, and every bar
   with something open; the other bars are still polled, briefed, scanned and
   recorded, and the broker fills between them. Refused on test and final and
   on runs not learning; the report counts the bars skipped and the time
   saved, and the learning report says the run was setup-focused. Optional
   `setupLibrary` pins a history library index (`scripts/setup-library.js`,
   practice-train only); pinned alone it is not shown. `libraryDisplay: true`
   shows it in `experience_lookup`, apart from your own record, as
   code-measured history: counts, win rate and no-room only.
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
   per process, or, with the run's `latency` on, the default for a learning
   run, runs with the wall clock from each decision time, so the cycle's own
   time is charged as live): the broker's clock moves to the time (fills in between
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
6. **Resume and stops.** Running a run again, and why a run stops: the
   `replay-resume` skill.
7. **The report**: month by month, decision times, cycles, failed cycles,
   stand-aside rate, trades, win rate, mean R, expectancy, net, MAE and MFE in
   R, and the gate's refusals by check (`replay-clock` refusals are the
   replay's plumbing, counted apart). It also writes `report.md` in the run's
   folder.
   **The prop score**: the Monte Carlo of the run's own trades
   (`scripts/lib/prop/model-score.js`), in order: zero blows (the hard gate);
   the pass rate within the account's `sessions` trading days; the median and
   p90 days to pass; the blow and timeout rates with their intervals (also at
   the effective sample size). A full-day run's score is `real`. A curated
   run's is "diagnostic (reweighted)", at its lists' natural rates (give its
   `--config`); a setup-focused run's is "diagnostic (setup-focused)". Neither
   is a promotion score. `report` also scores the model's risk actions (pass,
   day-stop, size-down, early-exit) against their counterfactuals by account
   state. Account: `--account <name>`, else the run's own attempt, else the
   runner config's `account` when it names a profile, else the policy
   strategies' account; with none the run is not scored. Report the score as
   replayed, never as a guarantee of a live result.

8. **The prop policy.** A policy strategy (for example `prop_portfolio`,
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

9. **After the run.** Labels: the `replay-labels` skill. The adherence
   scorecard and its flagged decisions: the `replay-scorecard` skill. A live
   trading day, recorded the same way: the `live-session-records` skill.

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
node scripts/replay.js report ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03   # --account topstep_50k: score another account
```

```text
month    times  cycles  failed  stand-aside  trades  win rate  mean R (n)  expectancy  net      MAE R  MFE R  refusals by check             replay-clock
2024-03  2520   2541    0       91.3%        38      44.7%     0.21 (38)   $9.42       $357.96  -0.48  1.12   plan-required 6, mtf-trend 3  0
total    2520   2541    0       91.3%        38      44.7%     0.21 (38)   $9.42       $357.96  -0.48  1.12   plan-required 6, mtf-trend 3  0

Prop Monte Carlo, 30-day attempts (<account>, prop_portfolio's rulebook): real
  1. Zero blows (hard gate): held: 0 blow(s) over 22 real attempts, 2000 resampled paths and the expectancy cuts
  2. Pass within 30 trading days: 18.2% of 22 real attempts (bootstrap [...], Wilson at 3 independent [...]); resampled 21.4% of 2000 (Wilson [...])
  3. Days to pass: median 24, p90 29 (real); median 25, p90 30 (resampled)
  4. Blow rate 0.0% (bootstrap [...]), timeout rate 81.8% (bootstrap [...]) (real); resampled blow 0.0%, timeout 78.6%
```
