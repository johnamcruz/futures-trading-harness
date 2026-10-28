'use strict';

// The harness-tools skill is retired: what it held is in single-responsibility skills, and a role references a piece
// by name instead of embedding it wherever embedding would make its prompt grow (the owner's rule: no role and no
// head-trader cycle grows).
//
//   tool-arguments          how the tools take arguments and paths, what they refuse, `record`; skill_lookup's row
//   bar-briefing            the bar_briefing, bars_fetch, market_snapshot and mtf_read rows; the blackouts_list row (the
//                           briefing's `news`, and the no-briefing fallback it already names)
//   news-blackouts          the blackouts_add row and its example call (the skill that builds the day's blackouts)
//   order-plan, reason-check, prop-challenge-pacing   the order_plan, reason_check and combine_status rows
//   strategy-tools          the five strategies rows and the scan example (strategy-scan and strategy-library are
//                           loaded every head-trader cycle, so the rows would grow it there)
//   user-commands           the user-only scripts and the people's scripts for lessons and reconcile (their
//                           agent-facing rows are dropped: the tools' MCP descriptions and schemas carry them)
//
// These tests prove nothing was lost, doubled or misplaced: every sentence (and every table cell and code line) of the
// skill as main had it (tests/fixtures/skill-split/harness-tools.before.txt, frozen at 0b1a2f79, unchanged since) is
// in the new homes exactly as many times as before, byte-for-byte after whitespace is normalised, each in the home its
// old lines map to. position-sizing step 8 points to order-plan the same way (order-plan.before.txt). The only
// exceptions are listed, each with its reason; an exception that no longer differs fails too, so the lists can only
// shrink. Every role still has the row of every harness tool it holds, or a reasoned reference, and no file but these
// tests' fixture and this test names the retired skill.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { units, count, differences, STRUCTURE } = require('./skill-split');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha = rel => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex');
const skill = s => read(`skills/${s}/SKILL.md`);
const flat = text => text.replace(/\s+/g, ' ');

const BEFORE = 'tests/fixtures/skill-split/harness-tools.before.txt';
const BEFORE_SHA256 = '1eb1759e1253d7b9032966b8c73fe73bccbedc22dbe13d26888a9025c6183576';
const HOMES = ['tool-arguments', 'bar-briefing', 'news-blackouts', 'order-plan', 'reason-check', 'prop-challenge-pacing', 'strategy-tools', 'user-commands'];
// The fixture's lines (1-based, inclusive), and single units, each home other than tool-arguments takes;
// tool-arguments takes every other unit (the intro, the first two When to Use bullets, skill_lookup's row, the rules).
const MOVED = {
  'bar-briefing': { lines: [[29, 29], [36, 38], [43, 43], [93, 94], [96, 96], [110, 110]] },
  // The blackouts_add row and its example call: the skill that builds the day's blackouts (no role holds the tool).
  'news-blackouts': { lines: [[39, 39], [111, 111]] },
  'order-plan': { lines: [[35, 35], [107, 109]] },
  'reason-check': { lines: [[44, 44], [113, 119]] },
  // The combine_status row and its example call (already prop-challenge-pacing's first example line).
  'prop-challenge-pacing': { lines: [[40, 40], [112, 112]] },
  'strategy-tools': { lines: [[30, 34], [97, 106]] },
  // The third When to Use bullet, the user-only scripts, the terminal example, and the lessons and reconcile rows'
  // first and last cells (the people's mirror).
  'user-commands': { lines: [[23, 23], [83, 88], [122, 123]], units: ['`lessons`', '`lessons.js [--top 10] [--json]`', '`reconcile`', '`reconcile.js --day <day> [--timeframe 3] [--json]`'] },
};
const HEADER = ['Tool', 'Arguments', 'What it returns', 'Script (people)'];
// The people's mirror table has two of the four columns.
const HEADER_OF = home => (home === 'user-commands' ? ['Tool', 'Script (people)'] : HEADER);

// The bar_briefing row's description, with the CISD block the briefing has carried since #125 (briefing.js
// cisdBlock and its summary line) named where the old row lists the m3 fields.
const BRIEFING_CELL = units(read(BEFORE)).find(u => u.startsWith('the bar briefing the autonomous runner built'));
// The summary in the order the briefing prints it (briefing.js): the candle lines, the swing targets, then the CISD
// line. The m3 fields in the order briefing.js builds m3: location, candidates, trendRule, cisd, candles, swingTargets.
// A timeframe's briefing points to the runner's `cisd`.
const CISD_FIELD = '`cisd` (the latest CISD per timeframe, 3m, 5m, 15m and 1h, on completed candles: its direction, level, displacement, any key-level sweep before it, and its leg\'s OTE zone with its status and whether price is in it; a read, not a signal), ';
const CISD = [
  ['a line per timeframe for its last completed candle, the next swing targets,', 'a line per timeframe for its last completed candle, the next swing targets, the latest CISD per timeframe,'],
  ['15m and 1h, in points, ticks and R), `candidates`', `15m and 1h, in points, ticks and R), ${CISD_FIELD}\`candidates\``],
  ['with a pointer to the runner\'s `candles` and `swingTargets`', 'with a pointer to the runner\'s `candles`, `swingTargets` and `cisd`'],
];
// The 4h candle and swing targets the briefing carries (candle-facts.js TIMEFRAMES, briefingTargets), named since
// fix/skills-concept-owners.
const FOURH = [
  ['`candles` (per timeframe, 3m, 5m, 15m and 1h,', '`candles` (per timeframe, 3m, 5m, 15m, 1h and 4h,'],
  ['on the base bars, 15m and 1h, in points', 'on the base bars, 15m, 1h and 4h, in points'],
];
/** The m3 fields from `location` to `trendRule` reordered as briefing.js builds them. */
function m3Order(text) {
  const loc = '`location`, ';
  const a = text.indexOf(`${loc}\`candles\` (per timeframe,`);
  const cisd = text.indexOf('`cisd` (the latest CISD', a);
  const cand = text.indexOf('`candidates` (each with', a);
  const tr = text.indexOf('`trendRule`. `m15`', a);
  if ([a, cisd, cand, tr].some(x => x < 0) || !(a < cisd && cisd < cand && cand < tr)) return text;
  const candles = text.slice(a + loc.length, cisd).replace(/, $/, '');
  const cisdSeg = text.slice(cisd, cand).replace(/, $/, '');
  const candidates = text.slice(cand, tr).replace(/, $/, '');
  return `${text.slice(0, a)}${loc}${candidates}, \`trendRule\`, ${cisdSeg}, ${candles}${text.slice(tr + '`trendRule`'.length)}`;
}

