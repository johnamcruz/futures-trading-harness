'use strict';

// The strategy-library skill was split into single-responsibility skills (strategy-library keeps applying a strategy
// and the priority order; strategy-scan, strategy-gate-checks and harness-root take the rest). This test proves
// nothing was lost or doubled: every sentence (and every code line) of the skill as it was
// (tests/fixtures/skill-split/strategy-library.before.txt, frozen) appears in the new skills exactly as many times as
// it did before, byte-for-byte after whitespace is normalised. The only exceptions are listed below, each with its
// reason; an exception that no longer differs fails too, so the list can only shrink. The unit rules are the
// broker-mcp split's (tests/plugin/broker-mcp-split.test.js), so both splits are held to the same standard.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BEFORE = 'tests/fixtures/skill-split/strategy-library.before.txt';
// The fixture is the skill exactly as main had it before the split (skills/strategy-library/SKILL.md at e7433091):
// pinned, so a sentence can't be dropped from the fixture and from its new home together.
const BEFORE_SHA256 = '04ad2fa5415f803c9c90fb3c7fca24e0b929aa22d34d1ea869bcc10577b67c64';
const HOMES = ['strategy-library', 'strategy-scan', 'strategy-gate-checks', 'harness-root'];

/**
 * A skill's units: its body (no frontmatter) in blocks (a heading, a list item, a table row, a paragraph, a code
 * line), whitespace normalised, list and heading markers dropped; table rows split into cells; prose into sentences.
 */
