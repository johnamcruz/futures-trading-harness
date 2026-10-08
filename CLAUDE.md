# CLAUDE.md

Guidance for Claude Code when working on this repository.

## Project

A Claude Code plugin for trading futures on TopstepX through the
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp) server. It uses the
ECC harness architecture (agents, skills, commands, rules, profile-gated
hooks) with trading content only. See `README.md` and `docs/HARNESS-DESIGN.md`.

## Layout

- `agents/`: subagents (Markdown, frontmatter `name`, `description`, `tools`, `model`).
  Only `trade-executor` may hold order-writing MCP tools; a test enforces it.
- `skills/<name>/SKILL.md`: frontmatter `name` (= folder) and `description`, then
  `## When to Use`, `## How It Works`, `## Examples`. Playbook descriptions end
  with `Journal tag setup:<tag>`.
- `commands/`: slash commands (frontmatter `description`, optional `argument-hint`).
- `rules/trading/`: always-on rules, installed with `scripts/install-rules.js`.
- `hooks/hooks.json`: every hook runs through `scripts/hooks/run-with-flags.js`.
- `scripts/lib/trading/`: pure logic (clock, journal, config, order gate,
  indicators, market snapshot). Hook scripts stay thin.
- `tests/`: `node:test` files named `*.test.js`, mirroring `scripts/`.

## Commands

```bash
npm test              # node tests/run-all.js
npm run lint          # eslint + markdownlint-cli2
node scripts/market-snapshot.js bars.json
```

## Rules for changes

- CommonJS, Node 18+, no runtime dependencies, no TypeScript.
- Hooks must not make network calls; read only local state (journal, clock,
  config files). Keep hook scripts under 200 lines.
- `pre:trading:order-gate` is fail-closed (`FAIL_CLOSED_HOOKS` in
  `run-with-flags.js`): crashes, unreadable journals, truncated input, and bad
  config block the order. Other hooks fail open (exit 0).
- Never weaken a gate default without the user asking. Every gate change needs a
  test in `tests/lib/order-gate.test.js` and, for hook wiring, in
  `tests/hooks/trading-hooks.test.js`.
- New `scripts/lib/` modules need a matching test in `tests/lib/`.
- Example arithmetic in skills must be tick-correct (MNQ/MES tick 0.25; MNQ
  $0.50/tick, MES $1.25/tick).
- Never commit credentials. `PROJECTX_API_KEY` belongs in the MCP server env only.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
