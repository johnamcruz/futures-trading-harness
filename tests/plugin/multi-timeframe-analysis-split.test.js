'use strict';

// The multi-timeframe-analysis skill was split by job: multi-timeframe-analysis keeps the read (each timeframe's
// trend, its three votes) and the trend rule as the scan, the backtester and the order gate enforce it (`mtf`,
// `mtf: reversal`), with how to write it down (the name stays: the order gate requires it, REQUIRED_FOR_ENTRY);
// daily-bias takes the daily read and the bias score, htf-to-ltf the alignment labels and the levels flowing down,
// timeframe-sources the bars and the briefing fields per timeframe, mtf-bias-filter the trend as a rules filter.
// This test proves nothing was lost, doubled or misplaced: every sentence (and every table cell and code line) of the
// skill as it was (tests/fixtures/skill-split/multi-timeframe-analysis.before.txt, frozen) is in the new homes exactly
// as many times as before, byte-for-byte after whitespace is normalised, in the home its old section maps to, in its
// old order within each home. The only exceptions are listed, each with its reason; an exception that no longer
// differs fails too, so the list can only shrink.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, count, differences, STRUCTURE } = require('./skill-split');
const { orderErrors } = require('./skill-split-order');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// skills/multi-timeframe-analysis/SKILL.md as main had it before the split (at baa4b192): pinned, so a sentence can't
// be dropped from the fixture and from its new home together.
const BEFORE = 'tests/fixtures/skill-split/multi-timeframe-analysis.before.txt';
const BEFORE_SHA256 = 'f3fdeb292a35c45994a1dcd095266aace7c8f6e476cef956ec63373c42324001';
const HOMES = ['multi-timeframe-analysis', 'daily-bias', 'htf-to-ltf', 'timeframe-sources', 'mtf-bias-filter'];

// Each moved home and the fixture's units it takes (units(BEFORE) indices, inclusive ranges); every other unit stays
// in multi-timeframe-analysis (HOMES[0]).
const MOVED = {
  // When to Use's premarket line, the daily fallback and fetch, the bias score, the daily swings.
  'daily-bias': [[4, 4], [29, 30], [81, 81], [87, 87]],
  // When to Use's disagreement line; a plan's alignment is the briefing's, the daily only context (in the skill the head
  // trader loads every cycle, not daily-bias); "Read the alignment" (table, policy ceiling, reversals); "Levels flow down".
  'htf-to-ltf': [[6, 6], [35, 35], [63, 80], [82, 85], [88, 88]],
  // "Get the bars" and its table, "Run the read" (briefing fields, mtf_read calls, the bars path), the briefing levels
  // (all but the table and the two-requests rule now one pointer to bar-briefing: DROPPED below).
  'timeframe-sources': [[8, 28], [31, 34], [36, 39], [86, 86]],
  // "In rules (mechanical strategies)".
  'mtf-bias-filter': [[93, 102]],
};

