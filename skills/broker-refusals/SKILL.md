---
name: broker-refusals
description: What the broker's own refusal or error reply means - success:false, errorCode 4/5/6/7, a risk-guardrail block, a lost reply - and what to do for each.
---

# Broker refusals

## When to Use

- The broker refused an order or replied with an error, or its reply was
  lost.

## How It Works

Find the reply in the table and do what its row says. The order gate's own
refusals (a `[code]` or `Blocked by trading harness`) are in the
`gate-refusals` skill.

| Message | Meaning | Do |
|---|---|---|
| `Blocked by risk guardrail:` | MCP server limit | Stand aside. Don't resize or reroute. |
| `success: false` with an `errorCode` other than 6 (`OrderPending`) or 7 (`UnknownError`) on an entry, its brackets included (e.g. a bracket mode the account isn't set to) | The broker refused it: nothing was opened | Never re-send it without the bracket. Journal it, tell the user the broker's message verbatim, end as `blocked`. |
| Any other error reply to an entry (codes 6 and 7 included), or one saying a position may be open | Unknown outcome, not a refusal: a position may be open without its stop | Read `list_open_positions` and `list_open_orders` at once; protect (`[protect]` stop) or `close_position` any uncovered position first. Never re-send the entry. Report what you found. |
| errorCode 4 `AccountViolation` / `canTrade=false` | Firm locked the account | Stop. Tell the user. |
| errorCode 5 `OutsideTradingHours` | Market closed | Don't retry in a loop. |
| "Live accounts not supported" on cancel/close | The broker limits the endpoint to sim/eval | Tell the user. |

## Examples

```text
place_order -> success:false, errorCode 5 (OutsideTradingHours)
  the market is closed: don't retry in a loop
place_order -> no reply (timeout)
  unknown outcome: read list_open_positions and list_open_orders at once; never re-send
```
