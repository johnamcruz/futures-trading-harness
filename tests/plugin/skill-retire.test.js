'use strict';

// Two skills retired and one shrunk: liquidity-concepts (fair value gaps to the new fair-value-gaps skill; equal highs
// and lows, resting liquidity and targets to levels-and-reactions), market-structure (premium and discount to
// pullback-vs-reversal; its swings and breaks were already bos-vs-choch's) and market-snapshot (now the fallback for
// computing without a bar briefing; its field glossary to the topic skills). This test proves nothing was lost or
// doubled: every unit (a sentence, a table cell, a code line) of each skill as main had it (frozen below, with its
// sha256) is in the skills now exactly as many times as before, byte-for-byte after whitespace is normalised, or is
// listed below with the text that now carries it (each a fragment of one file) and the reason. And no role loses
// knowledge in full mode: every role that loaded an old skill loads each skill its content went to, where the content
// is about fields its own body reads.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = t => t.replace(/\s+/g, ' ');

// The skills as main had them before this change (skills/<name>/SKILL.md at foundation batch B's merge of main 507adfbd), pinned.
const BEFORE = {
  'liquidity-concepts': '811bf8fe6f33c3f1ed8f41ffdc4b49773b2df606e22a673b3dc0cdaf82310503',
  'market-structure': '9d401380893fb5ef0b290452c1ae00ebee71ac229077ac6a189ab372e4d8a28f',
  'market-snapshot': 'e0caf689266b87fcebc8faf5f67ff702cc3a6917ff2097aa25b50b7f9239f243',
};
const fixture = name => `tests/fixtures/skill-split/${name}.before.txt`;
const RETIRED = ['liquidity-concepts', 'market-structure'];

// The roles that loaded each one on main (role-skills).
const OLD_ROLES = {
  'liquidity-concepts': ['volume-liquidity-analyst'],
  'market-structure': ['market-structure-analyst'],
  'market-snapshot': ['market-structure-analyst', 'trend-momentum-analyst', 'volume-liquidity-analyst'],
};

