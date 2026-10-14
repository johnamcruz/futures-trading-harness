---
name: lean-cycle
description: Use when the prompt says lean - a 1-minute cycle with no parallel analysts.
---

# Lean Cycle

## When to Use

- The prompt says "lean" (`trade-session` step 2).

## How It Works

**Lean cycle** (the prompt says "lean"; used for 1-minute bars so a cycle
fits inside one bar): no parallel analysts and no news fetch. Yourself, in
order: step 1, the bar briefing (without one: the multi-timeframe read,
`market_snapshot` and `strategies_scan` on the bars file), and the blackouts
(`blackouts_list`). No candidate and no setup you compose (`trade_lifecycle`)
→ note and end (`candidates: null`, the scan failed or the bar wasn't
scanned, counts as none). A candidate or a composed setup → `risk-manager`
phase 1 and 2, then execute. Steps 3-7 apply, with "the
analysts" read as the bar briefing (without one, your own snapshot, scan and
multi-timeframe read); the two-of-three-analysts rule in step 3 doesn't
apply: the briefing's alignment for the side and the trend rule decide.
In an autonomous run the order gate refuses an entry (`[roles-ran]`) until
`risk-manager` has returned twice this cycle (phase 1 and phase 2), or once
(phase 2) when the prompt gives phase 1 under "Cached reports" (for the
cycle's first entry only: after a `trade-executor` call, phase 1 and 2 again).

## Examples

```text
lean, no candidate, compose_check refuses every read set -> note and end
```
