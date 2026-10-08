---
name: strategy-authoring
description: Write a new trading strategy as a STRATEGY.md document - frontmatter schema, required sections, validation, and promotion from paper to active. Use when the user describes a strategy idea, ports one from code or a backtest, or edits an existing strategy.
---

# Strategy Authoring

## When to Use

- "Add a strategy that ..." or porting a strategy from code or a backtest.
- Changing an existing strategy's rules or status.

## How It Works

1. Copy `strategies/_template/STRATEGY.md` to `strategies/<name>/STRATEGY.md`
   (or to a folder in `FTH_STRATEGIES_DIRS` for private strategies). `<name>`
   is lowercase with `_` or `-`; it becomes the journal tag `setup:<name>`.
2. Frontmatter (checked by code):

   | Field | Meaning |
   |---|---|
   | `name`, `description` | Folder name; what/when, ≥ 40 chars |
   | `status` | `paper` (new), `active` (live entries allowed), `disabled` |
   | `instruments` | Contract roots, e.g. `[MNQ, MES]` |
   | `timeframe` | Trigger timeframe, e.g. `3m` |
   | `sessions` | Optional `"HH:MM-HH:MM@Zone"` windows; entries only inside |
   | `signal` | `orb`, `ema_cross`, `keltner`, `supertrend`, `bos` (built-in detectors) or `manual` |
   | `params` | Optional market-snapshot overrides (e.g. `orbMinutes: 30`) |
   | `filters` | Optional `adx_min`, `adx_max`, `adx_slope_min`, `max_vwap_distance_atr` |
   | `risk` | `stop` (`atr:<k>`, `structure`, `swing`, `manual`), `min_rr`, optional `max_risk_usd` |
   | `source`, `version` | Where it came from; bump version on rule changes |

3. Body (read by the agents): `## When to Use`, `## How It Works` (context
   filter, trigger, entry/stop/targets, skip when), `## Examples` with
   tick-correct numbers and a sample rationale.
4. Port faithfully. When porting code, copy the exact rules and parameters and
   flag suspected bugs to the user instead of silently fixing them.
5. Validate: `node "$FTH_ROOT/scripts/strategies.js" validate`.
6. Promote only on evidence: paper-trade it (reviews tagged `paper`), run
   setup-expectancy, and set `status: active` only with the user's approval.
7. A mechanical trigger the built-in detectors don't cover needs code: add it
   to `signals` in `scripts/lib/trading/market-snapshot.js`, add it to
   `SIGNALS` in `scripts/lib/trading/strategies.js`, and add tests.

## Examples

```yaml
---
name: vwap_reclaim
description: Long-only VWAP reclaim on MNQ/MES after a morning flush below RTH VWAP; manual trigger on 3-minute bars.
version: 1
status: paper
instruments: [MNQ, MES]
timeframe: 3m
sessions: ["10:00-12:00@America/New_York"]
signal: manual
filters:
  adx_max: 30
risk:
  stop: structure
  min_rr: 2
source: user idea, 2026-10-08
---
```