/** A skill's units: as tests/plugin/broker-mcp-split.test.js cuts them (a sentence, a table cell, a code line). */
function units(md) {
  const body = md.replace(/^---\n[^]*?\n---\n/, '');
  const blocks = [];
  let cur = null;
  let fence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; cur = null; continue; }
    if (fence) { if (line.trim()) blocks.push(line.trim()); cur = null; continue; }
    if (!line.trim()) { cur = null; continue; }
    if (cur === null || /^\s*(#{1,6} |- |\d+\. |\|)/.test(line)) { cur = [line]; blocks.push(cur); } else cur.push(line);
  }
  const out = [];
  for (const b of blocks) {
    const text = (Array.isArray(b) ? b.join(' ') : b).replace(/\s+/g, ' ').trim();
    if (!Array.isArray(b)) { out.push(text); continue; }
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
// The skill format's own section headings: every skill has them.
const STRUCTURE = ['When to Use', 'How It Works', 'Examples'];

// Units not carried byte-for-byte: where each one's content is now (a fragment of a skill, or of the role's own agent
// file), and why. `home: null`: nothing carries it, with the reason.
const S = s => `skills/${s}/SKILL.md`;
const A = a => `agents/${a}.md`;
// The briefing fields market-snapshot's glossary explained, by the skill it went to. A role must load that skill only
// when its own body reads one of those fields (the name as a word in its agent file, backticked or not, or the root of
// a dotted path it names: `regime.metrics.x` reads `regime`); homes of one `group` are alternatives (one of them is
// enough; a role's own agent file is one for that role only). A home without fields binds every role that loaded
// the old skill. Field names that are also plain words in every body (trend, today) are not used.
const IND = { fields: ['emaFast', 'emaSlow', 'atr14', 'atr20', 'adxSlope', 'supertrend', 'keltner'] };
const CTX = { fields: ['context'] };
const REGIME = { fields: ['regime'], group: 'regime' };
const MV = { fields: ['participation', 'relVolLastVsOpeningRange', 'relVolLast3VsOpeningRange', 'relVolLast3VsPrior20', 'relVolVsSameTimePriorDay'] };
const VVP = { fields: ['volumeProfile', 'priorProfile', 'sessionProfile', 'priorProfileNodes', 'hvnAbove', 'lvnBelow'] };
const DAY = { fields: ['dayType', 'openType'] };
const VWAP = { fields: ['vwap', 'applies', 'rthCrossesLast30', 'sessionCrossesLast30'], group: 'vwap' };
const LEVELS = { fields: ['priorRth', 'overnight', 'openingRange'], group: 'levels' };
const LIQ = { fields: ['liquidity', 'swingHighs', 'swingLows', 'equalHighs', 'equalLows', 'openFvgs', 'partlyFilledFvgs'] };
// Units moved byte-for-byte whose home binds only the roles that read these fields.
const VERBATIM_FIELDS = { 'Read a skip rule\'s number here; never estimate it.': CTX };
// The skip-rule step: a role whose body checks candidates' skip rules loads the skill holding their context fields.
const SKIP_RULES = /\bskip rules?\b/i;
const SKIP_CONTEXT = '**Skip-rule context**';
const ALLOWED = {
  'liquidity-concepts': [
    { old: 'Equal highs/lows: two of the last 12 confirmed swing highs (lows) within 0.1 × ATR(14) of each other (3m swings, 2 bars each side: about 12 ticks on MNQ at an ATR of 30 points); the last 3 such pairs, each `taken` once traded through.', home: [[S('levels-and-reactions'), 'Equal highs/lows: two of the last 12 confirmed swing highs (lows) within 0.1 × ATR(14) of each other (a frame\'s own swings from the 15m up, 2 bars each side); the last 3 such pairs, each `taken` once traded through.']], reason: 'feat/bias-bg: the entry frame\'s (3m) swings are no level (the owner: never the entry timeframe as a level; chain.js), so equal highs and lows are a frame\'s own from the 15m up' },
    { old: 'Reversal setups (crt_1h) follow a sweep; continuation setups follow a break.', home: [[S('levels-and-reactions'), 'Reversals follow a sweep, continuations a break.']], reason: 'crt_1h is retired (strategies/retired.json)' },
    { old: 'Liquidity Concepts', home: null, reason: 'the retired skill\'s title' },
    // The strong middle bar is the cisd skill's, stated there once (fix/skills-concept-owners): fair-value-gaps points to it.
    { old: "**Fair value gap (FVG):** a 3-bar pattern where bar 1's high is below bar 3's low (bullish) or bar 1's low is above bar 3's high (bearish), with a strong displacement middle bar the gap's way (the `cisd` skill's strong candle: body at least 0.6 of its range, close in the extreme third, range at least 1.0 x ATR(14) or engulfing).",
      home: [[S('fair-value-gaps'), 'with a strong displacement middle bar the gap\'s way (the `cisd` skill\'s strong candle).']], reason: 'the strong candle\'s numbers are the cisd skill\'s, not restated' },
    { old: 'A gap behind a weak middle bar (a doji, a small body, a close mid-range, the wrong way) is no FVG.',
      home: [[S('fair-value-gaps'), 'A gap behind a weak middle bar, or one the wrong way, is no FVG.']], reason: 'what makes it weak is the cisd skill\'s' },
    { old: 'Choosing targets and judging whether a breakout will hold.', home: [[S('levels-and-reactions'), 'Targets: the next untested liquidity pool in the trade\'s direction.']], reason: 'a trigger of the retired skill: targets are levels-and-reactions\'' },
    { old: 'Explaining a fast move through a level followed by a reversal.', home: [[S('levels-and-reactions'), 'sweep: `breakout-vs-fakeout` (`m3.sweeps`);']], reason: 'a trigger of the retired skill: the sweep reaction' },
    { old: 'In an autonomous cycle the bar briefing (`bar_briefing`, the `bar-briefing` skill) holds this bar\'s liquidity (`m3` `liquidity`, `sweeps`, `htfLevels`, `nearestLiquidity`): use it, and compute only what it doesn\'t hold.',
      home: [[A('volume-liquidity-analyst'), 'Start from the bar briefing: `bar_briefing {"symbol": "<SYMBOL>"}`.']], reason: 'the role\'s own Method says it' },
    { old: 'The sweeps are computed there: never call one by eye.', home: [[A('volume-liquidity-analyst'), 'in the last 10 bars, key levels first; computed, never by eye)']], reason: 'the role\'s own step 5 says it' },
    { old: '**Resting liquidity** (stops cluster just beyond obvious levels): the levels and their fields are the `levels-and-reactions` skill\'s.',
      home: [[S('levels-and-reactions'), '**Resting liquidity** (stops cluster just beyond obvious levels).']], reason: 'now in levels-and-reactions itself' },
    { old: '**Sweep vs break**: the `breakout-vs-fakeout` skill.', home: [[S('levels-and-reactions'), 'sweep: `breakout-vs-fakeout` (`m3.sweeps`);']], reason: 'a pointer; the sweep reaction is levels-and-reactions\' (the role\'s), the full read breakout-vs-fakeout\'s' },
    { old: '**Use.** Targets: the next untested liquidity pool in the trade\'s direction.', home: [[S('levels-and-reactions'), 'Targets: the next untested liquidity pool in the trade\'s direction.']], reason: 'the "Use." label dropped' },
    { old: 'Room: the first level in a setup\'s way (`inTheWay`) is the priority order\'s step 3 (strategy-library).',
      home: [[S('levels-and-reactions'), 'for a setup, `candidate.inTheWay` and `candidate.ahead` in its own R.'], [S('levels-and-reactions'), 'prior VAL 21480.00 5 ticks below, inTheWay 0.3R.']], reason: 'levels-and-reactions already says it' },
    ...[
      'Overnight high 21614.75 and prior-day high 21615.00, one tick apart: two key',
      'levels stacked into one pool (not the briefing\'s `equalHighs`, which are pairs',
      'of 3m swing highs; the briefing merges them as one level',
      '"overnight high / prior RTH high"). The 09:39 ET 3m bar wicks to 21624.00 and',
      'closes 21606.00. → sweep of a double liquidity pool (m3.sweeps lists it). A',
      'short idea is wrong above 21624.00 (the invalidation skill).',
    ].map(old => ({ old, home: [[S('levels-and-reactions'), 'Hypothesis: levels a few ticks apart act as one zone.'], [S('levels-and-reactions'), 'sweep: `breakout-vs-fakeout` (`m3.sweeps`);']],
      reason: 'the example\'s lesson (levels a tick apart are one pool; a wick through and a close back is a sweep) is levels-and-reactions\'' })),
  ],
  'market-structure': [
    { old: 'Within a trend, pullbacks into discount (premium for shorts) are where continuation setups sit.', home: [[S('pullback-vs-reversal'), 'within a trend, pullbacks into discount (premium for shorts) are where continuation setups sit.']], reason: 'kept in pullback-vs-reversal after its pointer to fib-retracement, which owns premium and discount (fix/skills-concept-owners)' },
    { old: 'Market Structure', home: null, reason: 'the retired skill\'s title' },
    { old: 'Forming a directional bias on any timeframe.', home: [[S('trend-vs-range'), 'Trader-process step 1 (HTF), and the regime in step 2.']], reason: 'a trigger of the retired skill: the bias is trend-vs-range\'s read' },
    { old: 'Choosing where a stop belongs (behind structure, not at an arbitrary distance).', home: [[S('trend-vs-range'), 'A stop belongs behind structure (a swing), not at an arbitrary distance (`invalidation`).'], [A('market-structure-analyst'), 'Invalidation of bias: <price and condition>']],
      reason: 'trend-vs-range keeps "behind structure" (the stop stays the strategy\'s); the analyst reports where its bias is wrong' },
    { old: 'Deciding whether a breakout is continuation or a reversal attempt.', home: [[S('bos-vs-choch'), 'No one timeframe is the signal; read them top-down.']], reason: 'a trigger of the retired skill: bos-vs-choch reads it' },
    { old: 'In an autonomous cycle the bar briefing (`bar_briefing`, the `bar-briefing` skill) holds this bar\'s structure (`m3`, `m15`, `h1`): use it, and compute only what it doesn\'t hold.',
      home: [[A('market-structure-analyst'), 'Start from the bar briefing: `bar_briefing {"symbol": "<SYMBOL>"}`.']], reason: 'the role\'s own Method says it' },
    { old: '**Swings**: how they are confirmed, the `bos-vs-choch` skill.', home: [[S('bos-vs-choch'), 'Confirmed fractal swings (k=2:']], reason: 'a pointer to bos-vs-choch' },
    { old: 'Mark the last 3-4 of each.', home: [[S('levels-and-reactions'), '(the last 4: `m3.liquidity.swingHighs`, `m3.liquidity.swingLows`)']], reason: 'the briefing lists the last 4' },
    { old: '**Trend, range or transition**: the `trend-vs-range` skill.', home: [[S('trend-vs-range'), '`transition`: everything else.']], reason: 'a pointer to trend-vs-range' },
    { old: '**Events**: BOS and CHoCH, and what each means by timeframe, the `bos-vs-choch` skill; a move against the trend, `pullback-vs-reversal`; a wick through a swing, `breakout-vs-fakeout`.',
      home: [[S('bos-vs-choch'), 'No one timeframe is the signal; read them top-down.'], [S('pullback-vs-reversal'), 'A lower-timeframe CHoCH inside an intact higher-timeframe structure is a pullback.'],
        [S('breakout-vs-fakeout'), 'No call before the close.']], reason: 'pointers to the three skills' },
    { old: '**Location.** Split the current dealing range (last major swing low to high) at 50%: above is premium, below is discount.',
      home: [[S('fib-retracement'), 'Above the leg\'s 0.5 level is premium, below it discount']], reason: 'moved to pullback-vs-reversal, then to fib-retracement, its one owner (fix/skills-concept-owners); pullback-vs-reversal points there' },
    { old: '**Invalidation**: the `invalidation` skill (the stop stays the strategy\'s).', home: [[A('market-structure-analyst'), 'Invalidation of bias: <price and condition>']],
      reason: 'a pointer; the stop is the strategy\'s, the analyst reports where its bias is wrong' },
    { old: '**Higher timeframe wins** (`bos-vs-choch`, by timeframe).', home: [[S('bos-vs-choch'), 'A 3-minute BOS against a 1-hour downtrend is a counter-trend trade.']], reason: 'superseded wording: #121 reads the timeframes top-down' },
    ...[
      '15m: HH 21620 → HL 21540 → HH 21655 → HL 21590 (uptrend)',
      '3m: close 21588 below the 21590 HL → CHoCH on 3m, 15m still up.',
      'Read: a pullback inside an uptrend until the 15m breaks (pullback-vs-reversal);',
    ].map(old => ({ old, home: [[S('pullback-vs-reversal'), 'A lower-timeframe CHoCH inside an intact higher-timeframe structure is a pullback.']], reason: 'the example\'s lesson is pullback-vs-reversal\'s' })),
    { old: 'the idea is wrong below 21540 (the 15m HL).', home: [[A('market-structure-analyst'), 'Invalidation of bias: <price and condition>']], reason: 'the analyst\'s own report line' },
    { old: 'Report structure as facts with prices and times, then the bias, then what would flip it.',
      home: [[A('market-structure-analyst'), '1h / 15m / 3m: <one line each with swing prices>'], [A('market-structure-analyst'), 'Invalidation of bias: <price and condition>']], reason: 'the role\'s own Output says it' },
  ],
  'market-snapshot': [
    { old: "Otherwise the harness tool `bars_fetch` (`{\"symbol\": \"MNQ\", \"timeframe\": 3}`: the runner's default, 5000 bars) writes `<FTH_HOME>/bars-scratch/MNQ-3m.json` (the path it returns) and says when its last bar closed (see the `bar-briefing` skill).",
      home: [[S('market-snapshot'), "Otherwise the harness tool `bars_fetch` (`{\"symbol\": \"MNQ\", \"timeframe\": 3}`: the runner's default count) writes `<FTH_HOME>/bars-scratch/MNQ-3m.json` (the path it returns)"]],
      reason: "feat/htf-history: the runner's bar count follows the read's window (config/analysis.json mtf.historyHours), so the skills name no count (its one home is the config)" },
    { old: 'Any time a decision depends on an indicator value or a level.', home: [[S('market-snapshot'), 'A number the briefing doesn\'t carry:']], reason: 'the briefing carries them now; the skill is the fallback' },
    { old: 'Checking whether a strategy\'s mechanical trigger fired on the last closed bar.', home: [[S('market-snapshot'), 'strategy triggers come from `strategies_scan`']], reason: 'the scan says it, as the skill\'s example has it' },
    { old: 'In an autonomous cycle the bar briefing (`bar_briefing`, the `bar-briefing` skill) already holds this bar\'s values: `m3` (EMAs, ADX, SuperTrend, Keltner, ATR, VWAP, participation, the skip-rule counters in `context`, swings and liquidity, `lastBreak`, `sweeps`, `htfLevels`, the nearest levels in points and R), `m15` and `h1` (the higher frames).',
      home: [[S('market-snapshot'), 'The bar briefing says there is no current briefing, or that it is old.']], reason: 'the skill is now the fallback without a briefing; the roles\' Method says to start from it' },
    { old: 'Use it, and compute only what it doesn\'t hold.', home: [[S('market-snapshot'), 'A number the briefing doesn\'t carry:']], reason: 'the fallback\'s triggers' },
    { old: 'Read the JSON:', home: [[S('market-snapshot'), 'Read the JSON: the briefing\'s values under the snapshot\'s own keys.']], reason: 'now names where each value is explained' },
    { old: '`trend`: emaFast(9), emaSlow(20), ema50, ema200, adx(14) and its 5-bar slope, supertrend(10,3) direction and line, keltner(20, 1.5×ATR20).',
      home: [[S('market-snapshot'), '`trend` (`emaFast`, `emaSlow`, `ema50`, `ema200`, `adx`, `adxSlope`, `supertrend`, `keltner`)'], [S('trend-momentum-indicators'), '| SuperTrend(10, 3) | ATR bands |', IND],
        [S('trend-momentum-indicators'), '| Keltner(20, 1.5) | EMA20 ± 1.5 × ATR20 |', IND], [S('momentum-and-volume'), '`m3.trend.adxSlope` (now minus 5 bars ago)', MV]], reason: 'the keys stay; the settings are trend-momentum-indicators\' table' },
    { old: '`volatility`: atr14, atr20.', home: [[S('market-snapshot'), '`volatility` (`atr14`, `atr20`)'], [S('trend-momentum-indicators'), '| ATR(14/20) | Wilder |', IND]], reason: 'the keys stay; ATR is trend-momentum-indicators\'' },
    { old: '`structure`: last confirmed fractal swing high/low (k=2) and when.', home: [[S('market-snapshot'), '`structure` (the last swing high and low)'], [S('levels-and-reactions'), '(a frame\'s own swings from the 15m up, 2 bars', LIQ]], reason: 'the key stays; the swings are levels-and-reactions\'' },
    { old: '`levels`: priorRth high/low/close, overnight high/low, openingRange (first 15 min from 09:30 ET, only after it closes), vwapSession (18:00 ET anchor), vwapRth (09:30 ET anchor; null before today\'s 09:30 ET open and after 16:00 ET: use vwapSession then, as the strategy filters do).',
      home: [[S('market-snapshot'), '`levels` (`priorRth`, `overnight`, `openingRange`, `vwapSession`, `vwapRth`)'], [S('levels-and-reactions'), 'opening range `m3.today.openingRange` (the first 15 minutes from 09:30 ET; null until formed)', LEVELS], [S('trend-momentum-indicators'), '**Skip-rule context**', LEVELS],
        [S('vwap-volume-profile'), '`vwapRth` is null before today\'s 09:30 ET open and after 16:00 ET: use `vwapSession` then, as the strategy filters do.', VWAP], [S('trend-momentum-indicators'), '`rth` from 09:30 to 16:00 ET, else `session`', VWAP]], reason: 'the keys stay; the levels are levels-and-reactions\', the VWAPs vwap-volume-profile\'s' },
    { old: '`vwap`: which VWAP applies now (`rth` or `session`), the distance in ATR(14), and the closes crossing each VWAP in the last 30 bars (`rthCrossesLast30`, `sessionCrossesLast30`; read the one that applies).',
      home: [[S('vwap-volume-profile'), 'The briefing\'s `m3.vwap`: which VWAP applies now (`applies`: `rth` or `session`), the distance in ATR(14) (`distanceAtr`), and the closes crossing each VWAP in the last 30 bars (`rthCrossesLast30`, `sessionCrossesLast30`; read the one that applies).', VWAP], [S('trend-momentum-indicators'), '**VWAP** (`m3.vwap`): which applies (`applies`:', VWAP]], reason: 'moved to vwap-volume-profile, with the briefing\'s field names' },
    { old: '`participation`: `lastBarVolume`; the last bar and the last 3 bars\' average vs the opening-range average bar (`relVolLastVsOpeningRange`, `relVolLast3VsOpeningRange`); the last 3 vs the 20 bars before them (`relVolLast3VsPrior20`); and the last bar vs the one bar at the same ET time on the previous trading day (`relVolVsSameTimePriorDay`: one bar, not an average over sessions). orb\'s skip rule reads `relVolLastVsOpeningRange`.',
      home: [[S('momentum-and-volume'), '`m3.participation.relVolLast3VsPrior20`: the last 3 bars\' mean volume over the mean of the bars before them (the code takes 21);', MV], [S('momentum-and-volume'), 'over the same ET minute\'s bar the previous trading day; `m3.participation.lastBarVolume`.', MV]],
      reason: 'momentum-and-volume says it exactly as the code computes it (#122: the code takes 21 bars, not 20); the orb note moved there, then left with orb\'s retirement (strategies/retired.json)' },
    { old: 'Both count by trading day (from the 18:00 ET open): from 18:00 ET until the new range closes (09:30 ET + orbMinutes; 09:45 by default), `levels.openingRange` and the opening-range ratios are null, never the closed day\'s.',
      home: [[S('momentum-and-volume'), 'bar average (null before it closes, and overnight)', MV], [S('levels-and-reactions'), 'null until formed)', LEVELS], [S('trend-momentum-indicators'), '**Skip-rule context**', LEVELS]], reason: 'momentum-and-volume and levels-and-reactions say it' },
    { old: '`volumeProfile`: computed from the bars, never estimate it.', home: [[S('vwap-volume-profile'), 'Don\'t estimate it by hand:', VVP]], reason: 'vwap-volume-profile says it' },
    { old: '`priorRth` (the last complete RTH day, the day\'s reference), `session` (this Globex session, developing), `rolling` (the last `vpLookback` bars).',
      home: [[S('vwap-volume-profile'), '`priorRth`: the last complete RTH day. The reference for the day; fixed.', VVP], [S('vwap-volume-profile'), '`rolling`: the last 360 bars (`vpLookback`).', VVP]], reason: 'vwap-volume-profile lists the three' },
    { old: 'Each: `poc`, `vah`, `val`, `price` (above, inside, or below value, from the exact levels: a shown VAH a tick under price can still read inside), `fromPocAtr` ((price - POC) / ATR(14)), the nearest high and low volume nodes (`hvnAbove`, `hvnBelow`, `lvnAbove`, `lvnBelow`), and all of them (`hvn`, `lvn`).',
      home: [[S('vwap-volume-profile'), '`price` (above, inside, or below value, from the exact levels: a shown VAH a tick under price can still read inside), `fromPocAtr` ((price - POC) / ATR(14))', VVP], [S('vwap-volume-profile'), 'with the nearest above and below (`hvnAbove`, `lvnBelow`, ...)', VVP]], reason: 'merged into vwap-volume-profile\'s own list' },
    { old: 'On the contract\'s tick (as in the briefing) for a harness bars file or with `symbol`; otherwise to two decimals, between ticks: round to `tickSize` before using one as an order price.',
      home: [[S('vwap-volume-profile'), 'shown on the contract\'s tick (as in the briefing) for a harness bars file or with `symbol`; otherwise to two decimals, between ticks: round to `tickSize` before using one as an order price.', VVP]], reason: 'replaces vwap-volume-profile\'s older "not on ticks" line' },
    { old: 'Bar-based: say so.', home: [[S('vwap-volume-profile'), 'Say so when you cite it.', VVP]], reason: 'vwap-volume-profile says it' },
    { old: '`day` (RTH only, else null): the open against the prior RTH day (`openVs`: inside the prior value area, outside value inside the range, or outside the range), the `gap` from the prior close, the `openType` (open-drive, open-test-drive, open-rejection-reverse, open-auction, from the first 30 minutes), the initial balance (`ibHigh`, `ibLow`, the first hour) and how far the day has gone past it (`extUp`, `extDown`), the `dayType` so far (inside the initial balance; normal variation: one side extended, under 2 IBs; trend: 2 IBs or more, or 1 from a narrow IB under 0.35 ADR; neutral: both sides), and the `range` against the average daily range (`adr`, over `adrDays`, default 10).',
      home: [[S('vwap-volume-profile'), 'the open against the prior RTH day (`openVs`: inside the prior value area, outside value inside the range, or outside the range), the `gap` from the prior close, the `openType` (open-drive, open-test-drive, open-rejection-reverse, open-auction, from the first 30 minutes), the initial balance (`ibHigh`, `ibLow`, the first hour) and how far the day has gone past it (`extUp`, `extDown`), the `dayType` so far (inside the initial balance; normal variation: one side extended, under 2 IBs; trend: 2 IBs or more, or 1 from a narrow IB under 0.35 ADR; neutral: both sides), and the range against the average daily range (`rangeVsAdr`, over 10 days).', DAY],
        [S('market-snapshot'), '`day` (RTH only, else null)']], reason: 'moved to vwap-volume-profile with the briefing\'s field (`m3.today`)' },
    { old: '`line` is the same as the prompt\'s "day:" line.', home: [[S('vwap-volume-profile'), 'the prompt\'s "day:" line says the same', DAY]], reason: 'moved to vwap-volume-profile' },
    { old: '`liquidity`: the last 4 swing highs and lows, equal highs/lows (within 0.1 x ATR), fair value gaps (3-bar gaps with a strong displacement middle bar, the CISD strength rule), open (`openFvgs`: not traded back into) and partly filled ones (`partlyFilledFvgs`: traded into, not through; `low` to `high` is the part still unfilled, `gapLow` to `gapHigh` the whole gap).',
      home: [[S('levels-and-reactions'), '(the last 4: `m3.liquidity.swingHighs`, `m3.liquidity.swingLows`)', LIQ], [S('levels-and-reactions'), 'Equal highs/lows: two of the last 12 confirmed swing highs (lows) within 0.1 × ATR(14)', LIQ],
        [S('levels-and-reactions'), 'FVGs `m3.fvgs` (`fair-value-gaps`)', LIQ],
        [S('fair-value-gaps'), 'with a strong displacement middle bar the gap\'s way (the `cisd` skill\'s strong candle).', LIQ]], reason: 'levels-and-reactions lists them (since feat/bias-bg the entry frame\'s own gaps and equal highs are no level: the 5m, 15m and 1h gaps, a frame\'s own swings); fair-value-gaps reads the gaps and defines them (the strong middle bar, #129)' },
    { old: '`context`: the numbers the strategies\' skip rules name: EMA 9/20 crosses in the last 30 bars, bars of falling ADX, Keltner width vs its 20-bar average (a squeeze is under 1), the band-close streak, SuperTrend flips in the last 20 bars, the last 5 bars\' range in ATR, the session\'s high and low so far, and the last bar\'s volume vs its 60-bar average (`volVsAvg60`).',
      home: [[S('trend-momentum-indicators'), '**Skip-rule counters** (`m3.context`): the numbers the strategies\' skip rules name: EMA 9/20 crosses in the last 30 bars (`emaCrossesLast30`), bars of falling ADX (`adxFallingBars`), Keltner width vs its 20-bar average (`keltnerWidthVsAvg20`: a squeeze is under 1), the band-close streak (`bandCloseStreak`), SuperTrend flips in the last 20 bars (`supertrendFlipsLast20`), the last 5 bars\' range in ATR (`range5Atr`).', CTX],
        [S('market-snapshot'), 'Only in this tool\'s output: `context.volVsAvg60` (the last bar\'s volume vs its 60-bar average) and `context.session` (the session\'s high and low so far;']], reason: 'the briefing\'s counters to trend-momentum-indicators; the two the briefing lacks stay here' },
    { old: 'The bar briefing\'s `m3` `context` has the same counters except `volVsAvg60` and `session` (the session high and low reach the briefing only as named levels, `session high` and `session low`, ranked with the others in `nearestLiquidity` and the candidates\' `ahead`): `volVsAvg60` is in this tool\'s output only.',
      home: [[S('market-snapshot'), 'the briefing has them only as named levels, `session high` and `session low`, ranked with the others in `nearestLiquidity` and the candidates\' `ahead`)']], reason: 'reworded for the fallback' },
    { old: 'No strategy\'s skip rule reads it; the strategies whose rules compare volume with an average compute it in their own rules (`vol_sma`), and the scan reports the result.',
      home: [[S('market-snapshot'), 'No strategy\'s skip rule reads `volVsAvg60`; the strategies whose rules compare volume with an average compute it in their own rules (`vol_sma`), and the scan reports the result.']], reason: '"it" named' },
    { old: '`regime`: primary (trend-up, trend-down, range, transition), volatility (high, normal, low), tags, and the metrics behind them (ADX, EMA(20) slope in ATRs, `sessionVwapCrosses`: closes crossing the session VWAP in the last 30 bars, the same count as `vwap.sessionCrossesLast30`; ATR vs its average).',
      home: [[S('trend-momentum-indicators'), '**The regime\'s metrics** (`m3.regime.metrics`): ADX, EMA(20) slope in ATRs, `sessionVwapCrosses`, ATR vs its average (`atrRatio`).', REGIME], [S('trend-vs-range'), '**The computed regime** (`m3.regime.primary`;', REGIME], [A('volume-liquidity-analyst'), 'session count is the regime\'s own (`regime.metrics.sessionVwapCrosses`)', REGIME]], reason: 'moved to trend-momentum-indicators; the primary regime is trend-vs-range\'s, the volatility the Volatility bullet\'s, the VWAP count vwap-volume-profile\'s (fix/skills-concept-owners)' },
    { old: 'Fractal swings need strictly higher/lower neighbours (2 bars each side), so a flat top or bottom (bars side by side at the same high or low) is no swing.',
      home: [[S('levels-and-reactions'), 'A flat top or bottom (bars side by side at the same high or low) is no swing, so it is in neither.', LIQ], [S('levels-and-reactions'), '(a frame\'s own swings from the 15m up, 2 bars', LIQ]], reason: 'moved to levels-and-reactions, next to the equal highs and lows' },
    { old: '`liquidity.equalHighs`/`equalLows` are pairs of separate confirmed swings within 0.1 x ATR(14) of each other (see levels-and-reactions); a flat top shows up in neither.',
      home: [[S('levels-and-reactions'), 'Equal highs/lows: two of the last 12 confirmed swing highs (lows) within 0.1 × ATR(14)', LIQ], [S('levels-and-reactions'), 'is no swing, so it is in neither.', LIQ]], reason: 'levels-and-reactions says it' },
  ],
};

const skillNames = () => fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));

