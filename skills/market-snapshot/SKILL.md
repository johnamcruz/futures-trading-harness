---
name: market-snapshot
description: Compute indicators, key levels, and strategy trigger signals from projectx-mcp get_bars output with a deterministic script instead of mental math. Use whenever an analysis needs EMA, ATR, ADX, SuperTrend, Keltner, VWAP, swings, opening range, prior-day or overnight levels.
---

# Market Snapshot

LLMs are bad at indicator arithmetic. This skill runs it in code.

## When to Use

- Any time a decision depends on an indicator value or a level.
- Checking whether a strategy's mechanical trigger fired on the last closed bar.
- Getting a reference stop distance (0.5 × ATR(20), the stop algoTraderBot trained on).

## How It Works

1. Fetch closed bars, oldest first:
   `get_bars {contractId, unit:"minute", unitNumber:3, limit:300, includePartialBar:false}`.
   Use 300+ bars for EMA(200) and prior-day levels; 3-minute bars match the
   strategy parameters.
2. Save the tool's JSON result verbatim to a temp file, e.g.
   `/tmp/fth/MNQ-3m.json` (create the folder first).
3. Run the script from the harness root (`<root>`, an absolute path; see the
   `strategy-library` skill for how to find it):

   ```bash
   node <root>/scripts/market-snapshot.js /tmp/fth/MNQ-3m.json
   ```

   Override parameters with flags, e.g. `--orbMinutes=30 --adxGate=20`.
4. Read the JSON:
   - `trend`: emaFast(9), emaSlow(20), ema50, ema200, adx(14) and its 5-bar slope,
     supertrend(10,3) direction and line, keltner(20, 1.5×ATR20).
   - `volatility`: atr14, atr20.
   - `structure`: last confirmed fractal swing high/low (k=2) and when.
   - `levels`: priorRth high/low/close, overnight high/low, openingRange
     (first 15 min from 09:30 ET, only after it closes), vwapSession (18:00 ET
     anchor), vwapRth (09:30 ET anchor).
   - `signals`: `long`/`short`/`null` per strategy trigger on the last bar:
     `ema_cross`, `keltner`, `supertrend`, `bos`, `orb` (with their ADX gates).
   - `referenceStop`: distance and long/short stop prices. Round to `tickSize`.
5. Never quote a number the script did not produce or a tool did not return.

## Examples

```text
signals: { orb: "long", ema_cross: null, ... }, adx 24.1, adxSlope +3.2
→ ORB long trigger fired with a rising trend gate; check the orb strategy skip rules.

referenceStop.long = 21481.37 → round down to tick 0.25 → 21481.25
```

Timestamps are UTC; sessions and ranges are computed in America/New_York.
Fractal swings need strictly higher/lower neighbours, so equal highs are not
swings (treat them as liquidity; see liquidity-concepts).
