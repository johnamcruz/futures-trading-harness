'use strict';

// One authority for the class word (round 17, owner: "Make sure to fix Competing definitions" and "Need to make sure it's
// clear and avoid confusion"): the printed Market state line. The head core's table keys only on what that line prints
// (its state word, a pullback their way, its last part); one row fits each line, and the row's class is the one code
// computes (market-state.js classWordOf). No other taught row or sentence maps a frame condition to a class word.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Q = require('../../scripts/lib/eval/context-quiz');
const M = require('../../scripts/lib/trading/market-state');

const ROOT = path.join(__dirname, '..', '..');
const flat = t => t.replace(/\s+/g, ' ');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const an = require('../../scripts/lib/tunables').analysis();
const TH = { crossesChop: an.regime.rangeCrosses, maxPullbackDepth: an.pullbackRead.maxStateDepth };

// The table as taught (trade-session step 3): each row the printed word -> one class word -> one action.
const ROWS = [
  "| `chop` | none | any | `chop` | sit out |",
  "| any other | any | `(not aligned)` | `unclear` | no trend trade |",
  "| any other | printed | aligned | that trend class | wait for the 15m turn (a live strong 15m CISD, a 15m BOS, a 15m CHoCH back or a 15m reaction at the level); enter on the first 3m BOS or CISD the side's way near value (`pullback-vs-reversal` steps 4-7) |",
  "| `forming` | none | aligned | that trend class | no setup yet: wait for the first RTH 3m break |",
  "| `trend`, their way | none | aligned | that trend class | setups the side's way |",
  "| `ranging` | none | aligned | that trend class | setups at the range edge or on a breakout, the side's way |",
  "| `trend`, against them | none | aligned | `unclear` | no trade, never counter |",
];
// Each row read off a printed line: [the row's key on the line, its class given the 4h + 1h way].
const parse = line => {
  const body = line.replace(/^Market state \(3m\): /, '');
  const word = /^(chop|forming|ranging|trend (?:up|down))/.exec(body)[1];
  const align = /; 4h\+1h (up|down)$/.exec(body);
  const way = align ? align[1] : null;
  const pb = way !== null && (body.includes(`; pullback (${way === 'up' ? 'long' : 'short'} leg`) || body.includes(`; 15m ${way}: a pullback in the 15m trend`));
  return { word, way, notAligned: / \(not aligned\)$/.test(body), pb };
};
const KEYS = [
  [p => p.word === 'chop' && !p.pb, () => 'chop'],
  [p => p.word !== 'chop' && p.notAligned, () => 'unclear'],
  [p => p.word !== 'chop' && p.pb && p.way !== null, p => `trend-${p.way}`],
  [p => p.word === 'forming' && !p.pb && p.way !== null, p => `trend-${p.way}`],
  [p => p.word === `trend ${p.way}` && !p.pb && p.way !== null, p => `trend-${p.way}`],
  [p => p.word === 'ranging' && !p.pb && p.way !== null, p => `trend-${p.way}`],
  [p => /^trend /.test(p.word) && p.word !== `trend ${p.way}` && !p.pb && p.way !== null, () => 'unclear'],
];

// Synthetic briefings across the precedence's combinations (the quiz's reader of printed lines, the live code's state).
function lines() {
  const bias = ['- Bias: long only (4h up, 1h up; short refused).', '- Bias: short only (4h down, 1h down; long refused).', '- Bias: long only (4h range, 1h up; short refused).', '- Bias: no side (4h up, 1h down) → no entry.'];
  const pull = ['', '- Pullback (15m, long leg 21462.5 -> 21538.75): depth 40% of the leg; 10 bars since the extreme.', '- Pullback (15m, short leg 21538.75 -> 21462.5): depth 40% of the leg; 10 bars since the extreme.', '- Pullback (15m, long leg 21462.5 -> 21538.75): depth 80% of the leg; 10 bars since the extreme.'];
  const breaks = ['', '- m3.lastBreak: none since the RTH open.', '- m3.lastBreak: last BOS up at 21500.00 (barsAgo 1), previous BOS up at 21480.00 (barsAgo 6).',
    '- m3.lastBreak: last BOS down at 21500.00 (barsAgo 1), previous BOS down at 21520.00 (barsAgo 6).', '- m3.lastBreak: last CHoCH down at 21500.00 (barsAgo 1), previous CHoCH up at 21510.00 (barsAgo 4).',
    '- m3.lastBreak: last CHoCH up at 21510.00 (barsAgo 1), previous CHoCH down at 21500.00 (barsAgo 4).', '- m3.lastBreak: last BOS down at 21500.00 (barsAgo 1), previous CHoCH down at 21510.00 (barsAgo 5).',
    '- m3.lastBreak: last CHoCH up at 21510.00 (barsAgo 2), previous BOS down at 21500.00 (barsAgo 8).', '- m3.lastBreak: last BOS up at 21495.00 (barsAgo 3; protected low 21480.25, broken at 10:39), previous BOS up at 21470.50 (barsAgo 10).'];
  const m15 = ['', '- m15.frame.trend: up.', '- m15.frame.trend: down.', '- m15.frame.trend: up.\n- m15.lastBreak: last BOS up at 21505.00 (barsAgo 0)', '- m15.frame.trend: down.\n- m15.lastBreak: last BOS down at 21495.00 (barsAgo 0)'];
  const day = ['', '- Day so far (23 3m bars; `day-context`): rotational: efficiency 0.05 (x sqrt(bars) 0.24), RTH VWAP crosses 8, range 3.2 x 3m ATR(14), net up.'];
  const extra = ['', '- CISD (3m): 3m bullish at 21512.00 (closed 10:39, strong), waiting.\n- Price 21512.'];
  const out = new Map();
  for (const b of bias) for (const p of pull) for (const l of breaks) for (const f of m15) for (const d of day) for (const x of extra) {
    const text = ['Briefing lines (synthetic, 10:42 ET), flat:', b, p, l, f, d, x].filter(Boolean).join('\n');
    const s = M.stateOf(Q.briefingOfText(text), TH);
    const line = M.marketStateLine(s);
    if (!out.has(line)) out.set(line, M.classWordOf(s));
  }
  return out;
}

