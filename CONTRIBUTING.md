# Contributing

## Adding a strategy

1. Copy `strategies/_template/` to `strategies/<name>/` (or use the
   `strategy-authoring` skill / `/new-strategy`).
2. Fill in the frontmatter and every body section; keep `status: paper`.
3. `node scripts/strategies.js validate`
4. Write mechanical triggers as `signal: rules` in the frontmatter, and
   discretionary ones as `signal: manual`. For a pattern the rule language
   can't express, add a series to `scripts/lib/trading/rules.js` (with
   tests) and use it in the strategy's rules.

## Adding a skill, agent, or command

- Skills: `skills/<name>/SKILL.md` with `name`, `description`, and the three sections.
- Agents: `agents/<name>.md` with `name`, `description`, `tools`, `model`; fewest
  tools that work; order tools belong to `trade-executor` only.
- Commands: a shim that says "Use the `<skill>` skill for: $ARGUMENTS".
- Then run `node scripts/sync-harness.js` to regenerate the Codex, Qwen, and
  workspace files, and commit them.

## Changing the order gate, hooks, gateway, or runner

- Logic lives in `scripts/lib/`; entry points stay thin.
- Unit tests in `tests/lib/`, end-to-end tests in `tests/hooks/` (hooks through
  `run-with-flags.js`, the gateway against a fake MCP server).
- Order gating fails closed. Don't change that.

## Checks

```bash
npm install
npm test
npm run lint
node scripts/sync-harness.js --check
```

Use conventional commit messages.
