'use strict';

// The Market state (scripts/lib/trading/market-state.js, round 20): the owner's three layers (internal structure,
// protected structure, price behavior; market-layers.js computes them into m3.layers), the precedence applied once, the
// class (round 18: printed last, classWordOf), and the line. The owner's classes: Trend, Weakening ("reduce confidence;
// wait"), Transitioning ("avoid premature entries"), Chop ("avoid trend entries"), Reversal ("evaluate the new
// direction"); a pullback is never chop. Without m3.layers (an older record, a quiz item) the printed breaks alone.

const test = require('node:test');
const assert = require('node:assert');
const M = require('../../scripts/lib/trading/market-state');

const TH = { crossesChop: 5, maxPullbackDepth: 0.62 };
const LINE_BYTES = require('../../scripts/lib/tunables').analysis().marketState.lineBytes; // config/analysis.json
const LEG = { origin: 21361.25, extreme: 21437.5 };
const pb = (o = {}) => ({ frame: '15m', side: 'long', leg: { ...LEG, atr: 4 }, depth: 0.28, pastOrigin: false, counter: { bars: 6 }, swing: {}, against: {}, ...o });
const T = m => new Date(Date.UTC(2026, 0, 6, 15, m)).toISOString(); // 10:mm ET (EST)
const leg = (o = {}) => ({ side: 'up', level: 21380.5, origin: 21361.25, status: 'intact', legOK: true, sinceProgress: 2, internal: 0, resumed: false, lastInternal: null,
  lastWay: { kind: 'BOS', direction: 'up', level: 21412.25, barsAgo: 2, strong: true, failed: false }, flip: null, flipsIn: 0, ...o });
const NO_CHOP = { now: false, inChop: false, S: false, B: false, facts: { ov: false, ef: false, fl: false, nd: false }, count: 0, evidence: { bothWays: false, flip: false, failed: false }, ended: false };
const lay = (o = {}) => ({
  rthBars: 20, structure: leg(), lastBreak: null,
  momentum: { dispAgainst: null, breakAgainst: null, trigger: false, loss: false, odf: false, od: null },
  behavior: { word: 'trending', word15: 'trending up', overlap: 0.52, eff: 0.41, netAtr: 1.6, disp: 2 },
  chop: NO_CHOP, edges: { top: 21431.25, bot: 21402, atTop: 1, atBot: 1, interior: 0 }, pbPhase: null, transition: false, stale: false, reversal: false, pbRotation: false, ...o,
});
const CHOP = { now: true, inChop: true, S: true, B: true, facts: { ov: true, ef: true, fl: true, nd: false }, count: 3, evidence: { bothWays: true, flip: false, failed: true }, ended: false };
const b = ({ h4 = 'up', h1 = 'up', m15, pullback, lastBreak, soFar, layers, m3 = {}, closedAt = T(30), minutes = 3 } = {}) => ({
  minutes, ...(closedAt ? { closedAt } : {}),
  sections: {
    h1: { data: { ...(h4 === 'none' ? {} : { h4: { trend: h4 } }), ...(h1 === 'none' ? {} : { h1: { trend: h1 } }) } },
    ...(m15 ? { m15: { data: { frame: { trend: m15 } } } } : {}),
    m3: { data: { ...(pullback === undefined ? {} : { pullback }), ...(lastBreak ? { lastBreak } : {}), ...(soFar ? { today: { soFar } } : {}), ...(layers ? { layers } : {}), ...m3 } },
  },
});
const S = o => M.stateOf(b(o), TH);
const st = o => S(o).state;
const word = o => M.classWordOf(S(o));
const line = o => M.marketStateLine(S(o));

test('precedence: forming before the first RTH break; the pullback guard beats chop, aligned or not (the owner: a pullback is never chop)', () => {
  assert.strictEqual(st({ layers: lay({ structure: null }) }), 'forming');
  assert.strictEqual(word({ layers: lay({ structure: null }) }), 'trend-up', 'forming under 4h + 1h up: the alignment default');
  assert.strictEqual(word({ layers: lay({ structure: null }), h4: 'range' }), 'unclear');
  assert.deepStrictEqual([st({ layers: lay({ chop: CHOP }), pullback: pb() }), word({ layers: lay({ chop: CHOP }), pullback: pb() })], ['pullback', 'trend-up']);
  assert.strictEqual(st({ layers: lay({ chop: CHOP }), pullback: pb(), h4: 'range' }), 'pullback', 'unaligned: still never chop');
  assert.strictEqual(word({ layers: lay({ chop: CHOP }), pullback: pb(), h4: 'range' }), 'unclear');
  assert.strictEqual(word({ layers: lay(), pullback: pb({ side: 'short' }) }), 'unclear', 'a short leg\'s pullback under 4h + 1h up');
  assert.strictEqual(word({ layers: lay(), pullback: pb({ side: 'short' }), h4: 'down', h1: 'down' }), 'trend-down');
  assert.strictEqual(st({ layers: lay({ chop: CHOP, structure: null }), pullback: pb() }), 'pullback', 'before any RTH break too');
});