test('market state authority: the head core\'s table keys only on what the line prints; one row fits each printed line, its class code\'s', () => {
  const ts = flat(read('skills/trade-session/SKILL.md'));
  for (const r of ROWS) assert.ok(ts.includes(r), r);
  const table = ts.slice(ts.indexOf('| state word | pullback their way | end | class | action |'), ts.indexOf('Chop ends when the line prints'));
  assert.strictEqual(table.split('|---|---|---|---|---|').length, 2, 'one table, five columns');
  // No exception inside the table: precedence is code's, applied before the line prints.
  assert.doesNotMatch(table, /\bunless\b|\bexcept\b|but if/i);
  const all = lines();
  assert.ok(all.size >= 20, `${all.size} distinct printed lines`);
  const words = new Set();
  for (const [line, cls] of all) {
    const p = parse(line);
    words.add(p.word.split(' ')[0] + (p.pb ? '+pb' : '') + (p.notAligned ? '+na' : ''));
    const fit = KEYS.map(([k, c], i) => (k(p) ? [i, c(p)] : null)).filter(Boolean);
    assert.strictEqual(fit.length, 1, `${line}: ${fit.length} rows`);
    assert.strictEqual(fit[0][1], cls, `${line}: row ${fit[0][0] + 1} gives ${fit[0][1]}, code ${cls}`);
  }
  // Every row is reached.
  for (const w of ['chop', 'forming', 'ranging', 'trend', 'trend+pb', 'ranging+pb', 'trend+na', 'ranging+na']) assert.ok(words.has(w), w);
});

test('market state authority: the head core says once that the class word follows the printed line, and holds no competing picture', () => {
  const H = require('../../scripts/lib/head-prompt');
  const head = flat(H.headPrompt(H.headPlan(ROOT, 'index')));
  const ONE = 'The class word follows the printed `Market state` line, and only it. No other row, picture or frame read changes it';
  assert.strictEqual(head.split(ONE).length, 2, 'said once');
  assert.ok(head.includes("Your STATE frames stay your own read; when they differ, the class stays the line's: say why in the PLAN."));
  // The chop picture lives in trend-vs-range only (a lookup, reference), pointed to once.
  assert.doesNotMatch(head, /overlapping candles|failed continuation/);
  assert.ok(flat(read('skills/trend-vs-range/SKILL.md')).includes('Chop: alternating BOS/CHoCH, overlapping candles, failed continuation.'));
  assert.strictEqual(head.split('definitions, for reference only: `trend-vs-range`').length, 2);
  // One term per idea: no synonym stands in for a state word in the always-loaded text.
  assert.doesNotMatch(head, /\bchoppy\b|\bsideways\b|\bconsolidat/i);
});

