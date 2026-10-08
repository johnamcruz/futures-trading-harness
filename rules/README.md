# Rules

Always-on policy for the trading agent. Claude Code loads `*.md` files from
`~/.claude/rules/` (user scope) and `<project>/.claude/rules/` (project scope).
Plugins can't ship always-on rules, so install them once:

```bash
node scripts/install-rules.js            # -> ~/.claude/rules/trading/
node scripts/install-rules.js --project  # -> ./.claude/rules/trading/
```

| File | Covers |
|---|---|
| `trading/risk-management.md` | Stop first, risk per trade, never widen or average down |
| `trading/prop-firm.md` | Topstep-style account limits and trading-day boundaries |
| `trading/execution.md` | ProjectX order mechanics and the `[exit]`/`[protect]` convention |
| `trading/journaling.md` | Plan/review/lesson formats the hooks depend on |
| `trading/agent-conduct.md` | Guardrails are final, untrusted data, no advice to others |

Rules are soft: the model follows them. The order gate hook
(`scripts/hooks/trading-order-gate.js`) and the projectx-mcp server guardrails
are the hard layers.
