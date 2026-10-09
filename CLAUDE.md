# CLAUDE.md

Guidance for coding agents working on this repository (Claude Code reads this
file; Codex and others read `AGENTS.md`, which points here). Trading sessions
run from `workspace/`, whose generated `AGENTS.md`/`CLAUDE.md`/`QWEN.md` hold the
operator instructions.

## Project

An LLM-agnostic futures trading harness: canonical agents, skills, commands,
rules, and hooks, with generated adapters for Claude
Code, Codex, and Qwen Code; strategies as `STRATEGY.md` documents; an order gate
enforced by hooks and by an MCP gateway; and an autonomous runner.

## Layout

- `agents/` (canonical roles, Claude format: `name`, `description`, `tools`, `model`).
  Only `trade-executor` may hold order-writing MCP tools; a test enforces it.
- `skills/<name>/SKILL.md`: frontmatter `name` (= folder) and `description`, then
  `## When to Use`, `## How It Works`, `## Examples`. Workflows are skills;
  `commands/` are thin shims that say "Use the `<skill>` skill".
- `strategies/<name>/STRATEGY.md`: schema in `scripts/lib/trading/strategies.js`.
- `accounts/<name>/ACCOUNT.md`: prop account profiles (`scripts/lib/trading/accounts.js`);
  combine rules and micro/mini sizing in `scripts/lib/trading/combine.js`, live attempt
  state and the gate's prop checks in `prop-state.js`.
- Policy strategies (`signal: policy`, e.g. `strategies/prop_portfolio_3m`) are the prop
  challenge as a strategy: they list rules strategies and carry `account`, `sizing`,
  `contracts`, `exit`, and `policy: { bundle }`. Only they have those keys.
- `rl/`: Python trainer (MaskablePPO, `rl/fth_rl`) on the JS backtester via
  `scripts/rl-env-server.js`; Optuna sweep -> retrain -> ship from
  `rl/configs/{sweep,retrain,ship}/<family>.json` (`fth_rl/pipeline.py`); bundles
  export to `models/<name>.json`, run by `scripts/lib/rl/policy-net.js`. The promotion gate (0 blows every OOS month,
  >= 40% pass) lives in `policy-bundle.js` and `rl/fth_rl/config.py`; never lower it.
- Brokers: no broker code in the harness. Every broker or prop firm runs its own MCP server (own repo)
  implementing one interface, `docs/BROKER-MCP-INTERFACE.md` (as data: `scripts/lib/broker/interface.js`).
  Which server is config (`mcp-configs/brokers.json`, `~/.futures-trading-harness/brokers.json`,
  `FTH_BROKER`; `scripts/lib/broker/config.js`); TopstepX (projectx-mcp) is the default. It is registered
  as the MCP server `broker` (gateway in front); harness code reaches it only through
  `scripts/lib/broker/adapter.js`. Check a server with `scripts/check-broker-mcp.js`.
- `rules/trading/`: always-on rules (installed for Claude, embedded in workspace/AGENTS.md).
- `hooks/hooks.json`: every hook runs through `scripts/hooks/run-with-flags.js`.
- `scripts/lib/`: pure logic (frontmatter, harness-sync, install, autotrader,
  trading/*). CLIs and hooks stay thin.
- Generated, never edit by hand: `workspace/*.md`, `.codex/agents/*.toml`, and
  `qwen-extension/` (manifest, `QWEN.md`, agents, commands, symlinks). Run
  `node scripts/sync-harness.js`.
- `tests/`: `node:test` files named `*.test.js`; `rl/tests/` (Python `unittest`) runs
  through `tests/lib/python-rl.test.js` when Python has numpy and gymnasium.

## Commands

```bash
npm test                         # node tests/run-all.js
npm run lint                     # eslint + markdownlint-cli2
node scripts/sync-harness.js     # after editing agents, commands, rules, or skills
node scripts/strategies.js validate
```

## Rules for changes

- CommonJS, Node 22+ (`.nvmrc`), no runtime dependencies (plugin installs don't run npm install).
  Python (`rl/requirements.txt`) is for training only; nothing at runtime needs it.
- Hooks and the gateway read only local state; no network. Hook scripts stay under 200 lines.
- The order gate fails closed in both the hook (`FAIL_CLOSED_HOOKS` in
  `run-with-flags.js`) and the gateway, and can't be disabled when
  `FTH_AUTONOMOUS=1`. The gateway (with `account-gate.js`) is authoritative.
  Keep it that way.
- Never weaken a gate default without the user asking. Gate changes need tests in
  `tests/lib/order-gate.test.js` and wiring tests in `tests/hooks/trading-hooks.test.js`.
- New `scripts/lib/` modules need tests in `tests/lib/`.
- Strategies are ported faithfully from their source; flag suspected bugs.
- Example arithmetic must be tick-correct (MNQ/MES tick 0.25; MNQ $0.50/tick, MES $1.25/tick).
- Never commit credentials.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
