'use strict';

// The read audit's day and ctx columns (scripts/lib/learning/read-audit.js firstTouch, dayLabelOf, the row's dayCtx) and
// their report (scripts/lib/learning/read-audit-day-ctx.js): the model's own day class and structure context, scored
// against labels computed from the bars after the fact, never shown to it. Synthetic fixtures only, built here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const A = require('../../scripts/lib/learning/read-audit');
const DC = require('../../scripts/lib/learning/read-audit-day-ctx');
const { parseStateLine, scoreState, stateFacts } = require('../../scripts/lib/trading/state-read');
const { DAY_CLASS } = require('../../scripts/lib/trading/day-so-far');

const TF = 3 * 60 * 1000;
const T0 = Date.parse('2021-06-11T13:00:00.000Z'); // 09:00 ET: the 09:30 bar is index 10, the 11:57 bar index 59
const T = i => new Date(T0 + i * TF).toISOString();
const CYCLE = 30; // 10:30 ET
const CFG = { forwardBars: 5, stopAtr: 1 };
const SESSION = '09:30-12:00@America/New_York';

/** Flat bars at 100 (range 2: ATR 2, one unit 2 points), then `after(k)` for the k-th bar after the cycle. */
function bars({ n = 60, after = null, at = CYCLE } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const c = i > at && after ? after(i - at) : 100;
    return { t: T(i), o: c, h: c + 1, l: c - 1, c };
  });
}
const rising = k => 100 + 0.5 * k;
const falling = k => 100 - 0.5 * k;

const briefing = ({ h4 = 'up', h1 = 'up', m15 = 'up', soFar = { status: 'read', read: 'directional', direction: 'up' }, breaks = {} } = {}) => ({ asOf: T(CYCLE), sections: {
  h1: { data: { h4: { trend: h4 }, h1: { trend: h1 }, lastBreak: breaks.h1 ? { last: { direction: breaks.h1 } } : null } },
  m15: { data: { frame: { trend: m15 }, lastBreak: breaks.m15 ? { last: { direction: breaks.m15 } } : null } },
  m3: { data: { today: { soFar }, regime: { primary: 'trend-up' } } },
} });
function stateRead(line, b) {
  const p = parseStateLine(line);
  return { status: p.status, line: p.line, read: p.read, missing: p.missing, bad: p.bad, symbol: 'MNQ', bar: T(CYCLE), ...scoreState(p.read, b), facts: stateFacts(b) };
}
const decision = (action, r) => ({ key: `${T(CYCLE + 1)}|MNQ`, t: T(CYCLE + 1), symbol: 'MNQ', barT: T(CYCLE), inTrade: false, actual: { action }, trade: r === undefined ? null : { r } });
const audit = (over = {}) => A.auditDecision({ day: '2021-06-11', t: T(CYCLE + 1), symbol: 'MNQ', bars: bars({ after: rising }), cfg: CFG, ...over });

// ---- The after-the-fact structure label (FIXED-SET's: first touch of one unit either way) ----

test('first touch: held (one unit the side\'s way first), reversed (one unit against first), none (neither in the window)', () => {
  const ft = (after, side, extra = {}) => A.firstTouch({ bars: bars({ after }), cycleT: T(CYCLE), side, ...CFG, ...extra });
  // Unit = 1 x ATR(20) = 2 points from the cycle bar's close 100: a high of 102 is +1 unit (the rising bar k=2: c 101, h 102).
  assert.deepStrictEqual(ft(rising, 'long'), { label: 'held', bars: 2, unit: 2, why: null });
  assert.strictEqual(ft(rising, 'short').label, 'reversed');
  assert.strictEqual(ft(falling, 'long').label, 'reversed');
  assert.strictEqual(ft(falling, 'short').label, 'held');
  assert.strictEqual(ft(() => 100, 'long').label, 'none');
  // No side: none (no unit either way) or moved.
  assert.strictEqual(ft(() => 100, null).label, 'none');
  assert.strictEqual(ft(rising, null).label, 'moved');
  assert.strictEqual(ft(falling, null).label, 'moved');
  // A move after the window is not in it (forwardBars 5: +1 unit needs k=2; a jump at k=6 is outside).
  assert.strictEqual(ft(k => (k >= 6 ? 120 : 100), 'long').label, 'none');
  assert.strictEqual(ft(k => (k === 5 ? 102 : 100), 'long').label, 'held', 'the window\'s last bar is in it');
});

