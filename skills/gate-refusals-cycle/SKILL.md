---
name: gate-refusals-cycle
description: Use when the gate refuses an entry with [roles-ran] or [phase2-facts].
---

# Gate refusals: cycle

## When to Use

- The gate refused an autonomous entry with `[roles-ran]` or `[phase2-facts]`.

## How It Works

| Message | Meaning | Do |
|---|---|---|
| `[roles-ran] … not returned yet: <roles>` | An autonomous cycle's entry before its roles reported: a full cycle needs `market-structure-analyst`, `trend-momentum-analyst`, `volume-liquidity-analyst` and `risk-manager` (phase 1 and phase 2) back this cycle, a lean one `risk-manager` twice; phase 2 started after phase 1 (and the analysts) returned, each in the foreground, since the last `trade-executor` call (trade-session skill). Also when the cycle's transcript can't be read | End the cycle (trade-session step 6): the refused `trade-executor` call ends the round, so the next entry needs every role again, then phase 2. Exits and stops still go. |
| `[phase2-facts] Risk-manager phase 2 approved on a fact the bar briefing contradicts: <fact>` | The phase-2 report that approved the entry states a `FACTS:` claim the bar briefing contradicts, fewer than two claims the current briefing checks (`approved with <n> checkable facts`), claims that can't be checked (no current briefing for the cycle's bar), or names another symbol, not the order's | End the cycle (trade-session step 6), naming the fact: the approval doesn't stand, and the next entry needs phase 2 to decide again from the briefing. Exits and stops still go. |

## Examples

```text
place_order -> [phase2-facts] ... contradicts: trend long allowed
  end the cycle, naming the fact; the next entry needs phase 2 again
```
