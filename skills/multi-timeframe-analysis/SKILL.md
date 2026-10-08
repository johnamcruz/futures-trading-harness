---
name: multi-timeframe-analysis
description: Top-down futures analysis across timeframes (daily/4h for context, 1h/15m for bias, 5m/3m/1m for the trigger) within the ProjectX bar rate limit. Use when building a bias or a plan, or when timeframes disagree.
---

# Multi-Timeframe Analysis

## When to Use

- Premarket preparation and every new trade plan.
- A trigger timeframe signal conflicts with the higher timeframe.

## How It Works

1. **Budget requests.** `get_bars` allows 50 requests per 30 s across all
   agents. Use one request per timeframe:

   | Role | Timeframe | `get_bars` | Bars |
   |---|---|---|---|
   | Context | daily | `unit:"day", unitNumber:1` | 30 |
   | Bias | 1 hour | `unit:"hour", unitNumber:1` | 120 |
   | Setup | 15 min | `unit:"minute", unitNumber:15` | 160 |
   | Trigger | 3 min | `unit:"minute", unitNumber:3` | 300 |

2. **Run market-snapshot on each** and record trend direction (EMA 20 vs 50,
   SuperTrend), ADX, and the nearest levels.
3. **Align.**
   - All aligned → full playbook size and target.
   - Context against bias → trade only at strong levels, reduce target to the
     next opposing level.
   - Trigger against bias → it's a pullback; wait for the trigger timeframe to
     turn back with the bias.
4. **Levels flow down.** Draw levels from higher timeframes (prior day high
   and low, overnight high and low, weekly levels, 1h swings) and treat them as
   targets or reasons to skip on the trigger timeframe.
5. **One sentence per timeframe.** "Daily: range 20900–21700, mid 21300.
   1h: uptrend, ADX 26. 15m: pullback to VWAP. 3m: CHoCH up."

## Examples

```text
Daily up, 1h up (ADX 28), 15m pulling back into session VWAP, 3m EMA cross up
with ADX 19 → aligned long; playbook-ema-cross applies, target 1h swing high.

Daily down, 1h range, 3m ORB long → counter-context. Skip, or half target to
the overnight high.
```
