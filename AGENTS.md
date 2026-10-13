# AGENTS.md

Instructions for coding agents (Codex, Qwen Code, Claude Code, others) working
on this repository. Read `CLAUDE.md`; it applies to every coding agent.

To trade rather than develop, run your harness from `workspace/`, which has
its own generated `AGENTS.md` with the operator instructions.

Before committing: `npm test`, `npm run lint`, and `node scripts/sync-harness.js`
if you changed agents, commands, rules, or skills.

Before every pull request (hard rule, every agent, every change): the
regression (`npm run verify`) passes and an adversarial review by a reviewer
other than the change's author found nothing left to fix. See "Before a pull
request" in `CLAUDE.md`.

Keep the harness platform-neutral: no platform-, firm- or model-specific code,
names, env vars, defaults, contract-id formats or paths ("Separation of work"
in `CLAUDE.md`; `tests/plugin/no-platform-specifics.test.js` enforces it).