test('first touch: both ways in one bar is reversed (the adverse touch first, as the read audit\'s stop-first); the cycle bar itself is never in the window', () => {
  const wide = bars({ after: () => 100 });
  wide[CYCLE + 1] = { t: T(CYCLE + 1), o: 100, h: 103, l: 97, c: 100 };
  assert.strictEqual(A.firstTouch({ bars: wide, cycleT: T(CYCLE), side: 'long', ...CFG }).label, 'reversed');
  assert.strictEqual(A.firstTouch({ bars: wide, cycleT: T(CYCLE), side: 'short', ...CFG }).label, 'reversed');
  // The cycle bar with a huge range: its own high and low are no touch (mutation: a window from the cycle bar is caught).
  const own = bars({ after: () => 100 });
  own[CYCLE] = { t: T(CYCLE), o: 100, h: 110, l: 99.5, c: 100 };
  assert.strictEqual(A.firstTouch({ bars: own, cycleT: T(CYCLE), side: 'long', ...CFG }).label, 'none');
});

test('first touch: unknown (null, with why) with no cycle bar, no ATR, or too few bars after and no touch in them', () => {
  assert.match(A.firstTouch({ bars: bars(), cycleT: T(99), side: 'long', ...CFG }).why, /not in the bars/);
  assert.strictEqual(A.firstTouch({ bars: bars(), cycleT: T(5), side: 'long', ...CFG }).label, null);
  const short = bars({ n: CYCLE + 3, after: () => 100 });
  assert.match(A.firstTouch({ bars: short, cycleT: T(CYCLE), side: 'long', ...CFG }).why, /no forward bars yet/);
  // A touch inside the bars there is known.
  assert.strictEqual(A.firstTouch({ bars: bars({ n: CYCLE + 3, after: rising }), cycleT: T(CYCLE), side: 'long', ...CFG }).label, 'held');
});

// ---- The after-the-fact day label: the Day so far read of the whole session window ----

test('day label: the Day so far read over the session window\'s bars, as a day class (directional trend, rotational chop, mixed)', () => {
  assert.deepStrictEqual(DAY_CLASS, { directional: 'trend', rotational: 'chop', mixed: 'mixed', 'too early': 'early' });
  const lab = b => A.dayLabelOf(b, { day: '2021-06-11', session: SESSION, tfMs: TF });
  // Flat all morning: rotational -> chop.
  assert.strictEqual(lab(bars()).label, 'chop');
  // A steady rise from 10:30 (eff 0.145 x sqrt(50) = 1.03): directional -> trend.
  assert.strictEqual(lab(bars({ after: rising })).label, 'trend');
  // In between: mixed (a rise from 11:12: net 7.5 of a summed range 100, x sqrt(50) 0.53).
  assert.strictEqual(lab(bars({ after: rising, at: 44 })).label, 'mixed');
  // Bars after the window's end are not the day's label (a crash at 12:03 changes nothing).
  const later = [...bars({ after: rising }), ...Array.from({ length: 10 }, (_, j) => ({ t: T(60 + j), o: 50, h: 51, l: 49, c: 50 }))];
  assert.deepStrictEqual(lab(later), lab(bars({ after: rising })));
});

test('day label: unknown (null, with why) when the bars end before the window\'s end, or the run has no session window', () => {
  const short = A.dayLabelOf(bars({ n: 45 }), { day: '2021-06-11', session: SESSION, tfMs: TF });
  assert.deepStrictEqual([short.label, short.why], [null, 'the day\'s bars end before the session window\'s end']);
  const none = A.dayLabelOf(bars(), { day: '2021-06-11', session: null, tfMs: TF });
  assert.deepStrictEqual([none.label, none.why], [null, 'no session window in the run\'s config']);
  assert.strictEqual(A.dayLabelOf(bars(), { day: '2021-06-12', session: SESSION, tfMs: TF }).label, null, 'another day: no bars');
});

// ---- The row's columns ----

