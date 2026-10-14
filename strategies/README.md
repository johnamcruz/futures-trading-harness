# Strategies

Each strategy is a folder with one `STRATEGY.md`, written like a skill:

- **Frontmatter** is read by code. `scripts/strategies.js` validates it and
  scans bars for candidates, and the order gate checks every live entry against
  it: the `setup:<name>` tag must name a valid strategy with `status: active`,
  the contract must be in `instruments`, and the time must be inside `sessions`.
  A rules strategy trades one leg of a micro/mini family (`MNQ` or `NQ`,
  `MES` or `ES`, `MYM` or `YM`, `M2K` or `RTY`, `MGC` or `GC`, `SIL` or `SI`):
  the selected one, the contract in the runner's `symbols` (`FTH_SYMBOLS` for
  an interactive session). Listing either leg covers the selected leg, so one
  leg per family is enough (listing MNQ, it trades a selected NQ), and the
  other leg is refused ("setup:my_orb trades MNQ (the selected contract), not
  NQ"): it never alternates between the two. With no leg of the family
  selected, it trades exactly what it lists (a rules strategy listing both
  legs trades neither until one is selected). Everything else is checked on the
  contract ordered: its broker tick specs, and its size and
  `risk.max_risk_usd` in its own dollars (a mini's tick is worth 10 micros', 5
  for silver). Manual strategies match their list exactly; a policy strategy
  trades within its list, the selected leg when one is selected. Exits
  and protective stops on either leg are never refused.
- **The Markdown body** is read by the agents: context filter, trigger, entry,
  stop, targets, and skip rules.

| Strategy | Signal | Status |
|---|---|---|
| `prop_portfolio` | policy: the prop account layer (sizing, trail, verdicts); lists no strategies until `trade_lifecycle` is built | active |

No rules strategy ships: every one was retired (below). The one strategy to
come is `trade_lifecycle` (docs/COMPOSED-ENTRY.md): the model composes the
whole trade from its skills (read, set up, enter, state its size under the
enforced ceiling, manage, exit), as `prop_portfolio`'s one component. Until
it is built the order gate refuses every entry (no strategy, no setup, no
verdict); exits and protective stops still go.

The code the retired strategies used stays and is tested through fixtures
(`tests/fixtures/strategies-fx`, `strategies-golden`): the rules language
(`strategy-rules` skill), the bar fields the broker MCP server puts on its
bars (`field(...)`), the prior day's volume profile
(`scripts/lib/trading/volume-profile.js`), and the CRT and CISD detectors,
whose reads stay in the briefing as facts.

## Add a strategy

1. Copy `_template/` to `strategies/<name>/` (or to your own folder listed in
   `FTH_STRATEGIES_DIRS`, so it survives plugin updates).
2. Fill in the frontmatter and every section. Keep `status: paper` until it
   has a track record.
3. `node scripts/strategies.js validate`
4. Paper-trade it (`/trade-plan`, reviews tagged `paper`), then check
   `/setup-scorecard` before setting `status: active`.

No strategy needs code. A mechanical trigger is written as `signal: rules`
with `long:`/`short:` condition lists in the frontmatter (see `_template/`
and the `strategy-rules` skill for the rule language), and code evaluates it
on every closed bar. A discretionary trigger uses `signal: manual` and is
judged by the agents from the body. The retired strategies' rules are kept
as test fixtures (`tests/fixtures/strategies-golden`, `fx_<name>`;
`fx_orb` holds the `orb` port's), and `tests/lib/parity.test.js` checks the
ports' signals and stops against the original bot's own output on its data.

## Prop challenges

The prop challenge is a strategy too: a **policy strategy** (`signal: policy`)
trades the setups of the rules strategies it lists on a prop account: each
setup at the largest size the attempt's budget allows (in the selected
contract), or skipped, and every trade exits by its trail.

- `prop_portfolio`: the account layer, on NQ, ES, YM, and RTY (micros or
  minis), one `topstep_100k` attempt and one position at a time across them.
  It lists no strategies since 2026-10-14; its one component will be
  `trade_lifecycle`. With none it has no setups, so it sizes nothing and
  every entry is refused; it stays `active` (the owner's decision) so it is
  ready when `trade_lifecycle` is.

A policy strategy trades one timeframe. Within one runner (one harness home)
the gate holds one cushion and one position at a time across the account.
It does not see another runner's entries: never start a second runner on the
same broker account (a per-account lock is coming).

While an active policy strategy has an attempt running, its rules strategies
trade only through it; otherwise they trade as before. Each rules strategy's
own rules, sessions, filters, and regimes still decide its setups, the same
in backtests and live, and so does its `status`: an active policy strategy
trades only its `active` strategies (a `paper` one stays paper inside it; a
`disabled` one can't be listed), and a `paper` policy strategy trades only in
a paper run. Its sizing, trail and multipliers are in its account's rulebook
(`accounts/<account>/RULEBOOK.md`).

## Retired strategies

Removed from the repository; their documents stay in its history. Only the
mechanical triggers are gone: the indicators they read (EMAs, ADX,
SuperTrend, Keltner) and the structure breaks (BOS, CHoCH) stay in the bar
briefing and the market snapshot as confluence data, and the skills still
teach the concepts (`trend-momentum-indicators`, `bos-vs-choch`).

| Strategy | Signal | Retired | Why |
|---|---|---|---|
| `bos` | break of structure (3m) | 2026-10-13 | the owner's decision (below) |
| `keltner` | Keltner channel breakout (3m) | 2026-10-13 | the owner's decision (below) |
| `ema_cross` | EMA 9/20 cross (3m) | 2026-10-13 | the owner's decision (below) |
| `supertrend` | SuperTrend flip (3m) | 2026-10-13 | the owner's decision (below) |
| `orb` | opening range breakout (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `cisd_ote` | CISD on 15m/60m + OTE bounce (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `vwap_reclaim` | VWAP reclaim (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `crt_1h` | 1-hour CRT raid and reclaim (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `crt_4h` | 4-hour CRT raid and reclaim (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `value_area` | prior-day POC rejection or breakout (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `value_area_reentry` | volume profile 80% rule (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `value_area_breakout` | acceptance beyond the prior value area (3m) | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `ofi` | 1m order-flow imbalance | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `ofi_absorption` | 1m absorption reversal | 2026-10-14 | the owner's decision (2026-10-14, below) |
| `prop_flow_1m` | policy over `ofi` and `ofi_absorption` (1m) | 2026-10-14 | the owner's decision (2026-10-14, below); its rulebook entry went with it |

Why, for the four of 2026-10-13:

- The owner's decision: as strategies they confused the model, and the
  basic skills already cover what they detect.
- Correlated: they largely fire together (2026-10-13 quant audit).
- Negative after costs on Train (2026-10-13 edge census).

Why, for the eleven of 2026-10-14: the owner's decision to trade one
strategy, `trade_lifecycle` (docs/COMPOSED-ENTRY.md), the model composing the
whole trade from its skills, under `prop_portfolio`. They were deleted, not
turned into skills or documents: named setups such as CRT are facts in the
briefing, and the skills stay as they are.

A record that still names one never breaks anything: an entry tagged with
it is refused, saying it was retired (the order gate, `order_plan`, a
policy verdict from it, a policy list naming it, a backtest asked for
it), while an `[exit]` or `[protect]` order for a position it opened still
goes and the runner keeps trailing that position by its remembered exit
plan. A runner lane that lists one doesn't stop the runner: it starts and
says so loudly (its log, a `lane_retired` event, and preflight), and that
lane enters nothing: it scans no strategy, records no verdict, and the
order gate refuses any entry on its timeframe under any tag
(`retired-lane`). Its bars, the trailing stops, end of day and every open
position's management go on: it runs a manage cycle while a position or
order is open, and every bar when no account is configured to see them
(`scripts/lib/lanes.js` `retireLanes`). The runner marks that timeframe's
signal record at its start, before any cycle, and clears a mark whose lane
was since fixed or deleted: to trade on it again, remove the name (or the
lane) from the runner config and restart the runner. A name that never existed still stops the runner at start
(`strategies/retired.json`, read as `RETIRED` by `scripts/lib/trading/strategies.js`;
`tests/lib/retired-strategies.test.js`). A private copy under one of
these names in a folder of your own (`FTH_STRATEGIES_DIRS`) is yours, not
a shipped strategy: it loads and trades as any user strategy, and the
runner's start and preflight (a warning) name it with its file, so a stale
copy is noticed.

## Commands

```bash
node scripts/strategies.js list                       # name, status, instruments, signal
node scripts/strategies.js show prop_portfolio        # full STRATEGY.md
node scripts/strategies.js validate                   # schema + section checks
node scripts/strategies.js scan bars.json --symbol MNQ   # candidates on the latest bar
```