test('precedence: a deep (past maxPullbackDepth, sticky) or given-back pullback loses the guard and the layers decide', () => {
  assert.strictEqual(st({ layers: lay({ chop: CHOP, structure: leg({ legOK: false }) }), pullback: pb({ depth: 0.63 }) }), 'chop');
  assert.strictEqual(st({ layers: lay({ chop: CHOP, structure: leg({ legOK: false }) }), pullback: pb({ depth: 0.5, maxDepth: 0.7 }) }), 'chop', 'sticky');
  assert.strictEqual(st({ layers: lay({ chop: CHOP, structure: leg({ legOK: false }) }), pullback: pb({ depth: 0.62 }) }), 'pullback', 'at the bound');
  assert.strictEqual(st({ layers: lay({ chop: CHOP, structure: leg({ legOK: false }) }), pullback: pb({ givenBackSince: true }) }), 'chop', 'given back since the extreme');
  assert.strictEqual(M.stateOf(b({ layers: lay({ chop: CHOP }), pullback: pb({ depth: 0.63 }) }), { crossesChop: 5, maxPullbackDepth: 0.7 }).state, 'pullback', 'the bound is passed in');
  assert.throws(() => M.stateOf(b({}), { crossesChop: 5 }), /maxPullbackDepth/);
  assert.throws(() => M.stateOf(b({}), {}), /crossesChop/);
});

test('decision 2: an open pullback with rotation evidence now prints rotation (class unclear: no trend entry), never chop', () => {
  const rot = lay({ chop: CHOP, pbRotation: true, pbPhase: { bars: 24, crosses: 4 } });
  assert.deepStrictEqual([st({ layers: rot, pullback: pb() }), word({ layers: rot, pullback: pb() })], ['rotation', 'unclear']);
  assert.strictEqual(line({ layers: rot, pullback: pb() }), 'Market state (3m): rotation: pullback (long leg 21361.25 -> 21437.5, depth 28%), 24 bars, 4 midpoint crosses; behavior trending (overlap 0.52, efficiency 0.41), 15m trending up; 4h+1h up; class unclear');
  const weak = lay({ pbRotation: true, pbPhase: { bars: 5, crosses: 0 }, momentum: { ...lay().momentum, trigger: true, breakAgainst: { direction: 'down', level: 21412.25, barsAgo: 1, strong: true } } });
  assert.match(line({ layers: weak, pullback: pb() }), /^Market state \(3m\): rotation: pullback \(long leg 21361\.25 -> 21437\.5, depth 28%\), 5 bars, 0 midpoint crosses, the up leg weakening;/);
});