test('row: the day read against the day label, its copy of the Day so far word, and the ctx against the first touch in its own side\'s way', () => {
  const sr = stateRead('STATE: 4h up | 1h up | 15m up | frames agree | day chop | ctx pullback', briefing());
  const row = audit({ stateRead: sr, decision: decision('none'), dayLabel: { label: 'trend', why: null } });
  assert.deepStrictEqual(row.dayCtx.day, { read: 'chop', label: 'trend', why: null, result: 'wrong', soFar: 'trend', copy: false, hour: '10' });
  // pullback in its own way (long): the rise holds -> right.
  assert.deepStrictEqual(row.dayCtx.ctx, { read: 'pullback', side: 'long', label: 'held', result: 'right', coded: 'continuation', why: null });
  assert.strictEqual(row.dayCtx.preEntryBD, false, 'a pass is no entry');
  // reversal right iff reversed; continuation as pullback; unclear iff no move either way.
  const ctx = (line, after) => audit({ stateRead: stateRead(line, briefing()), bars: bars({ after }), dayLabel: { label: 'chop' } }).dayCtx.ctx;
  assert.strictEqual(ctx('STATE: 4h up | 1h up | ctx reversal', falling).result, 'right');
  assert.strictEqual(ctx('STATE: 4h up | 1h up | ctx reversal', rising).result, 'wrong');
  assert.strictEqual(ctx('STATE: 4h down | 1h down | ctx continuation', falling).result, 'right');
  assert.strictEqual(ctx('STATE: 4h range | 1h up | ctx unclear', () => 100).result, 'right');
  assert.strictEqual(ctx('STATE: 4h range | 1h up | ctx unclear', rising).result, 'wrong');
  // A side-taking word with no side of its own: unscorable, never guessed.
  const noSide = ctx('STATE: 4h range | 1h up | ctx pullback', rising);
  assert.deepStrictEqual([noSide.result, noSide.why], [null, 'a side\'s ctx word with no 4h/1h side of the read\'s own']);
  assert.strictEqual(ctx('STATE: 4h up | 1h up | ctx unknown', rising).result, null);
  // The day: right on its class; early and unknown name no class (null); no label: null.
  const day = (w, label) => audit({ stateRead: stateRead(`STATE: 4h up | day ${w}`, briefing()), dayLabel: { label } }).dayCtx.day.result;
  assert.deepStrictEqual(['trend', 'chop', 'mixed', 'early', 'unknown'].map(w => day(w, 'trend')), ['right', 'wrong', 'wrong', null, null]);
  assert.strictEqual(day('chop', 'chop'), 'right');
  assert.strictEqual(day('chop', null), null);
  // Copy: the read's day word against the Day so far word at the bar (too early -> early).
  const copy = audit({ stateRead: stateRead('STATE: 4h up | day early', briefing({ soFar: { status: 'too early', bars: 4 } })), dayLabel: { label: 'chop' } }).dayCtx.day;
  assert.deepStrictEqual([copy.soFar, copy.copy], ['early', true]);
});

test('row: pre-entry B/D: an entry on an objective-chop day while its own day read said chop, mixed or early (never trend)', () => {
  const bd = (w, label, action = 'long') => audit({ stateRead: stateRead(`STATE: 4h up | 1h up | day ${w}`, briefing()), decision: decision(action, 1), dayLabel: { label } }).dayCtx.preEntryBD;
  assert.deepStrictEqual(['chop', 'mixed', 'early', 'trend'].map(w => bd(w, 'chop')), [true, true, true, false]);
  assert.strictEqual(bd('chop', 'trend'), false, 'not a chop day');
  assert.strictEqual(bd('chop', 'chop', 'none'), false, 'a pass');
  // No day word: not counted from the model (the coded source is the benchmark's, not this record's).
  assert.strictEqual(audit({ stateRead: stateRead('STATE: 4h up | 1h up', briefing()), decision: decision('long', 1), dayLabel: { label: 'chop' } }).dayCtx.preEntryBD, null);
});

test('row: no read of its own (no record, a coded read) has no model day or ctx; the columns never change the class', () => {
  const sr = stateRead('STATE: 4h up | 1h up | 15m up | frames agree', briefing());
  const without = audit({ stateRead: sr, decision: decision('none') });
  const withDay = audit({ stateRead: stateRead('STATE: 4h up | 1h up | 15m up | frames agree | day chop | ctx reversal', briefing()), decision: decision('none'), dayLabel: { label: 'trend' } });
  assert.strictEqual(without.class, withDay.class, 'day and ctx are beside the class, never in it');
  assert.deepStrictEqual(withDay.misread, []);
  assert.deepStrictEqual([without.dayCtx.day.read, without.dayCtx.ctx.read], [null, null]);
  const coded = A.auditDecision({ day: '2021-06-11', t: T(CYCLE + 1), symbol: 'MNQ', bars: bars({ after: rising }), cfg: CFG, stateRead: { ...sr, status: 'none', read: null }, decision: decision('none'), coded: true, dayLabel: { label: 'trend' } });
  assert.deepStrictEqual([coded.source, coded.dayCtx.day.read, coded.dayCtx.ctx.read], ['coded', null, null]);
  assert.strictEqual(coded.dayCtx.day.label, 'trend', 'the label is still recorded');
});