// Deliberate differences, each with its reason.
const ALLOWED = [
  ...HEADER.map(old => ({ old, copies: HOMES.filter(h => HEADER_OF(h).includes(old)).length, reason: 'the tool table header, in each home with a table' })),
  { old: 'Harness Tools', reason: 'the retired skill\'s title: each home has its own' },
  // tool-arguments' When to Use lists what it holds (the rules for calling any tool, skill_lookup's row).
  { old: 'Any time a skill or role needs bars in a file, a strategy scan, indicator numbers, the multi-timeframe read, the news blackouts, the prop attempt\'s state, the journal\'s lessons, or a day\'s reconcile.',
    now: 'Calling any harness tool: its arguments, the paths it reads, what it refuses; skill_lookup\'s row.', reason: 'the When to Use of the skill that holds the general rules, not of every tool' },
  // The strategy-authoring split (strategy-backtest has the backtest now).
  { old: 'The one exception is authoring: the `strategy-researcher` role, which the user starts interactively for a new strategy, may run a backtest itself (the `strategy-authoring` skill); no trading role does.',
    now: 'The one exception is authoring: the `strategy-researcher` role, which the user starts interactively for a new strategy, may run a backtest itself (the `strategy-backtest` skill); no trading role does.',
    reason: 'the backtest is the strategy-backtest skill\'s since the strategy-authoring split' },
  // The example call was already prop-challenge-pacing's own first example line: one copy, not two.
  // skill_lookup lists every skill without `skill` (foundation batch B, index-all-skills): its row's three cells.
  { old: '`skill`, `role`?', now: '`skill`?, `role`?, `query`?', reason: 'skill_lookup without skill lists every skill (query filters)' },
  { old: 'a skill of the harness in full: one a role\'s prompt lists in its skill index (its `role-index`), looked up only when the cycle needs it. With `role` (your role\'s name) in an autonomous cycle the lookup is recorded: where the bar\'s briefing makes a skill in your index required (your prompt says when), your report counts for an entry only once you looked it up during one of your calls this cycle. An unknown skill is refused. Read-only',
    now: 'any skill in full (your index lists yours), read only when the cycle needs it. With `role` (your role\'s name), in an autonomous cycle, the lookup is recorded: when your prompt says the bar requires a skill of your index, your report counts for an entry only once you looked it up in one of your calls this cycle. An unknown skill is refused. No `skill`: the list (`query` filters). Read-only',
    reason: 'the listing form, with the old cell shortened so the row (core for four roles) doesn\'t grow their prompts more than needed; any skill, not only the index\'s (a role denied opencode\'s skill tool reads the others with it)' },
  { old: '`bars` and `daily` are bars files by absolute path (no `~`): the runner\'s bars file (the prompt names it, under the bar directory) or a `bars_fetch` file under `<FTH_HOME>/bars-scratch` (use the path `bars_fetch` returns: each harness home, a replay\'s run home included, has its own, and `/tmp/fth` is no longer read).',
    now: '`bars` and `daily` are bars files by absolute path (no `~`): the runner\'s bars file (the prompt names it, under the bar directory) or a `bars_fetch` file under `<FTH_HOME>/bars-scratch` (use the path `bars_fetch` returns: each harness home, a replay\'s run home included, has its own).',
    reason: 'the old shared folder\'s note dropped (the next sentence refuses every other path), so the listing form costs the four roles that hold this skill nothing' },
  { old: '`skill-lookup.js --skill <name> [--role <role>]`', now: '`skill-lookup.js --skill <name> [--role <role>] \\| --query <text>`', reason: 'the CLI\'s listing form' },
  { old: 'combine_status {}', copies: 1, reason: 'already the first line of prop-challenge-pacing\'s Examples' },
  { old: BRIEFING_CELL, now: m3Order(FOURH.reduce((t, [a, b]) => t.replace(a, b), CISD.reduce((t, [a, b]) => t.replace(a, b), BRIEFING_CELL || ''))), reason: 'the briefing\'s `m3` `cisd` (#125), which the old row didn\'t name, the m3 fields in the order briefing.js builds them, and the 4h candle and swing targets' },
  // lessons and reconcile: the agent-facing cells are dropped. The tools' MCP descriptions (registry.js) say what each
  // returns, and their schemas list the arguments; only the reviewer and the head trader hold them, and embedding the
  // rows in trade-review would grow the reviewer. The people's scripts are in user-commands.
  { old: '`top`?, `json`?', reason: 'lessons\' arguments: its MCP schema' },
  { old: 'the instincts the journal\'s reviews add up to', reason: 'what lessons returns: its MCP description' },
  { old: '`day` (YYYY-MM-DD), `timeframe`?, `json`?', reason: 'reconcile\'s arguments: its MCP schema' },
  { old: 'the day\'s signals against what was traded', reason: 'what reconcile returns: its MCP description' },
];