// Deliberate differences, each with its reason.
const ALLOWED = [
  { old: 'Every trade plan, before risk-manager phase 1: is this setup with the higher timeframes, a pullback inside them, or against them?',
    now: 'Every trade plan, before risk-manager phase 1: each timeframe\'s trend, and whether the trend rule allows the side (with them, a pullback or against them: `htf-to-ltf`).',
    reason: 'with, pullback or against is the alignment, now htf-to-ltf: the core\'s line asks what the core answers and points there' },
  { old: 'Each timeframe\'s last completed candle (3m, 5m, 15m, 1h), with the levels it met, its previous candle\'s high and low among them, is in `m3` `candles`; the next swing high and low each side is in `m3` `swingTargets`.',
    now: 'Each timeframe\'s last completed candle and the levels it met, and the next swing each side: the `candle-reading` skill.',
    reason: 'a restatement of what candle-reading teaches (the stack, `m3.candles`, `m3.swingTargets`): now a pointer' },
  { old: '`mtf_bias(m)` is the same trend per bar, causal (each bar sees only candles completed before it): 1 up, -1 down, 0 range.',
    now: '`mtf_bias(m)` is the multi-timeframe trend per bar in strategy rules (the `strategy-authoring` skill defines it).',
    reason: 'a restatement of strategy-authoring\'s definition of mtf_bias (as of the last completed candle; 1 up, -1 down, 0 range): now a pointer' },
  { old: 'In an autonomous cycle the bar briefing (`bar_briefing`, the `bar-briefing` skill) already holds this read for the bar: the 15m frame and the alignment per side (`m15`), the 1h and 4h frames (`h1` `h1` and `h4`), and the trend rule (`m3` `trendRule`).',
    now: 'The briefing\'s fields per timeframe and the `mtf_read` calls: the `bar-briefing` skill (use a current briefing; `mtf_read`, on the files `tool-arguments` names, only for what it lacks: the close\'s place in the range, the frame\'s swing high and low, the previous candle\'s high and low are `mtf_read` json\'s).',
    reason: 'the briefing\'s fields are bar-briefing\'s (its bar_briefing and mtf_read rows): timeframe-sources keeps its source table and points there' },
  { old: 'Run the read', copies: 0, reason: 'its section is now the one pointer line after the table, under "Get the bars"' },
  ...[
    'Each frame there has the trend, bias, swing pattern, close, EMA20 and EMA50, ADX, ATR and the last 20 candles\' range with its mid (`range`); it leaves out the close\'s position in that range, the frame\'s swing high and low and its previous candle\'s high and low (the 15m and 1h swings against price are `m3` `htfLevels`; `mtf_read` with `json` has the rest).',
    'Use it; run `mtf_read` only without a current briefing.',
    'mtf_read {"bars": "<trigger bars>", "daily": "<the daily file bars_fetch returned>"}',
    'mtf_read {"bars": "<trigger bars>", "timeframes": [15, 60, 240], "json": true} every number',
    '`<trigger bars>` is the runner\'s bars file by absolute path (e.g.',
    '`/home/u/.futures-trading-harness/bars/MNQ-3m.json`; no `~`) or a `bars_fetch` file (the `tool-arguments` skill says which files it reads).',
    'The briefing shows: the 15m and 1h swing highs and lows against price (`m3` `htfLevels`), the 1h swings not yet traded back to (`m3` `untested1hSwings`), each frame\'s last-20-candle range high, low and mid (`m15` `frame.range`, `h1` `h1.range` and `h4.range`), and the prior RTH day\'s high and low (`day` `priorRth`).',
  ].map(old => ({ old, copies: 0, reason: 'a restatement of bar-briefing (its m3, m15, h1 and day fields; its mtf_read row and example; tool-arguments names the files): the pointer above replaces it' })),
  { old: "A policy strategy's verdict is a ceiling: the read halves or skips it like any setup (the priority order, strategy-library).",
    now: "For a composed trade the label is a reason in its plan, never a cut (the priority order, strategy-library).",
    reason: "owner decision D1 (fix/skills-composed-process): a composed trade, the policy's one component, is never halved by the read" },
  { old: "From the highest timeframe down, for each side:",
    now: "From the highest timeframe down, for each side (`m15.alignment`; read `read <side> <label>`):",
    reason: "the skill audit (fix/skills-concept-owners): the label's briefing field and its read form" },
  { old: "Reversal strategies (`crt_1h`, `crt_4h`, `ofi_absorption`, `value_area_reentry`) trade against the lower timeframes by design, and the trend rule lets them fade the prevailing trend.",
    now: "A composed entry against the prevailing trend needs the CHoCH tier of `trade-lifecycle` (strategy-library: the priority order, step 2).",
    reason: "the reversal strategies are retired (strategies/retired.json); owner decision D2: a composed entry against the trend needs a verified 15m or 1h CHoCH" },
  { old: "Judge the setup against the timeframe above its range candle (for `crt_1h`, the 4-hour trend; for `crt_4h`, the daily): against that one too, it is a `counter` reversal (the priority order, step 2, decides it: level, size, target).",
    copies: 0,
    reason: "crt_1h and crt_4h are retired (strategies/retired.json)" },
];

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "the runner's bars file (at least 2000 bars), or `bars_fetch` with `{\"symbol\": \"<SYMBOL>\", \"timeframe\": 3, \"record\": true}` (the runner's default, 5000 3-minute bars, to `<FTH_HOME>/bars-scratch/<SYMBOL>-3m.json`, and the read recorded for the gate)",
    to: "the runner's bars file (at least 2000 bars), or `bars_fetch` with `{\"symbol\": \"<SYMBOL>\", \"timeframe\": 3, \"record\": true}` (the runner's default count, to `<FTH_HOME>/bars-scratch/<SYMBOL>-3m.json`, and the read recorded for the gate)",
    reason: "feat/htf-history: the runner's bar count follows the read's window (config/analysis.json mtf.historyHours), so the skills name no count (its one home is the config)" },
  { from: "**Reversal strategies** (`mtf: reversal`: `crt_1h`, `crt_4h`, `ofi_absorption`, `value_area_reentry`): may fade it.",
    to: "**Reversal strategies** (`mtf: reversal`): may fade it.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "`strategies/orb_mtf/`) and compare the two with `scripts/backtest.js`.",
    to: "`strategies/<name>_mtf/`) and compare the two with `scripts/backtest.js`.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "-> Longs are a pullback: wait for a 3m shift up (a BOS up, then a long setup such as vwap_reclaim), target the 1h swing high.",
    to: "-> Longs are a pullback: wait for a 3m shift up (3m bos up), target the 1h swing high.",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples)" },
  { from: "Shorts are counter: a 3m orb short is refused (scan and gate); only a",
    to: "Shorts are counter: a trend strategy's short is refused (scan and gate); a composed",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples); owner decision D2: a composed short against the trend needs a 15m or 1h CHoCH down" },
  { from: "crt_1h raid of the 1h high could short (the priority order, step 2, decides it:",
    to: "short needs a 1h CHoCH down and a 4h rejection (`trade-lifecycle`).",
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples); owner decision D2: a composed short against the trend needs a 15m or 1h CHoCH down" },
  { from: "level, size, target).",
    to: null,
    reason: "every rules strategy is retired (strategies/retired.json): no retired name as an example (the skill audit, fix/skills-stale-examples); owner decision D2: a composed short against the trend needs a 15m or 1h CHoCH down" },
  { from: "**Trend strategies** (every strategy unless its STRATEGY.md says `mtf: reversal`): never enter against the prevailing trend, and wait while the 4h has fewer than 3 completed candles.", to: "**Every entry**, long or short alike (`trade_lifecycle`, and a rules strategy without `mtf: reversal`): never against the prevailing trend; wait while the 4h has fewer than 3 completed candles.",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "That is their setup, a raid at a higher-timeframe level; when they do, the priority order (strategy-library, step 2) decides them: level, size, target.", to: "**Against it**: a composed entry only on its CHoCH tier (`trade-lifecycle`); a rules `mtf: reversal` strategy (none active) at a higher-timeframe level, decided by the priority order (step 2).",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "`strategies_scan`: a trend strategy that fires against it is not a candidate; its why-not (`filtersFailed` in its full result) says `mtf: against the prevailing 4h down trend ...`.", to: "`strategies_scan` (rules strategies): one that fires against it is not a candidate; its why-not (`filtersFailed` in its full result) says `mtf: against the prevailing 4h down trend ...`.",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "The order gate (`mtf-trend`, hard: nothing switches it off) refuses a trend strategy's entry against the trend recorded in `<FTH_HOME>/mtf/<ROOT>.json`, or with no record or one more than 15 minutes (`FTH_MTF_MAX_AGE_MIN`) past its last bar's close.", to: "The order gate (`mtf-trend`, hard: nothing switches it off) refuses an entry against the trend recorded in `<FTH_HOME>/mtf/<ROOT>.json`, or with no record or one more than 15 minutes (`FTH_MTF_MAX_AGE_MIN`) past its last bar's close.",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "Step 4 of the priority order (strategy-library) sets the size; with room to its trail activation and confluence it is the opportunity (the briefing's candidate `facts` show both)", to: "Priority step 4 (strategy-library) sets the size; with room and confluence it is the opportunity",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "The setup timeframe is pulling back. Wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then step 4 of the priority order (strategy-library) sets the size. Do not enter while it is still moving against you", to: "The setup timeframe is pulling back. A rules strategy: wait for the trigger timeframe to turn back with the bias (a shift, a reclaim), then priority step 4",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "Step 4 of the priority order (strategy-library) sets the size. Target the nearest opposing level; skip in a quiet session", to: "Priority step 4 sets the size. Target the nearest opposing level; skip in a quiet session",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "Step 4 of the priority order (strategy-library); a reversal at a higher-timeframe level is its step 2, and the plan says why", to: "Priority step 4; a rules reversal at a higher-timeframe level is its step 2, and the plan says why",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "The daily and 4-hour swing highs and lows are not in it: take them from `mtf_read` (premarket's daily read).", to: "The prior RTH day's high and low and the 4h swings are in the briefing (`timeframe-sources`, `m3.swingTargets`); the daily swings only in `mtf_read`: no target read.",
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "The alignment and the trend rule in a trade plan are the briefing's (intraday frames); a daily read, if you have one (premarket's), is context only, never a second alignment.", to: "The alignment and the trend rule are the briefing's; a daily read (premarket's) is context only, never a second alignment.",
    reason: "feat/bias-bg: the same rule in fewer words, so the head prompt holds the BG side rule within its 74227 bytes" },
  { from: "For a composed trade the label is a reason in its plan, never a cut (the priority order, strategy-library).", to: "**The side rule** (in an attempt): each trending 4h or 1h your way, neither against; both ranging: the 15m and `Trend declared?` your way; else no trade.",
    reason: "feat/bias-bg: the entry rule's BG (bias_agree neutral-15m-declared, the owner's pick from the alignment study, 2026-10-29): a trending 4h or 1h sets the side, neither against; both ranging, the 15m and the declared trend; before it, feat/htf-aligned-trend-stage: the owner's \"No trade if there is no agreement between the two\" (bias_agree, 2026-10-29); before it, fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "A composed entry against the prevailing trend needs the CHoCH tier of `trade-lifecycle` (strategy-library: the priority order, step 2).", to: "`counter` (the HTF against): pass.",
    reason: "feat/htf-aligned-trend-stage: no CHoCH tier stands against the 4h or the 1h in an attempt (bias_agree, 2026-10-29); before it, fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "**Reversal strategies** (`mtf: reversal`): may fade it.", to: null,
    reason: "fix/skills-match-code: one side rule for every entry, long and short alike (the owner's trend-following decision; composed: pullback an entry, counter a pass unless the D2 tier); no rules strategy is active" },
  { from: "The last line of the read states it: `Trend rule: prevailing trend 4h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.` The daily (`daily`) is context for your judgment; the rule reads the intraday frames.",
    to: "The last line of the read states it, the allowed side first: `Trend rule: LONG allowed (prevailing 4h up); short only as a reversal (mtf: reversal).` The daily (`daily`) is context for your judgment; the rule reads the intraday frames.",
    reason: "fix/confluence-not-vetoes: the trend rule names the allowed side first (mtf.js ruleLine): the old line ended on the blocked side and local models read it as allowed" },
  { from: "Take levels from the higher timeframes and treat them as targets on the trigger timeframe, or as reasons to skip a setup that runs straight into one.",
    to: "Take levels from the higher timeframes and treat them as targets on the trigger timeframe, or as a read against a setup that runs straight into one.",
    reason: "fix/confluence-not-vetoes: a soft read is a read in the count, never a pass alone (owner, 2026-10-21; a census of 27,698 moments)" },
  { from: "Priority step 4 (strategy-library) sets the size; with room and confluence it is the opportunity",
    to: "Priority step 4 (strategy-library) sets the size; with the count for it, the opportunity",
    reason: "fix/confluence-not-vetoes: a soft read is a read in the count, never a pass alone (owner, 2026-10-21; a census of 27,698 moments)" },
  { from: "Priority step 4 sets the size. Target the nearest opposing level; skip in a quiet session",
    to: "Priority step 4 sets the size. Target the nearest opposing level; a quiet session is a read against",
    reason: "fix/confluence-not-vetoes: a soft read is a read in the count, never a pass alone (owner, 2026-10-21; a census of 27,698 moments)" },
];
// The two example lines (mtf_read output), both in today's wording (the same line twice: nowCopies).
ALLOWED.push({ old: "Trend rule: prevailing trend 4h up; trend strategies may not go short; reversal strategies (mtf: reversal) may go short too.",
  now: "Trend rule: LONG allowed (prevailing 4h up); short only as a reversal (mtf: reversal).", copies: 0, nowCopies: 2,
  reason: "fix/confluence-not-vetoes: the trend rule names the allowed side first (mtf.js ruleLine): the old line ended on the blocked side and local models read it as allowed" });
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();
// The units dropped outright (copies 0, no new text): no home holds them.
const DROPPED = new Set(ALLOWED.filter(a => a.copies === 0 && !a.now).map(a => a.old));

