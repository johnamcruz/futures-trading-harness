'use strict';

// One authority for the class word (round 17, owner: "Make sure to fix Competing definitions" and "Need to make sure it's
// clear and avoid confusion"): the printed Market state line. Round 18 (owner): the line prints the class code computes
// (market-state.js classWordOf) at its end; the head core's table maps that printed class to one action and never a
// state word to a class. No other taught row or sentence maps a frame condition to a class word.
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

// The table as taught (trade-session step 3, round 18: the line prints the class): each row one class word -> one action.
// No row keys on a state word: the class is read off the line, never derived from its words.
const ROWS = [
  "| `trend-up`, `trend-down` | setups the side's way (what the line prints picks the setup, below) |",
  "| `chop` | sit out |",
  "| `unclear` | no trend trade, never counter |",
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

test('market state authority: the line prints the class code computes (classWordOf), on every distinct line the precedence makes', () => {
  const all = lines();
  assert.ok(all.size >= 20, `${all.size} distinct printed lines`);
  const classes = new Set();
  for (const [line, cls] of all) {
    const m = /; class (trend-up|trend-down|chop|unclear)$/.exec(line);
    assert.ok(m, `${line}: no printed class at its end`);
    assert.strictEqual(m[1], cls, `${line}: prints ${m[1]}, code ${cls}`);
    // Parse-back (round 18): the class is the line's last `; ` field, said once; the leg's "->" never carries it.
    const fields = line.split('; ');
    assert.strictEqual(fields[fields.length - 1], `class ${cls}`, line);
    assert.match(fields[fields.length - 2], /(?:^|: )?4h\+1h (?:up|down)$|\(not aligned\)$/, line);
    assert.strictEqual(line.split('class ').length, 2, `${line}: one class`);
    assert.doesNotMatch(line, /-> class/, line);
    classes.add(cls);
  }
  // Every class word is reached, and each state word prints (forming and unclear lines carry a class too).
  for (const c of ['trend-up', 'trend-down', 'chop', 'unclear']) assert.ok(classes.has(c), c);
  for (const w of ['chop: ', 'forming ', 'ranging: ', 'trend up: ', 'trend down: ']) assert.ok([...all.keys()].some(l => l.includes(`(3m): ${w}`)), w);
});

test('market state authority: the head core\'s table maps the printed class to one action, never a state word to a class', () => {
  const body = read('skills/trade-session/SKILL.md');
  const ts = flat(body);
  const raw = body.slice(body.indexOf('| class printed | action |'), body.indexOf('Chop ends when the line'));
  assert.ok(raw.length > 0, 'the table');
  // The table's rows are exactly ROWS, in order: a row added, dropped or changed fails.
  assert.deepStrictEqual(raw.split('\n').map(l => l.trim()).filter(l => l.startsWith('|') && !l.startsWith('|-') && !l.startsWith('| class printed')), ROWS);
  assert.strictEqual(flat(raw).split('|---|---|').length, 2, 'one table, two columns');
  // No exception inside the table, and no state word keys a row (the class is the line's, printed).
  assert.doesNotMatch(raw, /\bunless\b|\bexcept\b|but if/i);
  for (const r of ROWS) assert.doesNotMatch(r.split('|')[1], /forming|ranging|`trend`|not aligned|pullback/, r);
  assert.ok(ts.includes('Write the class the `Market state` line prints after `class`; your own 4h/1h/15m reads stay in STATE.'));
  // The setup bullets under a trend class carry the precedence (review round 18): a pullback printed first, else the state
  // word; under that order exactly one bullet fits every trend-class line the code prints.
  assert.ok(ts.includes('Under a trend class, the setup by what the line prints (a pullback printed first; else its state word):'));
  for (const b of ['- A pullback their way (', '- `forming`: no setup yet', '- `ranging`: setups at the range edge', '- `trend`, their way: setups the side\'s way.']) assert.ok(ts.includes(b), b);
  for (const [line, cls] of lines()) {
    if (!/^trend-/.test(cls)) continue;
    const way = cls.slice('trend-'.length);
    const pb = line.includes(`; pullback (${way === 'up' ? 'long' : 'short'} leg`) || line.includes(`; 15m ${way}: a pullback in the 15m trend`);
    const word = /^Market state \(3m\): (forming|ranging|trend up|trend down)/.exec(line);
    const fits = pb ? ['pullback'] : [word && word[1] === 'forming' ? 'forming' : null, word && word[1] === 'ranging' ? 'ranging' : null, word && word[1] === `trend ${way}` ? 'trend' : null].filter(Boolean);
    assert.strictEqual(fits.length, 1, `${line}: ${fits.length} bullets`);
  }
});

test('market state authority: the head core says once that the class word follows the printed line, and holds no competing picture', () => {
  const H = require('../../scripts/lib/head-prompt');
  const head = flat(H.headPrompt(H.headPlan(ROOT, 'index')));
  const ONE = 'Write the class the `Market state` line prints after `class`';
  assert.strictEqual(head.split(ONE).length, 2, 'said once');
  assert.ok(head.includes('No other row, picture or frame read changes it. When your frames differ, say why in the PLAN.'));
  // Round 19 (q118: "the 15m is in transition, which the trend-class rules mark `unclear`"): the 15m frame read feeds the
  // setup, never the class, said once; and the computed regime (its values share the class spelling) is a read, not the class.
  const FRAME = 'Your 15m `range` or `transition` is a frame read: it feeds the setup, not the class.';
  assert.strictEqual(head.split(FRAME).length, 2, 'the frame-read sentence, once');
  assert.strictEqual(head.split('plus volatility: a read, not the class (the `Market state` line\'s).').length, 2, 'setup-judgment\'s regime: a read');
  // The chop picture lives in trend-vs-range only (a lookup, reference), pointed to once. The one exception is the
  // negative-only pause line (round 18, the diagnosis review), which names overlap only to say it is no chop.
  const PAUSE = "Small overlapping candles inside a printed pullback are a pause, not chop; the class stays the line's.";
  assert.strictEqual(head.split(PAUSE).length, 2, 'the pause line, once');
  assert.doesNotMatch(head.replace(PAUSE, ''), /overlapping candles|failed continuation/);
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
  /\|\s*(?:class\s+)?`?(?:chop|unclear|trend-up|trend-down)`?(?![\w-])/,
  /\b(?:reversal|range|transition|mixed),\s*`?(?:chop|unclear)`?(?![\w-])/,
  // Prose mappings (coordinator, round 17: close the prose gap): "means / gives / becomes / is read as / counts as /
  // call it <class word>", plain or backticked, with or without "class".
  /\b(?:means?|gives?|becomes?|(?:is|are) read as|reads? as|counts? as|calls? it|call it|makes? it)\s+(?:a\s+|the\s+)?(?:class\s+)?`?(?:chop|unclear|trend-up|trend-down)`?(?![\w-])/i,
  // Round 19 (q118: "the 15m is in transition, which the trend-class rules mark `unclear`"): a verb that labels, with up
  // to four words of object between ("mark", "marks", "rules mark", "marks it", "marks a 15m range", "is marked as",
  // "labels", "tags", "classifies ... as").
  /\b(?:marks?|marked|marking|labels?|labell?ed|tags?|tagged|classif(?:y|ies|ied)|classed)\s+(?:[\w`+-]+\s+){0,4}?(?:as\s+)?(?:a\s+|the\s+)?(?:class\s+)?`?(?:chop|unclear|trend-up|trend-down)`?(?![\w-])/i,
  // A frame word, then "so / thus / hence / therefore" and a class word ("15m transition, so `unclear`").
  /\b(?:range|ranging|transition|transitional|mixed)`?,?\s+(?:so|thus|hence|therefore)\s+(?:the\s+class\s+(?:is\s+)?)?`?(?:chop|unclear|trend-up|trend-down)`?(?![\w-])/i,
];
const ALLOWED = [
  // The table: the one authority (trade-session step 3). Round 19: the table alone, and each kept bullet sentence exactly
  // (it was the whole section, so a sentence planted inside it went unscanned).
  ['skills/trade-session/SKILL.md', /\| class printed \| action \|[^]*?\| `unclear` \| no trend trade, never counter \|/],
  // The pause line: negative only (round 18, the diagnosis review).
  ['skills/trade-session/SKILL.md', /Small overlapping candles inside a printed pullback are a pause, not chop; the class stays the line's\./],
  // The ranging bullet: ranging is no chop (round 18).
  ['skills/trade-session/SKILL.md', /a range day too; ranging is not chop\./],
  // The STATE grammar names the four words and points to the line.
  ['skills/trade-session/SKILL.md', /`<c>`, the market now at this candle, is `trend-up`, `trend-down`, `chop` or `unclear`, the one the `Market state` line prints;/],
  // A pass on the head trader's own read: class -> action, never a condition -> class.
  ['skills/trade-session/SKILL.md', /Then `chop`, `unclear`, or a trend class your 4h and 1h don't show/],
  // Examples that quote the printed line and give its class.
  ['skills/pullback-vs-reversal/SKILL.md', /the Market state line prints the pullback -> class trend-up \(the line's\)/],
  // #338 pinned (q91's anchor); "not chop" contrasts a pause with chop, does not assign the class (audit row 29). This
  // exact sentence only: a variant ("... is chop.", "... is not chop, unclear.") still trips the scan.
  ['skills/pullback-vs-reversal/SKILL.md', /A 15m `range` or `transition` here is the pause, not chop\./],
  ['skills/trend-vs-range/SKILL.md', /Chop: the line prints `chop: [^`]*` -> sit out\. It prints `trend up: [^`]*` -> trend-up\./],
  // The owner's chop definition, the one reference home, after "the class word is the line's, never this definition's".
  ['skills/trend-vs-range/SKILL.md', /Structure broken both ways with no continuation is chop, not a run of reversals\./],
  // trader-process's filled-in STATE example (a recorded line, no rule; audit row 12).
  ['skills/trader-process/SKILL.md', /STATE: 4h up \| 1h up \| 15m transition \| frames disagree \| class trend-up \| cites 15m-break, 3m-break, pullback/],
  // The README's step table: the line's words -> class, the authority restated for people.
  ['README.md', /\| The class word is the one the line prints, and only it: [^|]*\|/],
];

function teachingHomes() {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else if (r.endsWith('.md')) out.push(r); } };
  for (const d of ['skills', 'rules', 'agents']) walk(d);
  return [...out, 'README.md'];
}

// The scan of one text: every sentence, and every table row whole (a row's cells read together, never cut at a pipe).
function scanText(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const pieces = /^\s*\|/.test(line) ? [line.trim()] : flat(line).split(/(?<=[.;!?])\s+/);
    for (const piece of pieces) if (CLASS_MAP.some(re => re.test(piece))) out.push(piece.slice(0, 160));
  }
  return out;
}
// A teaching file as the scan reads it: prose joined into sentences (a sentence wraps lines), each table row its own line,
// the allowed passages blanked.
function scanFile(f) {
  let t = read(f).replace(/^---\n[^]*?\n---\n/, '').split('\n').map(l => (/^\s*\|/.test(l) ? `\n${l}\n` : `${l} `)).join('');
  t = t.replace(/[ \t]+/g, ' ');
  for (const [file, re] of ALLOWED) if (file === f) t = t.replace(re, ' ');
  return scanText(t);
}

test('market state authority: no taught row or sentence outside the Market state table maps a condition to a class word', () => {
  const found = [];
  for (const f of teachingHomes()) for (const piece of scanFile(f)) found.push(`${f}: ${piece}`);
  assert.deepStrictEqual(found, []);
  // Each allowed passage is still there (an allow-list entry never outlives its text).
  for (const [f, re] of ALLOWED) assert.match(flat(read(f)), re, `${f}: ${re}`);
});

test('market state authority: the scan catches a competing row or sentence (it fails without the allow-list\'s reasons)', () => {
  for (const s of ['Frames: transitional → `unclear`.', '| trend against them | aligned | `unclear` |', 'A 15m range is unclear.', 'It is not chop.', 'the side\'s trend class.', 'Skip: transition, 15m mixed: unclear;', '15m transition -> class trend-up.', 'a 3m CHoCH then CHoCH back: a failed reversal, chop, unless a pullback read is active'])
    assert.ok(scanText(s).length > 0, s);
  // Through the scan itself: table rows outside the allowed table, a sentence wrapped over lines.
  assert.strictEqual(scanText('Intro.\n| 15m range | `unclear` |\n| trend against them | aligned | `unclear` | no trade |\nMore.').length, 2);
  assert.strictEqual(scanText('Frames: transitional is a pause. Then -> `unclear`.').length, 1);
  // Each prose phrasing, plain and backticked (mutation tests for the prose pattern).
  for (const v of ['chop', '`chop`', 'unclear', '`unclear`', 'trend-up', '`trend-down`', 'class `unclear`']) {
    for (const p of ['A 15m range means', 'A 15m range gives', 'The class becomes', 'A transition is read as', 'A 15m range reads as', 'A CHoCH pair counts as', 'Call it', 'Overlapping candles make it'])
      assert.strictEqual(scanText(`${p} ${v} when the 15m ranges.`).length, 1, `${p} ${v}`);
  }
  for (const s of ['The line means what it prints.', 'It gives the class word: the Market state line.', 'The read becomes clear later.', 'It counts as a pullback.'])
    assert.deepStrictEqual(scanText(s), [], s);
  // Round 19: the model's own q118 sentence (k1, verbatim) and its kin: a frame read labelled with a class word.
  for (const s of ['With 4h and 1h both down and the 3m printing a CHoCH up, the 15m is in transition, which the trend-class rules mark `unclear`: no trend trade, never counter.',
    'A 15m transition marks it `unclear`.', 'The rules mark a 15m range unclear.', 'A 15m range is marked unclear.', 'Overlapping candles are marked as chop.', 'The rule marks the class `chop`.',
    'The class rules label a 15m transition `unclear`.', 'A 15m range is tagged unclear.', 'It classifies a transition as unclear.', 'The 15m is in transition, so `unclear`.', 'A 15m range, so the class is unclear.'])
    assert.ok(scanText(s).length > 0, s);
  for (const s of ['Mark the level on the chart.', 'The marked swing holds.', 'It labels the leg by its origin.', 'A 15m transition is a frame read; it feeds the setup.', 'The range, so far, holds.'])
    assert.deepStrictEqual(scanText(s), [], s);
  for (const row of ['| 15m range | `unclear`: no trade |', '| 15m range | class `unclear` |', '| 3m CHoCH pair | chop, sit out |']) assert.strictEqual(scanText(row).length, 1, row);
  // The restored #338 sentence is allowed exactly: a near-variant is not blanked, and the scan still catches it.
  const pause = ALLOWED.find(([, re]) => re.source.includes('the pause, not chop'))[1];
  for (const v of ['A 15m `range` or `transition` here is chop.', 'A 15m `range` or `transition` here is the pause, not chop, unclear.', 'A 15m `range` here is the pause, not chop.']) {
    assert.ok(scanText(v.replace(pause, ' ')).length > 0, v);
  }
  for (const s of ['A take: `class` on its side.', 'Chop ends when the line\'s state word is no longer `chop`.', 'The class word: the Market state line.', '| Depth | up to about 50-62% | past the origin |'])
    assert.deepStrictEqual(scanText(s), [], s);
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

// Round 19 (q102: "a CISD is not a BOS: ... the entry needs a 3m BOS up near value"): the owner's chain (the first 3m BOS
// or CISD the side's way near value) has one entry trigger with two forms. No taught sentence requires a 3m BOS alone for
// the entry, and the head core says a 3m CISD is the entry as a 3m BOS is, a 3m CHoCH against before it too.
const BOS_ONLY = [
  /\b(?:needs?|requires?|wait(?:s|ing)? for|until)\s+(?:the\s+|a\s+)?(?:first\s+)?3m\s+BOS(?:\s+(?:up|down))?\b(?!\s+or\s+(?:a\s+)?(?:3m\s+)?CISD|\/CISD)/i,
  /\bno (?:3m )?BOS\b(?! or (?:a )?(?:3m )?CISD)[^.;]{0,30}(?:->|→|:)\s*(?:watch|wait|pass)\b/i,
  /\ba CISD is not a BOS\b/i,
];
const bosOnly = text => flat(text).split(/(?<=[.;!?])\s+/).filter(p => BOS_ONLY.some(re => re.test(p)));

test('entry trigger: no taught sentence requires a 3m BOS alone; the head core names the 3m CISD beside it', () => {
  const homes = [...teachingHomes(), ...fs.readdirSync(path.join(ROOT, 'strategies')).map(d => path.join('strategies', d, 'STRATEGY.md')).filter(f => fs.existsSync(path.join(ROOT, f)))];
  const found = [];
  for (const f of homes) for (const p of bosOnly(read(f).replace(/^---\n[^]*?\n---\n/, ''))) found.push(`${f}: ${p.slice(0, 160)}`);
  assert.deepStrictEqual(found, []);
  const H = require('../../scripts/lib/head-prompt');
  const head = flat(H.headPrompt(H.headPlan(ROOT, 'index')));
  assert.strictEqual(head.split("enter on the first 3m BOS or CISD the side's way near value (a 3m CISD is the entry as a 3m BOS is, after a 3m CHoCH against too;").length, 2);
  // The one worked entry in the core's read chain shows the CISD form.
  assert.ok(head.includes('15m turn: rejected the RTH VWAP up, long-wick; 3m: CISD up, near value; strong setup: enter'));
});

test('entry trigger: the BOS-only scan catches the model\'s q102 words and their kin, and passes the chain', () => {
  for (const s of ['The 15m pullback is ended by a strong 15m CISD up, but the entry needs a 3m BOS up near value.', 'a CISD is not a BOS: wait for the 3m BOS up', 'Wait for the first 3m BOS.',
    'The entry requires a 3m BOS down.', '3m: CHoCH up, no BOS -> watch.', 'No 3m BOS yet: wait.', 'A CISD is not a BOS.'])
    assert.strictEqual(bosOnly(s).length, 1, s);
  for (const s of ['enter on the first 3m BOS or CISD the side\'s way near value.', 'the entry needs a 3m BOS or CISD the side\'s way.', '3m: CHoCH up, no BOS or CISD -> watch.',
    'no 3m BOS or CISD yet: watch.', 'Entry: the first 3m BOS/CISD near value.', 'a 3m BOS up, close 21527.25: the entry, a limit.'])
    assert.deepStrictEqual(bosOnly(s), [], s);
});