test('look-ahead: poisoning every bar after the cycle bar leaves the read and its copy column identical; only the labels may change', () => {
  const sr = stateRead('STATE: 4h up | 1h up | day trend | ctx pullback', briefing());
  const a = audit({ stateRead: sr, bars: bars({ after: rising }) }).dayCtx;
  const b = audit({ stateRead: sr, bars: bars({ after: falling }) }).dayCtx;
  assert.deepStrictEqual([a.day.read, a.day.soFar, a.day.copy, a.ctx.read, a.ctx.side, a.ctx.coded], [b.day.read, b.day.soFar, b.day.copy, b.ctx.read, b.ctx.side, b.ctx.coded]);
  assert.notStrictEqual(a.ctx.label, b.ctx.label);
});

// ---- The report ----

function rowsFor() {
  const at = (i, line, { label, soFar, after = rising, action = 'none', r } = {}) => A.auditDecision({ day: label === 'chop' ? '2021-06-12' : '2021-06-11', t: T(i + 1), symbol: 'MNQ', bars: bars({ after, at: i }), cfg: CFG,
    stateRead: { ...stateRead(line, briefing({ soFar })), bar: T(i) }, decision: { ...decision(action, r), barT: T(i) }, dayLabel: { label } });
  const early = { status: 'too early', bars: 3 };
  const rot = { status: 'read', read: 'rotational' };
  return [
    at(12, 'STATE: 4h up | 1h up | day early | ctx pullback', { label: 'chop', soFar: early }), // 09:36: early (no class), copy
    at(25, 'STATE: 4h up | 1h up | day chop | ctx reversal', { label: 'chop', soFar: rot, after: falling }), // 10:15: chop right, copy; reversal right
    at(26, 'STATE: 4h up | 1h up | day trend | ctx continuation', { label: 'chop', soFar: rot, action: 'long', r: -1 }), // 10:18: trend wrong, departs; entry on chop day read trend: no B/D
    at(27, 'STATE: 4h up | 1h up | day mixed | ctx pullback', { label: 'chop', soFar: rot, action: 'long', r: -1, after: falling }), // 10:21: B/D entry; pullback wrong
    at(40, 'STATE: 4h up | 1h up | day trend | ctx pullback', { label: 'trend', soFar: { status: 'read', read: 'directional' } }), // 11:00: trend right, copy
    at(41, 'STATE: 4h up | 1h up | 15m up | frames agree', { label: 'trend' }), // no day or ctx word
    at(42, 'STATE: 4h up | 1h up | day trend | ctx pullback', { label: 'trend', soFar: rot }), // 11:06: departs from a wrong Day so far word, right
    at(28, 'STATE: 4h up | 1h up | 15m up', { label: 'chop', soFar: rot, action: 'long', r: -1 }), // 10:24: an entry on a chop day with no day word: no B/D
  ];
}

test('report: written share, day recall per label class by hour, copy agreement and the departures, ctx right by word, pre-entry B/D', () => {
  const s = DC.summarizeDayCtx(rowsFor());
  assert.deepStrictEqual(s.written, { decisions: 8, withRead: 8, day: 6, ctx: 6 });
  assert.deepStrictEqual(s.day.byLabel.chop, { n: 4, right: 1, words: { early: 1, chop: 1, trend: 1, mixed: 1 } });
  assert.deepStrictEqual(s.day.byLabel.trend, { n: 2, right: 2, words: { trend: 2 } });
  assert.deepStrictEqual(s.day.byHour, { '09': { chop: { n: 1, right: 0 } }, '10': { chop: { n: 3, right: 1 } }, '11': { trend: { n: 2, right: 2 } } });
  assert.deepStrictEqual(s.day.copy, { n: 6, same: 3, soFarEarly: { n: 1, same: 1 }, soFarRead: { n: 5, same: 2 } });
  // Three departures: two wrong where the Day so far word was right, one right where it was wrong.
  assert.deepStrictEqual(s.day.departures, { n: 3, right: 1, wrong: 2, unscored: 0, soFarRight: 2 });
  assert.deepStrictEqual(s.ctx.byWord, { pullback: { n: 4, right: 2, wrong: 1, unscorable: 1 }, reversal: { n: 1, right: 1, wrong: 0, unscorable: 0 }, continuation: { n: 1, right: 1, wrong: 0, unscorable: 0 } });
  // The 09:36 row has no ATR(20) at its bar yet: its pullback is unscorable, never guessed.
  assert.deepStrictEqual([s.ctx.right, s.ctx.scored, s.ctx.sameAsCoded], [4, 5, 1]);
  // B/D: only an entry whose own day word said chop, mixed or early (the 10:24 entry wrote none: not counted).
  assert.strictEqual(s.preEntryBD.n, 1);
  assert.deepStrictEqual(s.preEntryBD.entries.map(e => e.read), ['mixed']);
  const text = DC.renderDayCtx(s);
  assert.match(text, /day read, its own words, vs the day label/);
  assert.match(text, /copies the Day so far word on 3 of 6/);
  assert.match(text, /pre-entry B\/D entries: 1/);
  assert.doesNotMatch(text, /accura/i);
});

