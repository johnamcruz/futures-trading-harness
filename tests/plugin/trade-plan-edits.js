'use strict';

// The edits made to trade-plan (trade-session step 4 as main had it, tests/fixtures/skill-split/trade-session-step4.before.txt)
// since the split, each with its reason. Both byte-for-byte tests (trade-session-split.test.js and
// harness-tools-split.test.js) apply exactly these to the fixture and compare: any other change fails, and an edit whose
// old text is gone from the fixture fails too.

const EDITS = [
  { old: `liquidity in the trade's way (the candidate's \`inTheWay\` in the briefing's
\`m3\` \`candidates\`: the first level in its direction in points and R, where
1R is its own stop; with \`order_plan\`'s stop, check there is room to the
target or the trail's activation, and a level closer than 1R is a skip under
the skip rules that name it), and the session window`,
  now: `liquidity in the trade's way (\`inTheWay\`, the compose record's or a
candidate's: the first level in its direction in points and R, where 1R is
its own stop: check there is room to the target or the trail's
activation), and the session window`,
  reason: 'a composed trade\'s room is its compose record\'s inTheWay; the skip rules that named it were the retired rules strategies\'' },
  { old: 'The exit follows the strategy\'s `exit` (shown in the scan):',
    now: `The exit: a composed trade's target is the record's level (\`trade-lifecycle\`);
a policy's or a rules strategy's follows its \`exit\` (the rulebook, the scan):`,
    reason: 'a composed trade\'s exit is its record\'s target level; a policy trails by its rulebook' },
  { old: '  from the scan\'s `exit`, don\'t assume them.', now: '  from its `exit`, don\'t assume them.', reason: 'a policy\'s exit is its rulebook\'s, not the scan\'s' },
  { old: `- **Target level:** with \`exit.target\` the scan gives \`targetDistance\`: the
  target is the signal bar's close ± that distance (e.g. a CRT range's far
  side).
- **Time stop:** with \`maxBars\`, close at market after that many bars in the
  trade if neither the stop nor the target has filled.
`,
  now: '',
  reason: 'only retired rules strategies had a target distance or a time stop (strategies/retired.json)' },
  { old: `**The exact numbers come from \`order_plan\`**, not from your own arithmetic:
once you have chosen the strategy and the side (the steps above: the trigger,
the trend rule, the skip rules, the account), call it with them, e.g.
\`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "orb", "side": "long"}\`.`,
  now: `**The exact numbers come from \`order_plan\`** (a rules strategy, a policy
verdict, or \`trade_lifecycle\`'s compose record: \`trade-lifecycle\`),
not from your own arithmetic: once you have chosen the strategy and the
side, call it with them, e.g.
\`order_plan {"bars": "<bars file>", "symbol": "MNQ", "strategy": "<name>", "side": "long"}\`.`,
  reason: 'a composed trade\'s numbers are its compose record\'s, which order_plan plans (the trade-lifecycle skill); orb is retired' },
  { old: `policy entry may have. A different size from
your plan changes only \`size\`, and the risk scales with it: smaller for a
\`mixed\` read or a reversal fade, and, for a rules strategy, larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual`,
  now: `policy entry may have; a composed trade's is the size you stated, refused
over its cap (in an attempt, also the verdict). A different size from
your plan changes only \`size\`, and the risk scales with it: for a rules
strategy, smaller for a \`mixed\` read or a reversal fade, and larger only as
position-sizing allows (a setup with 30+ reviewed trades and positive
expectancy, within the budget and caps). A manual`,
  reason: 'owner decision D1: a composed trade\'s size is its own under the caps (order_plan refuses one over them), never halved for a mixed read; the halving and the size steps stay for a rules strategy' },
];

/** The fixture with every edit applied; throws when an edit's old text isn't in it exactly once. */
function edited(fixture) {
  let t = fixture;
  for (const e of EDITS) {
    if (t.split(e.old).length !== 2) throw new Error(`trade-plan edit not in the fixture once: ${e.old.slice(0, 60)}`);
    t = t.replace(e.old, () => e.now);
  }
  return t;
}

module.exports = { EDITS, edited };
