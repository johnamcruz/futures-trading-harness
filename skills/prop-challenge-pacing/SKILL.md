---
name: prop-challenge-pacing
description: Pace a Topstep-style prop evaluation or funded account - profit target, trailing max loss, daily loss limit, consistency - so the account survives long enough for the edge to show. Use at the start of each day and after big wins or losses.
---

# Prop Challenge Pacing

## When to Use

- Start of each trading day: set today's risk budget.
- After a large win (protect it) or a drawdown (de-risk).

## How It Works

Ask the user for the account's current rules; don't assume them. Track these
numbers each morning (from `get_account_snapshot` and the user):

- **Target remaining** = profit target − profit so far.
- **Cushion** = balance − trailing loss floor. The floor trails the end-of-day
  high-water mark on Topstep combines; it stops trailing at the starting
  balance once the passmark is reached (account-type dependent).
- **Days traded** and the best day's share of total profit (consistency).

Rules of thumb (the PropEvolve objective: pass without blowing the account):

1. **Survival first.** Daily risk budget ≤ 25–30% of the cushion; per-trade risk
   ≤ 10% of the cushion. A small cushion means smaller size, not "make it back".
2. **Pace, don't sprint.** Aim for target ÷ 10–15 days per day. Stop for the
   day at +1.5× the daily pace; protecting a green day is worth more than
   stretching it.
3. **Consistency.** If one day would exceed the firm's best-day share,
   stop for the day.
4. **After a red day,** the next day's budget is half until a green day.
5. **Near the target,** cut size: the last 10% isn't worth risking the account.
6. **Funded accounts,** scale only per the firm's scaling plan and the
   journal's evidence.

Write the day's numbers into the `plan` entry so reviews can grade pacing.

## Examples

```text
Target $3,000, profit $1,150 → remaining $1,850. Cushion $1,400.
Daily budget = 25% × 1,400 = $350; per trade ≤ $140; pace ≈ $185/day;
stop for the day at +$280.
```