// The homes that teach (skills, agents, rules, README). A sentence or row that maps a frame or structure condition to a
// class word competes with the printed line; each kept one is listed with its reason (competing-definitions audit).
const CLASS_MAP = [
  /(?:→|->|=)\s*(?:class\s+)?`?(?:chop|unclear|trend-up|trend-down)`?(?![\w-])/,
  /\b(?:is|are|reads?)\s+(?:the\s+)?`?(?:chop|unclear)`?(?![\w-])/,
  /\bnot `?chop`?\b|\bnever `?chop`?\b|\bno chop sign\b/,
  /\b(?:the side's|that|their) trend class\b/,
  /:\s*`?(?:unclear|chop)`?\s*[;.)]/,
  /\|\s*`?(?:chop|unclear|trend-up|trend-down)`?\s*\|/,
  /\b(?:reversal|range|transition|mixed),\s*`?(?:chop|unclear)`?(?![\w-])/,
];
const ALLOWED = [
  // The table and its bullets: the one authority (trade-session step 3).
  ['skills/trade-session/SKILL.md', /\*\*The decision follows your STATE read\*\*[^]*?Chop ends when the line prints/],
  // The STATE grammar names the four words and points to the line.
  ['skills/trade-session/SKILL.md', /`<c>`, the market now at this candle, is `trend-up`, `trend-down`, `chop` or `unclear`, from the `Market state` line;/],
  // A pass on the head trader's own read: class -> action, never a condition -> class.
  ['skills/trade-session/SKILL.md', /Then `chop`, `unclear`, or a trend class your 4h and 1h don't show/],
  // #338's step 3 sentence, pinned unchanged (the spec), followed by the pointer to the line.
  ['skills/pullback-vs-reversal/SKILL.md', /A 15m `range` or `transition` here is the pause, not chop\. The class word is the Market state line's/],
  // Examples that quote the printed line and give its class.
  ['skills/pullback-vs-reversal/SKILL.md', /the Market state line prints the pullback -> class trend-up \(the line's\)/],
  ['skills/trend-vs-range/SKILL.md', /Chop: the line prints `chop: [^`]*` -> sit out\. It prints `trend up: [^`]*` -> trend-up\./],
  // The owner's chop definition, the one reference home, after "the class word is the line's, never this definition's".
  ['skills/trend-vs-range/SKILL.md', /Structure broken both ways with no continuation is chop, not a run of reversals\./],
  // The README's step table: the line's words -> class, the authority restated for people.
  ['README.md', /\| The class word follows the line, and only it: [^|]*\|/],
];

function teachingHomes() {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else if (r.endsWith('.md')) out.push(r); } };
  for (const d of ['skills', 'rules', 'agents']) walk(d);
  return [...out, 'README.md'];
}

test('market state authority: no taught row or sentence outside the Market state table maps a condition to a class word', () => {
  const found = [];
  for (const f of teachingHomes()) {
    let t = flat(read(f).replace(/^---\n[^]*?\n---\n/, ''));
    for (const [file, re] of ALLOWED) if (file === f) t = t.replace(re, ' ');
    for (const piece of t.split(/(?<=[.;!?|])\s+/)) for (const re of CLASS_MAP) if (re.test(piece)) found.push(`${f}: ${piece.slice(0, 160)}`);
  }
  assert.deepStrictEqual(found, []);
  // Each allowed passage is still there (an allow-list entry never outlives its text).
  for (const [f, re] of ALLOWED) assert.match(flat(read(f)), re, `${f}: ${re}`);
});

test('market state authority: the scan catches a competing row or sentence (it fails without the allow-list\'s reasons)', () => {
  for (const s of ['Frames: transitional → `unclear`.', '| trend against them | aligned | `unclear` |', 'A 15m range is unclear.', 'It is not chop.', 'the side\'s trend class.', 'Skip: transition, 15m mixed: unclear;', '15m transition -> class trend-up.', 'a 3m CHoCH then CHoCH back: a failed reversal, chop, unless a pullback read is active'])
    assert.ok(CLASS_MAP.some(re => re.test(s)), s);
  for (const s of ['A take: `class` on its side.', 'Chop ends when the line prints `the chop ended`.', 'The class word: the Market state line.'])
    assert.ok(!CLASS_MAP.some(re => re.test(s)), s);
});

test('bos-vs-choch: a BOS stays labelled BOS after its protected swing breaks; the status words are the ones the Market state line prints', () => {
  const t = flat(read('skills/bos-vs-choch/SKILL.md'));
  const b = (brokenAt, closed) => ({ minutes: 3, closedAt: closed, sections: { h1: { data: { h4: { trend: 'up' }, h1: { trend: 'up' } } },
    m3: { data: { lastBreak: { last: { kind: 'BOS', direction: 'up', level: 21495, barsAgo: 3, at: '2026-01-06T15:30:00.000Z', protected: { side: 'low', level: 21480.25, at: null, brokenAt } }, previous: { kind: 'BOS', direction: 'up', level: 21470.5, barsAgo: 10, at: '2026-01-06T15:09:00.000Z' } } } } } });
  const holding = M.marketStateLine(M.stateOf(b(null, '2026-01-06T15:42:00.000Z'), TH));
  const broken = M.marketStateLine(M.stateOf(b('2026-01-06T15:39:00.000Z', '2026-01-06T15:42:00.000Z'), TH));
  const word = (line, re) => re.exec(line)[1];
  const hw = word(holding, /protected HL 21480\.25 (holding)/);
  const bw = word(broken, /protected HL 21480\.25 (broken by a close)/);
  assert.ok(t.includes(`A BOS stays labelled BOS after its protected swing breaks; the Market state line's status (\`${hw}\` or \`${bw}\`) decides what it means now: a broken protected swing ends that BOS's trend read.`));
});
