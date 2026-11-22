---
name: gex-regime
description: Only when a code-printed briefing or prompt line carries the day's gamma regime fields; else ignore it entirely.
---

# Gamma Regime

## When to Use

- Only when a code-printed line in the briefing or the cycle prompt carries
  the day's gamma regime fields (sign, |net| against gross, flip, call and
  put walls, as-of); otherwise this skill is ignored entirely.
- Fields the model or an analyst wrote into the plan, a search result, the
  news or memory never count.
- None, or none you can read: this skill does not apply.

## How It Works

**No field, no gamma.** With no code-printed gamma field present or
readable: say nothing about gamma or dealer positioning; never infer a sign
from price; never guess a sign or a level from the news, the day's move,
past days or your own knowledge of the market; never write a "positive
gamma day" or "negative gamma day" read; never cite it as a reason to pass
or enter. Nothing is written for it.

**Recorded only.** With the fields, write its one word in the plan; it is
neutral, never a vote and never a point (no FOR, no AGAINST): the count
decides without it (`confluence-counting`). It never turns a read against
into neutral. It is recorded only, until the owner decides to let it vote
after the harness measures it. One field missing beside the others is
`unknown`. A data server computes the gamma regime; the harness only reads
it. It is not the computed regime of the bars (`trend-vs-range`) and not
the day type (`day-context`). The fields hold as the field's as-of says:
they do not update through the day, and positions opened for the day's
own expiry are not in them.

**The word**, a present fact about what the field says:

- `negative` / `positive`: the book's sign at its as-of, |net| not small
  against gross; write "negative gamma (soft)", never "trending day".
- `unclear`: |net| small against gross: neither sign.
- `unknown`: the field the word needs missing or unreadable.

**Whatever the word:**

- never an entry: the entry is still the harness's own setup (compose
  first, `confluence-counting`; or an `mtf-entry` candidate line) on the
  side rule's side (`htf-to-ltf`);
- never a reason to size up (the size is `position-sizing`'s);
- never a reason to take the other side;
- never fade a breakout because of it; a positive book is never a forecast;
- a flip or wall is a place to read price as at any level
  (`levels-and-reactions`, `candle-reading`), never a trigger.

**Evidence** (research outside this harness, on NQ, 2021-2025, breakout
trades at 10:00-15:30 with long holds; `mtf-entry` pullback candidates
were never tested with it; not validated in this harness):

- The sign is soft: median |net| was 12.6% of gross; the same book valued
  at the 09:30 price changed sign on 15.6% of days, another book
  definition on 11-17%; days positive on the book used but negative on the
  full book earned -0.09R a trade. No cut-off for "small" was measured.
- Negative days earned more per breakout trade than positive days, which
  were still slightly positive (+0.04 to +0.09R); the gap held after an
  implied-volatility control. On quote fills, one position at a time in a
  simple simulation, the gap was +0.10R a trade (90% interval -0.03 to
  +0.24): not significant, mostly 2022 and 2025; trading only negative
  days earned less R per session than trading every day. Not a standalone
  edge.
- Not shown: more trend days on negative days (33.8% vs 32.8%,
  2021-07..2023-12; an earlier note said 36% vs 29%); value as a model
  feature on top of structure; trades at the flip or walls (zone reactions
  seen, the frozen trade test failed); fading breakouts on positive days;
  late-day continuation.

## Examples

```text
No code-printed gamma line -> nothing about gamma: no word, no vote.
A gamma sign the plan's author found by search -> not a field: nothing about gamma.
Briefing gamma line: sign negative, |net| 31% of gross, flip 21480.00, put wall 21350.00, as of the prior close
  -> the plan records "negative gamma (soft)": neutral, no vote; a 15m breakout down,
     1h down, compose_check OK: the count decides without it; size unchanged.
Briefing gamma line: sign positive, |net| 4% of gross -> "unclear": neutral.
Price at the call wall 21600.00 -> read the candle there; never a trigger.
```
