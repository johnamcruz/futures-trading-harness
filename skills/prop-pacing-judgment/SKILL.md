---
name: prop-pacing-judgment
description: Use when pacing a prop account with no running attempt (daily budget, pace, consistency, stand-downs).
---

# Prop Pacing by Judgment

## When to Use

Only while no harness-tracked attempt is running (`combine_status` lists none;
for a running one, the `prop-challenge-pacing` skill):

- Start of each trading day: set today's risk budget.
- After a large win (protect it) or a drawdown (de-risk).

## How It Works

**Not in a prop attempt.** Only while no harness-tracked attempt is running (`combine_status` lists none): a
running attempt is paced by its verdicts (the `prop-challenge-pacing` skill), never
by these rules.

Interactive: ask the user for the account's current rules; don't assume
them. Autonomous: never ask. Track these numbers each morning (from
`get_account_snapshot`, and interactively the user):

- **Target remaining** = profit target − profit so far.
- **Cushion** = balance − trailing loss floor. The floor trails the end-of-day
  high-water mark on the bundled combine profiles; it stops trailing at the starting
  balance once the passmark is reached (account-type dependent).
- **Days traded** and the best day's share of total profit (consistency).

Rules of thumb (the PropEvolve objective: pass without blowing the account):

1. **Survival first.** Daily risk budget ≤ 25–30% of the cushion; per-trade risk
   ≤ 10% of the cushion (none known: no cap, never $0). A small cushion means smaller size, not "make it back".
2. **Pace, don't sprint.** Aim for the target remaining ÷ 10–15 days per day. Stop for the
   day at +1.5× the daily pace; protecting a green day is worth more than
   stretching it.
3. **Consistency.** If one day would exceed the firm's best-day share,
   stop for the day. Past the target, the gate stops entries once today's
   close would pass; while the best day is still too large a share, the
   attempt keeps trading (at normal size) on days smaller than the best one,
   and stops for the day once today is the best day (more can't help).
4. **After a red day,** the next day's budget is half until a green day.
5. **Near the target,** cut size: the last 10% isn't worth risking the account.
6. **Funded accounts,** scale only per the firm's scaling plan and the
   journal's evidence.

Write the day's numbers into the `plan` entry so reviews can grade pacing.

## Examples

```text
Target $3,000, profit $1,150 → remaining $1,850. Cushion $1,400.
Daily budget = 25% × 1,400 = $350; per trade ≤ 10% × 1,400 = $140;
pace ≈ $1,850 ÷ 10 = $185/day; stop for the day at +1.5 × $185 ≈ $280.
```
