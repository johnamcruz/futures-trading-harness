---
name: contract-roll
description: Use when a quarterly contract roll is near.
---

# Contract Roll

## When to Use

- Premarket in a roll week, or a front-month check before planning.

## How It Works

**Contract roll.** Equity index futures expire quarterly (H Mar, M Jun, U
Sep, Z Dec) on the third Friday; volume moves to the next contract about
eight days earlier (the roll, the Thursday or Friday before). Trade the
front month by its plain name (`MNQ`): the harness maps it to the contract the
broker marks active, once per trading day, so after the roll `MNQ` is the new
month and the old one shows as `MNQ:2026-12`. Exit a position by the name
`list_open_positions` shows for it: the gate matches the exact month, so an
exit by another month (or by the root, for an old-month position) is refused,
since it would open a new position. Bars from before the
roll come from the old contract at a different price (the spread between
months): levels, VWAP, and swings that straddle the roll day are not
comparable; prefer the new contract's own bars for levels on roll days.

## Examples

December 2026 expires Friday 12-18; volume moves about Thursday 12-10.
After it `MNQ` is March 2027 and the old month shows as `MNQ:2026-12`. With
the months 20.00 points apart, a VWAP from before the roll is off by 80
ticks, $40.00 per MNQ contract.
