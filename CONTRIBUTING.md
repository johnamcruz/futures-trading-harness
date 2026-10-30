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
  The description is at most 160 characters (the longer ones are pinned in
  `tests/plugin/skill-descriptions.pins.json` and only shrink), and every skill
  is indexed: a role's lists, the head trader's load list, a command shim, or
  the reasoned allow-list (`tests/plugin/skills-indexed.test.js`).
- Agents: `agents/<name>.md` with `name`, `description`, `tools`, `model`; fewest
  tools that work; order tools belong to `trade-executor` only. `role-skills` lists
  the skills the role uses every call; `role-index`, optional, the ones it reads only
  when a cycle needs them in opencode's index mode, the default (the role holds
  `mcp__harness__skill_lookup`). Its body's "Load the skills ..." sentence names both
  lists together: every adapter that reads the body loads them all, and opencode's
  prompts split them (the core embedded, "Look up as needed: ..." for the index) unless
  `FTH_ROLE_SKILLS=full`.
  A skill goes in the index when the role needs it only in some situations; when a
  situation makes it necessary, add the trigger to `SITUATIONAL` in
  `scripts/lib/trading/skills-loaded.js` (a small vocabulary over the bar briefing's
  `m3`), and in index mode the gate won't count the role's report for an entry without
  that lookup. The split into small single-purpose skills is what makes this work:
  the index entry is the skill's `description`, so write it to say when it is needed.
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

## Golden files

Some regression tests compare what the harness produces with a pinned copy:
`tests/fixtures/golden/` (loading, every strategy's decision on fixture
bars, the compact scan, snapshot and bar briefing the model reads, the cycle
prompts, the order gate's verdicts, and the cache keys and hits;
`tests/golden.js` compares them) and `tests/scripts/cli-parity.snapshot.json`
(the scripts' output). Any difference fails `npm run verify` with the changed
lines. A missing golden fails too: a test run never creates one.

The context quiz (`config/context-quiz.json`, run by hand: docs/TRAINING.md, "The context quiz") is held the same way:
a changed question or key is explained in the pull request.

When a change is meant to change that output, regenerate on purpose, then
review the diff:

```bash
FTH_UPDATE_SNAPSHOTS=1 node --test tests/lib/golden-decisions.test.js   # the test file whose golden changed
git diff tests/fixtures/golden/
```

The flag is refused when `CI` or `GITHUB_ACTIONS` is set (for the CLI snapshot too). Every changed golden line is explained
in the pull request (what changed and why it is intended); a golden diff with
no reason is a review finding.

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
