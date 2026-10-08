---
name: setup-expectancy
description: Measure whether each futures setup has an edge - win rate, average win/loss in R, expectancy, profit factor, sample size, and confidence - from get_performance and journal reviews, then promote, restrict, or cut setups. Use weekly, before raising size, or when a setup feels off.
---

# Setup Expectancy

## When to Use

- Weekly review (`/setup-scorecard`).
- Before increasing size or adding a setup to the active list.
- After a losing streak, to separate variance from a broken setup.

## How It Works

1. **Data.** `get_performance` over week/month windows gives account-level
   stats. For per-setup stats, `journal_read {kind:"review", tag:"setup:<name>"}`
   and parse R from each review text plus its `result:*` tag.
2. **Per setup:**
   - n (exclude `result:nofill`), win rate p, average win W and average loss L in R
   - expectancy E = p × W − (1 − p) × L (in R per trade)
   - profit factor = gross wins ÷ gross losses
   - rule-break share: fraction of reviews tagged `mistake:*`
3. **Confidence.** Fewer than 30 trades is anecdotal. A rough 95% band on E is
   E ± 2 × stdev(R) ÷ √n. If the band includes 0, the edge is unproven.
4. **Decide:**

   | Evidence | Action |
   |---|---|
   | Rule-break share > 20% | Fix execution before judging the setup (check this first) |
   | n ≥ 30, band above 0 | Active; eligible for a size step |
   | n ≥ 30, band includes 0 | Active at size 1; unproven, keep collecting |
   | n ≥ 30, band below 0 | Cut: propose `status: disabled` to the user |
   | n < 30, E ≥ 0 | Active at size 1 |
   | 20 ≤ n < 30, E < 0 | Restricted: only in its best context, or cut |
   | n < 20, E < 0 | Active at size 1; too few trades to judge, watch it |

5. **By regime.** Split each strategy's reviews by their `regime:*` tag. A
   strategy that is positive overall but negative in one regime should drop
   that regime from its `regimes:` list (and may set `regime_gate: true`); one
   that only works in a regime it doesn't list should add it. Propose the
   change to the user with the numbers; strategy files are edited by the user,
   never inside an autonomous run. This is how the desk adapts to regimes over
   time.
6. Compare live stats with the backtest numbers recorded in the strategy. Live
   far worse than backtest usually means execution drift or regime change.
7. **Does the judgment add anything?** Over the same days, compare the live
   results of the signals taken with what the passed ones would have done
   (`node <root>/scripts/reconcile.js --day <day>` per day lists both; the
   backtest of the same days trades every signal). If passing signals doesn't
   improve E, the filter costs trades without adding edge: say so.
8. Record the decision as a `lesson` tagged with the setup and regime.

## Examples

```text
setup:ema_cross  n=34  p=0.41  W=2.1R  L=1.0R  E=+0.27R  sd=1.4  band ±0.48 → unproven
setup:orb        n=41  p=0.46  W=1.9R  L=1.0R  E=+0.33R  sd=1.3  band ±0.41 → unproven
setup:keltner    n=22  p=0.27  W=1.8R  L=1.0R  E=-0.24R → restricted to ADX>25 mornings
  by regime: trend n=12 E=+0.21R | transition n=10 E=-0.78R → propose regimes: [trend]
```
