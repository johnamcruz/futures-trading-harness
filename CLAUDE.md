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
- Policy strategies (`signal: policy`, e.g. `strategies/prop_portfolio`) are the prop
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
  Contracts have standard names (`MNQ`, `NQ:2026-03`): the contract translator
  (`scripts/contract-translator.js`, `scripts/lib/broker/translator.js`) sits in front of every server and
  maps them to the broker's own contract ids by asking that server; nothing above it needs one.
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
npm run verify                   # the regression: everything CI runs (test incl. e2e, lint, sync check, strategies, secrets)
npm test                         # node tests/run-all.js
npm run lint                     # eslint + markdownlint-cli2
node scripts/sync-harness.js     # after editing agents, commands, rules, or skills
node scripts/strategies.js validate
```

## ECC architecture (hard rule)

The ECC architecture: one canonical tree of plain documents (agents, skills,
commands, rules, hooks, strategies, accounts) that each harness's own format is
generated from, with the logic in small tested modules and anything that must
hold enforced in code. Every new change or modification follows it; a change
that doesn't is not done, whatever else it fixes. Before committing, check it
against:

- Roles are agents, know-how and workflows are skills, commands are shims,
  always-on rules are rules, events are hooks, and strategies and accounts are
  documents. Generated adapters come only from `node scripts/sync-harness.js`.
- Logic lives in `scripts/lib/` with unit tests in `tests/lib/` (or
  `tests/scripts/`); a CLI stays under 200 lines and a hook script under 200.
- What the agent must know about a change (a new refusal, a new tool behaviour)
  goes into the skill or agent that uses it, synced to every harness.
- Brokers stay outside: harness code reaches them only through the adapter and
  the broker MCP interface.

`tests/plugin/ecc-architecture.test.js` enforces what can be checked in code
(lib modules unit-tested, CLI and hook size, no runtime dependencies, no
broker code); its listed exceptions and pinned sizes may only shrink.

## Before a pull request (hard rule)

Every coding agent (Claude Code, Codex, Qwen Code, any other) and every person
changing this repository does both of these before opening or updating a pull
request, every time, whatever the size of the change:

1. **Regression.** `npm run verify` passes: the full test suite (unit,
   wiring, e2e, including `tests/e2e/mock-trading-e2e.test.js`), lint, the
   generated-files check, strategy validation, and the secrets check, as CI
   runs them. A change under `rl/` or `scripts/lib/rl/` also runs the Python
   suite for real: `FTH_PYTHON=<python with rl/requirements.txt> FTH_REQUIRE_PYTHON=1 npm test`.
2. **Adversarial review.** A reviewer other than the author of the change (a
   separate agent or subagent with no stake in it, or a person) reviews the
   whole diff against the base branch, trying to break it: inputs that make a
   gate fail open, a refusal of a legitimate risk-reducing action, broker
   faults (lost, late, refused or errored replies), races, tests that would
   pass without the code they claim to cover, and ECC compliance. Every
   confirmed finding is fixed (or, if not worth its code, answered with the
   reason), then the regression runs again and the fixes get their own review,
   until a round confirms nothing new.

   A change to documents only (Markdown under `docs/`, `README.md`,
   `CONTRIBUTING.md`, and nothing else) gets the regression and a review that
   the plan or content is sound and its claims about the code are true, not
   the full adversarial round. Skills, agents, commands, rules, strategies, and
   accounts are instructions agents act on: they get the full round. So do
   `CLAUDE.md`, `AGENTS.md`, `QWEN.md`, generated files, and every document a
   skill, agent, command, rule, strategy, or hook points agents to (today
   `docs/BACKTESTING.md`, `docs/BROKER-MCP-INTERFACE.md`, the contract broker
   servers implement, and `docs/RL-DESIGN.md`).

Never open a pull request with a failing regression or an unaddressed
confirmed finding. The pull request description says what was run and what
the review found and fixed (`.github/pull_request_template.md`).
`tests/plugin/process.test.js` keeps `npm run verify` equal to what CI runs.

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
