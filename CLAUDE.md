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

## Separation of work

| Layer | Owns | Never |
|---|---|---|
| Harness (futures-trading-harness) | Agents, skills, rules, strategies, accounts (firm rules as documents); the order gate (fails closed); the runner (cycles, clock, end of day); the replay driver (the same runner against a replay broker); session recording, scorecard, the learned-policy loop; generated CLI adapters (Claude Code, Codex, Qwen Code, opencode); the generic broker MCP interface spec; the contract translator; `mcp-configs/brokers.json`, the one link to broker servers | Broker or platform names, ids or APIs; firm rules in code; model names or the model runtime; order-flow math or fields; machine paths |
| The live broker server (its own repo) | Everything about its platform: API, auth, orders, brackets, protection, flatten, reconcile, rate limits, contracts, live bars, L1/L2, order flow. It is the reference | Being changed to match local data; harness logic |
| The replay broker server (its own repo) | Serving local historical data through the same interface (bars, store, replay clock, simulated fills); reproducing the live server's output and proving it against the live server's golden files | Its own definitions that differ from live; harness logic |
| The user's machine (no repo) | `.env` credentials, local config overrides, runner config, the model server and its watchdog, the CLI's config | Anything committed |

Which live and replay broker servers are configured is in `mcp-configs/brokers.json`. From this:

- Swap the `brokers.json` entry to swap the broker; nothing else in the harness changes.
- Bars are data: fields a broker adds pass through untouched.
- Parity goes one way: live is the truth. The replay server matches the live one, never the reverse.
- `tests/plugin/no-platform-specifics.test.js` enforces it: no platform, firm or model names, and no
  firm times, in the repo outside `accounts/` and `mcp-configs/brokers.json`, except the shrink-only
  exceptions (plan C; pinned in
  `tests/plugin/no-platform-specifics.pins.json`, only ever shrinking against the base branch) and the
  interface's known first-server conventions (`docs/TECH-DEBT.md`), which name no platform, so the scan
  can't see them.

## Layout

