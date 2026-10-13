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
- Then run `node scripts/sync-harness.js` to regenerate the Codex, Qwen,
  opencode, and workspace files, and commit them.

## Changing the order gate, hooks, gateway, or runner

- Logic lives in `scripts/lib/`; entry points stay thin.
- Unit tests in `tests/lib/`, end-to-end tests in `tests/hooks/` (hooks through
  `run-with-flags.js`, the gateway against a fake MCP server).
- Order gating fails closed. Don't change that.

## Platform-neutral

No platform-, firm- or model-specific code, names, env vars, defaults,
contract-id formats or paths in this repository: platform specifics live in
the broker's MCP server (its own repo), firm rules in `accounts/`, model
specifics in your local config. `mcp-configs/brokers.json` is the one link.
Tests use the fake broker (`tests/fixtures/brokers.json`) and fixture accounts
(`tests/fixtures/accounts/`). `tests/plugin/no-platform-specifics.test.js`
enforces it; see "Separation of work" in `CLAUDE.md`.

## Checks

```bash
npm install
npm run verify    # test (unit, wiring, e2e), lint, sync check, strategies, secrets: what CI runs
```

## Before a pull request (hard rule)

For everyone, people and coding agents alike, on every pull request: the
regression passes (`npm run verify`), and an adversarial review by someone
other than the change's author found nothing left to fix (each confirmed
finding fixed, the regression re-run, the fixes reviewed again). A
change to documents only (Markdown under `docs/`, the README, this file, and
nothing else) still runs the regression, with a review that it is sound and
its claims about the code are true instead of the full round. A document
that a skill, agent, command, rule, strategy, account, hook, or script
points to (the list is in `CLAUDE.md`) gets
the full round. Say both in the pull request (the template asks). See `CLAUDE.md`.

Use conventional commit messages.