const homeTexts = () => HOMES.map(s => read(`skills/${s}/SKILL.md`));

/** The old units each home must hold: Map home -> Map unit -> count (HOMES[0] takes every unit not moved). */
function expectedHomes(beforeText) {
  const old = units(beforeText);
  const home = old.map(() => HOMES[0]);
  for (const [h, ranges] of Object.entries(MOVED)) for (const [a, b] of ranges) for (let i = a; i <= b; i++) home[i] = h;
  const out = new Map(HOMES.map(h => [h, new Map()]));
  old.forEach((u, i) => { if (!STRUCTURE.includes(u) && !DROPPED.has(u)) out.get(home[i]).set(u, (out.get(home[i]).get(u) || 0) + 1); });
  return out;
}

/** Old units in a home their old section doesn't map to (or missing from the one it does): [] when each is home. */
function homeErrors(beforeText, texts) {
  const expected = expectedHomes(beforeText);
  const old = new Set(units(beforeText));
  const nowToOld = new Map(ALLOWED.flatMap(a => [a.now || []].flat().map(n => [n, a.old])));
  const bad = [];
  HOMES.forEach((h, i) => {
    const got = count(units(texts[i]).map(u => nowToOld.get(u) || u).filter(u => old.has(u) && !STRUCTURE.includes(u)));
    const want = expected.get(h);
    for (const u of new Set([...got.keys(), ...want.keys()])) {
      if ((got.get(u) || 0) !== (want.get(u) || 0)) bad.push(`${h}: ${JSON.stringify(u)} ${got.get(u) || 0} time(s), its old section maps ${want.get(u) || 0} here`);
    }
  });
  return bad;
}