/** What differs between an old skill and the skills now, beyond its allowed exceptions; and the files its content went to. */
function differences(name, skillTexts, files = f => read(f)) {
  const before = count(units(read(fixture(name))));
  const now = new Map();
  for (const [s, text] of Object.entries(skillTexts)) for (const u of units(text)) { if (!now.has(u)) now.set(u, []); now.get(u).push(s); }
  const allowed = new Map(ALLOWED[name].map(a => [a.old, a]));
  const bad = [];
  const homes = [];
  for (const [u, n] of before) {
    if (STRUCTURE.includes(u)) continue;
    const a = allowed.get(u);
    if (a) {
      for (const [file, text, only] of a.home || []) {
        if (!flat(files(file)).includes(flat(text))) bad.push(`${name}: "${text}" not in ${file}`);
        // One home: a fragment in a skill is in exactly one skill.
        const inSkills = Object.entries(skillTexts).filter(([, t]) => flat(t).includes(flat(text))).map(([s]) => s);
        if (file.startsWith('skills/') && inSkills.length !== 1) bad.push(`${name}: "${text}" in ${inSkills.length} skills, not 1`);
        homes.push({ file, text, fields: only ? only.fields : null, group: only && only.group ? `${u}:${only.group}` : null });
      }
      if (!a.reason) bad.push(`${name}: no reason for ${u}`);
      continue;
    }
    const at = now.get(u) || [];
    if (at.length !== n) bad.push(`${name}: ${JSON.stringify(u)}: ${n} before, ${at.length} now`);
    const only = VERBATIM_FIELDS[u];
    for (const s of at) homes.push({ file: S(s), fields: only ? only.fields : null, group: null });
  }
  for (const a of ALLOWED[name]) if (!before.has(a.old)) bad.push(`${name}: allow-list entry not in the old skill: ${a.old}`);
  return { bad, homes };
}

