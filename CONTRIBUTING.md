# Contributing

## Adding a playbook

1. Use `/new-playbook <name> <source>` or copy an existing
   `skills/playbook-*/SKILL.md`.
2. Keep the structure: context filter, trigger, entry, stop, targets and
   management, skip rules, an example with tick-correct math and a sample
   rationale, and the source parameters.
3. If the trigger is computable from bars, add it to `signals` in
   `scripts/lib/trading/market-snapshot.js` with a test. The content test
   checks that every snapshot signal has a playbook with the same tag.

## Adding an agent

- Frontmatter `name` (matches the file), `description`, `tools`, `model`.
- Give it the fewest tools that work. MCP tools are named
  `mcp__projectx__<tool>`.
- Analysts are read-only. Order tools belong to `trade-executor` only.

## Changing hooks or gate rules

- Logic goes in `scripts/lib/trading/` as pure functions; hook scripts parse
  input and call them.
- Add unit tests (`tests/lib/`) and an end-to-end hook test
  (`tests/hooks/`) that runs through `run-with-flags.js`.
- Order gating fails closed. Don't change that.

## Checks

```bash
npm install
npm test
npm run lint
```

Use conventional commit messages.
