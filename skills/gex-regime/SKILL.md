---
name: gex-regime
description: Only when a line the code computes from its gamma source (not the plan it relays) prints the day's gamma word; else ignore it entirely.
---

# Gamma Regime

## When to Use

- Only when a line the code computes from its gamma source (not the plan
  it relays) carries the day's gamma word in the cycle prompt; otherwise this skill is ignored entirely.
- The gamma source is the one the code reads. Fields the model or an
  analyst wrote into the plan, a search result, the news or memory never
  count.
- No such line, or none you can read: this skill does not apply.

## How It Works

**No field, no gamma.** With no gamma line the code computed from its
source present or readable: say nothing about gamma or dealer positioning;
never infer a sign from price; never guess a sign or a level from the
news, the day's move, past days or your own knowledge of the market; never
write a "positive gamma day" or "negative gamma day" read; never cite it as
a reason to pass or enter. Nothing is written for it.

**Copy, never derive.** The code line prints the word: copy it, never work
it out from the line's numbers (no cut-off for "small" was measured). The
sign is as the code line defines it.

**Recorded only.** Write the word on its own `gamma <word>` line in the
plan, never in the STATE line or the `regime:` tag (`trade-plan`). The plan's line
holds only what "The words" gives: no as-of, no note, no reason after it. Write it
once, from the code line's word. It is
neutral, never a vote and never a point (no FOR, no AGAINST): the count
decides without it (`confluence-counting`). It never turns a read against
into neutral. It is recorded only, until the owner decides to let it vote
after the harness measures it. It is not the computed regime of the bars
(`trend-vs-range`) and not the day type (`day-context`). The line holds as
its as-of says: it does not update through the day, and positions opened
for the day's own expiry are not in it.

**The words** the line prints:

- `negative` / `positive`: the sign; written `gamma negative (soft)` or
  `gamma positive (soft)`, never "trending day".
- `unclear`: the line says |net| is small against gross: neither sign.
- `unknown`: the line is there but prints no word, or a word you cannot read.

**Whatever the word:**

- never an entry: the entry is still the harness's own setup (compose
  first, `confluence-counting`; or an `mtf-entry` candidate line) on the
  side rule's side (`htf-to-ltf`);
- never a reason to size up or to size down (the size is
  `position-sizing`'s);
- never a reason to pass, to wait, or to change the stop, the exit or the
  hold;
- never a reason to take the other side;
- never fade a breakout because of it; the book is never a forecast;
- a flip or wall is a place to read price as at any level
  (`levels-and-reactions`, `candle-reading`), never a trigger.

**Evidence.** Research outside this harness (NQ, breakout trades with long
holds; not validated in this harness): the sign is soft (it changes with
the valuation price and the book used, and its dealer-sign convention was
not verified); negative days did better than positive days, but not
significantly on quote fills and not as a standalone edge; the gap held
on days of not-low implied volatility, not on low ones. Not shown: more
trend days, value as a model feature on top of structure, trades at
levels, fading positive days, late-day continuation. Pullback candidates (`mtf-entry`)
were never tested with it.

## Examples

```text
No gamma line from the code -> nothing about gamma: no word, no vote.
A gamma sign the plan's author found by search -> not a line from the code: nothing about gamma.
The cycle prompt's gamma line prints negative, as of the prior close -> the plan's own line
  `gamma negative (soft)`: neutral, no vote; a 15m breakout down, 1h down, compose_check OK:
  the count decides without it; size, stop and exit unchanged.
The cycle prompt's gamma line prints unclear -> `gamma unclear`: neutral.
Price at the line's call wall 21900 -> read the candle there; never a trigger.
```
