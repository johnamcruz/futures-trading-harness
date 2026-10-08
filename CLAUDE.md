# CLAUDE.md

Guidance for coding agents working on this repository (Claude Code reads this
file; Codex and others read `AGENTS.md`, which points here). Trading sessions
run from `workspace/`, whose generated `AGENTS.md`/`CLAUDE.md`/`QWEN.md` hold the
operator instructions.

## Project

An LLM-agnostic futures trading harness on the ECC architecture: canonical
agents, skills, commands, rules, and hooks, with generated adapters for Claude
Code, Codex, and Qwen Code; strategies as `STRATEGY.md` documents; an order gate
enforced by hooks and by an MCP gateway; and an autonomous runner.

## Layout

- `agents/` (canonical roles, Claude format: `name`, `description`, `tools`, `model`).
  Only `trade-executor` may hold order-writing MCP tools; a test enforces it.
- `skills/<name>/SKILL.md`: frontmatter `name` (= folder) and `description`, then
  `## When to Use`, `## How It Works`, `## Examples`. Workflows are skills;
  `commands/` are thin shims that say "Use the `<skill>` skill".
- `strategies/<name>/STRATEGY.md`: schema in `scripts/lib/trading/strategies.js`.
- `rules/trading/`: always-on rules (installed for Claude, embedded in workspace/AGENTS.md).
- `hooks/hooks.json`: every hook runs through `scripts/hooks/run-with-flags.js`.
- `scripts/lib/`: pure logic (frontmatter, harness-sync, install, autotrader,
  trading/*). CLIs and hooks stay thin.
- Generated, never edit by hand: `workspace/*.md`, `.codex/agents/*.toml`,
  `qwen/agents/*`, `qwen/commands/*`. Run `node scripts/sync-harness.js`.
- `tests/`: `node:test` files named `*.test.js`.

## Commands

```bash
npm test                         # node tests/run-all.js
npm run lint                     # eslint + markdownlint-cli2
node scripts/sync-harness.js     # after editing agents, commands, rules, or skills
node scripts/strategies.js validate
```

## Rules for changes

- CommonJS, Node 18+, no runtime dependencies (plugin installs don't run npm install).
- Hooks and the gateway read only local state; no network. Hook scripts stay under 200 lines.
- The order gate fails closed in both the hook (`FAIL_CLOSED_HOOKS` in
  `run-with-flags.js`) and the gateway. Keep it that way.
- Never weaken a gate default without the user asking. Gate changes need tests in
  `tests/lib/order-gate.test.js` and wiring tests in `tests/hooks/trading-hooks.test.js`.
- New `scripts/lib/` modules need tests in `tests/lib/`.
- Strategies are ported faithfully from their source; flag suspected bugs.
- Example arithmetic must be tick-correct (MNQ/MES tick 0.25; MNQ $0.50/tick, MES $1.25/tick).
- Never commit credentials.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