const current = () => Object.fromEntries(skillNames().map(s => [s, read(S(s))]));
const loads = role => { const d = parseFrontmatter(read(A(role))).data; return [...(d['role-skills'] || []), ...(d['role-index'] || [])]; };

test('skill retire: the fixtures are the skills as main had them', () => {
  for (const [name, sha] of Object.entries(BEFORE)) {
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, fixture(name)))).digest('hex'), sha, name);
  }
  for (const name of RETIRED) assert.ok(!fs.existsSync(path.join(ROOT, 'skills', name)), `${name} is retired`);
});

test('skill retire: every unit of the old skills has exactly one home, or an allow-list entry with its home and reason', () => {
  const texts = current();
  for (const name of Object.keys(BEFORE)) assert.deepStrictEqual(differences(name, texts).bad, [], name);
});

/** The fields a role's body reads: every name in it as a word (backticked or not), and the root of each dotted path. */
function bodyFields(body) {
  const out = new Set();
  for (const [w] of body.matchAll(/[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*/g)) {
    out.add(w);
    out.add(w.split('.')[0]);
  }
  return out;
}
const agentBody = role => parseFrontmatter(read(A(role))).body;

/**
 * Each old role's missing homes: a skill it doesn't load (core or index: full mode embeds both) that its content went
 * to, where the home binds it (no fields, or a field its body reads; of a group, one home it has is enough, its own
 * agent file counting for it), or another role's file; and, for a role whose body checks skip rules, the skill that
 * holds their context fields.
 */
function roleGaps(texts, loadsOf = loads, bodyOf = agentBody) {
  const gaps = new Set();
  const skipHome = Object.keys(texts).filter(s => flat(texts[s]).includes(SKIP_CONTEXT));
  for (const [name, roles] of Object.entries(OLD_ROLES)) {
    const { homes } = differences(name, texts);
    if (new Set(homes.map(h => h.file)).size < 2) gaps.add(`${name}: homes ${homes.map(h => h.file)}`);
    for (const role of roles) {
      const body = bodyOf(role);
      const reads = bodyFields(body);
      const has = h => (h.file.startsWith('agents/') ? h.file === A(role) && flat(body).includes(flat(h.text)) : loadsOf(role).includes(h.file.split('/')[1]));
      for (const h of homes) {
        if (h.fields && !h.fields.some(x => reads.has(x))) continue;
        // A group: one home it has is enough; missing all, it is reported once, by its first home.
        if (h.group) {
          if (homes.some(o => o.group === h.group && has(o)) || homes.find(o => o.group === h.group) !== h) continue;
        } else if (h.file.startsWith('agents/')) {
          if (h.file !== A(role)) gaps.add(`${role}: ${name} went to ${h.file}, another role's file`);
          continue;
        }
        if (!has(h)) gaps.add(`${role}: loaded ${name}, but not ${h.file.split('/')[1]}`);
      }
      if (name === 'market-snapshot' && SKIP_RULES.test(body)) {
        if (skipHome.length !== 1) gaps.add(`${role}: checks skip rules, but ${skipHome.length} skills hold the skip-rule context fields`);
        else if (!loadsOf(role).includes(skipHome[0])) gaps.add(`${role}: checks skip rules, but not ${skipHome[0]}`);
      }
    }
  }
  return [...gaps];
}

test('skill retire: no role loses knowledge in full mode: each role that loaded an old skill loads every skill its content went to', () => {
  const texts = current();
  assert.deepStrictEqual(roleGaps(texts), []);
  // A role without one of the homes fails.
  const without = (role, skill) => r => loads(r).filter(s => !(r === role && s === skill));
  // The trend analyst reads `regime` and `context` (trend-momentum-indicators), `participation` (momentum-and-volume) and
  // `vwap` (trend-momentum-indicators' VWAP line, or vwap-volume-profile); the volume analyst `vwap` and the profiles.
  // Without trend-momentum-indicators, its VWAP and skip-rule level groups are missing too (each reported by its first
  // home), and so is the skip-rule step's home.
  assert.deepStrictEqual(roleGaps(texts, without('trend-momentum-analyst', 'trend-momentum-indicators')).sort(), [
    'trend-momentum-analyst: checks skip rules, but not trend-momentum-indicators',
    'trend-momentum-analyst: loaded market-snapshot, but not levels-and-reactions',
    'trend-momentum-analyst: loaded market-snapshot, but not trend-momentum-indicators',
    'trend-momentum-analyst: loaded market-snapshot, but not vwap-volume-profile',
  ]);
  // With either VWAP home the group is met: the volume analyst with trend-momentum-indicators instead of
  // vwap-volume-profile misses only the profile and day homes' skill, never the VWAP group.
  const swapped = r => (r === 'volume-liquidity-analyst' ? [...loads(r), 'trend-momentum-indicators'].filter(s => s !== 'vwap-volume-profile') : loads(r));
  assert.deepStrictEqual(roleGaps(texts, swapped), ['volume-liquidity-analyst: loaded market-snapshot, but not vwap-volume-profile']);
  assert.deepStrictEqual(roleGaps(texts, without('trend-momentum-analyst', 'momentum-and-volume')), ['trend-momentum-analyst: loaded market-snapshot, but not momentum-and-volume']);
  assert.deepStrictEqual(roleGaps(texts, without('volume-liquidity-analyst', 'vwap-volume-profile')), ['volume-liquidity-analyst: loaded market-snapshot, but not vwap-volume-profile']);
  assert.deepStrictEqual(roleGaps(texts, without('volume-liquidity-analyst', 'levels-and-reactions')).sort(),
    ['volume-liquidity-analyst: loaded liquidity-concepts, but not levels-and-reactions', 'volume-liquidity-analyst: loaded market-snapshot, but not levels-and-reactions']);
  // A field the body reads binds it: the structure analyst reads none of these.
  const reads = bodyFields(agentBody('market-structure-analyst'));
  assert.ok(!reads.has('regime') && !reads.has('participation') && !reads.has('vwap') && !reads.has('context'), 'the structure analyst reads none of them');
  // A dotted path binds its root: the volume analyst's `regime.metrics.sessionVwapCrosses` reads `regime`, met by its
  // own body's definition; without it, it would need trend-momentum-indicators.
  assert.ok(bodyFields(agentBody('volume-liquidity-analyst')).has('regime'));
  const noOwnRegime = r => (r === 'volume-liquidity-analyst' ? agentBody(r).replace('session count is the regime\'s own', 'session count is the') : agentBody(r));
  assert.deepStrictEqual(roleGaps(texts, loads, noOwnRegime), ['volume-liquidity-analyst: loaded market-snapshot, but not trend-momentum-indicators']);
  // Backticks don't matter: the trend body with `participation` un-backticked still binds momentum-and-volume.
  const plain = r => (r === 'trend-momentum-analyst' ? agentBody(r).replace(/`participation`/g, 'participation') : agentBody(r));
  assert.deepStrictEqual(roleGaps(texts, without('trend-momentum-analyst', 'momentum-and-volume'), plain), ['trend-momentum-analyst: loaded market-snapshot, but not momentum-and-volume']);
  // The skip-rule step: the trend analyst checks skip rules, so the skill holding their context fields binds it; with
  // that paragraph dropped from every skill, the general check fails.
  assert.match(agentBody('trend-momentum-analyst'), SKIP_RULES);
  const dropped = { ...texts, 'trend-momentum-indicators': texts['trend-momentum-indicators'].replace(SKIP_CONTEXT, '**Context**') };
  assert.ok(roleGaps(dropped).includes('trend-momentum-analyst: checks skip rules, but 0 skills hold the skip-rule context fields'), roleGaps(dropped).join('\n'));
  const moved = { ...texts, 'trend-momentum-indicators': dropped['trend-momentum-indicators'], absorption: `${texts.absorption}\n\n${SKIP_CONTEXT}\n` };
  assert.ok(roleGaps(moved).includes('trend-momentum-analyst: checks skip rules, but not absorption'), roleGaps(moved).join('\n'));
  assert.deepStrictEqual(roleGaps(texts, without('market-structure-analyst', 'pullback-vs-reversal')), ['market-structure-analyst: loaded market-structure, but not pullback-vs-reversal']);
  assert.deepStrictEqual(roleGaps(texts, without('volume-liquidity-analyst', 'fair-value-gaps')), ['volume-liquidity-analyst: loaded liquidity-concepts, but not fair-value-gaps', 'volume-liquidity-analyst: loaded market-snapshot, but not fair-value-gaps']);
});

test('skill retire: the comparison catches a lost, a doubled or an edited unit, a fragment gone, and a stale exception', () => {
  const texts = current();
  // A unit still verbatim in its new home (the equal-highs one is an allowed edit since feat/bias-bg).
  const EQ = 'No call until the close; wicks are information, not signals.';
  assert.ok(units(read(fixture('liquidity-concepts'))).includes(EQ), 'a sentence is a unit');
  const lr = texts['levels-and-reactions'];
  const flatLr = flat(lr);
  assert.ok(flatLr.includes(EQ));
  const withLr = t => ({ ...texts, 'levels-and-reactions': t });
  // Lost.
  assert.notDeepStrictEqual(differences('liquidity-concepts', withLr(flatLr.replace(EQ, ''))).bad, []);
  // Doubled: in a second skill.
  assert.notDeepStrictEqual(differences('liquidity-concepts', { ...texts, 'fair-value-gaps': `${texts['fair-value-gaps']}\n\n${EQ}\n` }).bad, []);
  // Edited: one number changed.
  assert.notDeepStrictEqual(differences('liquidity-concepts', withLr(flatLr.replace(EQ, EQ.replace('No call', 'A call')))).bad, []);
  // A fragment an exception names is gone from its home.
  const T = 'Targets: the next untested liquidity pool in the trade\'s direction.';
  const read2 = f => (f === S('levels-and-reactions') ? flatLr.replace(T, '') : read(f));
  assert.notDeepStrictEqual(differences('liquidity-concepts', withLr(flatLr.replace(T, '')), read2).bad, []);
  // A rewritten fragment in two skills (two homes) fails.
  const P = 'Above the leg\'s 0.5 level is premium, below it discount';
  assert.notDeepStrictEqual(differences('market-structure', { ...texts, 'bos-vs-choch': `${texts['bos-vs-choch']}\n\n${P}\n` }).bad, []);
  // An exception for a unit the old skill never had fails (the list only shrinks).
  ALLOWED['market-structure'].push({ old: 'Not in the old skill.', home: null, reason: 'x' });
  try {
    assert.notDeepStrictEqual(differences('market-structure', texts).bad, []);
  } finally {
    ALLOWED['market-structure'].pop();
  }
});

test('skill retire: no instruction names a retired skill; market-snapshot is index-only and the fallback', () => {
  const NAMES = /(?<![\w-])(?:liquidity-concepts|market-structure)(?![\w-])/;
  const dirs = ['agents', 'skills', 'commands', 'rules', 'strategies', 'scripts', 'hooks', 'workspace', 'qwen-extension', '.codex'];
  const bad = [];
  const walk = rel => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs)) walk(path.join(rel, e)); return; }
    if (/\.(md|js|json|toml)$/.test(rel) && NAMES.test(fs.readFileSync(abs, 'utf8'))) bad.push(rel);
  };
  for (const d of dirs) walk(d);
  assert.deepStrictEqual(bad, []);
  for (const role of OLD_ROLES['market-snapshot']) {
    const d = parseFrontmatter(read(A(role))).data;
    assert.ok(!d['role-skills'].includes('market-snapshot') && d['role-index'].includes('market-snapshot'), role);
  }
  const ms = parseFrontmatter(read(S('market-snapshot'))).body;
  assert.ok(Buffer.byteLength(ms) < Buffer.byteLength(read(fixture('market-snapshot'))) / 2 + 300, 'market-snapshot is short');
  assert.match(flat(ms), /The bar briefing says there is no current briefing, or that it is old\./);
});