- `agents/` (canonical roles, Claude format: `name`, `description`, `tools`, `model`, plus
  `role-skills` and an optional `timeframe`, the bars the role reads; none means the first lane's,
  only the three analysts may set one, and no adapter carries it). Only `trade-executor` may hold order-writing MCP tools; a test enforces it.
  `role-skills` lists the skills the role's body says to load (a test keeps them equal); no
  harness interprets the key: opencode's generated roles carry those skills in full in their
  prompt, and the other adapters load them as the body says. An optional `role-index` lists the
  skills it looks up only as needed in index mode (its body's load sentence names `role-skills` and
  `role-index` together, kept equal, so every adapter that reads the body loads them all as before;
  the role then holds `mcp__harness__skill_lookup`). `FTH_ROLE_SKILLS` (`scripts/lib/role-skills.js`)
  picks opencode's prompts: `index` (the default, committed) embeds `role-skills` and lists
  `role-index` one line per skill, read with `skill_lookup` (the prompt's load sentence becomes
  two: the core below, "Look up as needed: ..." for the index), and the gate requires the
  situational ones a bar's briefing triggers (`SITUATIONAL` in
  `scripts/lib/trading/skills-loaded.js`; `scripts/lib/trading/skill-lookups.js`); `full`, on
  request, embeds both lists. The runner passes opencode's mode to its run and `full` to every
  other harness's (their roles load every skill as their body says). In index mode opencode's
  head trader has a prompt of its own (`scripts/lib/head-prompt.js`): its per-cycle skills embedded,
  any other read with `skill_lookup`, no skill tool; the gate counts the embedded ones as loaded
  only on the runner's attestation (`FTH_HEAD_PROMPT`), checked against the run's `opencode.json`.
  `workspace/AGENTS.md` keeps the skill catalog (Codex's only list); `QWEN.md`, which
  `workspace/CLAUDE.md` imports, leaves it out (Claude Code and Qwen Code list skills themselves).
- `skills/<name>/SKILL.md`: frontmatter `name` (= folder) and `description`, then
  `## When to Use`, `## How It Works`, `## Examples`. Workflows are skills;
  `commands/` are thin shims that say "Use the `<skill>` skill".
  A description is at most 160 characters (longer ones pinned, shrinking
  only), and every skill is indexed: a role's lists, the head trader's load
  list, a command shim, or a reasoned allow-list
  (`tests/plugin/skills-indexed.test.js`).
- `strategies/<name>/STRATEGY.md`: schema in `scripts/lib/trading/strategies.js`.
- `accounts/<name>/ACCOUNT.md`: prop account profiles (`scripts/lib/trading/accounts.js`);
  combine rules and micro/mini sizing in `scripts/lib/trading/combine.js`, live attempt
  state and the gate's prop checks in `prop-state.js`.
- `accounts/<name>/RULEBOOK.md`: the account's rulebook (`scripts/lib/trading/rulebook.js`,
  docs/LEARNED-RULEBOOK.md R1-R4), the one place for the numbers its policies trade with
  (the soft daily stop; each policy's `sizing`, `exit` and verdict `multipliers`) and the
  enforced-or-taught classification of every rule. The loaders read it; nothing else states
  a value (`tests/plugin/rulebook.test.js`).
- Policy strategies (`signal: policy`, e.g. `strategies/prop_portfolio`) are the prop
  challenge as a strategy: they list rules strategies and carry `account` and `contracts`;
  their `sizing` and `exit` come only from the account's rulebook (every key stated; a
  policy it doesn't list, or an account without a valid rulebook, is refused). Only they
  have those keys.
- `scripts/lib/prop/`: the prop challenge's runtime and simulator: the runner's prop hooks
  (`live-runner.js`), the sizing verdict (`verdict.js`, `full` or `skip`, with the rulebook's multiplier), combine attempts on
  a trade stream (`attempts.js`, scored by `evaluator.js`), the split windows (`splits.js`), and the promotion gate (0 blows every
  OOS month, >= 40% pass over >= 20 independent attempts and 2 months) in `promotion.js`, frozen code with a
  test that its numbers only rise; never lower it. No trained policy runs: the rulebook holds
  today's values, and nothing in it is learned yet.
- Brokers: no broker code in the harness. Every broker or prop firm runs its own MCP server (own repo)
  implementing one interface, `docs/BROKER-MCP-INTERFACE.md` (as data: `scripts/lib/broker/interface.js`).
  Which server is config (`mcp-configs/brokers.json`, `~/.futures-trading-harness/brokers.json`,
  `FTH_BROKER`; `scripts/lib/broker/config.js`); the default broker is whatever `mcp-configs/brokers.json`
  names. It is registered
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
- No platform-, firm- or model-specific code, names, env vars, defaults,
  contract-id formats or paths: platform specifics live in the broker's MCP
  server, firm rules in account files, model specifics in the user's local
  config. `mcp-configs/brokers.json` is the one link.

`tests/plugin/ecc-architecture.test.js` enforces what can be checked in code
(lib modules unit-tested, CLI and hook size, no runtime dependencies, no
broker code), and `tests/plugin/no-platform-specifics.test.js` the no
platform-, firm- or model-specific rule; their listed exceptions and pinned
sizes may only shrink.

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
   pass without the code they claim to cover, and ECC compliance (including no
   platform-, firm- or model-specific code, names, env vars, defaults,
   contract-id formats or paths). Any change to the platform guard files
   (`tests/plugin/no-platform-specifics.test.js`, `tests/plugin/platform-scan.js`) or their pins
   (`tests/plugin/no-platform-specifics.pins.json`), other than lines removed, is a finding by
   default. So is a changed golden (`tests/fixtures/golden/`, `tests/scripts/cli-parity.snapshot.json`)
   that the pull request doesn't explain as intended (CONTRIBUTING.md, "Golden files"). Every confirmed finding is fixed (or,
   if not worth its code, answered with the reason), then the regression
   runs again and the fixes get their own review, until a round confirms
   nothing new.

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
   `docs/LEARNED-RULEBOOK.md` (the learned-policy design the prop code is
   built from), `docs/LIVE-DRY-RUN.md` (the runbook for live-money setup
   that preflight points to), `docs/research/mtf-setup-catalog.md` (the
   census the basics skills cite as evidence),
   `docs/research/cisd-ote-textbook.md` (the census the `cisd` and
   `fib-retracement` skills cite), and `docs/COMPOSED-ENTRY.md` (the
   approved design of `trade_lifecycle` that `prop_portfolio`, the
   rulebook and the retired-strategy list point to).

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