test('multi-timeframe-analysis split: every unit of the old skill is in exactly one new home, its own, in its old order', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, BEFORE))).digest('hex');
  assert.strictEqual(sha, BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.deepStrictEqual(differences(read(BEFORE), homeTexts(), ALLOWED), []);
  assert.deepStrictEqual(homeErrors(read(BEFORE), homeTexts()), [], 'each unit is in the home its old section maps to');
  assert.deepStrictEqual(orderErrors(read(BEFORE), homeTexts(), HOMES, ALLOWED), [], 'moved text keeps its old order in each home');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
});

test('multi-timeframe-analysis split: the comparison catches a lost, a doubled, an edited, a misplaced or a reordered sentence', () => {
  const old = read(BEFORE);
  const u = units(old);
  assert.ok(u.length > 100, `the units are fine-grained (${u.length})`);
  assert.ok(u.includes('the highest timeframe is against it'), 'a table cell is a unit');
  assert.ok(u.includes('The backtester uses the same scan, so its trades obey it.'), 'a sentence is a unit');
  // The pins name the sections they say: a range's first and last units.
  assert.strictEqual(u[63], 'Read the alignment');
  assert.strictEqual(u[93], 'In rules (mechanical strategies)');
  assert.strictEqual(u[8], 'Get the bars (one request per timeframe at most)');
  assert.match(u[82], /^Reversal strategies/);
  const homes = homeTexts();
  const at = name => HOMES.indexOf(name);
  const swap = (...pairs) => homes.map((h, i) => { const p = pairs.find(([n]) => at(n) === i); return p ? p[1] : h; });
  const S = 'The backtester uses the same scan, so its trades obey it.';
  const core = homes[at('multi-timeframe-analysis')];
  assert.ok(core.includes(S));
  // Lost, doubled, edited.
  assert.notDeepStrictEqual(differences(old, swap(['multi-timeframe-analysis', core.replace(S, '')]), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap(['daily-bias', `${homes[at('daily-bias')]}\n${S}\n`]), ALLOWED), []);
  assert.notDeepStrictEqual(differences(old, swap(['multi-timeframe-analysis', core.replace('fewer than 3 completed candles', 'fewer than 2 completed candles')]), ALLOWED), []);
  // Misplaced: the trend-rule bullet moved into mtf-bias-filter, or the reversal paragraph out of htf-to-ltf into the
  // core: nothing is lost or doubled, but it left its home.
  const BULLET = /- \*\*Every entry\*\*[^]*?both sides are open\.\n/.exec(core)[0];
  const f = homes[at('mtf-bias-filter')];
  const moved1 = swap(['multi-timeframe-analysis', core.replace(BULLET, '')], ['mtf-bias-filter', `${f}\n${BULLET}`]);
  assert.deepStrictEqual(differences(old, moved1, ALLOWED), [], 'the move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved1), [], 'but the trend rule left the core');
  const h = homes[at('htf-to-ltf')];
  // The reversal paragraph (now the side rule: owner decision D2 and the trend-following side rule).
  const REV = /\*\*The side rule\*\*[^]*?the trend rule decides\.\n/.exec(h)[0];
  const moved2 = swap(['htf-to-ltf', h.replace(REV, '')], ['multi-timeframe-analysis', `${core}\n${REV}`]);
  assert.deepStrictEqual(differences(old, moved2, ALLOWED), [], 'the move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved2), [], 'but the reversal paragraph left htf-to-ltf');
  // Reordered: two rows of the alignment table swapped (nothing lost, the order changed).
  const R1 = /^\| `aligned` .*\n/m.exec(h)[0];
  const R2 = /^\| `counter` .*\n/m.exec(h)[0];
  const swapped = h.replace(R1, '\u0000').replace(R2, R1).replace('\u0000', R2);
  assert.deepStrictEqual(differences(old, swap(['htf-to-ltf', swapped]), ALLOWED), [], 'a swap loses nothing');
  assert.notDeepStrictEqual(orderErrors(old, swap(['htf-to-ltf', swapped]), HOMES, ALLOWED), [], 'but changes the order');
  // A changed sentence reverted to its old text (the exception no longer needed) fails: the list only shrinks.
  const reverted = f.replace(/`mtf_bias\(m\)` is the multi-timeframe trend[^]*?defines it\)\./, ALLOWED[2].old);
  assert.notStrictEqual(reverted, f);
  assert.notDeepStrictEqual(differences(old, swap(['mtf-bias-filter', reverted]), ALLOWED), []);
  // A section heading dropped.
  assert.notDeepStrictEqual(differences(old, swap(['daily-bias', homes[at('daily-bias')].replace('## Examples', '## Example')]), ALLOWED), []);
});

test('multi-timeframe-analysis split: each skill has a short "Use when" index line, and the core points to the rest', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of HOMES) {
    const d = parseFrontmatter(read(`skills/${s}/SKILL.md`)).data.description;
    assert.ok(d.length <= 160, `${s}: description ${d.length} chars, over 160`);
    assert.match(d, /^Use when /, s);
    for (const hd of STRUCTURE) assert.ok(read(`skills/${s}/SKILL.md`).includes(`## ${hd}`), `${s}: ## ${hd}`);
  }
  const core = read('skills/multi-timeframe-analysis/SKILL.md').replace(/\s+/g, ' ');
  for (const s of HOMES.slice(1)) assert.match(core, new RegExp(`\\(\`${s}\`\\)`), `multi-timeframe-analysis points to ${s}`);
  // The trend rule stays in the core, the name the order gate requires; the moved jobs left it.
  assert.ok(require('../../scripts/lib/trading/skills-loaded').REQUIRED_FOR_ENTRY.includes('multi-timeframe-analysis'));
  assert.match(core, /### 2\. The trend rule \(enforced, not advice\)[^#]*`mtf: reversal`[^#]*The order gate \(`mtf-trend`, hard/);
  assert.doesNotMatch(core, /### \d\. (Get the bars|Run the read|Read the alignment|Levels flow down|In rules)|```yaml|\| `pullback` \|/);
  // The /mtf command promises the alignment and names the skill that has it.
  assert.match(read('commands/mtf.md').replace(/\s+/g, ' '), /Use the `multi-timeframe-analysis` skill for: \$ARGUMENTS \(with the `htf-to-ltf` skill for each side's alignment, and `timeframe-sources` for the bars\)/);
});

/**
 * The skills trade-session step 0 tells the head trader to load every cycle, by its instructions: the gated three
 * ("Before any decision, load `a`, `b`, and `c`"), "Load `trader-process` too", and each "Load `<skill>` every cycle".
 */
function headTraderLoads(tradeSession) {
  const step0 = tradeSession.slice(tradeSession.indexOf('### 0. Load the skills'), tradeSession.indexOf('### 1.')).replace(/\s+/g, ' ');
  const out = [];
  const gated = /Before any decision, load ([^.]*?) with the skill tool(?: \([^)]*\))?\./.exec(step0);
  if (gated) out.push(...[...gated[1].matchAll(/`([a-z][a-z-]+)`/g)].map(m => m[1]));
  for (const m of step0.matchAll(/Load `([a-z][a-z-]+)` (?:too|every cycle)\b/g)) out.push(m[1]);
  return [...new Set(out)];
}

test('multi-timeframe-analysis split: the head trader loads htf-to-ltf every cycle, so it still reads the alignment rule', () => {
  const ts = read('skills/trade-session/SKILL.md');
  const loads = headTraderLoads(ts);
  for (const s of [...require('../../scripts/lib/trading/skills-loaded').REQUIRED_FOR_COMPOSED, 'trader-process', 'htf-to-ltf', 'confluence-counting']) assert.ok(loads.includes(s), `trade-session step 0 loads ${s}`);
  // Every unit of the old alignment section (the table, the policy ceiling), its reversal paragraph, and the rule that
  // a plan's alignment is the briefing's (never the daily) is in a skill the head trader loads every cycle.
  const old = units(read(BEFORE));
  const loaded = new Set(loads.flatMap(s => units(read(`skills/${s}/SKILL.md`))));
  // An edited unit (an allow-list `now`) is read as its new text.
  const nowOf = u => { const a = ALLOWED.find(x => x.old === u); return a ? [a.now || []].flat() : [u]; };
  for (const i of [35, ...Array.from({ length: 21 }, (_, k) => 63 + k).filter(i => i !== 81)]) for (const u of nowOf(old[i])) assert.ok(loaded.has(u), `the head trader reads: ${u}`);
  // Self-test: the instruction, not the name, counts; step 0 saying never to load it fails.
  const never = ts.replace(/Load `htf-to-ltf` every cycle as\s+well/, 'Never load `htf-to-ltf`');
  assert.notStrictEqual(never, ts);
  assert.ok(!headTraderLoads(never).includes('htf-to-ltf'), '"Never load `htf-to-ltf`" is not a load');
});

test('multi-timeframe-analysis split: the market-structure analyst loads what its body uses; others point to the new homes', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  const { data } = parseFrontmatter(read('agents/market-structure-analyst.md'));
  assert.ok(data['role-skills'].includes('htf-to-ltf'), 'htf-to-ltf is core: its HTF and Location lines, every report');
  assert.ok(data['role-index'].includes('daily-bias'), 'daily-bias is looked up as needed');
  for (const s of ['timeframe-sources', 'mtf-bias-filter']) assert.ok(![...data['role-skills'], ...data['role-index']].includes(s), s);
  assert.match(read('skills/premarket/SKILL.md').replace(/\s+/g, ' '), /see the `timeframe-sources` and `daily-bias` skills/);
  assert.match(read('skills/trade-session/SKILL.md'), /\(`mtf_read` with the bars file, the `timeframe-sources` skill\)/);
  // In setup-judgment since the trade-session split (trade-session-split.test.js).
  assert.match(read('skills/setup-judgment/SKILL.md').replace(/\s+/g, ' '), /the side rule \(`htf-to-ltf`\) and its alignment table/);
  assert.match(read('skills/pullback-vs-reversal/SKILL.md'), /shift or reclaim of `htf-to-ltf`/);
});

test('multi-timeframe-analysis-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});
