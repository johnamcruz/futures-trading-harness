---
name: gex-regime
description: Only when the plan or briefing carries the day's gamma regime fields; else ignore it entirely.
---

# Gamma Regime

## When to Use

- Only when the premarket plan or the briefing carries the day's gamma
  regime fields (sign, |net| against gross, flip, call and put walls,
  as-of); otherwise this skill is ignored entirely.
- None, or none you can read: this skill does not apply.

## How It Works

**No field, no gamma.** With no gamma field present or readable: say
nothing about gamma or dealer positioning; never infer a sign from price;
never guess a sign or a level from the news, the day's move, past days or
your own knowledge of the market; never write a "positive gamma day" or
"negative gamma day" read; never count it; never cite it as a reason to
pass or enter. Nothing is written for it.

With the fields: a read, never a veto: the count decides
(`confluence-counting`). One field missing beside the others is
`unknown`, which counts for nothing. A data server computes the gamma regime; the
harness only reads it. It is not the computed regime of the bars
(`trend-vs-range`) and not the day type (`day-context`).

**The facts** are the prior close's: they do not update through the day,
and positions opened for the day's own expiry are not in them.

**The read**, one word in the plan:

- `negative` / `positive`: the sign, |net| not small against gross; say
  "negative gamma day (soft)", never "trending day".
- `unclear`: |net| small against gross: a weak gamma regime, neither sign.
- `unknown`: the field the read needs missing or unreadable.

**Acting on it.**

- Negative: context that a move may extend, a hypothesis, never a forecast.
  The entry is still the harness's own setup (compose first,
  `confluence-counting`; or an `mtf-entry` candidate line) on the side
  rule's side (`htf-to-ltf`): never an entry, never a reason to size up
  (the size is `position-sizing`'s), never a reason to take the other side.
- Positive: no edge shown either way. Never fade a breakout because of it;
  "pinning" is no forecast.
- A flip or wall: a place to read price as at any level
  (`levels-and-reactions`, `candle-reading`), never a trigger.
- One read inside the `context` vote, beside the category's other reads,
  never a point of its own: negative with a setup on the side rule's side
  reads FOR; positive, `unclear` and `unknown` neutral; never AGAINST.

**Evidence** (research outside this harness, on NQ, 2021-2025, a breakout strategy with
long holds; not validated in this harness):

- The sign is soft: median |net| was 12.6% of gross; the same book valued
  at the 09:30 price flipped it on 15.6% of days, another book definition
  on 11-17%; days positive on the book used but negative on the full book
  earned -0.09R. No cut-off for "small" was measured.
- Negative days carried the breakout edge (positive about zero); the sign
  held after an implied-volatility control, but after quote fills the
  difference was +0.10R a trade [-0.03, +0.24], not significant, mostly
  2022 and 2025. Not a standalone edge.
- Not shown: more trend days on negative days (33.8% vs 32.8%); value as
  a model feature on top of structure; trades at the flip or walls (zone
  reactions seen, the frozen trade test failed); fading breakouts on
  positive days; late-day continuation.

## Examples

```text
No gamma field in the plan or briefing -> nothing about gamma: no read, no word, no vote.
Plan: gamma negative, |net| 31% of gross, flip 21480.00, put wall 21350.00, as of the prior close
  -> "negative gamma day (soft)"; a 15m breakout down, 1h down, compose_check OK:
     context FOR; size unchanged.
Plan: gamma positive, |net| 4% of gross -> "unclear": neutral; never "pinned".
Price reaches the call wall 21600.00 -> read the candle there; never a short by itself.
```