function units(md) {
  const body = md.replace(/^---\n[^]*?\n---\n/, '');
  const blocks = [];
  let cur = null;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^```/.test(line)) { fence = !fence; cur = null; continue; }
    if (fence) { if (line.trim()) blocks.push(line); cur = null; continue; }
    if (!line.trim()) { cur = null; continue; }
    if (cur === null || /^(#{1,6} |- |\d+\. |\|)/.test(line)) { cur = [line]; blocks.push(cur); } else cur.push(line);
  }
  const out = [];
  for (const b of blocks) {
    const text = (Array.isArray(b) ? b.join(' ') : b).replace(/\s+/g, ' ').trim();
    if (!Array.isArray(b)) { out.push(text); continue; } // a code line, whole
    if (text.startsWith('|')) {
      for (const cell of text.replace(/^\|\s*|\s*\|$/g, '').split(/\s+\|\s+/)) if (!/^[-|: ]+$/.test(cell)) out.push(cell);
      continue;
    }
    const prose = text.replace(/^#{1,6} /, '').replace(/^(?:- |\d+\. )/, '');
    for (const s of prose.split(/(?<=[.!?])\s+(?=[A-Z`*[("])/)) if (s) out.push(s);
  }
  return out;
}

const count = list => list.reduce((m, u) => m.set(u, (m.get(u) || 0) + 1), new Map());

// The skill format's own section headings: every new skill has them (CLAUDE.md, skill format).
const STRUCTURE = ['When to Use', 'How It Works', 'Examples'];

// Deliberate differences, each with its reason. An entry is { old, now?, copies?, reason }, as in the broker-mcp split.
const ALLOWED = [
  // A truth fix in moved text (pre-existing): orb's `risk.min_rr` is 2 (strategies/orb/STRATEGY.md), and the scan's
  // summary prints the stop in points, whole ticks and one contract's dollars, then the exit and the confluence, in full
  // (harness-tools/compact.js candidateLine; orb's exit trails from 2R giving back 0.5R).
  { old: 'strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stopDistance 5.25, minRR 1.5 (a candidate)',
    now: 'strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none (a candidate)',
    reason: 'the example as the scan prints it, with orb\'s own min R:R' },
  // A pointer to a skill retired later (tests/plugin/harness-tools-split.test.js): the strategies tools' rows are
  // strategy-tools'.
  { old: 'With the harness tools (the `harness-tools` skill):', now: 'With the harness tools (`strategy-tools`):',
    reason: 'the tool skill is retired; the strategies tools\' rows are in strategy-tools' },
  { old: "Stop from `risk.stop`: `atr:<k>` or a distance expression (e.g. cisd_ote's `cisd_risk(15)`) → the scan's `stopDistance`; `structure`/`swing` → beyond the level the body names.",
    now: "Stop from `risk.stop`: `atr:<k>` or a distance expression → the scan's `stopDistance`; `structure`/`swing` → beyond the level the body names.",
    reason: "the skill audit (fix/skills-composed-process): cisd_ote is retired" },
  { old: "**The trend rule**: a trend strategy against the prevailing trend → no trade (the scan and the gate refuse it anyway).",
    now: "**The trend rule**: a trend strategy against the prevailing trend → no trade.",
    reason: "the parenthesis restated the gate (multi-timeframe-analysis owns the trend rule); room for D2 below without growing a prompt" },
  { old: "A reversal strategy may fade it only at a higher-timeframe level, at half size and the nearest target.",
    now: "A reversal strategy may fade it only at a higher-timeframe level, at half size and the nearest target; a composed one needs a CHoCH its way at or above the trend's frame.",
    reason: "owner decision D2 (fix/skills-composed-process): a composed entry against the trend needs a CHoCH its way at or above the trend's frame" },
  { old: "strategies_show orb → skip rule \"relative volume < 1.0x\" → volume analyst reports 0.8x → no trade.",
    now: "trade_lifecycle long, read long mixed → its stated size.",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade is never halved; orb is retired" },
  { old: "strategies_scan → crt_1h short, a candidate, stopDistance 18.5 → read the",
    now: "trade_lifecycle short, 1h up, no 1h CHoCH down → step 2: no trade.",
    reason: "owner decision D2: the trend rule for a composed trade; crt_1h is retired" },
  { old: "body's skip rules → none apply → plan it.",
    copies: 0,
    reason: "the second line of the crt_1h example (retired)" },
];

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "trade_lifecycle long, read long mixed → its stated size.",
    to: null,
    reason: "review of #169: the intro and step 4 say it; the example made room for step 3 and 4's composed clauses without growing a prompt" },
  { from: "The rule for every setup (a rules strategy's candidate or a policy verdict).",
    to: "The rule for every setup.",
    reason: "re-review of #169: room for step 2's D2 tiers (the gate's D2_TIERS) without growing a prompt; every setup includes a composed one, so the list of kinds goes" },
  { from: "**Confluence**: another strategy firing the other side → no trade; confluence with it supports the full size; none changes nothing alone.",
    to: "**Confluence**: another strategy firing the other side → no trade; confluence with it supports the full size.",
    reason: "re-review of #169: room for step 2's D2 tiers (the gate's D2_TIERS) without growing a prompt; \"none changes nothing alone\" said nothing" },
  { from: "A reversal strategy may fade it only at a higher-timeframe level, at half size and the nearest target; a composed one needs a CHoCH its way at or above the trend's frame.",
    to: "A reversal strategy may fade it only at a higher-timeframe level, at half size and the nearest target; a composed one needs `trade-lifecycle`'s tier: vs a 15m trend a 15m or 1h CHoCH; vs 1h a 1h CHoCH; vs 4h a 1h CHoCH plus a 4h rejection.",
    reason: "re-review of #169: room for step 2's D2 tiers (the gate's D2_TIERS) without growing a prompt: the gate's tiers, which the risk manager reads here (it doesn't load trade-lifecycle)" },
  { from: "strategies_show {\"name\": \"orb\"} the full STRATEGY.md",
    to: "strategies_show {\"name\": \"<name>\"} the full STRATEGY.md",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "strategies_scan {\"bars\": \"<bars file>\", \"symbol\": \"MNQ\", \"name\": \"orb\"} one strategy's full result",
    to: "strategies_scan {\"bars\": \"<bars file>\", \"symbol\": \"MNQ\", \"name\": \"<name>\"} one strategy's full result",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "A strategy's full scan result (`name`) has `detail`, the detectors' state: a CRT's candle (`c1Open`/`c1High`/`c1Low`/`c1Close`) and why it did or didn't fire, and cisd_ote's `cisd(15)`: the CISD level, the leg, the zone, the stop and the swept level.",
    to: "A strategy's full scan result (`name`) has `detail`, the detectors' state: a CRT's candle (`c1Open`/`c1High`/`c1Low`/`c1Close`) and why it did or didn't fire, and a `cisd(15)` detector's: the CISD level, the leg, the zone, the stop and the swept level.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples); the cisd(15) detector named without cisd_ote" },
  { from: "The scan runs market-snapshot with each strategy's `params`, and a full result reports: `direction` (mechanical signal on the last closed bar), `filtersFailed`, `inSession`, `regime` (the computed regime of these bars), `inRegime` (fits the strategy's `regimes`: the trend-following strategies, `orb`, `value_area_breakout` and `vwap_reclaim`, never trade a range, and the order gate refuses their entries there too), `confluence` (on a strategy that fired: the other strategies on its timeframe that fired the same side, `with`, and the other side, `against`), `mtf` (the trend rule: the 4h, 1h, 15m trends, the `prevailing` one, and `longAllowed` / `shortAllowed` for this strategy's style; its `reason` names the side it blocks, e.g.",
    to: "The scan runs market-snapshot with each strategy's `params`, and a full result reports: `direction` (mechanical signal on the last closed bar), `filtersFailed`, `inSession`, `regime` (the computed regime of these bars), `inRegime` (fits the strategy's `regimes`: a trend-following one never trades a range, and the order gate refuses its entries there too), `confluence` (on a strategy that fired: the other strategies on its timeframe that fired the same side, `with`, and the other side, `against`), `mtf` (the trend rule: the 4h, 1h, 15m trends, the `prevailing` one, and `longAllowed` / `shortAllowed` for this strategy's style; its `reason` names the side it blocks, e.g.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "Listing MNQ, it trades NQ when NQ is selected, and then never MNQ (\"setup:orb trades NQ (the selected contract), not MNQ\"): trade the selected contract, don't switch legs.",
    to: "Listing MNQ, it trades NQ when NQ is selected, and then never MNQ (\"setup:<name> trades NQ (the selected contract), not MNQ\"): trade the selected contract, don't switch legs.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "A retired strategy (`bos`, `keltner`, `ema_cross`, `supertrend`; strategies/README.md, \"Retired strategies\") is no setup: its tag is refused, saying so, and a position it opened is still exited and protected with `[exit]` or `[protect]`.",
    to: "A retired strategy (strategies/retired.json) is no setup: its tag is refused, saying so, and a position it opened is still exited and protected with `[exit]` or `[protect]`.",
    reason: "the retired list is strategies/retired.json (every rules strategy since 2026-10-14), not four names" },
  { from: "It does refuse an order that contradicts its own rationale (`order-consistency`): write the side right after the tag (`setup:orb long ...`), the stop and target as prices on the tick, and brackets the same distance as those prices.",
    to: "It does refuse an order that contradicts its own rationale (`order-consistency`): write the side right after the tag (`setup:trade_lifecycle long ...`), the stop and target as prices on the tick, and brackets the same distance as those prices.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples); the tag of the one strategy, trade_lifecycle" },
  { from: "strategies_scan → orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none (a candidate)",
    to: "strategies_scan → <name> long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none (a candidate)",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "Apply a strategy", to: "Apply a rules strategy (none active; composed: `trade-lifecycle`)",
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "Round the stop away from the entry to the tick (a long's stop down, a short's up), the target toward it; bracket ticks = `ceil(distance / tickSize)`.", to: "Round the stop away from the entry to the tick, the target toward it; bracket ticks = `ceil(distance / tickSize)`.",
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "`atr:<k>` means k \u00d7 ATR(20) on the strategy's bars.", to: null,
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "**The multi-timeframe read for its side**: `aligned` \u2192 full; `pullback` \u2192 no trade until the trigger timeframe turns back with the bias (a shift, a reclaim), then full; `mixed` \u2192 half; `counter` on a non-reversal setup \u2192 no trade.", to: "**The multi-timeframe read for its side**: a rules strategy: `aligned` \u2192 full; `pullback` \u2192 no trade until the trigger timeframe turns back with the bias (a shift, a reclaim), then full; `mixed` \u2192 half; `counter` on a non-reversal setup \u2192 no trade.",
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "Stop from `risk.stop`: `atr:<k>` or a distance expression \u2192 the scan's `stopDistance`; `structure`/`swing` \u2192 beyond the level the body names.", to: "Stop from `risk.stop`: `atr:<k>` (k \u00d7 ATR(20) on its bars) or a distance expression \u2192 the scan's `stopDistance`; `structure`/`swing` \u2192 beyond the level the body names.",
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "The rule for every setup.", to: null,
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "**Confluence**: another strategy firing the other side \u2192 no trade; confluence with it supports the full size.", to: "**Confluence** (rules strategies): another firing the other side \u2192 no trade; confluence with it supports the full size.",
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "A strategy's full scan result (`name`) has `detail`, the detectors' state: a CRT's candle (`c1Open`/`c1High`/`c1Low`/`c1Close`) and why it did or didn't fire, and a `cisd(15)` detector's: the CISD level, the leg, the zone, the stop and the swept level.", to: "A strategy's full scan result (`name`) has `detail`, its detectors' state.",
    reason: "fix/skills-match-code: no rules strategy is active (labelled); composed: the htf-to-ltf side rule (the owner's trend-following decision: pullback an entry, counter a pass unless the D2 tier); retired CRT detail dropped" },
  { from: "A trade needs, in order (and then the priority order below sizes or skips it): the trigger has fired on a closed bar (scan lists it as a candidate, or the manual trigger described in the body), every context filter holds, no \"Skip when\" rule applies, and planned R:R \u2265 `risk.min_rr` (a trailing exit has no target: there, `trailActivateR` \u2265 `min_rr` stands in for it).", to: "A trade needs, in order (then the priority order sizes or skips it): the trigger fired on a closed bar (a scan candidate, or the body's manual trigger), every context filter holds, no \"Skip when\" rule applies, and planned R:R \u2265 `risk.min_rr` (a trailing exit: `trailActivateR` \u2265 `min_rr`).",
    reason: "fix/skills-match-code: the rules-only steps, shorter and labelled (no rules strategy is active)" },
  { from: "The values that rules reading a broker field saw on the bar appear in two places only: a candidate's `values:` (its side's rules that held; for an `any(...)` group, the branches that held), and, when no rule set fired, next to each rule that did not hold, `[field(\"a.b\")=0.42]` (`missing` when the bar has none; at most 6 per strategy, the rest counted).", to: "A rule reading a broker field shows its value on the bar: a candidate's `values:`, or `[field(\"a.b\")=0.42]` beside a rule that did not hold.",
    reason: "fix/skills-match-code review: the scan's broker-field values, shorter (rules strategies only; none active)" },
  { from: "A strategy that fired but failed a filter shows none.", to: null,
    reason: "fix/skills-match-code review: the scan's broker-field values, shorter (rules strategies only; none active)" },
  { from: "Contradicting facts mean no trade; confluence means trade.",
    to: "A valid setup is the trade (`confluence-counting`).",
    reason: "fix/confluence-not-vetoes: the count under the bias decides; a soft read is never a no trade alone (owner, 2026-10-21)" },
  { from: "**Room**: the first level in its way (`inTheWay`, in its own R) comes before the room it needs (`needR`) → no trade.",
    to: ["**Room**: the first level ahead (`inTheWay`, its own R) and the R it aims for (`needR`): a read, never a no trade alone.", "Hard: R:R to the target at least `risk.min_rr` (compose_check's)."],
    reason: "fix/confluence-not-vetoes: the room rule selected nothing in a census of 27,698 moments (blocked -0.032R vs room -0.079R, p 0.51): a read, never a no trade; R:R to the target stays hard" },
  { from: "**Secondary context** (the VWAP side, the lunch lull, participation): cuts to half, never vetoes alone.", to: null,
    reason: "feat/bias-bg (never counter): no entry against a trending 4h or 1h on any path, the 15m setup is the entry and the 3m only times it, the trail exits, a prop attempt trades the full verdict size; the rewritten text is new" },
  { from: "**The trend rule**: a trend strategy against the prevailing trend → no trade.", to: "**The trend rule** (never counter): any setup or strategy against a trending 4h or 1h, or with both ranging against the 15m → no trade, whatever CHoCH.",
    reason: "feat/bias-bg (never counter): no entry against a trending 4h or 1h on any path, the 15m setup is the entry and the 3m only times it, the trail exits, a prop attempt trades the full verdict size; the rewritten text is new" },
  { from: "A reversal strategy may fade it only at a higher-timeframe level, at half size and the nearest target; a composed one needs `trade-lifecycle`'s tier: vs a 15m trend a 15m or 1h CHoCH; vs 1h a 1h CHoCH; vs 4h a 1h CHoCH plus a 4h rejection.", to: null,
    reason: "feat/bias-bg (never counter): no entry against a trending 4h or 1h on any path, the 15m setup is the entry and the 3m only times it, the trail exits, a prop attempt trades the full verdict size; the rewritten text is new" },
  { from: "trade_lifecycle short, 1h up, no 1h CHoCH down → step 2: no trade.", to: null,
    reason: "feat/bias-bg (never counter): no entry against a trending 4h or 1h on any path, the 15m setup is the entry and the 3m only times it, the trail exits, a prop attempt trades the full verdict size; the rewritten text is new" },
  { from: "**The multi-timeframe read for its side**: a rules strategy: `aligned` → full; `pullback` → no trade until the trigger timeframe turns back with the bias (a shift, a reclaim), then full; `mixed` → half; `counter` on a non-reversal setup → no trade.", to: null,
    reason: "feat/bias-bg (never counter): no entry against a trending 4h or 1h on any path, the 15m setup is the entry and the 3m only times it, the trail exits, a prop attempt trades the full verdict size; the rewritten text is new" },
  { from: "Wherever a step halves, half is `floor(size / 2)`, and 0 means no trade (so at size 1 every halving is a skip).", to: null,
    reason: "feat/bias-bg (the context quiz, Q18): nothing halves in a prop attempt; the halving arithmetic is position-sizing's non-prop step, the priority order points there" },
  { from: "Halvings don't compound: however many steps halve, the size is halved once.", to: null,
    reason: "feat/bias-bg (the context quiz, Q18): nothing halves in a prop attempt; the halving arithmetic is position-sizing's non-prop step, the priority order points there" },
];
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();

/** What differs between the old skill and the new homes, beyond the allowed exceptions: [] when nothing does. */
function differences(beforeText, homeTexts) {
  const before = count(units(beforeText));
  const after = count(homeTexts.flatMap(units));
  const allowed = new Map(ALLOWED.map(a => [a.old, a]));
  const bad = [];
  for (const [u, n] of before) {
    if (STRUCTURE.includes(u)) continue;
    const a = allowed.get(u);
    const want = a ? (a.copies || 0) : n;
    if ((after.get(u) || 0) !== want) bad.push(`${JSON.stringify(u)}: ${n} before, ${after.get(u) || 0} after${a ? ` (allowed: ${want})` : ''}`);
  }
  for (const a of ALLOWED) {
    if (!before.has(a.old)) bad.push(`allow-list entry not in the old skill: ${a.old}`);
    for (const now of [a.now || []].flat()) if (after.get(now) !== 1) bad.push(`changed sentence in ${after.get(now) || 0} homes, not 1: ${now}`);
  }
  for (const h of STRUCTURE) if (after.get(h) !== homeTexts.length) bad.push(`"${h}" heading: ${after.get(h) || 0}, not one per skill`);
  return bad;
}

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

/**
 * Units out of their old order: in each home, the units that came from the old skill (a changed one standing in for
 * its old text) keep their old relative order, numbered steps included. [] when every home keeps it.
 */
function orderErrors(beforeText, homeTexts) {
  const old = units(beforeText);
  const nowToOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  homeTexts.forEach((text, h) => {
    const used = new Map();
    let last = -1;
    let lastUnit = '';
    for (const u0 of units(text)) {
      const u = nowToOld.get(u0) || u0;
      if (STRUCTURE.includes(u)) continue;
      const from = used.has(u) ? used.get(u) + 1 : 0;
      const at = old.indexOf(u, from);
      if (at < 0) continue; // new text, not from the old skill
      used.set(u, at);
      if (at < last) bad.push(`${HOMES[h]}: ${JSON.stringify(u)} now comes after ${JSON.stringify(lastUnit)}; it came before it`);
      last = at;
      lastUnit = u;
    }
  });
  return bad;
}

test('strategy-library split: every unit of the old skill is in exactly one new home, byte-for-byte (whitespace normalised)', () => {
  const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts()), []);
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts()), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('strategy-library split: the comparison catches a lost, a doubled or an edited sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 80, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('Exits and protective stops on either leg always go.'), 'a sentence is a unit');
  assert.ok(u.includes('strategies_list {} name, status, signal, instruments'), 'a code line is a unit');
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (name, text) => homes.map((h, i) => (i === at(name) ? text : h));
  const LEG = 'Exits and protective stops on either leg always go.';
  const gate = homes[at('strategy-gate-checks')];
  assert.ok(gate.includes(LEG));
  // Lost: a sentence dropped from its home.
  assert.notDeepStrictEqual(differences(old, swap('strategy-gate-checks', gate.replace(LEG, ''))), []);
  // Doubled: the same sentence in a second home.
  assert.notDeepStrictEqual(differences(old, swap('harness-root', `${homes[at('harness-root')]}\n${LEG}\n`)), []);
  // Edited: one word changed.
  assert.notDeepStrictEqual(differences(old, swap('strategy-gate-checks', gate.replace('never more than 45 minutes ago', 'never more than 50 minutes ago'))), []);
  // Reordered: two numbered steps of the priority order swapped (the content is all there, the order is not).
  const lib = homes[at('strategy-library')];
  const ROOM = /3\. \*\*Room\*\*[^]*?\(compose_check's\)\.\n/.exec(lib)[0];
  const TREND = /2\. \*\*The trend rule\*\*[^]*?whatever CHoCH\.\n/.exec(lib)[0];
  const swapped = lib.replace(TREND, '\u0000').replace(ROOM, TREND.replace('2. ', '3. ')).replace('\u0000', ROOM.replace('3. ', '2. '));
  assert.notStrictEqual(swapped, lib);
  assert.deepStrictEqual(differences(old, swap('strategy-library', swapped)), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap('strategy-library', swapped)), [], 'but changes the order');
  // Two sentences of one paragraph swapped, in another home.
  const A1 = 'Exits and protective stops on either leg always go.';
  const A2 = '`paper` strategies can only be paper-traded.';
  assert.notDeepStrictEqual(orderErrors(old, swap('strategy-gate-checks', gate.replace(`${A1} ${A2}`, `${A2} ${A1}`))), []);
  // A changed line reverted to its old text (the exception no longer needed) also fails: the list only shrinks.
  const scan = homes[at('strategy-scan')];
  assert.notDeepStrictEqual(differences(old, swap('strategy-scan', scan.replace(ALLOWED[0].now, ALLOWED[0].old))), []);
  // A section heading dropped: each new skill keeps the format's three sections.
  assert.notDeepStrictEqual(differences(old, swap('harness-root', homes[at('harness-root')].replace('## Examples', '## Example'))), []);
});

