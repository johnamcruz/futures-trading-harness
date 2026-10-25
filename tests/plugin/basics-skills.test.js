'use strict';

// The trading-basics skills: small skills that teach a read each (trend vs range, pullback vs reversal, breakout vs
// fakeout, levels and reactions, momentum and volume, absorption, invalidation, confluence counting, candle reading, BOS vs
// CHoCH, CISD, fib retracement), and the two setups on any timeframe (rejection, breakout).
// Each is a read, never a veto: the priority order (strategy-library) decides. These tests pin their structure, that
// every briefing field they name resolves on a real briefing built by briefing.js, their take, skip and losing
// examples (tick-correct), the absence of veto language, their key sentences (a mutation fails), and the roles that
// carry them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { RETIRED } = require('../../scripts/lib/trading/strategies');
const { skillByteCap, SETUP_SKILLS } = require('../../scripts/lib/skill-caps');

/**
 * A strategy a skill names: active, or one of those retired on 2026-10-14. The skills were written when those
 * strategies shipped, and are kept as they are by the owner's decision (the retirement edits no skill), so a name
 * retired that day is accepted; any other name must be an active strategy in strategies/.
 */
function namedStrategyOk(name) {
  const doc = `strategies/${name}/STRATEGY.md`;
  if (fs.existsSync(path.join(ROOT, doc))) return parseFrontmatter(read(doc)).data.status === 'active';
  return RETIRED[name] === '2026-10-14';
}

