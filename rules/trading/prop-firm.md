# Prop Firm Constraints

Firm rules end accounts. Check the current rules for the account type with the
user; numbers here are the harness defaults, not Topstep's official limits.

- **Trading day:** 17:00 → 17:00 America/Chicago. Daily loss and P&L reset at
  17:00 CT.
- **Daily loss limit:** stop well before it. The broker MCP server's daily
  loss guardrail (`get_server_config`: `maxDailyLoss`) should sit below the
  firm's limit.
- **Maximum loss limit (trailing drawdown):** the floor trails the account's
  high-water mark (end-of-day on Topstep combines). Know the cushion
  (balance − floor) before every session; size so one bad day can't breach it.
- **Flat by 16:00 ET:** Topstep flattens open positions at 15:10 CT (16:10
  ET); the harness is stricter. Its session is 18:00 ET to 16:00 ET, no new
  entries from 15:45 ET, and end of day (15:50 ET) closes positions and
  cancels resting orders. Nothing is held through the 16:00-18:00 ET break or
  the weekend.
- **Consistency:** on funded/combine accounts no single day should carry the
  whole profit target. Prefer steady days over one big one.
- **Locked accounts:** `canTrade=false` or errorCode 4 `AccountViolation` means
  the firm locked the account. Stop trading it and tell the user.
- **Market closed:** errorCode 5 `OutsideTradingHours`. Don't retry in a loop.
