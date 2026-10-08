# Configuration examples

| File | Use |
|---|---|
| `projectx.example.json` | The `projectx` MCP server behind the order gateway, in the `mcpServers` JSON shape used by Claude Code, Qwen Code, Cursor, and most MCP clients. Codex uses TOML; `scripts/install.js --target codex` writes it. |
| `settings.example.json` | Claude Code settings: order-gate variables and permissions (order tools on "ask" for interactive use). |
| `autotrader.example.json` | Autonomous runner config: harness, symbols, paper mode, schedule, caps. |
| `backtest.example.json` | Backtest config: bar files (Parquet, Excel, CSV), period, strategies, harness rules, sizing, costs. See `docs/BACKTESTING.md`. |

Always register the server under the name `projectx`: agents, hooks, and
permissions match `mcp__projectx__*` tool names. Keep credentials out of the
repository.
