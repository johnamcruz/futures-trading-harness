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

A trade cycle is a full harness cycle with the model: count the decision
times (`points`) before a long run; `--max-cycles` stops cleanly, and the
next run resumes. Replays and a live session share `/tmp/fth` (the scripts'
scratch files): don't run both at once on one machine.

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