// Edits made to the homes since the split (skill-split-late.js), each with its reason: the coverage test holds each
// home to its edited text, and a late edit that matches nothing fails.
const { withLate } = require('./skill-split-late');
const LATE = [
  { from: "`strategies.js plan <bars> --symbol MNQ --strategy orb --side long [--account-id 7]`",
    to: "`strategies.js plan <bars> --symbol MNQ --strategy <name> --side long [--account-id 7]`",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "orb long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none",
    to: "<name> long | active, 3m, rules, mtf trend | entryRef 21503.25, stop 5.25 pts = 21 ticks ($10.50/MNQ contract), minRR 2, exit: trail from 2R giving back 0.5R | with: none; against: none",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "cisd_ote | paper | 3m | - | no | no rule set fired (long: cisd_entry(15) > 0; short: cisd_entry(15) < 0)",
    to: "<other> | paper | 3m | - | no | no rule set fired",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "strategies_scan {\"bars\": \"/home/u/.futures-trading-harness/bars/MNQ-3m.json\", \"symbol\": \"MNQ\", \"name\": \"orb\"}",
    to: "strategies_scan {\"bars\": \"/home/u/.futures-trading-harness/bars/MNQ-3m.json\", \"symbol\": \"MNQ\", \"name\": \"<name>\"}",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "→ orb's full result as JSON",
    to: "→ its full result as JSON",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "order_plan {\"bars\": \"/home/u/.futures-trading-harness/bars/MNQ-3m.json\", \"symbol\": \"MNQ\", \"strategy\": \"vwap_reclaim\", \"side\": \"long\", \"accountId\": 7}",
    to: "order_plan {\"bars\": \"/home/u/.futures-trading-harness/bars/MNQ-3m.json\", \"symbol\": \"MNQ\", \"strategy\": \"<name>\", \"side\": \"long\", \"accountId\": 7}",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "→ vwap_reclaim long: 1 MNQ at market (entry ref 21503.25) | stop 21498.00, below the entry: 5.25 pts = 21 ticks ($10.50/MNQ contract), stopLossBracket.ticks 21 | target 21513.75 (2R): 42 ticks, takeProfitBracket.ticks 42 | risk $10.50 = 1 x 21 ticks x $0.50/tick (before fees) | size 1: the minimum; no account budget sizes a rules strategy (position-sizing: size 1 until the setup has 30+ reviewed trades)",
    to: "→ <name> long: 1 MNQ at market (entry ref 21503.25) | stop 21498.00, below the entry: 5.25 pts = 21 ticks ($10.50/MNQ contract), stopLossBracket.ticks 21 | target 21513.75 (2R): 42 ticks, takeProfitBracket.ticks 42 | risk $10.50 = 1 x 21 ticks x $0.50/tick (before fees) | size 1: the minimum; no account budget sizes a rules strategy (position-sizing: size 1 until the setup has 30+ reviewed trades)",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "place_order arguments: {\"accountId\":7,\"contractId\":\"MNQ\",\"side\":\"buy\",\"type\":\"market\",\"size\":1,\"stopLossBracket\":{\"ticks\":21,\"type\":\"stop\"},\"takeProfitBracket\":{\"ticks\":42,\"type\":\"limit\"},\"rationale\":\"setup:vwap_reclaim long at market from 21503.25 (the signal bar's close), stop 21498.00 (21 ticks), target 21513.75 (42 ticks), 1 MNQ risks $10.50\"}",
    to: "place_order arguments: {\"accountId\":7,\"contractId\":\"MNQ\",\"side\":\"buy\",\"type\":\"market\",\"size\":1,\"stopLossBracket\":{\"ticks\":21,\"type\":\"stop\"},\"takeProfitBracket\":{\"ticks\":42,\"type\":\"limit\"},\"rationale\":\"setup:<name> long at market from 21503.25 (the signal bar's close), stop 21498.00 (21 ticks), target 21513.75 (42 ticks), 1 MNQ risks $10.50\"}",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "- orb short: 1 hard stops pass (no hard stop); 2 trend rule pass (the trend rule allows a short); 3 room no-trade (VWAP (rth) at 0.4R before the 2R it needs); ...",
    to: "- <name> short: 1 hard stops pass (no hard stop); 2 trend rule pass (the trend rule allows a short); 3 room no-trade (VWAP (rth) at 0.4R before the 2R it needs); ...",
    reason: "every rules strategy is retired (strategies/retired.json): the tool examples name a placeholder <name>, not a retired strategy (fix/skills-stale-examples)" },
  { from: "`symbol` (a root, or a contract by month), `json`?", to: "`symbol` (a root, or a contract by month), `timeframe`?, `json`?",
    reason: "fix/skills-match-code: bar_briefing's timeframe argument (the registry's); the briefing's setups are the rules setups (none active) and the setups to check; order_plan plans a compose record first" },
  { from: "the bar briefing the autonomous runner built for the bar this cycle decides, opening with a plain-language summary (price and 1R, trend rule, alignment, regime, VWAP, news, the room above and below, a line per timeframe for its last completed candle, the next swing targets, the latest CISD per timeframe, each setup with its facts), times in ET, distances in points and R (1R is a setup's own stop, else the reference stop, 0.5 x ATR(20) of the briefing's own bars, named by its timeframe: `oneR`). `m3`, every bar: price, the bar (OHLC, range in ATR), ET time and the session window with its scope (`windowText`: market open or closed, entries allowed or not, until when; also `windowEntries`, `windowRefusal`, `marketOpen`; from the gate's own clock config), the next news blackout (`news`), regime (tags, metrics), EMA9/20/50/200, ADX, SuperTrend, Keltner, ATR(14), VWAP (which applies, side, distance, crosses), participation, the skip-rule counters (`context`), `referenceStop`, swings and liquidity (equal highs and lows marked taken or not), `lastBreak` (BOS or CHoCH with its age), `sweeps` (key levels first; only levels that existed before), `htfLevels` (the 15m and 1h swings against price, and the last one a 3m close broke), `untested1hSwings`, `nearestLiquidity` (the three nearest levels each side; `at`, the round number price sits on, only when it sits on one; `roundNumbers`, why there are none, only when the family's configured step was refused), today so far, the overnight range, the session profile and its nodes, `location`, `candidates` (each with its stop, exit, the first level in its way in R, the room it needs, and its context as `facts`: the trend rule and the multi-timeframe read for its side, room, confluence, VWAP side, window; `null`: the scan failed or the bar wasn't scanned; `blocked` in a no-entry window (named, with its end), a news blackout, or with the news unknown), `trendRule`, `cisd` (the latest CISD per timeframe, 3m, 5m, 15m and 1h, on completed candles: its direction, level, displacement, any key-level sweep before it, and its leg's OTE zone with its status and whether price is in it; a read, not a signal), `candles` (per timeframe, 3m, 5m, 15m, 1h and 4h, the last COMPLETED candle, never the one forming: OHLCV, its close time, body and wick shares, close third, range in that timeframe's ATR, volume against its average, a pattern label (doji, hammer, shooting star, bullish or bearish engulfing, inside, outside, displacement, or none), and the key levels it met as `rejected` (traded through, closed back), `broke` (closed beyond, most of the body beyond) or `touched`, a fixed level as it stood when the candle opened (never one its own bars made, nor one formed later), a moving one (VWAP, the session profile) at its close, plus the round numbers in its range (on its family's step; none without one), its previous candle and the CRT range, at most four, strongest first (`moreLevels`: the rest); a timeframe that isn't whole base bars, 5m from 3m bars, is built from a 1m lane's bars when one runs (the candle ending at this close only once its last 1m bar is in), else `unavailable` with the reason (left out of the summary when no 1m lane runs), never approximated), `swingTargets` (the next swing high above and low below on the base bars, 15m, 1h and 4h, in points, ticks and R). `m15`, until the next 15m close: `frame` (trend, bias, close, EMA20/50, swing pattern, ADX, ATR, and the last 20 candles' range with its mid), `alignment`, `lastBreak` (times are candle opens; `knownAt` is the breaking candle's close), `indicators` (EMA9/20, regime, ADX, SuperTrend, Keltner). `h1`, until the next 1h close: the 1h and 4h frames, `lastBreak`. `day`, until the first bar after 16:00 ET: the prior RTH day and its profile. Each part has a version and changes only on expiry. Reuse it; don't recompute what it holds. When it answers that there is no current briefing, or that it is old, read the bars yourself. With `timeframe` (`\"15m\"`, `\"1h\"`; only when the caller gave you one: the runner config puts some analysts on their own timeframe): that timeframe's briefing, `bar` (the `m3` facts on its own bars, valid until its next bar close, with a pointer to the runner's `candles`, `swingTargets` and `cisd` (the session's levels, one value each), the last bar before the 16:00 ET break until the first bar after the open; 1R and ATR named by its timeframe; no trend rule: the gate's current one is the runner's briefing's; no session facts (today, overnight, VWAP, session profile, `location`: `sessionLevels` points to the runner's briefing, their one value), so its levels and room are its own bars' (a lane's, whose setups are traded, add the runner's session levels, its values); setups only when a lane trades those bars, else in the runner's briefing) and the runner's parts that change no faster (`m15` up to 15m, `h1` up to 1h, `day`); its bars file is named in it. Your report on it may be reused until that close, so it may be up to one of its bars old", to: "the bar briefing the autonomous runner built for the bar this cycle decides, opening with a plain-language summary (price and 1R, trend rule, alignment, regime, VWAP, news, the room above and below, a line per timeframe for its last completed candle, the next swing targets, the latest CISD per timeframe, the rules setups, the setups to check), times in ET, distances in points and R (1R is a setup's own stop, else the reference stop, 0.5 x ATR(20) of the briefing's own bars, named by its timeframe: `oneR`). `m3`, every bar: price, the bar (OHLC, range in ATR), ET time and the session window with its scope (`windowText`: market open or closed, entries allowed or not, until when; also `windowEntries`, `windowRefusal`, `marketOpen`; from the gate's own clock config), the next news blackout (`news`), regime (tags, metrics), EMA9/20/50/200, ADX, SuperTrend, Keltner, ATR(14), VWAP (which applies, side, distance, crosses), participation, the skip-rule counters (`context`), `referenceStop`, swings and liquidity (equal highs and lows marked taken or not), `lastBreak` (BOS or CHoCH with its age), `sweeps` (key levels first; only levels that existed before), `htfLevels` (the 15m and 1h swings against price, and the last one a 3m close broke), `untested1hSwings`, `nearestLiquidity` (the three nearest levels each side; `at`, the round number price sits on, only when it sits on one; `roundNumbers`, why there are none, only when the family's configured step was refused), today so far, the overnight range, the session profile and its nodes, `location`, `candidates` (a rules strategy's setups, none active: each with its stop, exit, room and `facts`; `null`: not scanned; `blocked`: a no-entry window, a news blackout or the news unknown), `trendRule`, `cisd` (the latest CISD per timeframe, 3m, 5m, 15m and 1h, on completed candles: its direction, level, displacement, any key-level sweep before it, and its leg's OTE zone with its status and whether price is in it; a read, not a signal), `candles` (per timeframe, 3m, 5m, 15m, 1h and 4h, the last COMPLETED candle, never the one forming: OHLCV, its close time, body and wick shares, close third, range in that timeframe's ATR, volume against its average, a pattern label (doji, hammer, shooting star, bullish or bearish engulfing, inside, outside, displacement, or none), and the key levels it met as `rejected` (traded through, closed back), `broke` (closed beyond, most of the body beyond) or `touched`, a fixed level as it stood when the candle opened (never one its own bars made, nor one formed later), a moving one (VWAP, the session profile) at its close, plus the round numbers in its range (on its family's step; none without one), its previous candle and the CRT range, at most four, strongest first (`moreLevels`: the rest); a timeframe that isn't whole base bars, 5m from 3m bars, is built from a 1m lane's bars when one runs (the candle ending at this close only once its last 1m bar is in), else `unavailable` with the reason (left out of the summary when no 1m lane runs), never approximated), `swingTargets` (the next swing high above and low below on the base bars, 15m, 1h and 4h, in points, ticks and R). `m15`, until the next 15m close: `frame` (trend, bias, close, EMA20/50, swing pattern, ADX, ATR, and the last 20 candles' range with its mid), `alignment`, `lastBreak` (times are candle opens; `knownAt` is the breaking candle's close), `indicators` (EMA9/20, regime, ADX, SuperTrend, Keltner). `h1`, until the next 1h close: the 1h and 4h frames, `lastBreak`. `day`, until the first bar after 16:00 ET: the prior RTH day and its profile. Each part has a version and changes only on expiry. Reuse it; don't recompute what it holds. When it answers that there is no current briefing, or that it is old, read the bars yourself. With `timeframe` (`\"15m\"`, `\"1h\"`; only when the caller gave you one: the runner config puts some analysts on their own timeframe): that timeframe's briefing, `bar` (the `m3` facts on its own bars, valid until its next bar close, with a pointer to the runner's `candles`, `swingTargets` and `cisd` (the session's levels, one value each), the last bar before the 16:00 ET break until the first bar after the open; 1R and ATR named by its timeframe; no trend rule: the gate's current one is the runner's briefing's; no session facts (today, overnight, VWAP, session profile, `location`: `sessionLevels` points to the runner's briefing, their one value), so its levels and room are its own bars' (a lane's, whose setups are traded, add the runner's session levels, its values); setups only when a lane trades those bars, else in the runner's briefing) and the runner's parts that change no faster (`m15` up to 15m, `h1` up to 1h, `day`); its bars file is named in it. Your report on it may be reused until that close, so it may be up to one of its bars old",
    reason: "fix/skills-match-code: bar_briefing's timeframe argument (the registry's); the briefing's setups are the rules setups (none active) and the setups to check; order_plan plans a compose record first" },
  { from: "- <name> short: 1 hard stops pass (no hard stop); 2 trend rule pass (the trend rule allows a short); 3 room no-trade (VWAP (rth) at 0.4R before the 2R it needs); ...",
    to: "- <name> short: 1 hard stops pass (no hard stop); 2 trend rule pass (the trend rule allows a short); 3 room judgment (VWAP (rth) at 0.4R ahead, it aims for 2R: a read, never a no trade alone); ...",
    reason: "fix/confluence-not-vetoes: reason_check's step 3 is a read (judgment), never a no trade: the room selected nothing in a census of 27,698 moments" },
];
const LATE_STALE = (() => {
  const r = withLate(ALLOWED, LATE, units(require('fs').readFileSync(require('path').join(__dirname, '..', '..', BEFORE), 'utf8')));
  ALLOWED.splice(0, ALLOWED.length, ...r.allowed);
  return r.stale.map(l => l.from);
})();
const DROPPED = new Set(ALLOWED.filter(a => !a.copies && !a.now).map(a => a.old));

