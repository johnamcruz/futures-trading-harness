# AGENTS.md

Instructions for coding agents working on this repository. The trading
agents themselves live in `agents/` and follow `rules/trading/`.

Read `CLAUDE.md` first; it applies to every coding agent. In short:

- Run `npm test` and `npm run lint` before committing.
- Keep the order gate fail-closed and covered by tests.
- Only `agents/trade-executor.md` may list order-writing tools
  (`place_order`, `modify_order`, `cancel_order`, `close_position`,
  `partial_close_position`).
- Strategy playbooks are ported from source code faithfully; flag suspected
  source bugs instead of silently fixing them.
