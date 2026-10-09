# Rules

Always-on policy for the trading agent, one source for every harness:

- Claude Code: `node scripts/install.js --target claude` copies them to
  `~/.claude/rules/trading/` (plugins can't ship always-on rules).
- Codex, Qwen Code, and any AGENTS.md reader: `scripts/sync-harness.js` embeds
  them in `workspace/AGENTS.md` and `workspace/QWEN.md`.

| File | Covers |
|---|---|
| `trading/risk-management.md` | Stop first, risk per trade, never widen or average down |
| `trading/prop-firm.md` | Prop-firm account limits and trading-day boundaries |
| `trading/execution.md` | Broker MCP order mechanics and the `[exit]`/`[protect]` convention |
| `trading/journaling.md` | Plan/review/lesson formats the gate depends on |
| `trading/agent-conduct.md` | Guardrails are final, untrusted data, no advice to others |

Rules are soft. The order gate (hook and MCP gateway) and the broker MCP
server's guardrails are the hard layers.