/** The old units each home must hold: Map home -> Map unit -> count (tool-arguments takes every unit not moved). */
function expectedHomes(beforeText) {
  const lines = beforeText.split('\n');
  let fence = false;
  const fenced = lines.map(l => { if (/^```/.test(l)) { fence = !fence; return false; } return fence; });
  const skip = u => STRUCTURE.includes(u) || HEADER.includes(u) || DROPPED.has(u);
  const rest = count(units(beforeText).filter(u => !skip(u)));
  const out = new Map();
  for (const [home, m] of Object.entries(MOVED)) {
    // A range inside the Examples block is code: fence it, so its lines are code lines, as in the old skill.
    const text = ([a, b]) => { const t = lines.slice(a - 1, b).join('\n'); return fenced[a - 1] ? `\`\`\`\n${t}\n\`\`\`` : t; };
    const want = count([...units((m.lines || []).map(text).join('\n\n')), ...(m.units || [])].filter(u => !skip(u)));
    for (const [u, n] of want) {
      if ((rest.get(u) || 0) < n) throw new Error(`${home}: "${u}" is not in the old skill ${n} time(s)`);
      rest.set(u, rest.get(u) - n);
    }
    out.set(home, want);
  }
  out.set('tool-arguments', new Map([...rest].filter(([, n]) => n > 0)));
  return out;
}

/** Old units in a home their old lines don't map to (or missing from the one they do): [] when each is home. */
function homeErrors(beforeText, homeTexts) {
  const expected = expectedHomes(beforeText);
  const old = new Set(units(beforeText));
  const asOld = new Map(ALLOWED.filter(a => a.now).map(a => [a.now, a.old]));
  const bad = [];
  HOMES.forEach((home, i) => {
    const got = count(units(homeTexts[i]).map(u => asOld.get(u) || u).filter(u => old.has(u) && !STRUCTURE.includes(u) && !HEADER.includes(u)));
    const want = expected.get(home);
    for (const u of new Set([...got.keys(), ...want.keys()])) {
      if ((got.get(u) || 0) !== (want.get(u) || 0)) bad.push(`${home}: ${JSON.stringify(u.slice(0, 80))} ${got.get(u) || 0} time(s), its old lines map ${want.get(u) || 0} here`);
    }
    const cells = count(units(homeTexts[i]));
    for (const h of HEADER) if ((cells.get(h) || 0) !== (HEADER_OF(home).includes(h) ? 1 : 0)) bad.push(`${home}: the table header's "${h}" ${cells.get(h) || 0} time(s)`);
  });
  return bad;
}

// position-sizing step 8 as main had it (at 0b1a2f79): what order_plan shows is order-plan's now; step 8 points to it.
const OP_BEFORE = 'tests/fixtures/skill-split/order-plan.before.txt';
const OP_BEFORE_SHA256 = '6d319c1504ba47d0c7bcae2931a69f48f720225000dacb946959aed075244594';
const OP_HOMES = ['position-sizing', 'order-plan'];
const OP_ALLOWED = [
  { old: '**The arithmetic from `order_plan`.** For a scan candidate (or a policy verdict), the harness tool `order_plan` does steps 2 and 4\'s arithmetic for the strategy and side you chose and shows it: the stop in points and whole ticks, the risk per contract, the size and where it came from (1 for a rules strategy, the size-1 rule; the verdict\'s, within the attempt\'s budget, for a policy strategy), and the dollar risk.',
    now: "**The arithmetic from `order_plan`** (the `order-plan` skill): steps 2 and 4 for a compose record (refused over its cap), a policy verdict or a rules candidate; use its numbers, never your own.",
    reason: 'what it shows is the order_plan row (stop and target in points and whole ticks, how the size was derived, $ risk) plus order-plan\'s "Its working includes the risk per contract."; a composed trade\'s numbers are its compose record\'s (the skill audit, X2); then fix/skills-match-code: step 8 shorter, the compose record first (no rules strategy is active)' },
  { old: 'Use its numbers instead of computing them by hand.', copies: 0,
    reason: 'fix/skills-match-code: merged into step 8\'s first sentence (use its numbers, never your own)' },
  { old: 'The budget (step 3) and the caps are still your judgement: a budget below its risk is a skip, and a size you are allowed to raise (30+ reviewed trades) changes only `size`, with the risk scaling by it.', now: "The budget (step 3) and the caps stay your judgement: a budget below its risk is a skip; a raised size (a rules setup with 30+ reviewed trades) changes only `size`, the risk scaling with it.",
    reason: 'fix/skills-match-code: the same judgement, a raised size only a rules setup\'s' },
];

test('harness-tools retired: every unit of the old skill is in exactly one new home, the one its old lines map to, byte-for-byte', () => {
  assert.strictEqual(sha(BEFORE), BEFORE_SHA256, 'the fixture is the old skill, unchanged');
  assert.ok(BRIEFING_CELL, 'the old bar_briefing row');
  const homes = HOMES.map(skill);
  assert.deepStrictEqual(differences(read(BEFORE), homes, ALLOWED), []);
  assert.deepStrictEqual(homeErrors(read(BEFORE), homes), [], 'each unit is in the home its old lines map to');
  for (const a of ALLOWED) assert.ok(a.reason, a.old);
  assert.ok(!fs.existsSync(path.join(ROOT, 'skills', 'harness-tools')), 'the skill is gone');
  // The dropped lessons and reconcile cells: the tools' own descriptions and schemas carry them.
  const { BY_NAME } = require('../../scripts/lib/harness-tools/registry');
  assert.deepStrictEqual(Object.keys(BY_NAME.get('lessons').inputSchema.properties).sort(), ['json', 'top']);
  assert.deepStrictEqual(Object.keys(BY_NAME.get('reconcile').inputSchema.properties).sort(), ['day', 'json', 'timeframe']);
  assert.match(BY_NAME.get('lessons').description, /instincts/);
  assert.match(BY_NAME.get('reconcile').description, /signals .* traded/);
});

test('order-plan: position-sizing step 8 points to it for what order_plan shows; order-plan holds the read rules', () => {
  assert.strictEqual(sha(OP_BEFORE), OP_BEFORE_SHA256, 'the fixture is main\'s step 8, unchanged');
  assert.deepStrictEqual(differences(read(OP_BEFORE), OP_HOMES.map(skill), OP_ALLOWED, { structure: false }), []);
  for (const a of OP_ALLOWED) assert.ok(a.reason, a.old);
  const op = flat(skill('order-plan'));
  for (const s of ['Its working includes the risk per contract.', 'Never supply tick numbers of your own.', 'Round a stop away from the entry and a target toward it; bracket ticks = `ceil(distance / tickSize)`']) assert.ok(op.includes(s), s);
});

test('harness-tools retired: the comparison catches a lost, a doubled, an edited or a misplaced unit, and a stale exception', () => {
  const old = read(BEFORE);
  assert.ok(units(old).length > 100, 'the units are fine-grained');
  const homes = HOMES.map(skill);
  const at = name => HOMES.indexOf(name);
  const swap = (...pairs) => homes.map((h, i) => { const p = pairs.find(([n]) => at(n) === i); return p ? p[1] : h; });
  const bb = homes[at('bar-briefing')];
  const ROW = /^\| `market_snapshot` \|.*\n/m;
  const row = ROW.exec(bb)[0];
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', bb.replace(ROW, '')]), ALLOWED), [], 'lost');
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', `${bb}\n${row}`]), ALLOWED), [], 'doubled');
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', bb.replace('Reuse it; don\'t recompute what it holds.', 'Reuse it.')]), ALLOWED), [], 'edited');
  // Misplaced: the market_snapshot row moved from bar-briefing to order-plan: nothing is lost or doubled, but it left
  // its home.
  const op = homes[at('order-plan')];
  const moved = swap(['bar-briefing', bb.replace(ROW, '')], ['order-plan', op.replace(/^(\| `order_plan` \|.*\n)/m, `$1${row}`)]);
  assert.deepStrictEqual(differences(old, moved, ALLOWED), [], 'a cross-home move loses nothing');
  assert.notDeepStrictEqual(homeErrors(old, moved), [], 'but leaves its home');
  // A rule moved out of tool-arguments into user-commands (nobody loads it) is caught too.
  const ta = homes[at('tool-arguments')];
  const RULE = /^- An unknown argument is refused, with the arguments the tool takes\.\n/m;
  const rule = RULE.exec(ta)[0];
  assert.notDeepStrictEqual(homeErrors(old, swap(['tool-arguments', ta.replace(RULE, '')], ['user-commands', `${homes[at('user-commands')]}\n${rule}`])), [], 'rule moved to user-commands');
  // A stale exception: the example dropped from prop-challenge-pacing too; a dropped cell put back.
  const pp = homes[at('prop-challenge-pacing')];
  assert.notDeepStrictEqual(differences(old, swap(['prop-challenge-pacing', pp.replace('combine_status {}\n', '')]), ALLOWED), [], 'stale');
  assert.notDeepStrictEqual(differences(old, swap(['user-commands', homes[at('user-commands')].replace('| `lessons` | `lessons.js', '| `lessons` | `top`?, `json`? | `lessons.js')]), ALLOWED), [], 'a dropped cell back');
  // The CISD exception reverted (the old row back) fails too.
  assert.notDeepStrictEqual(differences(old, swap(['bar-briefing', bb.replace(ALLOWED.find(a => a.old === BRIEFING_CELL).now, BRIEFING_CELL)]), ALLOWED), [], 'cisd reverted');
});

