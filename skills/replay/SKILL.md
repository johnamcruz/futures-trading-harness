---
name: replay
description: Replay the live harness over history - the same runner, harness CLI, agents, skills, scripts, order gate and broker interface, cycle by cycle on a replay broker (backtester-mcp) that simulates only the data, the clock and the fills - to measure how the reasoning trader would have traded. Use when the user wants to set up, run, resume, or read a replay of the autonomous trader; replay runs are the user's to start.
---

# Replay

A replay is the live harness run on replayed data. Nothing about the trader
changes: the runner builds each cycle as it does live (bars through the broker
adapter, the bars file, the trend and signal records, the strategy scan, a
policy's verdicts, the account), the harness CLI the runner config selects
(Qwen Code, Claude Code, Codex, or a custom one) runs the cycle with the same
agents and skills, and every order goes through the same order gate to the
broker. Only the data, the clock and the fills are simulated, by a replay
broker.

## When to Use

- The user wants to know how the autonomous trader would have done over a
  stretch of history (edge, win rate, R, how often it stands aside, which
  gate checks refuse it).
- Setting up a replay broker, starting a replay, resuming one, or reading its
  report.
- Not inside an autonomous cycle: replays, like backtests and training, are
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
5. **The store**, local only: `<run home>/replay/<runId>/<day>.jsonl`, one
   line per decision time (what ran, the cycle's result, prompt hash, tool
   calls, skills and orders from the cycle log, the gate's refusals, and the
   broker's fills since the previous time, with its round-trip metrics such
   as R, MAE and MFE), plus `manifest.json` (config hash, harness command)
   and `steps.log` (each step's output).
6. **Resume.** Run it again: completed days are skipped and an unfinished
   day continues after its last decision time (the broker's clock only moves
   forward). A changed config, harness or model needs a new `runId`.
7. **The report**: month by month, decision times, cycles, failed cycles,
   stand-aside rate, trades, win rate, mean R, expectancy, net, MAE and MFE in
   R, and the gate's refusals by check (`replay-clock` refusals are the
   replay's plumbing, counted apart). It also writes `report.md` in the run's
   folder.

8. **Stops.** The run stops, saying why, after `maxConsecutiveErrors` failed
   cycles in a row, when a step can't run, and while the run's kill switch
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
   replay the policy, start an attempt in the run home at the replayed time
   after the first step created the home (`run --max-cycles 1`), then resume:
   `FTH_HOME=<workDir>/<runId> FTH_BROKERS_FILE=<workDir>/<runId>/brokers.json FTH_BROKER=<replay broker> FTH_REPLAY_NOW=<start, UTC> node scripts/combine.js start --account topstep_100k`.

A trade cycle is a full harness cycle with the model: count the decision
times (`points`) before a long run; `--max-cycles` stops cleanly, and the
next run resumes. One driver runs a run at a time (a lock in its folder).

What a replay can't seal off (say so when reporting results):

- **The web.** The live allowlists keep web search and the calendar sites,
  which answer with today's pages, after the replayed time. For a sealed run,
  use a runner config whose harness has no web tools (a custom command or
  `extraArgs`).
- **Scratch files.** The scripts write `/tmp/fth`, shared with live sessions
  and earlier runs: a stale file there can hold later bars. The driver
  refuses to start while the live runner runs; clear `/tmp/fth` before a
  replay when no live session needs it.
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
node scripts/replay.js report ~/fth-replays/mnq-ny-2024-03/replay/mnq-ny-2024-03
```

```text
month    times  cycles  failed  stand-aside  trades  win rate  mean R (n)  expectancy  net      MAE R  MFE R  refusals by check
2024-03  2520   2541    0       91.3%        38      44.7%     0.21 (38)   $9.42       $357.96  -0.48  1.12   plan-required 6, mtf-trend 3
```