const ROOT = path.resolve(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = t => t.replace(/\s+/g, ' ');

const SKILLS = ['trend-vs-range', 'pullback-vs-reversal', 'breakout-vs-fakeout', 'levels-and-reactions', 'momentum-and-volume',
  'absorption', 'invalidation', 'confluence-counting', 'candle-reading', 'rejection', 'breakout', 'bos-vs-choch', 'cisd', 'fib-retracement', 'fair-value-gaps', 'compression'];
const SETUPS = [...SETUP_SKILLS];
const file = s => `skills/${s}/SKILL.md`;

// Who carries which (each role only what it uses, and the homes of the retired skills it loaded: skill-retire.test.js;
// the executor and the news analyst none).
const ROLES = {
  'market-structure-analyst': ['trend-vs-range', 'bos-vs-choch', 'pullback-vs-reversal', 'breakout-vs-fakeout', 'levels-and-reactions', 'fair-value-gaps', 'candle-reading', 'rejection', 'breakout', 'cisd', 'fib-retracement', 'compression'],
  'trend-momentum-analyst': ['trend-vs-range', 'bos-vs-choch', 'momentum-and-volume', 'pullback-vs-reversal'],
  'volume-liquidity-analyst': ['levels-and-reactions', 'fair-value-gaps', 'momentum-and-volume', 'absorption'],
  'risk-manager': ['confluence-counting', 'invalidation'],
  'trade-executor': [],
  'news-calendar-analyst': [],
};

const READ = 'A read, never a veto: the count decides (`confluence-counting`).';

// Key sentences, by skill: each must be present; a test below shows a changed one fails.
const PINS = {
  'trend-vs-range': [
    '`trend-up`: ADX(14) at least 20 (`m3.regime.metrics.adx`), at most 3 session-VWAP crosses in the last 30 bars',
    'EMA(20) up at least 0.3 ATR(14) over 5 bars',
    '`range`: neither, and ADX under 18 or 5 or more crosses.',
    '`m3.trendRule` wins where they differ.',
    'the breaks a sequence of BOS that way;',
    'alternating breaks on that timeframe (its last two opposite CHoCHs) or none;',
    'a lower-timeframe CHoCH back the HTF way inside an HTF trend is the pullback ending (`pullback-vs-reversal`), not a range;',
  ],
  'pullback-vs-reversal': [
    'A 15m or 1h CHoCH against the trend weighs most: then the read is a reversal attempt.',
    'The pullback ends when its own minor structure breaks back: `m3.lastBreak.last` turns the trend\'s way',
    'up to about 50-62% of the leg (hypothesis)',
    'depth alone is no edge; buying a 50% or 62% retrace with the 4h trend lost after costs (F5).',
    'A lower-timeframe CHoCH inside an intact higher-timeframe structure is a pullback.',
    'CHoCHs stacking up the timeframes (3m, then 15m, then 1h) are a reversal developing.',
    'a lower-timeframe CHoCH back the HTF way at a level times the entry; the setup there: `rejection`, `breakout`, `fair-value-gaps`.',
  ],
  'breakout-vs-fakeout': [
    'a level traded through from inside and closed back inside within 1-3 bars, in the last 10 bars',
    'Never by eye.',
    'No call before the close.',
    'sweep of the previous hour\'s high or low lost after costs (F1). The levels in `m3.sweeps` differ and were not tested',
  ],
  'levels-and-reactions': [
    'No reaction is not a rejection.',
    'Which kind matters most is not measured',
    'Equal highs/lows: two of the last 12 confirmed swing highs (lows) within 0.1 × ATR(14) of each other',
    'Targets: the next untested liquidity pool in the trade\'s direction.',
    'is no swing, so it is in neither.',
  ],
  'fair-value-gaps': [
    'Price inside a gap is never "at an open FVG".',
    'only the unfilled part is still a gap;',
    'gaps of the last 60 bars of the briefing\'s own timeframe, the last 3 of each kind',
    'a filled gap is in neither list. Never mark one by eye.',
    'The briefing does not rank gaps among the levels in a setup\'s way',
    'Like the first level ahead, a read in the count, never a pass alone.',
    'Evidence**: not measured;',
  ],
  'momentum-and-volume': [
    'over the mean of the bars before them (the code takes 21)',
    '`m3.trend.adxSlope` (now minus 5 bars ago)',
    'They never trigger an entry and never override the price-action read.',
    'all with its side FOR, all against AGAINST, mixed neutral',
    'ADX has no side',
    'The code\'s note (under 1.0 thin, 1.5 or more strong) is a hypothesis.',
  ],
  absorption: [
    // Broker bar fields are broker-bar-fields' (fix/skills-concept-owners): this skill points there.
    '(the harness computes none of',
    '`broker-bar-fields`. Never derive one from OHLCV; without them, `unknown`.',
    'A bar\'s volume has no side',
  ],
  invalidation: [
    'This skill never moves, widens or replaces it.',
    'a fact, never a reason to change the stop;',
    // The stop read is this skill's (step stop): its forms and the code's placement and floor (trade-lifecycle.js).
    'Code places the stop one tick beyond it, at least the larger of 8 ticks and 0.25 x ATR(20); a closer one is refused, never widened',
    'acting on it is management\'s call under trade-session, never a wider stop.',
    'Stops move toward the market only.',
    'weighs by its timeframe against the trade\'s own: on the trade\'s timeframe or higher',
    'on a lower one it is mostly noise.',
  ],
  'confluence-counting': [
    // Independent categories, never labels (the owner's principle, fix/confluence-not-vetoes): reads of the same price
    // move are one piece of evidence; the trend rule is the side rule and never counted.
    '**Six independent categories**, one vote each, so for + against + neutral = 6: reads of one price move are one piece of evidence.',
    // The margin sizes it (the owner's principle 3: strong is full size, marginal reduced or a pass).
    // Compose first (fix/confluence-not-vetoes): the plan, never the model, works out R:R.
    '**Compose first.** The trend rule\'s side (or its CHoCH tier), a rejection or breakout at a key level or FVG, the trigger closed → call `compose_check`.',
    'Never estimate room or R:R: the briefing\'s "Standard plan" line states it; OK → compose with its reads, refused → pass, naming it.',
    'OK → **a valid setup is the trade**: full size within the verdict\'s ceiling; the against sets the size:',
    // A swing broken is serious, never decisive: decisive is a real HTF reversal (the owner: a sweep misread as a pass).
    '**Decisive** → pass: a real HTF reversal against the side (a 1h CHoCH against: the trend rule\'s tier, `trade-lifecycle`), or a hard step fails.',
    '**Serious** → half (`floor`, at least 1): 2+ categories against, location against (the trigger into the other side\'s level), or a 3m close beyond the leg\'s 15m swing (`m3.htfLevels` `brokenAt`).',
    'Closed back inside, it is a sweep (`breakout-vs-fakeout`): liquidity for.',
    '**Minor** → full size, never a reason not to compose: thin volume, the first level ahead, VWAP distance or "chasing" (no edge in the census), no pullback yet, mixed reads.',
    'A missing read is no reason to pass.',
    // A pullback inside the trend is never counted against itself (fix/confluence-not-vetoes).
    '**The pullback is neutral** (`pullback-vs-reversal`): entry-timeframe structure against the trend; for once it breaks back.',
    '| structure | 3m, 5m, 15m BOS, CHoCH (`bos-vs-choch`), CISD; momentum, EMA, ADX, SuperTrend |',
    '| location | the level, POI or FVG it reacts at |',
    '| liquidity | a sweep taken, or liquidity as the target |',
    '| trigger | the rejection or engulfing candle and its close |',
    '| participation | volume, delta, absorption; thin is neutral |',
    '| context | VWAP side, value area, day type, session |',
    '**One vote**: all its reads your way → for; all against → against; mixed, none or `unknown` → neutral.',
    'Labels never add: a 3m BOS, an EMA slope and ADX are one structure vote.',
    '**Not counted**: the trend rule and the 1h and 4h direction (the side rule; compose step bias), R:R, the window, the news.',
    // The count decides (fix/confluence-not-vetoes): no soft read is a pass alone, the room among them.
  ],
  'candle-reading': [
    'A pattern away from a level is not evidence.',
    'Never judge the in-progress candle: a 15m hammer half formed is not a hammer.',
    'In strategy rules `htfc_*` is the candle in progress: never judge a pattern on it.',
    'Judge a pattern at its candle\'s close, on every timeframe.',
    'standalone candlestick patterns have weak evidence in general',
  ],
  rejection: [
    // A setup read of the composed trade (no fired strategy since the rules strategies retired).
    '**A setup read, not an entry by itself.** It is stated with the other steps\' reads and `compose_check` verifies them (`trade_lifecycle`).',
    // A rejection is the briefing's relation; the wick, the close third and an engulfing grade it (candle-facts.js).
    '**4 Setup**: a completed candle rejects the level: the briefing\'s relation `rejected` (traded through it, closed back; read `<tf> rejected <level> up|down`).',
    'A long wick, the close in the opposite third or an engulfing grade its strength (`candle-reading`)',
    '| 3m, 5m | entry timing at an HTF level; alone, a minor level | least |',
    '| 15m | the working structure and the session levels | more |',
    '| 1h, 4h | HTF levels (prior day, overnight, CRT) | most |',
    '**Strongest**: a 15m or 1h rejection confirmed on 3m or 5m (step 6), with the HTF bias (step 1); a lone 3m or 5m one against it is counter-trend.',
    'whether a structure break went its way (`m15.lastBreak.last` or `h1.lastBreak.last` a CHoCH) is the trend rule\'s CHoCH tier (`trade-lifecycle`), never counted.',
    'Never anticipate it.',
    'the stop read names it (`invalidation`).',
    '**Paired with `breakout`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
    'After an HTF BOS, at the level a pullback reaches (`pullback-vs-reversal`), it is a continuation.',
    'A reversal rejection reads strongest with an HTF CHoCH its way (`bos-vs-choch`).',
    'or a CHoCH against it on its timeframe or higher (`bos-vs-choch`).',
  ],
  cisd: [
    'A down run: at least 2 consecutive bearish completed candles',
    'The level: the OPEN of the run\'s first candle (`level`).',
    'Confirmed when a completed candle CLOSES above that level, within 6 candles of the run',
    'The CISD usually comes first: an early sign, not yet a change of structure.',
    'It is a setup read (`<tf> cisd up|down`), never a trade of its own',
    'A CISD after a sweep of a key level is stronger confluence; one without is still a CISD.',
    'A doji, a small body or a mid-range close is weak: no zone, no fib',
    'price pulls back to a level, then a CISD back in the trend\'s direction ends the pullback; a later close is the entry.',
    'a CISD back toward the middle, aiming at the other side.',
    'a 3m or 5m CISD in the 15m/1h trend\'s direction is the pullback ending',
    'Never anticipate the bounce.',
  ],
  compression: [
    // The one definition (compression.js; the numbers are the config's: a test below holds them equal).
    '`inside`: a candle inside its mother (`candle-reading`, `insideStack` in a row); the box is the mother\'s range. A displacement mother is a pole, never a box: then the narrow candle\'s own range.',
    '`nr7`: the narrowest range of the last 7 back-to-back candles (ties count); the box is its range.',
    '`pole`: a displacement candle (`candle-reading`) in the 3 candles just before the box, outside it.',
    'the next candle CLOSES beyond the box by 0.1 x ATR or more (`beyondAtr`: a poke of a tick or two is none), its range 1 x ATR or more (`rangeAtr`);',
    '`state` `expanding` while within 3 candles (`barsAgo`), no close back inside (`backInside`), price still beyond (`beyondNow`; acceptance by closes: `breakout-vs-fakeout`) and under 1 x ATR past its close (`late`).',
    'The expansion candle closes out of the box the HTF bias\'s way.',
    'Side, entry and runway: `trade-lifecycle`, `take-profit`. Never anticipate.',
    'Stop: the box\'s far side, `stop <tf> box low|high <price>` (`invalidation`).',
    'closed back inside: fakeout (`breakout-vs-fakeout`); a break against the HTF bias (the trend rule\'s); a small candle; late.',
    'a box pressing a key level the bias\'s way, the expansion closing through it: location `<tf> box at <level>`, setup the break.',
    'a displacement pole, then a narrow candle (flag) or an inside stack (pennant), the break the pole\'s way (`withPole`).',
  ],
  'fib-retracement': [
    'The levels read: 0.5, 0.618, 0.705 and 0.79.',
    'is 0.62 to 0.79 of the leg, mid 0.705',
    'completed candles only, never the candle forming.',
    'Never anticipate it: a touch is not a bounce.',
  ],
  breakout: [
    // A setup read of the composed trade (no fired strategy since the rules strategies retired).
    '**A setup read, not an entry by itself.** It is stated with the other steps\' reads and `compose_check` verifies them (`trade_lifecycle`).',
    '**4 Setup**: a completed candle closes beyond the level with acceptance',
    'not just a wick',
    '| 3m, 5m | entry timing past an HTF level; alone, a minor level, often a fakeout | least |',
    '| 15m | the working structure and the session levels | more |',
    '| 1h, 4h | HTF levels (prior day, overnight, CRT) | most |',
    '**Strongest**: a 15m or 1h breakout confirmed on 3m or 5m (step 6), with the HTF bias (step 1); a lone 3m or 5m one against it is counter-trend.',
    'a retest of the broken level that holds (a pullback: `pullback-vs-reversal`), with a rejection candle there (preferred), or a continuation displacement.',
    'Never anticipate it.',
    'the stop read names it (`invalidation`).',
    'a close back inside the level means the breakout failed: invalidation.',
    '**Paired with `rejection`**: a failed breakout (a close back inside) is the setup for a rejection the other way.',
    'A close beyond a level that is also a BOS on that timeframe (`m15.lastBreak.last`, `h1.lastBreak.last`) is accepted structure',
    'A CHoCH against the trade on its timeframe or higher (`bos-vs-choch`) is one too.',
  ],
  'bos-vs-choch': [
    'Confirmed fractal swings (k=2: a pivot with 2 strictly lower highs or higher lows on each side, confirmed 2 bars later).',
    'A close strictly beyond the last confirmed swing not yet broken; each swing breaks once. Only closes count, on completed candles.',
    'In the code, that is the previous break\'s direction (the first break too).',
    'No one timeframe is the signal; read them top-down.',
    '| 3m, 5m | continuation; entry timing | against the HTF: usually a pullback; back with it: the pullback ends |',
    '| 15m | the working structure continues | the working structure shifting: a deeper pullback, or a reversal starting |',
    '| 1h (4h swings) | the HTF trend continues | the strongest sign of an HTF trend change, not a reversal by itself: a BOS the new way confirms it |',
    'CHoCHs stacking up the timeframes (3m, then 15m, then 1h) are a reversal developing.',
    'a CHoCH against an open trade on its timeframe or higher is significant (`invalidation`); lower is mostly noise.',
  ],
};

/** Veto language: a skill that tells the model to skip or never take. Only the read sentence names a veto. */
const VETO = /\b(?:never|don'?t|do not|must not|should not|cannot|can't)\s+(?:take|enter|entry|trade|buy|sell|short|long|go long|go short)\b|\bno (?:trade|entry)\b|\b(?:must|always) skip\b|\bstand aside\b|\bvetoe?s?\b/i;
const vetoFree = text => !VETO.test(flat(text).replace(READ, '').replace(/\bnever a veto\b/g, ''));

/** Each pin of a skill present (flattened). */
const pinned = (skill, text) => PINS[skill].every(p => flat(text).includes(p));

/** The take, skip and losing examples, tick-correct: points = ticks x 0.25, $ = ticks x $0.50 (MNQ), entry - stop = points. */
function examples(text) {
  const ex = text.slice(text.indexOf('## Examples'));
  const ok = ['Take:', 'Skip:', 'Loser:'].every(k => new RegExp(`^${k}`, 'm').test(ex));
  const loss = /(?:long|short) at (\d+\.\d\d)[^\n]*?stop (\d+\.\d\d)\s*\((\d+\.\d\d) pts = (\d+) ticks,\s+\$(\d+\.\d\d) on 1 MNQ\)[^]*?-(\d+) ticks, -\$(\d+\.\d\d)/.exec(ex.slice(ex.indexOf('Loser:')));
  if (!ok || !loss) return false;
  const [, entry, stop, pts, ticks, usd, lostTicks, lost] = loss.map(Number);
  const prices = [...ex.matchAll(/\b(\d{5}\.\d\d)\b/g)].map(m => Number(m[1]));
  return Math.abs(Math.abs(entry - stop) - pts) < 1e-9 && pts / 0.25 === ticks && ticks * 0.5 === usd && lostTicks === ticks && lost === usd
    && prices.every(p => Number.isInteger(p / 0.25));
}

/** Two real briefings from briefing.js: the parity bars to the last (overnight), and cut where a sweep, an opening range and RTH VWAP exist. */
function briefings() {
  const B = require('../../scripts/lib/trading/briefing');
  const { readBarsArg } = require('../../scripts/lib/backtest/data');
  const bars = readBarsArg(path.join(ROOT, 'tests', 'fixtures', 'parity', 'NQ-3m.csv'));
  const scan = [{ name: 'orb', candidate: true, direction: 'long', status: 'active', confluence: { with: [], against: [] }, entryRef: 1, stopDistance: 10, exit: { trailActivateR: 2 },
    rules: { long: [{ rule: 'field("x.y") > 0', ok: true, values: { 'x.y': 0.42 } }] } }];
  const full = B.buildBriefing({ symbol: 'NQ', bars, minutes: 3, scan });
  const cut = B.buildBriefing({ symbol: 'NQ', bars: bars.slice(0, 1354), minutes: 3, scan });
  return [full, cut];
}

/** Every briefing path a skill names: m3., m15., h1., day., candidate. ([] steps into an array's first item). */
const pathsIn = text => [...new Set([...text.matchAll(/\b((?:m3|m15|h1|day|candidate)(?:\.[A-Za-z][A-Za-z0-9]*|\[\])+)/g)].map(m => m[1]))];

function resolves(b, p) {
  const [root, ...rest] = p.replace(/\[\]/g, '.[]').split('.');
  const d = b.sections.m3.data;
  let at = root === 'candidate' ? (d.candidates || [])[0] : root === 'm3' ? d : (b.sections[root] || {}).data;
  for (const k of rest) {
    if (k === '[]') { if (!Array.isArray(at) || !at.length) return false; at = at[0]; continue; }
    if (!(at && typeof at === 'object' && Object.prototype.hasOwnProperty.call(at, k))) return false;
    at = at[k];
  }
  return at !== undefined;
}

test('basics skills: frontmatter, the sections in order, and small', () => {
  for (const s of SKILLS) {
    const text = read(file(s));
    const { data, body } = parseFrontmatter(text);
    assert.strictEqual(data.name, s);
    assert.ok(String(data.description || '').length > 40, s);
    const at = ['## When to Use', '## How It Works', '## Examples'].map(h => text.indexOf(`\n${h}\n`));
    assert.ok(at.every(i => i > 0) && at[0] < at[1] && at[1] < at[2], s);
    const words = body.split(/\s+/).filter(Boolean).length;
    assert.ok(words >= 250 && words <= 650, `${s}: ${words} words`);
    // The two setups also carry a timeframe table (what the setup means on 3m/5m, 15m and 1h/4h): a little more room
    // (scripts/lib/skill-caps.js, the one source the training loop's probe edits read too).
    const max = skillByteCap(s);
    assert.ok(Buffer.byteLength(body) <= max, `${s}: ${Buffer.byteLength(body)} bytes, embedded in its roles' prompts`);
  }
});

test('basics skills: a read, never a veto; the priority order decides', () => {
  for (const s of SKILLS) {
    const text = read(file(s));
    // confluence-counting is the count that decides (fix/confluence-not-vetoes); every other basics skill is a read in it.
    if (s === 'confluence-counting') assert.ok(flat(text).includes('**a valid setup is the trade**'), s);
    else assert.ok(flat(text).includes(READ), s);
    assert.ok(vetoFree(text), `${s}: veto language`);
    // A skip in an example is the priority order's (or no fired strategy), never the skill's.
    const skip = text.slice(text.indexOf('Skip:')).split('\nLoser:')[0];
    // ...or a missing read's pass, the level ahead never the reason (fix/confluence-not-vetoes).
    assert.match(flat(skip), /[Pp]riority order[^.]*skip|No setup without a fired strategy|-> pass\b/, s);
    assert.doesNotMatch(flat(skip), /\(step 3, room\)/, `${s}: a skip on the room alone`);
  }
  for (const bad of ['Never take a long here.', 'You must skip it.', 'Stand aside on a doji.', 'Do not enter after a sweep.', 'This vetoes the trade.',
    'Without one do not buy.', 'Never short into support.', 'Do not go long here.', 'No entry on a doji.']) {
    assert.ok(!vetoFree(`${READ} ${bad}`), bad);
  }
});

test('basics skills: every briefing field named resolves on a briefing built by briefing.js', () => {
  const bs = briefings();
  // The candidate's broker field values (when its rules read one) and the sweeps exist on these briefings.
  assert.ok(bs[0].sections.m3.data.candidates[0].values, 'candidate.values');
  assert.ok(bs[1].sections.m3.data.sweeps.length > 0, 'a sweep');
  let n = 0;
  for (const s of SKILLS) {
    for (const p of pathsIn(read(file(s)))) {
      n += 1;
      assert.ok(bs.some(b => resolves(b, p)), `${s}: ${p}`);
    }
  }
  assert.ok(n >= 80, `${n} paths checked`);
  // An invented field fails.
  assert.ok(!bs.some(b => resolves(b, 'm3.participation.relVolVsPrior20')) && !bs.some(b => resolves(b, 'm3.sweeps[].depth')));
});

test('basics skills: the regime rule is regime.js\'s, and the participation window the code\'s', () => {
  const { REGIME_PARAMS: P, PRIMARY } = require('../../scripts/lib/trading/regime');
  const t = flat(read(file('trend-vs-range')));
  assert.ok(t.includes(`ADX(14) at least ${P.trendAdx}`) && t.includes(`at most ${P.maxTrendCrosses} session-VWAP crosses in the last ${P.crossBars} bars`));
  assert.ok(t.includes(`up at least ${P.slopeAtr} ATR(14) over ${P.slopeBars} bars`) && t.includes(`ADX under ${P.rangeAdx} or ${P.rangeCrosses} or more crosses`));
  for (const r of PRIMARY) assert.ok(t.includes(`\`${r}\``), r);
  // relVolLast3VsPrior20: the last 3 bars against the 21 bars before them (slice i-23 .. i-3).
  assert.match(read('scripts/lib/trading/market-snapshot.js'), /const prior20 = mean\(bars\.slice\(Math\.max\(0, i - 23\), i - 2\)\.map\(vol\)\);/);
});

test('basics skills: the setups add no filter, equal highs are the code\'s, and the size cuts hold', () => {
  for (const s of SETUPS) assert.doesNotMatch(flat(read(file(s))), /needs an HTF structure break|is preferred|counts as one AGAINST/, s);
  // The categories (fix/confluence-not-vetoes): six, each once; the HTF break is the side rule's, never a category.
  const cc = flat(read(file('confluence-counting')));
  const cats = [...cc.matchAll(/\| (structure|location|liquidity|trigger|participation|context) \|/g)].map(m => m[1]);
  assert.deepStrictEqual(cats, ['structure', 'location', 'liquidity', 'trigger', 'participation', 'context']);
  assert.ok(flat(read(file('rejection'))).includes('is the trend rule\'s CHoCH tier (`trade-lifecycle`), never counted'));
  // momentum-and-volume puts the indicators in structure, the same vote rule.
  assert.ok(flat(read(file('momentum-and-volume'))).includes('are structure (`confluence-counting`): all with its side FOR, all against AGAINST, mixed neutral.'));
  // Equal highs and lows: two of the last 12 confirmed swings within 0.1 x ATR(14) (market-snapshot.js), stated once,
  // in levels-and-reactions (liquidity-concepts retired: skill-retire.test.js).
  const ms = read('scripts/lib/trading/market-snapshot.js');
  assert.match(ms, /const tol = atrNow \? 0\.1 \* atrNow : 0;/);
  assert.match(ms, /const recentHighs = highs\.slice\(-12\);/);
  assert.ok(flat(read(file('levels-and-reactions'))).includes('two of the last 12 confirmed swing highs (lows) within 0.1 × ATR(14) of each other'));
  assert.doesNotMatch(read(file('levels-and-reactions')), /~2 ticks/);
  // Fair value gaps as the code computes them: the last 60 bars (a strong displacement middle bar, by ATR(14): #129), the
  // last 3 of each kind; an open gap untouched, a partly filled one traded into but not through (low-high the unfilled part).
  assert.match(ms, /function fairValueGaps\(bars, n = 60, atr14 = ind\.atr\(bars, ind\.ATR_PERIOD\)\)/);
  assert.strictEqual(require('../../scripts/lib/trading/indicators').ATR_PERIOD, 14, 'ATR(14), as the skill says');
  assert.match(ms, /openFvgs: open\.slice\(-3\),\n\s*partlyFilledFvgs: partly\.slice\(-3\),/);
  assert.match(ms, /else if \(deepest > g\.low\) partly\.push\(\{ side: 'bullish', low: g\.low, high: deepest, gapLow: g\.low, gapHigh: g\.high, at: g\.at \}\);/);
  // Unsourced numbers stay out of confluence-counting.
  assert.doesNotMatch(read(file('confluence-counting')), /46%|9 minutes|about half|quant audit/);
  // Each role only what it uses: the structure analyst reads levels and sweeps from the small skills.
  // Its core (role-skills) and its index (role-index: looked up as needed in opencode's index mode).
  const skillsOf = r => { const d = parseFrontmatter(read(`agents/${r}.md`)).data; return [...(d['role-skills'] || []), ...(d['role-index'] || [])]; };
  for (const r of ['market-structure-analyst', 'volume-liquidity-analyst']) {
    assert.ok(skillsOf(r).includes('fair-value-gaps') && skillsOf(r).includes('levels-and-reactions'), r);
  }
});

test('basics skills: key sentences pinned; a changed one fails', () => {
  for (const s of SKILLS) {
    const text = read(file(s));
    assert.ok(pinned(s, text), `${s}: ${PINS[s].find(p => !flat(text).includes(p))}`);
    // Mutate each pin (a number or a word changed): the check fails.
    for (const p of PINS[s]) {
      const word = /\b(never|not|no|none|only|one|most|every|weak)\b/i;
      const changed = /\d/.test(p) ? p.replace(/\d+/, d => String(Number(d) + 1)) : word.test(p) ? p.replace(word, 'often') : p.replace(/\w+(?=\W*$)/, 'maybe');
      assert.notStrictEqual(changed, p, `${s}: the pin can be mutated: ${p}`);
      assert.ok(!pinned(s, flat(text).replace(p, changed)), `${s}: mutated "${changed}"`);
    }
  }
});

test('basics skills: take, skip and losing examples, tick-correct', () => {
  for (const s of SKILLS) assert.ok(examples(read(file(s))), s);
  // A wrong tick count, dollar amount or off-tick price fails.
  const good = 'x\n## Examples\nTake: a\nSkip: b\nLoser: orb long at 21503.25, stop 21499.00 (4.25 pts = 17 ticks, $8.50 on 1 MNQ); -17 ticks, -$8.50.\n';
  assert.ok(examples(good));
  for (const [a, b] of [['17 ticks, $8.50 on', '16 ticks, $8.50 on'], ['$8.50 on', '$8.25 on'], ['21503.25', '21503.30'], ['Skip: b\n', '']]) {
    assert.ok(!examples(good.replace(a, b)), b);
  }
});

/** In each example, every stop price after the first lies at or closer than it (never farther from the entry), and no example widens or loosens a stop. */
function stopsNeverWiden(text) {
  const ex = text.slice(text.indexOf('## Examples'));
  if (/(?<!never )\b(?:widen(?:s|ed)?|wider|loosen(?:s|ed)?)\b/i.test(ex)) return false;
  for (const part of ex.split(/\n(?=Take:|Skip:|Loser:)/)) {
    const entry = /\b(long|short) at (\d{5}\.\d\d)/.exec(part);
    const stops = [...part.matchAll(/\bstop(?:ped)?(?: (?:at|to|now|moved to))? (\d{5}\.\d\d)/g)].map(m => Number(m[1]));
    if (!entry || !stops.length) continue;
    const long = entry[1] === 'long';
    if (stops.some(x => (long ? x < stops[0] : x > stops[0]))) return false;
  }
  return true;
}

test('basics skills: no example moves a stop away from risk', () => {
  for (const s of SKILLS) assert.ok(stopsNeverWiden(read(file(s))), s);
  const inv = read(file('invalidation'));
  assert.ok(!stopsNeverWiden(inv.replace('stopped at 21512.50', 'stopped at 21510.50')));
  assert.ok(!stopsNeverWiden(inv.replace('traded through the 15m low', 'the stop moved to 21510.50 and traded through the 15m low')));
  assert.ok(!stopsNeverWiden(inv.replace('in one move', 'in one move; the stop was widened')));
});

test('basics skills: confluence-counting\'s examples count six categories', () => {
  const ex = read(file('confluence-counting')).split('## Examples')[1];
  const counts = [...ex.matchAll(/for (\d), against (\d), neutral (\d)/g)];
  assert.ok(counts.length >= 3);
  for (const [, a, b, c] of counts) assert.strictEqual(Number(a) + Number(b) + Number(c), 6);
  // Each example names the categories it counts, never the trend rule's frames as one.
  for (const line of ex.split('\n').filter(l => /^(?:Take|Skip):/.test(l))) assert.match(line, /structure \(/, line);
  // trader-process's own example uses the same six.
  const tp = /5 Confluence: for (\d), against (\d), neutral (\d)/.exec(read('skills/trader-process/SKILL.md').split('## Examples')[1]);
  assert.strictEqual(Number(tp[1]) + Number(tp[2]) + Number(tp[3]), 6);
});

test('basics skills: examples name existing active strategies (or ones retired on 2026-10-14), and never the retired trend four as strategies', () => {
  for (const s of SKILLS) {
    const text = read(file(s));
    // As strategies: a briefing field named for the indicator (`m3.trend.supertrend`) is data.
    // A read in compose_check's form (`1h bos up`) is a structure break, not the retired strategy.
    assert.doesNotMatch(text.replace(/bos-vs-choch/g, '').replace(/\b\d+[mh] (?:bos|choch) (?:up|down)\b/g, ''), /(?<![.\w])(?:bos|keltner|ema_cross|supertrend)\b/, s);
    for (const m of text.split('## Examples')[1].matchAll(/\b([a-z]+_[a-z0-9_]+|orb)\b (?:long|short)/g)) {
      assert.ok(namedStrategyOk(m[1]), `${s}: ${m[1]}`);
    }
    // Census families cited exist in the catalog.
    const cat = read('docs/research/mtf-setup-catalog.md');
    for (const m of text.matchAll(/\bF(\d)([A-C]?)\b/g)) assert.ok(cat.includes(`F${m[1]}${m[2]}`), `${s}: F${m[1]}${m[2]}`);
  }
});

test('basics skills: candle-reading is confirmation at a level, on completed candles of the stack', () => {
  const t = flat(read(file('candle-reading')));
  assert.ok(t.includes('**Confirmation only, at a level.**') && t.includes('`levels-and-reactions` skill\'s list'));
  for (const tf of ['3m', '5m', '15m', '1h', '4h']) assert.ok(t.includes(`- ${tf}`) || t.includes(`${tf}:`) || t.includes(`${tf} and`) || t.includes(`${tf},`), tf);
  const ex = read(file('candle-reading')).split('## Examples')[1];
  // Every example is at a named level and names the close of its timeframe; one shows the stack agreeing.
  for (const k of ['Take:', 'Skip:', 'Loser:']) assert.match(ex.slice(ex.indexOf(k)), /^[A-Za-z]+: at the [a-zA-Z ]+ \d{5}\.\d\d[^\n]*on the (?:3m|5m|15m|1h|4h) close/, k);
  assert.match(flat(ex), /on the 15m close[^\n]*?on the 1h close[^\n]*?on the 3m close[^\n]*?Stack agrees/);
});

test('basics skills: the two setups, on any timeframe, follow the PLAN steps, on completed candles, at a level', () => {
  for (const s of SETUPS) {
    const text = read(file(s));
    const t = flat(text);
    let at = -1;
    for (const [n, name] of [[1, 'HTF'], [3, 'Location'], [4, 'Setup'], [5, 'Confluence'], [6, 'Entry'], [7, 'Risk'], [9, 'Manage']]) {
      const k = t.indexOf(`- **${n} ${name}**:`);
      assert.ok(k > at, `${s}: step ${n} ${name} in order`);
      at = k;
    }
    assert.ok(t.includes('Completed candles only, on 3m, 5m, 15m, 1h and 4h (`candle-reading`).'), s);
    // The strategies it names exist and are active (or retired on 2026-10-14: the skills are kept as they are).
    // It is a setup read of the one strategy, trade_lifecycle, which compose_check verifies: every strategy it names is active.
    const names = [...t.slice(0, t.indexOf('A read, never a veto')).matchAll(/`([a-z0-9_]+)`/g)].map(m => m[1]).filter(n => n !== 'compose_check');
    assert.deepStrictEqual(names, ['trade_lifecycle'], s);
    for (const n of names) assert.ok(namedStrategyOk(n), `${s}: ${n}`);
    // Generic: the setup is defined on any completed candle, not on one timeframe; its timeframe table has three rows.
    assert.doesNotMatch(t, /\*\*4 Setup\*\*: a completed (?:3m|5m|15m|1h|4h)/, s);
    for (const row of ['| 3m, 5m |', '| 15m |', '| 1h, 4h |']) assert.ok(t.includes(row), `${s}: ${row}`);
    assert.ok(t.includes('| Timeframe | What it reads | Weight |') && t.includes('| least |') && t.includes('| most |'), `${s}: the weight by timeframe`);
    // The multi-timeframe form is the best practice, pointed to the reads that define it, not restated.
    for (const p of ['trend-vs-range', 'pullback-vs-reversal', 'bos-vs-choch', 'candle-reading', 'levels-and-reactions']) assert.ok(t.includes(`\`${p}\``), `${s}: ${p}`);
    const ex = text.split('## Examples')[1];
    const tfs = new Set();
    for (const k of ['Take:', 'Skip:', 'Loser:']) {
      const m = /^[A-Za-z]+: at the [a-zA-Z ]+ \d{5}\.\d\d[^]*?on the (3m|5m|15m|1h|4h) close/.exec(ex.slice(ex.indexOf(k)));
      assert.ok(m, `${s} ${k}`);
      tfs.add(m[1]);
    }
    // The examples show the setup on at least two different timeframes.
    assert.ok(tfs.size >= 2, `${s}: examples on ${[...tfs].join(', ')}`);
  }
});

test('basics skills: each role carries exactly its own, says to load them, and trader-process points to them', () => {
  for (const [role, mine] of Object.entries(ROLES)) {
    const { data, body } = parseFrontmatter(read(`agents/${role}.md`));
    // Its core (role-skills) or its index (role-index); the load sentence names both.
    const has = SKILLS.filter(s => [...(data['role-skills'] || []), ...(data['role-index'] || [])].includes(s));
    assert.deepStrictEqual(has.sort(), [...mine].sort(), role);
    const said = /Load the\s+skills?\s+([^.]*)\./.exec(flat(body));
    for (const s of mine) assert.ok(said && said[1].includes(`\`${s}\``), `${role}: ${s}`);
  }
  const tp = read('skills/trader-process/SKILL.md');
  const step = n => tp.slice(tp.indexOf(`${n}. **`), tp.indexOf(`${n + 1}. **`) > 0 ? tp.indexOf(`${n + 1}. **`) : tp.indexOf('### Roles'));
  const POINTERS = { 1: ['trend-vs-range'], 3: ['levels-and-reactions', 'breakout-vs-fakeout'], 4: ['pullback-vs-reversal', 'cisd'], 6: ['candle-reading'], 9: ['invalidation'] };
  // Step 5 counts confluence-counting's six categories.
  assert.ok(flat(step(5)).includes('The six categories of `confluence-counting`.'));
  for (const [n, list] of Object.entries(POINTERS)) for (const s of list) assert.match(step(Number(n)), new RegExp(`Read: [^\\n]*\`${s}\``), `step ${n}: ${s}`);
  assert.match(flat(step(4)), /setups: `rejection`, `breakout`, `fair-value-gaps`\./);
  // One home per topic: the older skills point to the new ones instead of restating them.
  // (market-structure and liquidity-concepts are retired; their content's homes: skill-retire.test.js.)
  assert.ok(read(file('levels-and-reactions')).includes('`fair-value-gaps`'), 'levels-and-reactions points to fair-value-gaps');
  assert.ok(read(file('fair-value-gaps')).includes('`levels-and-reactions`'), 'fair-value-gaps points to levels-and-reactions');
  assert.match(read('skills/vwap-volume-profile/SKILL.md'), /`momentum-and-volume` skill's[^]*the `absorption` skill/);
  assert.match(read('skills/trend-momentum-indicators/SKILL.md'), /`trend-vs-range` skill's/);
  // The generated opencode roles carry them: in full mode (FTH_ROLE_SKILLS=full) embedded; in the committed file
  // (index, the default) embedded when in the role's core (role-skills), else one line of its skill index.
  const { expectedFiles, loadAgents } = require('../../scripts/lib/harness-sync');
  const full = JSON.parse(expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);
  const oc = JSON.parse(read('workspace/opencode.json'));
  const core = Object.fromEntries(loadAgents(ROOT).map(a => [a.name, a.skills]));
  for (const [role, mine] of Object.entries(ROLES)) {
    for (const s of SKILLS) {
      const body = parseFrontmatter(read(file(s))).body.trim();
      const embedded = p => p.includes(`<skill name="${s}">\n${body}\n</skill>`);
      assert.strictEqual(embedded(full.agent[role].prompt), mine.includes(s), `${role}: ${s} (full)`);
      const prompt = oc.agent[role].prompt;
      assert.strictEqual(embedded(prompt), mine.includes(s) && core[role].includes(s), `${role}: ${s} (index: embedded)`);
      assert.strictEqual(prompt.includes(`\n- ${s}: `), mine.includes(s) && !core[role].includes(s), `${role}: ${s} (index: listed)`);
    }
  }
});

// The BOS and CHoCH definitions moved out of market-structure: each has exactly one home, bos-vs-choch.
const MOVED = [
  'The latest BOS or CHoCH (`lastBreak`) is computed there from confirmed swings: never call it by eye.',
  'Confirmed fractal swings (k=2: a pivot with 2 strictly lower highs or higher lows on each side, confirmed 2 bars later).',
  'BOS: a close beyond the last swing in the trend\'s direction.',
  'CHoCH: the first close beyond the last swing against it, an early warning, not a reversal by itself (the `pullback-vs-reversal` skill).',
  'A wick through a swing that closes back inside is a sweep, not a break (the `breakout-vs-fakeout` skill).',
  'A 3-minute BOS against a 1-hour downtrend is a counter-trend trade.',
];

test('bos-vs-choch: every BOS/CHoCH sentence moved from market-structure has exactly one home, and the old skills point to it', () => {
  const all = fs.readdirSync(path.join(ROOT, 'skills')).filter(d => fs.existsSync(path.join(ROOT, 'skills', d, 'SKILL.md')));
  for (const sentence of MOVED) {
    const homes = all.filter(d => flat(read(file(d))).includes(sentence));
    assert.deepStrictEqual(homes, ['bos-vs-choch'], sentence);
  }
  // A sentence in a second skill (two homes) fails. (market-structure itself is retired: skill-retire.test.js.)
  assert.ok(!fs.existsSync(path.join(ROOT, 'skills', 'market-structure')));
  const other = flat(read(file('pullback-vs-reversal')));
  assert.ok(!other.includes('BOS: a close'));
  const twoHomes = d => [flat(read(file('bos-vs-choch'))), `${other} ${MOVED[2]}`].filter(x => x.includes(d)).length;
  assert.strictEqual(twoHomes(MOVED[2]), 2);
  // The reads that use structure breaks point to it.
  for (const s of ['trend-vs-range', 'pullback-vs-reversal', 'rejection', 'breakout', 'confluence-counting', 'invalidation']) {
    assert.ok(read(file(s)).includes('`bos-vs-choch`'), s);
  }
});

test('bos-vs-choch: the description is short, and the swings and breaks are the code\'s', () => {
  const { data } = parseFrontmatter(read(file('bos-vs-choch')));
  assert.ok(String(data.description).length <= 160, `${String(data.description).length} characters`);
  // Swings: strictly above (below) the k bars on each side, k = 2, confirmed k bars later; the 15m and 1h use the default.
  const se = read('scripts/lib/trading/structure-events.js');
  assert.match(se, /function pivots\(bars, k = AN\.indicators\.swingK\)/);
  assert.strictEqual(require('../../scripts/lib/tunables').analysis().indicators.swingK, 2, 'config/analysis.json: the swing confirmation the skill teaches');
  assert.match(se, /if \(!\(bars\[j\]\.h > bars\[m\]\.h\)\) hi = false;/);
  assert.match(se, /confirmedAt: j \+ k/);
  // Breaks: a close strictly beyond the last unbroken swing, once; BOS with the previous break's direction, else CHoCH.
  assert.match(se, /\(direction === 'up' && c > swing\.price\) \|\| \(direction === 'down' && c < swing\.price\)/);
  assert.match(se, /kind: prev && prev\.direction !== direction \? 'CHoCH' : 'BOS'/);
  assert.match(se, /if \(direction === 'up'\) hi = null; else lo = null;/);
  const br = read('scripts/lib/trading/briefing.js');
  assert.match(br, /lastBreak: lastBreaks\(bars\),/);
  assert.match(br, /lastBreak: atClose\(lastBreaks\(c15\), 15\),/);
  assert.match(br, /lastBreak: atClose\(lastBreaks\(c60\), 60\)/);
  // On a real briefing: the kinds and directions the skill names, knownAt on 15m and 1h, and no 4h break.
  const bs = briefings();
  let n = 0;
  for (const b of bs) {
    for (const [sec, k] of [['m3', null], ['m15', 'knownAt'], ['h1', 'knownAt']]) {
      for (const x of [b.sections[sec].data.lastBreak.last, b.sections[sec].data.lastBreak.previous].filter(Boolean)) {
        n += 1;
        assert.ok(['BOS', 'CHoCH'].includes(x.kind) && ['up', 'down'].includes(x.direction) && Number.isInteger(x.barsAgo), sec);
        if (k) assert.ok(x[k], `${sec} ${k}`);
      }
    }
    assert.ok(!resolves(b, 'h1.h4.lastBreak') && resolves(b, 'h1.h4.swingPattern'));
  }
  assert.ok(n >= 6, `${n} breaks checked`);
  // Wicks are no break: a bar trading through the swing and closing back inside makes none.
  const { lastBreaks } = require('../../scripts/lib/trading/structure-events');
  const bar = (h, l, c) => ({ t: new Date(Date.UTC(2026, 0, 5, 15, 0) + 180000 * bar.n++).toISOString(), o: c, h, l, c });
  bar.n = 0;
  const base = [bar(10, 9, 9.5), bar(11, 9.5, 10), bar(13, 10, 12), bar(12, 10.5, 11), bar(11.5, 10, 10.5)];
  assert.strictEqual(lastBreaks([...base, bar(13.5, 11, 12.75)]).last, null);
  assert.strictEqual(lastBreaks([...base, bar(13.5, 11, 13.25)]).last.kind, 'BOS');
});

test('bos-vs-choch: the timeframes are read top-down, the same logic in the setups and invalidation', () => {
  const t = flat(read(file('bos-vs-choch')));
  for (const tf of ['| 3m, 5m |', '| 15m |', '| 1h (4h swings) |']) assert.ok(t.includes(tf), tf);
  assert.doesNotMatch(t, /\bthe (?:key|main) (?:structural )?(?:signal|evidence)\b/);
  for (const s of ['bos-vs-choch', 'rejection', 'breakout', 'invalidation']) {
    assert.match(flat(read(file(s))), /timeframe or higher/, s);
  }
});

test('compression: the skill states the code\'s numbers (config/analysis.json compression), and its reads are the checker\'s forms', () => {
  const P = require('../../scripts/lib/trading/compression').PARAMS;
  const t = flat(read(file('compression')));
  assert.deepStrictEqual(P.nr, [7], 'the skill teaches the config\'s NR length');
  const states = q => t.includes(`\`nr${q.nr[0]}\`: the narrowest range of the last ${q.nr[0]} back-to-back candles`)
    && t.includes(`in the ${q.poleBars} candles just before the box`)
    && t.includes(`CLOSES beyond the box by ${q.minBeyondAtr} x ATR or more`) && t.includes(`its range ${q.expandAtr} x ATR or more`)
    && t.includes(`within ${q.recentBars} candles`) && t.includes(`under ${q.maxRunAtr} x ATR past its close`);
  assert.ok(states(P), 'the skill states the config\'s numbers');
  // A changed number in the config fails the check (the check reads the config, not the text).
  for (const k of ['poleBars', 'minBeyondAtr', 'expandAtr', 'recentBars', 'maxRunAtr']) assert.ok(!states({ ...P, [k]: P[k] + 1 }), k);
  assert.ok(!states({ ...P, nr: [P.nr[0] + 1] }));
  // Each read the skill teaches parses into the checker's form and step.
  const CR = require('../../scripts/lib/trading/composed-reads');
  const reads = /Reads: (.+?) \(\d+\.\d+R\); hit/.exec(t)[1].split(', ');
  assert.deepStrictEqual(reads.map(x => CR.parseRead(x).kind), ['compression', 'close', 'stop', 'target'], reads.join('; '));
  // candle-reading's displacement and breakout point to it.
  assert.match(flat(read(file('candle-reading'))), /it starts a leg, out of a box \(`compression`\)/);
  assert.match(flat(read(file('breakout'))), /Out of a tight box: `compression`\./);
});

test('basics skills: the fib numbers have one home: fib-retracement states the code\'s, cisd restates none', () => {
  const { LEVELS, OTE } = require('../../scripts/lib/trading/fib');
  const cisd = require('../../scripts/lib/trading/cisd');
  const text = read(file('fib-retracement'));
  const t = flat(text);
  assert.ok(t.includes(`The levels read: ${LEVELS.slice(0, -1).join(', ')} and ${LEVELS[LEVELS.length - 1]}.`), 'the levels are fib.LEVELS');
  assert.ok(t.includes(`is ${OTE.from} to ${OTE.to} of the leg, mid ${OTE.mid}`), 'the golden zone is fib.OTE');
  // Every ratio the skill names (its examples' computed retracements aside) is one of the code's.
  const known = new Set([...LEVELS, OTE.from, OTE.to, OTE.mid].map(String));
  for (const m of text.split('## Examples')[0].matchAll(/\b0\.\d+\b/g)) assert.ok(known.has(m[0]), `fib-retracement names ${m[0]}, not a code ratio`);
  // A changed ratio in the code (or the skill) fails.
  assert.ok(!flat(text.replaceAll('0.705', '0.71')).includes(`mid ${OTE.mid}`));
  // cisd points to them, restating no ratio (as 0.62 or 62%). (The cisd_ote strategy, checked here too, retired on 2026-10-14.)
  const RATIO = /\b0?\.(?:5|618|62|705|79)\b|\b(?:50|61\.8|62|70\.5|79)%/;
  assert.doesNotMatch(read(file('cisd')), RATIO);
  assert.match(read(file('cisd')), /`fib-retracement`/);
  // The CISD skill's run and wait are the code's defaults.
  const c = flat(read(file('cisd')));
  assert.ok(c.includes(`at least ${cisd.PARAMS.minRun} consecutive bearish completed candles`) && c.includes(`within ${cisd.PARAMS.maxWait} candles of the run`));
  // Its strong displacement is the code's: the body share, the extreme third, the range against ATR(14), engulfing.
  assert.ok(c.includes(`body at least ${cisd.PARAMS.minBody} of the range, the close in the top third, and a range of at least ${cisd.PARAMS.minRangeAtr.toFixed(1)} x ATR(14) of that timeframe or a body engulfing the prior one`));
  // Every bare field the cisd skill names is in a real briefing's m3.cisd entry (or its leg), and every status it names
  // is one the code sets: a field the briefing drops fails.
  const entries = briefings().flatMap(b => Object.values(b.sections.m3.data.cisd || {}).filter(x => x && typeof x === 'object'));
  assert.ok(entries.length, 'a CISD in the briefings');
  const keys = new Set(entries.flatMap(x => [...Object.keys(x), ...Object.keys(x.leg || {})]));
  const skills = new Set(fs.readdirSync(path.join(ROOT, 'skills')));
  const STATUS = ['waiting', 'touched', 'bounced', 'void', 'expired', 'weak'];
  // Values of other briefing fields it names (the regime, the swing pattern), each the code's.
  const VALUES = { transition: 'scripts/lib/trading/regime.js', range: 'scripts/lib/trading/regime.js', mixed: 'scripts/lib/trading/mtf.js', unclear: 'scripts/lib/trading/mtf.js' };
  // Its dotted briefing paths resolve on a real briefing, and the regime values it names are regime.js's.
  const bs = briefings();
  const dotted = pathsIn(read(file('cisd')));
  assert.ok(dotted.includes('m3.regime.primary') && dotted.includes('m15.frame.swingPattern'), dotted.join(', '));
  for (const pth of dotted) assert.ok(bs.some(b => resolves(b, pth)), `cisd names ${pth}`);
  const { PRIMARY } = require('../../scripts/lib/trading/regime');
  for (const v of ['transition', 'range']) assert.ok(PRIMARY.includes(v), v);
  // Chop is the measured filter (a transition regime), never the range regime's own conditions (ADX under 18, 5+ crosses).
  assert.doesNotMatch(flat(read(file('cisd'))), /under 18|5\+ crosses|adxSlope/);
  const src = read('scripts/lib/trading/cisd.js');
  for (const m of read(file('cisd')).matchAll(/`([a-zA-Z]+)`/g)) {
    const w = m[1];
    if (skills.has(w) || w === 'unknown') continue;
    if (VALUES[w]) assert.ok(read(VALUES[w]).includes(`'${w}'`), `${w} is ${VALUES[w]}'s`);
    else if (STATUS.includes(w)) assert.ok(src.includes(`'${w}'`), `status ${w} is the code's`);
    else assert.ok(keys.has(w), `cisd names \`${w}\`, not in the briefing's m3.cisd`);
  }
  for (const k of ['displacement', 'engulfing']) assert.ok(keys.has(k), k);
  // fib-retracement stays generic: no displacement-strength rules (they are the cisd skill's).
  assert.doesNotMatch(text, /displacement|engulf|doji|\bstrong\b|\bweak\b/i, 'fib-retracement names no displacement rule');
  assert.match(flat(read(file('cisd'))), /strong/);
  // pullback-vs-reversal points to both in a few words.
  assert.match(flat(read(file('pullback-vs-reversal'))), /A CISD \(`cisd`\) is an earlier sign than the CHoCH; depth in fib terms: `fib-retracement`\./);
});

// The two procedures of the multi-timeframe read: today's bias (daily-bias) and the top-down read to the entry
// (top-down-entry, split from htf-to-ltf). Not basics (no take/skip/loser format), but the same checks where they apply:
// every briefing field named resolves on a real briefing, the ordered steps are pinned, the examples are tick-correct,
// and both stay reads that yield to the trend rule.
const PROCEDURES = {
  'daily-bias': { section: '### Today\'s bias, step by step', steps: ['Prior day\'s candle', 'Price against the prior day', 'The open', '1h and 4h structure', 'Regime', 'Write it'] },
  'top-down-entry': { section: '## How It Works', steps: ['HTF: side and level', '15m: the setup there', '3m/5m: the trigger', 'Where the idea is wrong', 'Where it aims'] },
};

/** The procedure's numbered steps, in order, inside its section (before the next heading). */
function stepsInOrder(text, { section, steps }) {
  const at = text.indexOf(`\n${section}\n`);
  if (at < 0) return false;
  const body = text.slice(at).split(/\n#{2,3} /)[1];
  let last = -1;
  return steps.every((s, k) => {
    const i = body.indexOf(`\n${k + 1}. **${s}.**`);
    const ok = i > last;
    last = i;
    return ok;
  }) && !body.includes(`\n${steps.length + 1}. **`);
}

test('daily-bias and top-down-entry: every briefing field named resolves on a briefing built by briefing.js; an invented one fails', () => {
  const bs = briefings();
  const named = Object.keys(PROCEDURES).flatMap(s => pathsIn(read(file(s))).map(p => [s, p]));
  for (const [s, p] of named) assert.ok(bs.some(b => resolves(b, p)), `${s}: ${p}`);
  const paths = named.map(([, p]) => p);
  for (const p of ['day.priorRthCandle', 'm3.location.priorRthClose', 'm3.today.openType', 'h1.lastBreak.last', 'h1.h4.swingPattern', 'm3.trendRule', 'm3.swingTargets', 'candidate.inTheWay']) {
    assert.ok(paths.includes(p), `named: ${p}`);
  }
  assert.ok(paths.length >= 14, `${paths.length} paths checked`);
  // The candle's fields the skill names in backticks are the briefing's own.
  const candle = bs.map(b => b.sections.day.data.priorRthCandle).find(Boolean);
  for (const k of ['dir', 'closeLocation', 'closeVsDayBefore']) assert.ok(k in candle && read(file('daily-bias')).includes(`\`${k}\``), k);
  assert.ok(!bs.some(b => resolves(b, 'day.priorRthCandle.pattern')) && !bs.some(b => resolves(b, 'h1.h4.lastBreak')));
});

test('daily-bias and top-down-entry: the procedures\' steps are pinned in order; a changed, dropped or reordered step fails', () => {
  for (const [s, proc] of Object.entries(PROCEDURES)) {
    const text = read(file(s));
    assert.ok(stepsInOrder(text, proc), s);
    assert.ok(!stepsInOrder(text.replace(`**${proc.steps[1]}.**`, '**Something else.**'), proc), `${s}: changed`);
    assert.ok(!stepsInOrder(text.replace(`${proc.section}\n`, '### Elsewhere\n'), proc), `${s}: the section renamed`);
    const one = new RegExp(`\\n1\\. \\*\\*${proc.steps[0].replace(/[/.]/g, '\\$&')}\\.\\*\\*`);
    const two = new RegExp(`\\n2\\. \\*\\*${proc.steps[1].replace(/[/.]/g, '\\$&')}\\.\\*\\*`);
    assert.ok(!stepsInOrder(text.replace(one, '\n2. **X.**').replace(two, `\n1. **${proc.steps[0]}.**`), proc), `${s}: reordered`);
  }
  const db = flat(read(file('daily-bias')));
  for (const pin of [
    'The higher one sets the side; the 1h against it lowers the confidence.',
    'Long, short or neutral; high when steps 1-5 all back it, medium when one does not, low when two or more do not;',
    '**Flips intraday**: a 1h CHoCH against it, or closes back inside the prior range after a breakout of it.',
    '**Neutral**: expect two-sided trade; the range\'s extremes (prior range, value, overnight) are the better locations.',
    'A holiday or early-close prior day is a weak read.',
    '`m3.location.priorRthClose` (`above`, `below`, `at`)',
  ]) assert.ok(db.includes(pin), pin);
  // Neutral is a read, not a filter.
  assert.doesNotMatch(db, /or nothing|stand aside/);
  // The values the bias names are the code's: the candle against the day before, price against the close, the open, the regime.
  const ms = read('scripts/lib/trading/market-snapshot.js');
  for (const v of ['above its high', 'below its low', 'inside its range']) assert.ok(ms.includes(`'${v}'`), v);
  assert.ok(read('scripts/lib/trading/briefing.js').includes('(p > level ? \'above\' : p < level ? \'below\' : \'at\')'));
  assert.ok(read('scripts/lib/trading/day-context.js').includes('return \'open-auction\';'));
  assert.match(db, /an open-auction is two-sided/);
  const { PRIMARY } = require('../../scripts/lib/trading/regime');
  assert.ok(PRIMARY.includes('range') && PRIMARY.includes('transition'));
});

test('daily-bias and top-down-entry: reads that yield to the trend rule; the stop and exit stay the strategy\'s', () => {
  const YIELD = 'the trend rule (`multi-timeframe-analysis`) and the priority order (strategy-library) decide entries. Against the prevailing trend, trend strategies wait';
  for (const s of Object.keys(PROCEDURES)) assert.ok(flat(read(file(s))).includes(YIELD), s);
  assert.ok(flat(read(file('daily-bias'))).includes('it never points at a side the rule refuses.'));
  const top = flat(read(file('top-down-entry')));
  for (const pin of [
    '**HTF: side and level.** The side the trend rule allows (`m3.trendRule`); today\'s bias (`daily-bias`) sets the confidence, never a side the rule refuses.',
    'check that the strategy\'s stop sits beyond it.',
    'is the first level ahead: a read to weigh, not a pass.',
    'The stop and exit stay the strategy\'s (the priority order, step 2: a reversal takes the nearest target).',
    'Completed candles only, on every timeframe.',
    'the HTF gives the side, the LTF only the timing.',
  ]) assert.ok(top.includes(pin), pin);
  // The counter example: the trend rule's side wins over a rejection at a level.
  assert.match(top, /2022-08-12, trend rule 4h up\.[^`]*shorts are not the side the rule allows/);
});

test('daily-bias, htf-to-ltf and top-down-entry: pointers, small, short "Use when" descriptions; the head trader\'s per-cycle load does not grow', () => {
  const skills = new Set(fs.readdirSync(path.join(ROOT, 'skills')));
  for (const s of [...Object.keys(PROCEDURES), 'htf-to-ltf']) {
    const text = read(file(s));
    const { data, body } = parseFrontmatter(text);
    assert.match(data.description, /^Use when /, s);
    assert.ok(data.description.length <= 160, `${s}: description ${data.description.length}`);
    assert.ok(Buffer.byteLength(body) <= skillByteCap(s), `${s}: ${Buffer.byteLength(body)} bytes`);
    // Every skill it names in backticks exists.
    for (const m of text.matchAll(/`([a-z]+(?:-[a-z0-9]+)+)`/g)) {
      if (/^(?:open|trend)-/.test(m[1])) continue; // values (an open type, a regime), not skills
      assert.ok(skills.has(m[1]), `${s} names \`${m[1]}\``);
    }
  }
  for (const s of Object.keys(PROCEDURES)) assert.ok(read(file(s)).includes('back-adjusted CSV prices'), `${s}: the examples say their prices are back-adjusted`);
  // htf-to-ltf points to the top-down read in one line; the top-down read points to the reads it uses, never restates them.
  assert.ok(flat(read(file('htf-to-ltf'))).includes('Top down: `top-down-entry`.'));
  assert.doesNotMatch(read(file('htf-to-ltf')), /### 3\. Top down/);
  const top = read(file('top-down-entry'));
  for (const p of ['htf-to-ltf', 'daily-bias', 'levels-and-reactions', 'rejection', 'breakout', 'cisd', 'pullback-vs-reversal', 'bos-vs-choch', 'candle-reading', 'momentum-and-volume', 'invalidation']) {
    assert.ok(top.includes(`\`${p}\``), p);
  }
  // Referenced, never embedded: no role lists it (full mode would embed it); the market-structure analyst's body names it
  // in its setup step and looks it up as needed; the head trader never loads it every cycle.
  for (const f of fs.readdirSync(path.join(ROOT, 'agents'))) {
    const d = parseFrontmatter(read(`agents/${f}`)).data;
    assert.ok(![...(d['role-skills'] || []), ...(d['role-index'] || [])].includes('top-down-entry'), f);
  }
  const msa = read('agents/market-structure-analyst.md');
  assert.ok(flat(msa).includes('The steps from level to entry: the `top-down-entry` skill (`skill_lookup` when a setup forms at a level).'));
  assert.ok(!/Load the\s+skills?\s+[^.]*`top-down-entry`/.test(flat(msa)), 'not in the load sentence');
  assert.ok(!JSON.parse(read('workspace/opencode.json')).agent['market-structure-analyst'].prompt.includes('<skill name="top-down-entry">'), 'not embedded');
  const ts = read('skills/trade-session/SKILL.md');
  const step0 = flat(ts.slice(ts.indexOf('### 0. Load the skills'), ts.indexOf('### 1.')));
  assert.ok(!step0.includes('top-down-entry'));
  // What the head trader loads every cycle (trade-session step 0: the gated three, trader-process, htf-to-ltf; the
  // strategy skills only for a rules entry, so not per cycle since trade_lifecycle is the entry strategy), in
  // bytes, is no more than at the split's merge (foundation batch B, on main at 507adfbd, whose same load without htf-to-ltf
  // was 58878): 55733.
  const loads = [...new Set([...step0.matchAll(/`([a-z][a-z-]+)`/g)].map(m => m[1]))].filter(x => skills.has(x) && !/^strategy-/.test(x));
  // confluence-counting every cycle too (fix/confluence-not-vetoes: the count that decides take or pass).
  assert.deepStrictEqual(loads.sort(), ['confluence-counting', 'htf-to-ltf', 'multi-timeframe-analysis', 'trade-lifecycle', 'trade-session', 'trader-process']);
  const bytes = loads.reduce((a, x) => a + Buffer.byteLength(read(file(x))), 0);
  assert.ok(bytes <= 55733, `the head trader's per-cycle load: ${bytes} bytes`);
});

/** Every trade in an example: long or short at E, stop S (P pts = T ticks, $D per MNQ), on the tick and consistent; a target X (Q pts, RR) when given. */
function topDownExamples(text) {
  const ex = text.slice(text.indexOf('## Examples'));
  const trades = [...ex.matchAll(/(long|short) (\d+\.\d\d), stop (\d+\.\d\d)[^(]*\((\d+\.\d\d) pts = (\d+)\s+ticks, \$(\d+\.\d\d) per MNQ\)(?:;\s+target[^(]*?(\d+\.\d\d) \((\d+\.\d\d) pts, (\d+\.\d\d)R\))?/g)];
  if (!trades.length) return false;
  const prices = [...ex.matchAll(/\b(\d{5}\.\d\d)\b/g)].map(k => Number(k[1]));
  return prices.every(p => Number.isInteger(p / 0.25)) && trades.every(m => {
    const [, side, e, s, pts, ticks, usd, x, q, r] = m;
    const [E, S, P, T, D] = [e, s, pts, ticks, usd].map(Number);
    const long = side === 'long';
    const stopOk = (long ? S < E : S > E) && Math.abs(Math.abs(E - S) - P) < 1e-9 && P / 0.25 === T && T * 0.5 === D;
    if (x === undefined) return stopOk;
    const [X, Q, R] = [x, q, r].map(Number);
    return stopOk && (long ? X > E : X < E) && Math.abs(Math.abs(X - E) - Q) < 1e-9 && Math.abs(Q / P - R) < 0.005;
  });
}

test('daily-bias and top-down-entry: the examples are tick-correct (NQ 0.25 tick; MNQ $0.50 a tick)', () => {
  const top = read(file('top-down-entry'));
  assert.ok(topDownExamples(top));
  assert.strictEqual([...top.split('## Examples')[1].matchAll(/ per MNQ\)/g)].length, 2, 'both trades checked');
  for (const s of Object.keys(PROCEDURES)) {
    const ex = read(file(s)).split('## Examples')[1];
    for (const m of ex.matchAll(/\b(\d{5}\.\d\d)\b/g)) assert.ok(Number.isInteger(Number(m[1]) / 0.25), `${s}: ${m[1]}`);
  }
  // A wrong tick count, dollar amount, R, side or off-tick price fails, in either trade.
  const good = '## Examples\nlong 14960.00, stop 14938.50 under the low (21.50 pts = 86 ticks, $43.00 per MNQ);\ntarget 15040.25 (80.25 pts, 3.73R)\n'
    + 'short 16789.25, stop 16814.00 (24.75 pts = 99 ticks, $49.50 per MNQ).\n';
  assert.ok(topDownExamples(good));
  for (const [a, b] of [['86 ticks', '85 ticks'], ['$43.00', '$43.50'], ['3.73R', '3.50R'], ['15040.25', '15040.30'], ['stop 14938.50', 'stop 14981.50'], ['99 ticks', '98 ticks'], ['$49.50', '$49.00'], ['stop 16814.00', 'stop 16764.50']]) {
    assert.ok(!topDownExamples(good.replace(a, b)), b);
  }
});