const { TOOLS } = require('../../scripts/lib/harness-tools/registry');
const SKILLS = fs.readdirSync(path.join(ROOT, 'skills')).filter(s => fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')));
const rowOf = (text, tool) => text.split('\n').find(l => l.startsWith(`| \`${tool}\` |`));
const homeOf = tool => SKILLS.filter(s => rowOf(skill(s), tool));
// Each tool's row: its single home.
const ROW_HOME = {
  bar_briefing: 'bar-briefing', bars_fetch: 'bar-briefing', market_snapshot: 'bar-briefing', mtf_read: 'bar-briefing',
  blackouts_list: 'bar-briefing', blackouts_add: 'news-blackouts', order_plan: 'order-plan', reason_check: 'reason-check',
  combine_status: 'prop-challenge-pacing', strategies_list: 'strategy-tools', strategies_show: 'strategy-tools',
  strategies_validate: 'strategy-tools', strategies_scan: 'strategy-tools', strategies_recent: 'strategy-tools',
  skill_lookup: 'tool-arguments', lessons: 'user-commands', reconcile: 'user-commands', compose_check: 'trade-lifecycle', experience_lookup: 'trade-lifecycle',
};


test('every harness tool has its row in exactly one skill, its home', () => {
  assert.deepStrictEqual(Object.keys(ROW_HOME).sort(), TOOLS.map(t => t.name).sort(), 'every tool has a home');
  for (const t of TOOLS) assert.deepStrictEqual(homeOf(t.name), [ROW_HOME[t.name]], `${t.name}: its row's skill`);
});

test('every role has the row of every harness tool it holds in its core, or a reasoned reference', () => {
  // Reasoned exceptions: a tool whose row is in a skill the role doesn't embed (no role grows; the role references the
  // skill instead, and the tool's MCP schema carries its arguments).
  const REFERENCED = {
    // The risk manager calls order_plan; its arguments are in the tool's schema and its use is in its step 5, which
    // references the order-plan skill and states the two read rules it acts on.
    // lessons: the runner reads it for phase 1 every cycle (cycle-data.js deskReads, no arguments), as step 4 names
    // it, so the lessons it shows are the run's own with their record, never the raw journal; embedding its row's
    // skill (user-commands) would grow the prompt.
    'risk-manager': ['order_plan', 'lessons'],
    // Neither ever loaded harness-tools, so neither had these rows on main; embedding them would grow its prompt.
    'trade-reviewer': ['bars_fetch', 'lessons', 'reconcile'],
    'strategy-researcher': ['strategies_validate', 'strategies_list', 'strategies_show'],
    // It holds skill_lookup only to read a skill its embedded skills name (gate-refusals-limits, ...), so opencode's
    // listing of every skill is out of its prompt; its prompt says so and the tool's schema carries the arguments.
    // Embedding tool-arguments would grow it.
    'trade-executor': ['skill_lookup'],
  };
  const HAD_HARNESS_TOOLS = ['market-structure-analyst', 'risk-manager', 'trend-momentum-analyst', 'volume-liquidity-analyst'];
  for (const a of require('../../scripts/lib/role-skills').loadRoles(ROOT)) {
    const held = a.tools.filter(t => t.startsWith('mcp__harness__')).map(t => t.slice('mcp__harness__'.length));
    for (const tool of held) {
      // The core (role-skills): in index mode a role-index skill isn't in the prompt.
      const loaded = homeOf(tool).some(s => a.skills.includes(s));
      if ((REFERENCED[a.name] || []).includes(tool)) {
        assert.ok(!loaded, `${a.name}: ${tool}'s row is embedded now; drop the exception`);
        continue;
      }
      assert.ok(loaded, `${a.name}: holds ${tool} but embeds no skill with its row (${homeOf(tool)})`);
    }
    // The roles that embedded harness-tools now embed its rules and the briefing's rows.
    if (HAD_HARNESS_TOOLS.includes(a.name)) assert.ok(a.skills.includes('tool-arguments') && a.skills.includes('bar-briefing'), `${a.name}: tool-arguments and bar-briefing are core`);
    // Every role holding skill_lookup reaches its row.
    if (held.includes('skill_lookup') && !(REFERENCED[a.name] || []).includes('skill_lookup')) assert.ok(a.skills.includes('tool-arguments'), `${a.name}: skill_lookup's row`);
  }
  const rm = flat(read('agents/risk-manager.md'));
  assert.match(rm, /Approve the plan's numbers as order_plan shows them; never supply tick numbers of your own\. Its refusal \(not a candidate now, the other side, a verdict the gate would refuse\) is a VETO; a tick-spec refusal: `get_contract`, then call it again \(the `order-plan` skill\)\./);
  assert.doesNotMatch(read('agents/risk-manager.md'), /^role-skills: \[[^\]]*\border-plan\b/m);
  assert.match(flat(skill('bar-briefing')), /Without one, the news blackouts are `blackouts_list`\./);
  // The scan's tool calls in strategy-scan reference the rows' skill.
  assert.match(skill('strategy-scan'), /With the harness tools \(`strategy-tools`\):/);
});

test('the new skills answer one question in a short index line; the topic skills reference bar-briefing for the briefing', () => {
  const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
  for (const s of ['tool-arguments', 'bar-briefing', 'order-plan', 'reason-check', 'strategy-tools', 'user-commands']) {
    const d = parseFrontmatter(skill(s)).data.description;
    assert.ok(d.length <= 80, `${s}: description ${d.length} chars, over 80 (each is a line of the head trader's catalog)`);
  }
  assert.match(skill('vwap-volume-profile'), /In an autonomous cycle the bar briefing \(`bar_briefing`, the\s+`bar-briefing`\s+skill\)/);
  // liquidity-concepts and market-structure are retired (tests/plugin/skill-retire.test.js); trend-momentum-indicators
  // starts from the briefing's fields, and market-snapshot is the fallback without a briefing.
  assert.match(skill('trend-momentum-indicators'), /The bar briefing holds these values \(`m3` `trend`, `context`, `regime`;\s+`m15` `indicators`\); without one, `market-snapshot`\./);
  assert.match(skill('market-snapshot'), /The bar briefing says there is no current briefing, or that it is old\./);
  // The multi-timeframe read's briefing fields: timeframe-sources (split from multi-timeframe-analysis) points there.
  assert.match(skill('timeframe-sources'), /The briefing's fields per timeframe and the `mtf_read` calls: the `bar-briefing`/);
});

test('no file names the retired harness-tools skill (the code module scripts/lib/harness-tools/ and its tests keep their name)', () => {
  // Frozen whole: the skill-split fixtures (old skills as main had them, pinned by sha256), a recorded transcript of an
  // old run, and this test. In the other splits' tests only their allow-list lines that quote the old text
  // (`old: '...'`) may name it.
  const FROZEN = f => /^tests\/fixtures\/skill-split\/[a-z-]+\.before\.txt$/.test(f) || ['tests/fixtures/qwen-cycle-transcript.txt', 'tests/plugin/harness-tools-split.test.js'].includes(f);
  const QUOTES_OLD = ['tests/plugin/broker-mcp-split.test.js', 'tests/plugin/strategy-library-split.test.js', 'tests/plugin/autonomous-trading-split.test.js'];
  // Every file in the tree (tracked or new), but not dependencies or the repository database, nor a symlinked directory.
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel); else if (e.isFile()) files.push(rel);
    }
  };
  walk('.');
  const bad = files.filter(f => !FROZEN(f) && /\.(md|js|json|toml|txt|sh|ya?ml)$/.test(f))
    .flatMap(f => skillRefs(f, fs.readFileSync(path.join(ROOT, f), 'utf8'), QUOTES_OLD.includes(f)));
  assert.deepStrictEqual(bad, []);
  // The check catches what it is for: any case, a space or a hyphen, backticked or bare, in a list, a title; in a file
  // whose allow-list may quote it, a line that isn't an allow-list quote.
  for (const s of ['the `harness-tools` skill', 'skills/harness-tools/SKILL.md', 'role-skills: [a, harness-tools, b]', 'the harness-tools skill',
    'the Harness-Tools skill', 'the harness tools skill', 'the `Harness Tools` skill', '(harness-tools)', 'load harness-tools first', 'load harness-tools.', '# Harness Tools',
    'see [it](../harness-tools/SKILL.md)', 'harness-tools/SKILL.md', 'the harness\ntools skill', 'the `harness_tools` skill', 'the harness\u2011tools skill',
    'the harness-tools operations skill', 'the harness-tools server skill', 'the harness-tools MCP server skill']) {
    assert.notDeepStrictEqual(skillRefs('x.md', s), [], s);
  }
  assert.notDeepStrictEqual(skillRefs(QUOTES_OLD[0], 'see the harness-tools skill', true), [], 'a new line in a file that quotes the old text');
  assert.deepStrictEqual(skillRefs(QUOTES_OLD[0], "  { old: 'then `mtf_read` (the `harness-tools` skill).',", true), [], 'its allow-list quote');
  assert.notDeepStrictEqual(skillRefs(QUOTES_OLD[0], "  { old: 'x', reason: 'see the harness-tools skill' },", true), [], 'text after the quoted old value');
  // The code module keeps its name; prose about the harness's tools is no reference to the skill.
  for (const s of ['scripts/lib/harness-tools/registry.js', 'harness-tools-mcp.js', 'tests/lib/harness-tools-order-plan.test.js', 'tests/plugin/harness-tools-split.test.js', 'tests/lib/harness-tools.test.js',
    'the harness-tools MCP server', 'the harness-tools server', 'the harness-tools operations', "require('./harness-tools/registry')", '(harness-tools/reasons.js)', 'const { TOOLS: HARNESS_TOOLS }', "path.join(ROOT, 'scripts', 'lib', 'harness-tools', script)", 'scripts/lib/harness-tools/', 'With the harness tools (`strategy-tools`):', 'the harness tools server']) {
    assert.deepStrictEqual(skillRefs('x.md', s), [], s);
  }
});

