# Harness Design

How this repository uses the ECC harness architecture to run a disciplined,
self-reviewing futures trader on TopstepX through
[projectx-mcp](https://github.com/johnamcruz/projectx-mcp).

## Core idea

> projectx-mcp is the hands and the hard limits. This harness is the desk:
> who analyses, who approves, who executes, and which rules are enforced in
> code rather than left to the model.

The projectx-mcp guide states several soft rules (plan before trading, stop
after 2 losses, no entries in the first 5 minutes). Most of them depend only on
the journal and the clock, which are local, so a PreToolUse hook can enforce
them without a network call.

## What was kept from ECC

| ECC piece | Here |
|---|---|
| Plugin layout (`.claude-plugin/`, `agents/`, `skills/`, `commands/`, `hooks/`) | Same layout, trading content |
| `run-with-flags.js` + `hook-flags.js` profile gating | Ported, env vars renamed `FTH_*`, plus a fail-closed list for order gating |
| Hook stdin bounding (`hook-input.js`) | Kept |
| Rules folder | `rules/trading/`, installed by `scripts/install-rules.js` |
| Skill format (When to Use / How It Works / Examples) | Kept; enforced by a test |

Everything else in ECC (about 4,200 files: engineering agents and skills, other
harness adapters, installers, dashboards, translations) was removed.

## Desk roles

| Role | Agent | Tools | Runs |
|---|---|---|---|
| Market structure | `market-structure-analyst` | bars, contracts, snapshot script | Parallel |
| Trend and momentum | `trend-momentum-analyst` | bars, contracts, snapshot script | Parallel |
| Volume and liquidity | `volume-liquidity-analyst` | bars, quote, snapshot script | Parallel |
| Event risk | `news-calendar-analyst` | web only | Parallel |
| Risk | `risk-manager` | account, positions, orders, performance, journal (read) | Parallel (state), then sequential (verdict) |
| Head trader | main session | everything, via the commands | Synthesis and plan |
| Execution | `trade-executor` | the only agent with order tools | After APPROVE |
| Review | `trade-reviewer` | trades, orders, performance, journal | After exits, end of day |
| Research | `strategy-researcher` | repo files | New playbooks |

Separation of duties: the agent that finds a trade never approves it, and
neither of them can place it.

## The order gate

`scripts/hooks/trading-order-gate.js` → `scripts/lib/trading/order-gate.js`.
It matches `mcp__.*projectx.*__place_order`, so plugin-scoped server names
still match.

Classification by the start of `rationale`: `[exit]` and `[protect]` orders
pass (risk-reducing; the MCP still applies its limits). Everything else is an
entry and must pass:

| Check | Rule |
|---|---|
| `setup-tag` | Rationale names `setup:<name>` |
| `stop-defined` | `stopLossBracket`, or a stop price stated in the rationale |
| `plan-required` | A `plan` journal entry for the contract within `FTH_PLAN_MAX_AGE_MIN`, this trading day |
| `time-window` | Not inside `FTH_NO_ENTRY_WINDOWS` (default 09:30–09:35 ET and 15:00–18:00 CT) |
| `blackout` | Not inside a window in the blackouts file |
| `loss-streak` | After `FTH_MAX_CONSECUTIVE_LOSSES` losing reviews in a row, wait `FTH_LOSS_COOLDOWN_MIN` |
| `daily-loss-count` | Fewer than `FTH_MAX_DAILY_LOSSES` losing reviews this trading day |
| `review-before-next-entry` | Every earlier successful entry today has a review |
| `max-entries` | Fewer than `FTH_MAX_ENTRIES_PER_DAY` entries |

Trading day = since 17:00 America/Chicago. Reviews tagged `paper` never count
toward live state.

Failure behaviour: malformed input, oversized input, an unreadable journal or
blackout file, an invalid window spec, or a crash all block the order (exit 2).
A user can still disable the hook explicitly (`FTH_DISABLED_HOOKS`,
`hooks_enabled=false`); that is their decision, not the model's.

## Known limits

- Hooks can't see live prices or positions, so price-side checks (stop on the
  correct side of the market, size vs. open position) stay in projectx-mcp's
  `risk.ts` and the risk-manager agent.
- The `[exit]`/`[protect]` labels are self-declared. A mislabelled entry
  passes the gate (the MCP's position and loss limits still apply) and is
  graded `mistake:rule-break` by the reviewer. Closing this hole needs
  position awareness in the server; a good projectx-mcp follow-up is to let
  `place_order` reject an `[exit]`/`[protect]` order that increases exposure.
- Analysts move bars through a temp file to run `market-snapshot.js`. A
  `get_indicators` tool in projectx-mcp would remove that round trip.
- The CISD+OTE playbook mirrors algoTraderBot's zone math, which differs from
  textbook OTE: longs enter at the 50% retracement, shorts at the 29.5%
  retracement. It is ported as written; confirm whether it's intended.

## Roadmap

1. Read-only use with `/premarket` and `/trade-plan` (trading disabled).
2. Practice account, micros, size 1, every order approved by hand.
3. Upstream to projectx-mcp: exposure check for `[exit]`/`[protect]`, a
   `get_indicators` tool, and per-setup stats in `get_performance`.
4. Backtest replay: run the playbooks over historical bars with the same
   snapshot code to record the baseline stats in each playbook.