test('precedence: transition beats chop; chop needs no pullback or early read; the classes of each', () => {
  const tr = lay({ transition: true, chop: CHOP, structure: leg({ side: 'down', status: 'broken', legOK: false, level: 21437.5, flip: { barsAgo: 3, strong: true, disp: true, held: true, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' } }) });
  assert.deepStrictEqual([st({ layers: tr }), S({ layers: tr }).way, word({ layers: tr })], ['transition', 'down', 'unclear'], 'against the 4h + 1h: unclear (Transitioning)');
  assert.strictEqual(word({ layers: tr, h4: 'down', h1: 'down' }), 'trend-down', 'the new way the side\'s: the trend class');
  const ch = lay({ chop: CHOP, structure: leg({ legOK: false }) });
  assert.deepStrictEqual([st({ layers: ch }), word({ layers: ch }), word({ layers: ch, h4: 'range' })], ['chop', 'chop', 'chop']);
  const downLeg = leg({ side: 'down', level: 21437.5 });
  const early = { layers: lay({ chop: CHOP, structure: downLeg, behavior: { ...lay().behavior, word: 'overlapping' } }), m15: 'up' };
  assert.deepStrictEqual([S(early).early, st(early), word(early)], [true, 'leg', 'trend-up'], 'the early read (15m up, an established 3m leg down) keeps the trend class');
  assert.match(line(early), /; 15m up: a pullback in the 15m trend; 4h\+1h up; class trend-up$/);
  assert.strictEqual(S({ layers: lay({ structure: downLeg }), m15: 'up', lastBreak: { last: { kind: 'CHoCH', direction: 'down', level: 21400, at: T(24) }, previous: null } }).early, true, 'with layers, the leg decides, not the printed break');
  assert.strictEqual(S({ layers: lay({ structure: leg({ side: 'down', legOK: false }) }), m15: 'up', lastBreak: { last: { kind: 'BOS', direction: 'down', level: 21400, at: T(24) }, previous: null } }).early, false, 'no established leg against: no early read, whatever the printed BOS');
  assert.strictEqual(S({ layers: lay(), m15: 'up' }).early, false, 'the 3m leg with the 4h + 1h: no pullback');
  assert.deepStrictEqual([st({ layers: lay({ chop: CHOP, structure: leg({ side: 'down', legOK: false }) }), m15: 'up' })], ['chop'], 'chop when no early read');
  assert.strictEqual(st({ layers: lay({ chop: { ...CHOP, inChop: false, now: false }, structure: leg({ legOK: false }) }) }), 'range', 'no chop memory: range');
});

test('precedence (round 20b): the side\'s protected level broken without displacement is a transition until a new leg; the owner: protected HL breaks -> structure invalidated', () => {
  const flip = { barsAgo: 2, strong: false, disp: false, held: true, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' };
  const brk = leg({ status: 'broken', legOK: false, side: 'down', level: 21437.5, flip });
  const L0 = lay({ structure: brk });
  assert.deepStrictEqual([st({ layers: L0 }), S({ layers: L0 }).way, word({ layers: L0 })], ['transition', 'down', 'unclear'], '4h + 1h up, the HL broken: Transitioning, class unclear (avoid premature entries)');
  assert.deepStrictEqual([st({ layers: L0, h4: 'down', h1: 'down' }), word({ layers: L0, h4: 'down', h1: 'down' })], ['range', 'trend-down'], 'a counter (up) leg broken the 4h + 1h (down) way: the range default, unchanged');
  assert.deepStrictEqual([st({ layers: L0, h4: 'range' }), word({ layers: L0, h4: 'range' })], ['range', 'unclear'], 'not aligned: unchanged');
  assert.strictEqual(st({ layers: lay({ structure: brk, chop: CHOP }) }), 'chop', 'the chop memory still decides first (the break does not end chop: no displacement)');
  assert.strictEqual(st({ layers: L0, pullback: pb() }), 'pullback', 'an open pullback still decides first');
  assert.strictEqual(st({ layers: lay({ structure: leg({ ...brk, flip: { ...flip, held: false } }) }) }), 'transition', 'no held, displacement or follow-through condition (frozen before the measurement)');
  const newLeg = lay({ structure: leg({ side: 'down', level: 21437.5, flip }) });
  assert.deepStrictEqual([st({ layers: newLeg }), word({ layers: newLeg })], ['trend', 'unclear'], 'the new down leg established: the leg against the side, unclear');
  assert.deepStrictEqual([st({ layers: lay() }), word({ layers: lay() })], ['trend', 'trend-up'], 'the old leg resumed: the trend class again');
});

test('precedence: weakening (the trigger on an intact leg) and the stale-leg rotation print unclear whichever way the leg points', () => {
  const m = { ...lay().momentum, trigger: true, dispAgainst: { barsAgo: 2 }, breakAgainst: { direction: 'down', level: 21412.25, barsAgo: 2, strong: false } };
  assert.deepStrictEqual([st({ layers: lay({ momentum: m }) }), word({ layers: lay({ momentum: m }) })], ['weakening', 'unclear']);
  const counter = lay({ structure: leg({ side: 'down', level: 21437.5 }), momentum: { ...m, breakAgainst: { direction: 'up', level: 21400, barsAgo: 2, strong: true } } });
  assert.deepStrictEqual([st({ layers: counter }), word({ layers: counter })], ['weakening', 'unclear'], 'a counter leg weakening: unclear, not the side\'s trend class (decision 4)');
  assert.strictEqual(st({ layers: lay({ momentum: m, structure: leg({ legOK: false }) }) }), 'range', 'the trigger needs an established leg');
  assert.strictEqual(st({ layers: lay({ momentum: m, chop: CHOP, structure: leg({ legOK: false }) }) }), 'chop');
  assert.deepStrictEqual([st({ layers: lay({ stale: true }) }), word({ layers: lay({ stale: true }) })], ['rotation', 'unclear']);
  assert.strictEqual(st({ layers: lay({ stale: true, momentum: m }) }), 'weakening', 'weakening before rotation');
  assert.strictEqual(st({ layers: lay({ stale: true, structure: leg({ side: 'down', level: 21437.5 }) }), m15: 'up' }), 'trend', 'the early read: no stale rotation');
});

test('precedence: trend needs an established leg and the behavior word trending; else in the leg; no leg: range; the classes', () => {
  assert.deepStrictEqual([st({ layers: lay() }), S({ layers: lay() }).way, word({ layers: lay() })], ['trend', 'up', 'trend-up']);
  const l = lay({ behavior: { ...lay().behavior, word: 'overlapping' } });
  assert.deepStrictEqual([st({ layers: l }), word({ layers: l })], ['leg', 'trend-up']);
  assert.strictEqual(word({ layers: lay(), h4: 'down', h1: 'down' }), 'unclear', 'a 3m leg against the 4h + 1h: unclear, never counter');
  assert.strictEqual(word({ layers: lay(), h4: 'range' }), 'unclear');
  const r = lay({ structure: leg({ legOK: false }) });
  assert.deepStrictEqual([st({ layers: r }), word({ layers: r }), word({ layers: r, h4: 'range' })], ['range', 'trend-up', 'unclear'], 'range: the alignment default (decision 3)');
});

test('the line: one exact string per state, structure then momentum then behavior, the class last, within the line budget', () => {
  const L1 = line({ layers: lay() });
  assert.strictEqual(L1, 'Market state (3m): trend up: HL 21380.5 holds, BOS up 6 min ago (displaced); overlap 0.52, efficiency 0.41, 15m trending up; 4h+1h up; class trend-up');
  const m = { ...lay().momentum, trigger: true, loss: true, dispAgainst: { barsAgo: 2 }, breakAgainst: { direction: 'down', level: 21412.25, barsAgo: 2, strong: false } };
  const weak = lay({ momentum: m, structure: leg({ sinceProgress: 9, lastWay: { kind: 'BOS', direction: 'up', level: 21412.25, barsAgo: 12, strong: false, failed: false }, lastInternal: { direction: 'down', level: 21412.25, barsAgo: 2 } }), behavior: { ...lay().behavior, word: 'failing', overlap: 0.64, eff: 0.12 } });
  assert.strictEqual(line({ layers: weak }), 'Market state (3m): weakening up: HL 21380.5 holds; displacement down 2 bars ago broke internal low 21412.25, no new high for 27 min; behavior failing (overlap 0.64, efficiency 0.12), 15m trending up; 4h+1h up; class unclear');
  const tr = lay({ transition: true, structure: leg({ side: 'down', status: 'broken', legOK: false, level: 21437.5, flip: { barsAgo: 3, strong: true, disp: true, held: true, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' } }), behavior: { ...lay().behavior, word: 'mixed', word15: 'overlapping' } });
  assert.strictEqual(line({ layers: tr }), 'Market state (3m): transition down: HL 21380.5 broken by a displaced close 9 min ago, the new leg unconfirmed; behavior mixed (overlap 0.52, efficiency 0.41), 15m overlapping; 4h+1h up; class unclear');
  const ch = lay({ chop: CHOP, structure: leg({ legOK: false }), behavior: { ...lay().behavior, word: 'failing', word15: 'overlapping', overlap: 0.74, eff: 0.09 } });
  assert.strictEqual(line({ layers: ch, h4: 'range', soFar: { status: 'read', read: 'rotational', vwapCrosses: 7 } }), 'Market state (3m): chop: no leg holds (breaks both ways, a failed break); overlap 0.74, efficiency 0.09, failed continuation; 15m overlapping; Day so far rotational, RTH VWAP crosses 7; 4h range, 1h up (not aligned); class chop');
  const rg = lay({ structure: leg({ legOK: false }), behavior: { ...lay().behavior, word: 'rotating' } });
  assert.strictEqual(line({ layers: rg }), 'Market state (3m): range: no leg holds, edges 21402-21431.25 (travel edge to edge); overlap 0.52, efficiency 0.41, 15m trending up; 4h+1h up; class trend-up');
  assert.strictEqual(line({ layers: lay({ structure: null }) }), 'Market state (3m): forming (no RTH structure yet); 4h+1h up; class trend-up');
  assert.strictEqual(line({ layers: lay(), pullback: pb() }), 'Market state (3m): pullback (long leg 21361.25 -> 21437.5, depth 28%): 3m up leg, HL 21380.5 holds; overlap 0.52, efficiency 0.41, 15m trending up; 4h+1h up; class trend-up');
  assert.strictEqual(line({ layers: lay({ stale: true, structure: leg({ sinceProgress: 22 }) }) }), 'Market state (3m): rotation up: HL 21380.5 holds, no new high for 66 min; behavior trending (overlap 0.52, efficiency 0.41), 15m trending up; 4h+1h up; class unclear');
  const rev = lay({ reversal: true, structure: leg({ flip: { barsAgo: 6, strong: true, disp: true, held: true, oldSide: 'down', oldLevel: 21420, byRule: 'close' } }) });
  assert.match(line({ layers: rev }), /HL 21380\.5 holds, BOS up 6 min ago \(displaced\), reversal confirmed;/, 'Reversal: printed on the leg');
  const back = lay({ momentum: { ...lay().momentum, trigger: true, dispAgainst: { barsAgo: 3 }, breakAgainst: { direction: 'down', level: 21380.5, barsAgo: 3, strong: true } }, structure: leg({ resumed: true, flip: { barsAgo: 3, strong: true, disp: false, held: false, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' } }) });
  assert.match(line({ layers: back }), /^Market state \(3m\): weakening up: HL 21380\.5 holds[^;]*; displacement down 3 bars ago through the HL, closed back;/, 'a break at the protected level itself is no internal break (review round 20, finding 1)');
  assert.doesNotMatch(line({ layers: back }), /broke internal low 21380\.5/);
  const tie = lay({ momentum: { ...lay().momentum, trigger: true, dispAgainst: { barsAgo: 0 }, breakAgainst: { direction: 'down', level: 21380.5, barsAgo: 0, strong: true } } });
  assert.match(line({ layers: tie }), /; displacement down this bar tested the HL \(a tie\);/, 'a close within the tie tolerance (decision 8): no break, not resumed');
  const kept = lay({ structure: leg({ resumed: true, flip: { barsAgo: 12, strong: false, disp: false, held: false, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' }, lastWay: { kind: 'BOS', direction: 'up', level: 21412.25, barsAgo: 20, strong: false, failed: false }, lastInternal: { direction: 'down', level: 21380.5, barsAgo: 12 } }), behavior: { ...lay().behavior, word: 'overlapping' } });
  assert.match(line({ layers: kept }), /: HL 21380\.5 holds, through the HL, closed back;/, 'the structure clause too: never "internal low X broken" beside "X holds"');
  assert.match(line({ layers: lay({ structure: leg({ lastWay: null, lastInternal: { direction: 'down', level: 21380.5, barsAgo: 1 } }), behavior: { ...lay().behavior, word: 'mixed' } }) }), /: HL 21380\.5 holds, tested the HL \(a tie\);/);
  // "closed back" is this break's fact, not the leg's (re-review of fe35c98b8, finding 1): a leg resumed earlier at another
  // level or bar, then a tie at its current level, prints the tie.
  const oldResume = { barsAgo: 15, strong: false, disp: false, held: false, oldSide: 'up', oldLevel: 21361.25, byRule: 'close' };
  const laterTie = lay({ momentum: { ...lay().momentum, trigger: true, dispAgainst: { barsAgo: 1 }, breakAgainst: { direction: 'down', level: 21380.5, barsAgo: 1, strong: true } }, structure: leg({ resumed: true, flip: oldResume }) });
  assert.match(line({ layers: laterTie }), /; displacement down 1 bar ago tested the HL \(a tie\);/, 'resumed at another level: this break is a tie');
  const sameLevelOtherBar = lay({ structure: leg({ resumed: true, flip: { ...oldResume, oldLevel: 21380.5 }, lastWay: null, lastInternal: { direction: 'down', level: 21380.5, barsAgo: 2 } }), behavior: { ...lay().behavior, word: 'mixed' } });
  assert.match(line({ layers: sameLevelOtherBar }), /: HL 21380\.5 holds, tested the HL \(a tie\);/, 'the resume was at another bar: this break is a tie');
  const heldFlip = lay({ structure: leg({ resumed: true, flip: { ...oldResume, oldLevel: 21380.5, barsAgo: 2, held: true }, lastWay: null, lastInternal: { direction: 'down', level: 21380.5, barsAgo: 2 } }), behavior: { ...lay().behavior, word: 'mixed' } });
  assert.match(line({ layers: heldFlip }), /tested the HL \(a tie\);/, 'a held flip never printed as closed back');
  const brokenRange = lay({ structure: leg({ status: 'broken', legOK: false, side: 'down', level: 21437.5, flip: { barsAgo: 2, strong: false, disp: false, held: true, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' } }), behavior: { ...lay().behavior, word: 'mixed' } });
  assert.deepStrictEqual([st({ layers: brokenRange }), word({ layers: brokenRange })], ['transition', 'unclear'], 'the side\'s protected HL broken without displacement: structure invalidated (round 20b), not the range default');
  assert.match(line({ layers: brokenRange }), /^Market state \(3m\): transition down: HL 21380\.5 broken by a close 6 min ago, the new leg unconfirmed;.*class unclear$/);
  const counterBroken = lay({ structure: leg({ status: 'broken', legOK: false, side: 'up', level: 21361.25, flip: { barsAgo: 2, strong: false, disp: false, held: true, oldSide: 'down', oldLevel: 21420, byRule: 'close' } }), behavior: { ...lay().behavior, word: 'mixed' } });
  assert.deepStrictEqual([st({ layers: counterBroken }), word({ layers: counterBroken })], ['range', 'trend-up'], 'a counter leg\'s protected level broken the side\'s way: today\'s range default');
  assert.match(line({ layers: counterBroken }), /^Market state \(3m\): range: no leg holds, LH 21420 broken 6 min ago, edges/, 'the broken protected level printed (finding 2)');
  const internal = lay({ structure: leg({ lastInternal: { direction: 'down', level: 21402.25, barsAgo: 1 } }), behavior: { ...lay().behavior, word: 'overlapping' } });
  assert.match(line({ layers: internal }), /^Market state \(3m\): in the up leg: HL 21380\.5 holds, internal low 21402\.25 broken; overlap 0\.52, efficiency 0\.41, 15m trending up;/, 'an internal break against while the HL holds');
  const d1 = lay({ momentum: { ...lay().momentum, dispAgainst: { barsAgo: 1 } } });
  assert.match(line({ layers: d1 }), /; displacement down 1 bar ago;/);
  const odf = lay({ momentum: { ...lay().momentum, odf: true }, behavior: { ...lay().behavior, word: 'overlapping' } });
  assert.match(line({ layers: odf }), /^Market state \(3m\): in the up leg: HL 21380\.5 holds, BOS up 6 min ago \(displaced\); potential failed opening drive; .*class trend-up$/, 'the opening-drive failure: a printed fact, no class change (decision 6)');
  const long = { layers: lay({ momentum: m, structure: leg({ sinceProgress: 9, lastWay: null }), behavior: { ...lay().behavior, word: 'failing', word15: 'trending down' } }), m15: 'up', h4: 'up', h1: 'up', pullback: undefined };
  const sLong = M.stateOf(b(long), { ...TH, lineBytes: 150 });
  assert.ok(Buffer.byteLength(M.marketStateLine(sLong)) < Buffer.byteLength(M.marketStateLine(M.stateOf(b(long), TH))), 'over the budget the behavior numbers drop');
  assert.doesNotMatch(M.marketStateLine(sLong), /\(overlap/);
  assert.match(M.marketStateLine(sLong), /behavior failing, 15m trending down; .*class unclear$/);
  for (const x of [L1, line({ layers: weak }), line({ layers: ch, h4: 'range', soFar: { status: 'read', read: 'rotational', vwapCrosses: 7 } })]) assert.ok(Buffer.byteLength(x) <= LINE_BYTES, `${Buffer.byteLength(x)}: ${x}`);
  // The worst chop line (every structure flag and behavior fact, a rotational day, two-digit crosses, not aligned) stays in
  // the budget (re-review finding 2): the day-so-far word drops; the chop's numbers (its evidence) stay.
  const worst = lay({ chop: { ...CHOP, facts: { ov: true, ef: true, fl: true, nd: true }, count: 4, evidence: { bothWays: true, flip: true, failed: true } }, structure: leg({ legOK: false }), behavior: { ...lay().behavior, word: 'failing', word15: 'overlapping', overlap: 0.74, eff: 0.09 } });
  const wo = { layers: worst, h4: 'range', h1: 'down', soFar: { status: 'read', read: 'rotational', vwapCrosses: 12 } };
  const wFull = M.marketStateLine(M.stateOf(b(wo), TH));
  const wCut = M.marketStateLine(M.stateOf(b(wo), { ...TH, lineBytes: LINE_BYTES }));
  assert.ok(Buffer.byteLength(wFull) > LINE_BYTES, `the case is over the budget unbudgeted: ${Buffer.byteLength(wFull)}`);
  assert.ok(Buffer.byteLength(wCut) <= LINE_BYTES, `${Buffer.byteLength(wCut)}: ${wCut}`);
  assert.match(wCut, /; overlap 0\.74, efficiency 0\.09, failed continuation, no displacement; 15m overlapping; RTH VWAP crosses 12; 4h range, 1h down \(not aligned\); class chop$/);
  assert.strictEqual(M.marketStateLine(M.stateOf(b({ ...wo, soFar: { status: 'read', read: 'rotational', vwapCrosses: null } }), { ...TH, lineBytes: 10 })).includes('Day so far'), false, 'the day-so-far word alone drops too');
  assert.strictEqual(M.marketStateLine(M.stateOf(b({ layers: ch, h4: 'range', soFar: { status: 'read', read: 'rotational', vwapCrosses: 7 } }), { ...TH, lineBytes: LINE_BYTES })), line({ layers: ch, h4: 'range', soFar: { status: 'read', read: 'rotational', vwapCrosses: 7 } }), 'under the budget: unchanged');

});

test('the behavior word (round 20b): printed only where it is the state\'s evidence (rotation, weakening, transition; chop names its facts); never under trend, in the leg, pullback or range', () => {
  const words = ['trending', 'failing', 'mixed', 'overlapping', 'rotating', 'early'];
  const m = { ...lay().momentum, trigger: true, dispAgainst: { barsAgo: 2 }, breakAgainst: { direction: 'down', level: 21412.25, barsAgo: 2, strong: false } };
  const flip = { barsAgo: 3, strong: true, disp: true, held: true, oldSide: 'up', oldLevel: 21380.5, byRule: 'close' };
  const broken = leg({ side: 'down', status: 'broken', legOK: false, level: 21437.5, flip });
  for (const w of words) {
    const beh = { ...lay().behavior, word: w };
    const quiet = { trend: { layers: lay({ behavior: { ...beh, word: 'trending' } }) }, leg: { layers: lay({ behavior: w === 'trending' ? { ...beh, word: 'mixed' } : beh }) }, pullback: { layers: lay({ behavior: beh }), pullback: pb() }, range: { layers: lay({ structure: leg({ legOK: false }), behavior: beh }) }, rangeBroken: { layers: lay({ structure: leg({ status: 'broken', legOK: false, side: 'up', level: 21361.25, flip: { ...flip, oldSide: 'down', oldLevel: 21420 } }), behavior: beh }) } };
    for (const [k, o] of Object.entries(quiet)) {
      const l = line(o);
      assert.doesNotMatch(l, /\bbehavior\b/, `${k} ${w}: ${l}`);
      assert.match(l, /; overlap 0\.52, efficiency 0\.41, 15m trending up; /, `${k}: the numbers and the 15m word stay`);
      if (k !== 'trend') assert.strictEqual(S(o).state, k === 'rangeBroken' ? 'range' : k);
    }
    const loud = { weakening: { layers: lay({ momentum: m, behavior: beh }) }, transition: { layers: lay({ transition: true, structure: broken, behavior: beh }) }, transitionUndisplaced: { layers: lay({ structure: leg({ ...broken, flip: { ...flip, disp: false, strong: false } }), behavior: beh }) }, rotation: { layers: lay({ stale: true, structure: leg({ sinceProgress: 22 }), behavior: beh }) }, rotationPb: { layers: lay({ pbRotation: true, pbPhase: { bars: 24, crosses: 4 }, behavior: beh }), pullback: pb() } };
    for (const [k, o] of Object.entries(loud)) assert.match(line(o), new RegExp(`; behavior ${w} \\(overlap 0\\.52, efficiency 0\\.41\\), 15m trending up; `), `${k} ${w}`);
  }
  // Over the budget the quiet states' numbers drop too (the 15m word stays).
  const tl = M.marketStateLine(M.stateOf(b({ layers: lay() }), { ...TH, lineBytes: 50 }));
  assert.match(tl, /\(displaced\); 15m trending up; 4h\+1h up; class trend-up$/, tl);
});

test('without m3.layers (an older record, a quiz item): the printed breaks alone, the same words; no behavior read, so never chop', () => {
  const brk = (kind, direction, level, m, protectedSwing) => ({ kind, direction, level, at: T(m), ...(protectedSwing ? { protected: protectedSwing } : {}) });
  const prot = (level, brokenAt = null) => ({ side: 'low', level, at: T(10), brokenAt });
  assert.strictEqual(line({ lastBreak: { last: null, previous: null } }), 'Market state (3m): forming (no RTH structure yet); 4h+1h up; class trend-up');
  assert.strictEqual(line({ lastBreak: { last: brk('BOS', 'up', 21495, 24, prot(21480.25)), previous: brk('BOS', 'up', 21470.5, 12) } }), 'Market state (3m): in the up leg: 3m BOS up then BOS up, 3 min ago, HL 21480.25 holds; 4h+1h up; class trend-up');
  assert.strictEqual(line({ lastBreak: { last: brk('BOS', 'up', 21495, 24, prot(21480.25, T(27))), previous: brk('BOS', 'up', 21470.5, 12) } }), 'Market state (3m): range: 3m BOS up then BOS up, HL 21480.25 broken by a close; 4h+1h up; class trend-up');
  const pair = { last: brk('CHoCH', 'up', 21558.25, 24), previous: brk('CHoCH', 'down', 21497.75, 12) };
  assert.deepStrictEqual([st({ lastBreak: pair }), line({ lastBreak: pair })], ['range', 'Market state (3m): range: 3m CHoCH down then CHoCH up (unconfirmed); 4h+1h up; class trend-up'], 'a CHoCH pair alone is no chop (the owner)');
  assert.strictEqual(line({ lastBreak: { last: brk('CHoCH', 'up', 21512.25, 24, prot(21462.5)), previous: null } }), 'Market state (3m): range: 3m CHoCH up (unconfirmed, holds above 21462.5 (origin)); 4h+1h up; class trend-up');
  assert.strictEqual(line({ lastBreak: { last: brk('CHoCH', 'up', 21512.25, 24, prot(21462.5, T(27))), previous: null } }), 'Market state (3m): range: 3m CHoCH up (failed: a close below its origin 21462.5); 4h+1h up; class trend-up');
  const cisd = { '3m': { dir: 'bullish', level: 21550, confirmedClose: T(30), status: 'waiting' } };
  assert.strictEqual(line({ lastBreak: pair, m3: { cisd } }), 'Market state (3m): in the up leg: 3m CHoCH down then CHoCH up, then a 3m CISD up (confirmed); 4h+1h up; class trend-up');
  assert.strictEqual(line({ lastBreak: { last: brk('BOS', 'down', 21470, 24), previous: null } }), 'Market state (3m): in the down leg: 3m BOS down, 3 min ago; 4h+1h up; class unclear');
  assert.strictEqual(line({ lastBreak: { last: brk('BOS', 'down', 21470, 24), previous: null }, pullback: pb() }), 'Market state (3m): pullback (long leg 21361.25 -> 21437.5, depth 28%): 3m BOS down; 4h+1h up; class trend-up', 'the 3m break inside the pullback printed');
  assert.strictEqual(line({ lastBreak: { last: brk('BOS', 'down', 21470, 24), previous: null }, m15: 'up' }), 'Market state (3m): in the down leg: 3m BOS down, 3 min ago; 15m up: a pullback in the 15m trend; 4h+1h up; class trend-up');
  assert.strictEqual(line({ closedAt: null }), 'Market state (3m): range: no 3m break printed; 4h+1h up; class trend-up', 'no clock (a fixture), no break');
  assert.strictEqual(line({ closedAt: null, h4: 'none' }), 'Market state (3m): range: no 3m break printed; 4h unknown, 1h up (not aligned); class unclear');
});

test('stateOf: off the entry lane or without a 1h part: null; readState has no lane guard; classWordOf(null) null', () => {
  assert.strictEqual(M.stateOf(b({ minutes: 15 }), TH), null);
  assert.strictEqual(M.stateOf({ minutes: 3, sections: {} }, TH), null);
  assert.strictEqual(M.readState({ sections: { h1: { data: {} } } }, TH).state, 'range');
  assert.strictEqual(M.marketStateLine(null), null);
  assert.strictEqual(M.classWordOf(null), null);
});

test('stateThresholds: the briefing\'s and the quiz\'s one set of thresholds from config/analysis.json (re-review finding 3)', () => {
  const an = require('../../scripts/lib/tunables').analysis();
  assert.deepStrictEqual(M.stateThresholds(an), { crossesChop: an.regime.rangeCrosses, maxPullbackDepth: an.pullbackRead.maxStateDepth, lineBytes: an.marketState.lineBytes });
  const fs = require('node:fs');
  const path = require('node:path');
  for (const f of ['trading/briefing.js', 'eval/context-quiz.js']) assert.match(fs.readFileSync(path.join(__dirname, '../../scripts/lib', f), 'utf8'), /stateThresholds\(/, f);
});

test('the briefing\'s crosses threshold equals the recognition key\'s', () => {
  const { analysis } = require('../../scripts/lib/tunables');
  assert.strictEqual(analysis().regime.rangeCrosses, require('../../config/recognition.json').signals.crossesChop);
});