test('strategy-library split: each skill answers one question in a short index line; strategy-library keeps the priority order; no prompt grows', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
  }
  const sl = read('skills/strategy-library/SKILL.md').replace(/\s+/g, ' ');
  // No prompt grows (the owner's rule): the three pieces a trading role loads together are no larger than the old
  // skill's body, so their new text (headings, a bullet, an example) fits in what harness-root took away.
  const { parseFrontmatter: pf } = require('../../scripts/lib/frontmatter');
  const body = t => pf(t).body.trim().length;
  const pieces = ['strategy-library', 'strategy-scan', 'strategy-gate-checks'].reduce((n, x) => n + body(read(`skills/${x}/SKILL.md`)), 0);
  assert.ok(pieces <= body(read(BEFORE)), `the three pieces are ${pieces} characters, over the old skill's ${body(read(BEFORE))}`);
  assert.match(sl, /### Apply a rules strategy \(none active; composed: `trade-lifecycle`\)/);
  assert.match(sl, /### The priority order: the rule for every setup/);
  assert.doesNotMatch(sl, /### (Read the library|What the code enforces|Find the harness root)|retired-lane|trigger-fired|FTH_ROOT|filtersFailed/);
  // The priority order is in strategy-library only (the content test holds the rest of the priority-order guard).
  for (const s of HOMES.slice(1)) assert.doesNotMatch(read(`skills/${s}/SKILL.md`), /\*\*Hard stops → no trade\*\*|floor\(size \/ 2\)/, s);
  // The tool calls point to the strategies tools' rows (the strategy-tools skill).
  assert.match(read('skills/strategy-scan/SKILL.md'), /### Read the library\n\nWith the harness tools \(`strategy-tools`\):\n\n```text\nstrategies_list/);
});

test('strategy-library split: a rules entry still needs all of the old skill (the gate requires the pieces; trade-session names them); the prompt names the composed entry\'s list', () => {
  const { REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  // Every unit of the old skill is in a skill the main session must load before an entry, except harness-root's:
  // finding <root> is interactive use, and the autonomous prompt states the root itself ("Harness root (FTH_ROOT)").
  const asOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const loaded = new Set(REQUIRED_FOR_ENTRY.filter(s => HOMES.includes(s)).flatMap(s => units(read(`skills/${s}/SKILL.md`))).map(u => asOld.get(u) || u));
  const rootOnly = new Set(units(read('skills/harness-root/SKILL.md')));
  // A unit the allow-list drops (no `now`, no copies) is in no skill by design.
  const dropped = new Set(ALLOWED.filter(a => !a.now && !a.copies).map(a => a.old));
  const lost = units(read(BEFORE)).filter(u => !STRUCTURE.includes(u) && !loaded.has(u) && !rootOnly.has(u) && !dropped.has(u));
  assert.deepStrictEqual(lost, [], 'the main session loads every section of the old strategy-library');
  assert.deepStrictEqual(HOMES.filter(s => !REQUIRED_FOR_ENTRY.includes(s)), ['harness-root']);
  // trade-session's step 0 names each required skill; the autonomous prompt does too.
  const step0 = /### 0\. Load the skills([^]*?)###/.exec(read('skills/trade-session/SKILL.md'))[1];
  for (const s of REQUIRED_FOR_ENTRY) assert.match(step0, new RegExp(`\`${s}\``), `trade-session step 0 names ${s}`);
  const A = require('../../scripts/lib/autotrader');
  const prompt = A.prompts(A.validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  // The gate's list, then its parenthetical, then any skill it doesn't require (ALSO_LOAD): "load a, b, and c (the order
  // gate refuses an entry without them); also load d before deciding".
  const sentence = /load ([^.(]*?)(?: \(the order gate refuses an entry without them\))?(?:; also load [^.()]*?)? before deciding/.exec(prompt)[1];
  assert.match(prompt, /\(the order gate refuses an entry without them\)/);
  // trade_lifecycle is the one entry strategy (the owner's): the prompt names its list, trade-lifecycle in place of the
  // strategy skills, which a rules entry (a user's or a fixture's) reads with skill_lookup.
  const { REQUIRED_FOR_COMPOSED } = require('../../scripts/lib/trading/skills-loaded');
  for (const s of REQUIRED_FOR_COMPOSED) assert.ok(sentence.split(/,\s*(?:and\s+)?|\s+and\s+/).includes(s), `the prompt names ${s}`);
  for (const s of HOMES.filter(x => x !== 'harness-root')) assert.ok(!sentence.includes(s), `the prompt no longer loads ${s}`);
});

test('strategy-library-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});
