# CLAUDE.md

Guidance for coding agents working on this repository (Claude Code reads this
file; Codex and others read `AGENTS.md`, which points here). Trading sessions
run from `workspace/`, whose generated `AGENTS.md`/`CLAUDE.md`/`QWEN.md` hold the
operator instructions.

## Project

An LLM-agnostic futures trading harness: canonical agents, skills, commands,
rules, and hooks, with generated adapters for Claude
Code, Codex, Qwen Code, and opencode; strategies as `STRATEGY.md` documents; an order gate
enforced by hooks and by an MCP gateway; and an autonomous runner.

## Layout

- `agents/` (canonical roles, Claude format: `name`, `description`, `tools`, `model`, plus
  `role-skills`). Only `trade-executor` may hold order-writing MCP tools; a test enforces it.
  `role-skills` lists the skills the role's body says to load (a test keeps them equal); no
  harness interprets the key: opencode's generated roles carry those skills in full in their
  prompt, and the other adapters load them as the body says.
- `skills/<name>/SKILL.md`: frontmatter `name` (= folder) and `description`, then
  `## When to Use`, `## How It Works`, `## Examples`. Workflows are skills;
  `commands/` are thin shims that say "Use the `<skill>` skill".
- `strategies/<name>/STRATEGY.md`: schema in `scripts/lib/trading/strategies.js`.
- `accounts/<name>/ACCOUNT.md`: prop account profiles (`scripts/lib/trading/accounts.js`);
  combine rules and micro/mini sizing in `scripts/lib/trading/combine.js`, live attempt
  state and the gate's prop checks in `prop-state.js`.
- Policy strategies (`signal: policy`, e.g. `strategies/prop_portfolio`) are the prop
  challenge as a strategy: they list rules strategies and carry `account`, `sizing`,
  `contracts`, and `exit`. Only they have those keys.
- `scripts/lib/prop/`: the prop challenge's runtime and simulator: the runner's prop hooks
  (`live-runner.js`), the sizing verdict (`verdict.js`, `full` or `skip`), combine attempts on
  history (`challenge.js`), the split windows (`splits.js`), and the promotion gate (0 blows every
  OOS month, >= 40% pass over >= 20 attempts and 2 months) in `promotion.js`, frozen code with a
  test that its numbers only rise; never lower it. No trained policy runs: the learned rulebook
  that replaces the retired PPO policy is still to come.
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
- Generated, never edit by hand: `workspace/*.md`, `workspace/opencode.json`
  (opencode's project config: roles, permissions; `scripts/lib/opencode.js`),
  `.codex/agents/*.toml`, and `qwen-extension/` (manifest, `QWEN.md`, agents,
  commands, symlinks). Run `node scripts/sync-harness.js`.
- `tests/`: `node:test` files named `*.test.js`.

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
   runs them.
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
   the full adversarial round, unless it touches a document named below.
   Skills, agents, commands, rules, strategies, and
   accounts are instructions agents act on: they get the full round. So do
   `CLAUDE.md`, `AGENTS.md`, `QWEN.md`, generated files, and every document
   that a skill, agent, command, rule, strategy, account, hook, or script
   points to. Today those are `docs/BACKTESTING.md`,
   `docs/BROKER-MCP-INTERFACE.md` (the contract broker servers implement),
   and `docs/LEARNED-RULEBOOK.md` (the learned-policy design the prop code is
   built from).

Never open a pull request with a failing regression or an unaddressed
confirmed finding. The pull request description says what was run and what
the review found and fixed (`.github/pull_request_template.md`).
`tests/plugin/process.test.js` keeps `npm run verify` equal to what CI runs.

## Rules for changes

- CommonJS, Node 22+ (`.nvmrc`), no runtime dependencies (plugin installs don't run npm install).
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
