# Strategies

Each strategy is a folder with one `STRATEGY.md`, written like a skill:

- **Frontmatter** is read by code. `scripts/strategies.js` validates it and
  scans bars for candidates, and the order gate checks every live entry against
  it: the `setup:<name>` tag must name a valid strategy with `status: active`,
  the contract must be in `instruments`, and the time must be inside `sessions`.
- **The Markdown body** is read by the agents: context filter, trigger, entry,
  stop, targets, and skip rules.

| Strategy | Signal | Status |
|---|---|---|
| `orb` | opening range breakout | active |
| `ema_cross` | EMA 9/20 cross | active |
| `keltner` | Keltner breakout | active |
| `supertrend` | SuperTrend flip | active |
| `bos` | break of structure | active |
| `cisd_ote` | manual (12m CISD + fib zone) | active |

## Add a strategy

1. Copy `_template/` to `strategies/<name>/` (or to your own folder listed in
   `FTH_STRATEGIES_DIRS`, so it survives plugin updates).
2. Fill in the frontmatter and every section. Keep `status: paper` until it
   has a track record.
3. `node scripts/strategies.js validate`
4. Paper-trade it (`/trade-plan`, reviews tagged `paper`), then check
   `/setup-scorecard` before setting `status: active`.

A strategy with `signal: manual` needs no code: the agents evaluate its trigger
from the body. To make a trigger mechanical, add a detector to
`scripts/lib/trading/market-snapshot.js` `signals`, with a test.

## Commands

```bash
node scripts/strategies.js list                       # name, status, instruments, signal
node scripts/strategies.js show orb                   # full STRATEGY.md
node scripts/strategies.js validate                   # schema + section checks
node scripts/strategies.js scan bars.json --symbol MNQ   # candidates on the latest bar
```