/**
 * Where a file names the retired skill: any case; a space, a hyphen (U+2010-U+2014 too) or an underscore between the
 * words; across a line break. The hyphenated name is the skill's unless it is the code module's (`lib/harness-tools`,
 * `'lib', 'harness-tools'`, `harness-tools-mcp`, `harness-tools[-<x>].test`, or "the harness-tools MCP server",
 * "server" or "operations", unless "skill" follows, or a module file, `harness-tools/<file>`); so a link to its
 * SKILL.md or a relative path to its folder (`../harness-tools/`) is the skill's. `HARNESS_TOOLS`, a constant, is not. The spaced one ("the harness tools") is plain prose unless it is backticked, in a skills path, called a
 * skill, or a title. In a file whose allow-list quotes the old text, only the quoted `old` values are skipped.
 */
function skillRefs(rel, text, quotesOld = false) {
  let src = text.replace(/[\u2010-\u2014]/g, '-').replace(/harness_tools|Harness_Tools/g, 'harness-tools');
  if (quotesOld) src = src.replace(/(\bold: )'(?:[^'\\\n]|\\.)*'/g, "$1''");
  const titles = src.split('\n').filter(l => /^#+\s*harness[\s-]tools\s*$/i.test(l));
  const flat = src.replace(/\s+/g, ' ');
  const MODULE_NEXT = String.raw`\s+(?:MCP\s+server|MCP|server|operations)\b(?!(?:\s+(?:MCP|server|operations))*\s+skills?\b)`;
  const HYPHEN = new RegExp(String.raw`(?<!lib\/|'lib', ')harness-tools(?![\w.-]|\/(?!SKILL\.md)[\w-]+|${MODULE_NEXT})|harness-tools(?=[-.])(?!-mcp\b|-[a-z-]+\.test\b|\.test\b)`, 'gi');
  const SPACED = /`harness[\s-]tools`|skills\/harness[\s-]tools\b|harness[\s-]tools`?\s+skill/gi;
  const out = titles.map(l => `${rel}: ${l.trim()}`);
  for (const re of [HYPHEN, SPACED]) for (const m of flat.matchAll(re)) out.push(`${rel}: …${flat.slice(Math.max(0, m.index - 40), m.index + 60)}…`);
  return out;
}

// trade-session step 4 as main had it (at 0b1a2f79): the head trader's own procedure, read every cycle, stays as it
// was, byte for byte (order-plan is referenced from the risk manager's step 5, not added to the head trader's reading).
// One edit since, same length: the structure role's report is "(market structure)", not the retired skill's name
// (tests/plugin/skill-retire.test.js).
const STEP4 = 'tests/fixtures/skill-split/trade-session-step4.before.txt';
const STEP4_SHA256 = '392cb9fcf88ec97ef5a747e08c6770c01db8029d363671f01ce4eb968b4749b7';

// Step 4 is the trade-plan skill's body now (the trade-session split, tests/plugin/trade-session-split.test.js): its How It
// Works is the fixture without its heading, byte for byte; trade-session keeps the heading and a pointer.
test('trade-session step 4 is main\'s, byte for byte (in trade-plan); the head trader\'s load list is unchanged', () => {
  assert.strictEqual(sha(STEP4), STEP4_SHA256, 'the fixture is main\'s step 4, unchanged');
  const tp = skill('trade-plan');
  const body = tp.slice(tp.indexOf('## How It Works\n\n') + '## How It Works\n\n'.length, tp.indexOf('## Examples'));
  // Byte for byte, after the edits made since, each with its reason (trade-plan-edits.js): no other change.
  assert.strictEqual(`### 4. Plan\n\n${body}`, require('./trade-plan-edits').edited(read(STEP4)), 'step 4 byte-equal to main, with its listed edits');
  assert.match(skill('trade-session'), /### 4\. Plan\n\nThe `trade-plan` skill/);
  // order-plan is referenced, not loaded every cycle: not in the gate's list, nor in the prompt's.
  const { REQUIRED_FOR_ENTRY } = require('../../scripts/lib/trading/skills-loaded');
  assert.ok(!REQUIRED_FOR_ENTRY.includes('order-plan'));
  const { prompts, validateConfig } = require('../../scripts/lib/autotrader');
  const prompt = prompts(validateConfig({}), new Date('2026-10-07T14:30:00Z')).trade([{ symbol: 'MNQ', bar: { t: '2026-10-07T14:27:00Z', c: 1, file: '/b.json', contractId: 'MNQ' } }]);
  assert.doesNotMatch(prompt, /order-plan/);
});

test('harness-tools-split: every late edit matches a unit of the homes', () => {
  assert.deepStrictEqual(LATE_STALE, []);
});
