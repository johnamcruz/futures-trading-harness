# Configuration examples

| File | Use |
|---|---|
| `brokers.json` | The broker MCP servers the harness can use and the one it uses (default `topstepx`). Each server lives in its own repo and implements the broker MCP interface (`docs/BROKER-MCP-INTERFACE.md`). Override or add brokers in `~/.futures-trading-harness/brokers.json`; `FTH_BROKER` picks one. |
| `broker.example.json` | The `broker` MCP server behind the order gateway, in the `mcpServers` JSON shape used by Claude Code, Qwen Code, Cursor, and most MCP clients. The gateway starts the server named in `brokers.json`. Codex uses TOML; `scripts/install.js --target codex` writes it. |
| `settings.example.json` | Claude Code settings: order-gate variables and permissions (order tools on "ask" for interactive use). |
| `autotrader.example.json` | Autonomous runner config: harness, symbols, paper mode, schedule, caps. |
| `backtest.example.json` | Backtest config: bar files (Parquet, Excel, CSV), period, strategies, harness rules, sizing, costs. See `docs/BACKTESTING.md`. |

Always register the server under the name `broker`: agents, hooks, and
permissions match `mcp__broker__*` tool names. The broker server's settings
(credentials, guardrails) go in `~/.futures-trading-harness/.env`, which the
gateway loads. Keep credentials out of the repository.