test('report: a departure that names no class (early against a read Day so far word) or has no day label is unscored, never right or wrong, and never in soFarRight', () => {
  const rot = { status: 'read', read: 'rotational' };
  const at = (i, line, label) => A.auditDecision({ day: '2021-06-12', t: T(i + 1), symbol: 'MNQ', bars: bars({ at: i }), cfg: CFG,
    stateRead: { ...stateRead(line, briefing({ soFar: rot })), bar: T(i) }, decision: { ...decision('none'), barT: T(i) }, dayLabel: { label } });
  const rows = [
    at(25, 'STATE: 4h up | 1h up | day early | ctx pullback', 'chop'), // early vs chop: departs, no class -> unscored (its Day so far word chop was right)
    at(26, 'STATE: 4h up | 1h up | day trend | ctx pullback', null), // trend vs chop on an unlabelled day: departs, unscored
    at(27, 'STATE: 4h up | 1h up | day trend | ctx pullback', 'chop'), // trend vs chop on a chop day: wrong, the Day so far word right
    at(28, 'STATE: 4h up | 1h up | day chop | ctx pullback', 'chop'), // a copy: not a departure
  ];
  const d = DC.summarizeDayCtx(rows).day.departures;
  assert.deepStrictEqual(d, { n: 3, right: 0, wrong: 1, unscored: 2, soFarRight: 1 });
  assert.strictEqual(d.right + d.wrong + d.unscored, d.n, 'every departure is right, wrong or unscored');
  const text = DC.renderDayCtx(DC.summarizeDayCtx(rows));
  assert.match(text, /departures 3: right 0, wrong 1, unscored 2 \(early, or no day label\), the Day so far word right on 1 of the 1 scored/);
});

test('report: no rows, or rows without day or ctx words, report zeros, never a rate from nothing', () => {
  const s = DC.summarizeDayCtx([]);
  assert.deepStrictEqual(s.written, { decisions: 0, withRead: 0, day: 0, ctx: 0 });
  assert.match(DC.renderDayCtx(s), /day word on 0 of 0/);
  const none = DC.summarizeDayCtx([rowsFor()[5]]);
  assert.deepStrictEqual([none.written.day, none.day.copy.n, none.ctx.scored], [0, 0, 0]);
});

// ---- The run ----

test('a run: the day label from the run\'s own session window and bars; no sessions in its config: no label, with why', () => {
  const runId = 'arm-dc-t20210611.abc.0';
  const home = path.join(tmpDir(), runId);
  const dir = path.join(home, 'replay', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, runId }));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: bars({ after: rising }) }));
  const sr = stateRead('STATE: 4h up | 1h up | 15m up | day chop | ctx pullback', briefing());
  fs.writeFileSync(path.join(dir, '2021-06-11.jsonl'), `${JSON.stringify({ v: 1, t: T(CYCLE + 1), day: '2021-06-11', kind: 'trade', ran: [{ action: 'trade', symbols: ['MNQ'] }], cycles: [{ action: 'trade', result: 'CYCLE RESULT: no-trade - x', orders: [], stateRead: sr }] })}\n`);
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'], sessions: [SESSION] }));
  const [row] = A.runRows(home, { cfg: CFG }).rows;
  assert.deepStrictEqual([row.dayCtx.day.label, row.dayCtx.day.result, row.dayCtx.ctx.result], ['trend', 'wrong', 'right']);
  // The CLI reports it, in text and --json.
  const { spawnSync } = require('child_process');
  const cli = args => spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'read-audit.js'), ...args], { encoding: 'utf8' });
  const text = cli(['--run', home]);
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /Day and ctx .*day word on 1 of 1 decisions, ctx word on 1 of 1/);
  assert.match(text.stdout, /trend-labelled days: its word trend on 0 of 1 \(words: chop 1\)/);
  assert.deepStrictEqual(JSON.parse(cli(['--run', home, '--json']).stdout).dayCtx.written, { decisions: 1, withRead: 1, day: 1, ctx: 1 });
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'] }));
  const [bare] = A.runRows(home, { cfg: CFG }).rows;
  assert.deepStrictEqual([bare.dayCtx.day.label, bare.dayCtx.day.why, bare.dayCtx.day.result], [null, 'no session window in the run\'s config', null]);
});
