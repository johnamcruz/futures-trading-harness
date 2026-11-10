'use strict';

// The read audit (scripts/lib/learning/read-audit.js): per decision, what the model read (its STATE line), what the
// market was doing (the cycle bar's briefing labels, as recorded), and what happened next (OUTCOME: the trade's R, or a
// pass's forward move in R of a standard stop). Synthetic fixtures only, built here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');
const A = require('../../scripts/lib/learning/read-audit');
const { parseStateLine, scoreState, stateFacts } = require('../../scripts/lib/trading/state-read');

const ROOT = path.resolve(__dirname, '..', '..');
const TF = 3 * 60 * 1000;
const T0 = Date.parse('2021-06-11T13:00:00.000Z');
const T = i => new Date(T0 + i * TF).toISOString();
const CYCLE = 30; // the cycle bar's index: enough bars before it for ATR(20)
const CFG = { forwardBars: 5, stopAtr: 1 };

/** Flat bars at 100 (each range 2: ATR 2, so a 1 ATR stop is 2 points), then `after(k)` for the k-th bar after the cycle. */
function bars({ n = 60, after = null } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const c = i > CYCLE && after ? after(i - CYCLE) : 100;
    return { t: T(i), o: c, h: c + 1, l: c - 1, c };
  });
}
const rising = k => 100 + 0.5 * k; // +0.25R a bar on a 2-point stop, low never past the stop
const falling = k => 100 - 0.5 * k;

const briefing = (h4, h1, m15, day = 'directional') => ({ asOf: T(CYCLE), sections: {
  h1: { data: { h4: { trend: h4 }, h1: { trend: h1 } } },
  m15: { data: { frame: { trend: m15 } } },
  m3: { data: { today: { soFar: { status: 'read', read: day } } } },
} });
/** A cycle's STATE record as cycle-log.js keeps it: the real parser and scorer on a synthetic briefing. */
function stateRead(line, b) {
  const p = parseStateLine(line);
  return { status: p.status, line: p.line, read: p.read, missing: p.missing, bad: p.bad, symbol: 'MNQ', bar: T(CYCLE), ...scoreState(p.read, b), facts: stateFacts(b) };
}
const UP = briefing('up', 'up', 'up');
const decision = (action, r, extra = {}) => ({ key: `${T(CYCLE + 1)}|MNQ`, t: T(CYCLE + 1), symbol: 'MNQ', barT: T(CYCLE), inTrade: false, actual: { action }, trade: r === undefined ? null : { r }, ...extra });
const audit = (over = {}) => A.auditDecision({ day: '2021-06-11', t: T(CYCLE + 1), symbol: 'MNQ', bars: bars({ after: rising }), cfg: CFG, ...over });

// ---- The pieces ----

test('read side: long or short only when the read\'s own 4h and 1h both trend that way', () => {
  assert.strictEqual(A.readSide({ frames: { '4h': 'up', '1h': 'up', '15m': 'down' } }), 'long');
  assert.strictEqual(A.readSide({ frames: { '4h': 'down', '1h': 'down' } }), 'short');
  for (const f of [{ '4h': 'up', '1h': 'range' }, { '4h': 'up', '1h': 'transition' }, { '4h': 'up', '1h': 'unknown' }, { '4h': 'up' }, {}]) assert.strictEqual(A.readSide({ frames: f }), null, JSON.stringify(f));
  assert.strictEqual(A.readSide(null), null);
});

test('consistency table: only what the read itself says against the trend rule; transition and unknown never contradict', () => {
  const r = f => ({ frames: f });
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'down', '1h': 'down', '15m': 'down' }), 'long'), ['counter-own-htf']);
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'up', '1h': 'down' }), 'long'), ['counter-own-htf'], 'one trending frame against is enough (the trend rule)');
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'up', '1h': 'up', '15m': 'down' }), 'long'), [], 'a 15m against an HTF trend is a pullback, allowed');
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'range', '1h': 'range', '15m': 'up' }), 'short'), ['counter-own-15m']);
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'range', '1h': 'range', '15m': 'range' }), 'long'), ['no-own-side']);
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'range', '1h': 'range', '15m': 'up' }), 'long'), []);
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'transition', '1h': 'unknown', '15m': 'down' }), 'long'), [], 'the read says no trend it can be held to');
  assert.deepStrictEqual(A.inconsistencies(r({ '4h': 'range', '1h': 'transition', '15m': 'range' }), 'long'), []);
  assert.deepStrictEqual(A.inconsistencies(r({}), 'long'), []);
  assert.ok(A.CONSISTENCY.every(x => typeof x.key === 'string' && typeof x.says === 'string'));
});

test('forward move: from the cycle bar\'s close over the bars strictly after it, in R of the standard stop', () => {
  const b = bars({ after: rising });
  const long = A.forwardMove({ bars: b, cycleT: T(CYCLE), side: 'long', ...CFG });
  assert.strictEqual(long.stop, 2);
  assert.strictEqual(long.R, 1.25); // 5 bars x 0.5 points over a 2-point stop
  assert.strictEqual(long.stopped, false);
  const short = A.forwardMove({ bars: b, cycleT: T(CYCLE), side: 'short', ...CFG });
  assert.strictEqual(short.R, -1, 'the short side is stopped when a bar reaches entry + stop');
  assert.strictEqual(short.stopped, true);
});

test('forward move: the stop is the scorecard labels\' ATR(20) at the cycle bar (bars closed by its close), whatever comes after', () => {
  const { atrAt } = require('../../scripts/lib/replay/labels');
  const b = bars({ after: rising }).map((x, i) => ({ ...x, h: x.c + 1 + (i % 7) * 0.25, l: x.c - 1 - (i % 5) * 0.5 }));
  const want = atrAt(b.map(x => ({ ...x, ms: Date.parse(x.t) })), TF, Date.parse(T(CYCLE)) + TF);
  const got = A.forwardMove({ bars: b, cycleT: T(CYCLE), side: 'long', ...CFG }).stop;
  assert.ok(Math.abs(got - want) < 1e-4, `${got} vs ${want}`);
  const wide = b.map((x, i) => (i > CYCLE ? { ...x, h: x.c + 50, l: x.c - 0.1 } : x));
  assert.strictEqual(A.forwardMove({ bars: wide, cycleT: T(CYCLE), side: 'long', ...CFG }).stop, got);
});

test('forward move: a bar touching the stop is -1R even when it closes back (stop first)', () => {
  const b = bars();
  b[CYCLE + 2] = { ...b[CYCLE + 2], l: 97.5, h: 110, c: 109 };
  const f = A.forwardMove({ bars: b, cycleT: T(CYCLE), side: 'long', ...CFG });
  assert.strictEqual(f.R, -1);
  assert.strictEqual(f.stopped, true);
});

test('forward move: the cycle bar itself is never in the window (mutation: a window starting at the cycle bar is caught)', () => {
  const b = bars({ after: rising });
  b[CYCLE] = { ...b[CYCLE], l: 90 }; // its own low would stop a long, were it inside the window
  const f = A.forwardMove({ bars: b, cycleT: T(CYCLE), side: 'long', ...CFG });
  assert.strictEqual(f.stopped, false);
  assert.ok(f.R > 0);
});

test('forward move: too few bars after the cycle is unknown (null, never 0); a stop inside the bars there is known', () => {
  const few = bars({ n: CYCLE + 3, after: rising });
  const f = A.forwardMove({ bars: few, cycleT: T(CYCLE), side: 'long', ...CFG });
  assert.strictEqual(f.R, null);
  assert.match(f.why, /no forward bars yet \(2 of 5\)/);
  const stoppedEarly = A.forwardMove({ bars: bars({ n: CYCLE + 3, after: falling }), cycleT: T(CYCLE), side: 'long', ...{ ...CFG, stopAtr: 0.5 } });
  assert.strictEqual(stoppedEarly.R, -1);
  const missing = A.forwardMove({ bars: bars(), cycleT: '2022-01-01T00:00:00.000Z', side: 'long', ...CFG });
  assert.strictEqual(missing.R, null);
  assert.match(missing.why, /cycle bar/);
  const noAtr = A.forwardMove({ bars: bars().slice(CYCLE - 5), cycleT: T(CYCLE), side: 'long', ...CFG });
  assert.strictEqual(noAtr.R, null);
  assert.match(noAtr.why, /ATR/);
});

// ---- One test per class ----

test('class MISREAD: a scored field mismatches the recorded label, whatever the outcome', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h up | 1h down | 15m up | frames disagree', UP), decision: decision('long', 2.5) });
  assert.strictEqual(row.class, 'misread');
  assert.deepStrictEqual(row.misread.sort(), ['1h', 'frames']);
  assert.strictEqual(row.outcome.R, 2.5);
  assert.strictEqual(row.outcome.basis, 'trade');
});

test('unknown is never a mismatch: an unknown or transition field neither misreads nor counts as read', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h unknown | 1h transition | 15m up', UP), decision: decision('long', 1.5) });
  assert.strictEqual(row.class, 'acted-right');
  assert.deepStrictEqual(row.misread, []);
  assert.deepStrictEqual(row.scored, ['15m']);
  const none = audit({ stateRead: stateRead('STATE: 4h unknown | 1h transition', UP), decision: decision('long', 1.5) });
  assert.strictEqual(none.class, null);
  assert.strictEqual(none.unscorable, 'no scored field (every stated field unknown)');
});

test('class READ RIGHT / ACTED WRONG: every scored field matches, the entry is against the read\'s own trending frames', () => {
  const down = briefing('down', 'down', 'down');
  const row = audit({ stateRead: stateRead('STATE: 4h down | 1h down | 15m down | frames agree', down), decision: decision('long', 3) });
  assert.strictEqual(row.class, 'acted-wrong');
  assert.deepStrictEqual(row.broken, ['counter-own-htf']);
  assert.strictEqual(row.outcome.R, 3, 'a winner can still be acted wrong: the class is the read and the act, not the result');
});

test('class READ RIGHT / MARKET TURNED: read right, consistent, the trade at or past the stop', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h up | 1h up | 15m up | frames agree', UP), decision: decision('long', -1.016) });
  assert.strictEqual(row.class, 'market-turned');
});

test('read right, consistent, between the stop and 0 is its own row (never folded into turned or right)', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h up | 1h up | 15m up', UP), decision: decision('long', -0.4) });
  assert.strictEqual(row.class, 'small-loss');
  assert.strictEqual(audit({ stateRead: stateRead('STATE: 4h up | 1h up | 15m up', UP), decision: decision('long', 0) }).class, 'small-loss');
});

test('class READ RIGHT / ACTED RIGHT: read right, consistent, the trade positive', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h up | 1h up | 15m up | frames agree', UP), decision: decision('long', 0.01) });
  assert.strictEqual(row.class, 'acted-right');
  assert.deepStrictEqual(row.broken, []);
});

test('a pass is never acted wrong: read right, a no-trade is PASSED with the forward move of its read\'s side', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h up | 1h up | 15m up', UP), decision: decision('none') });
  assert.strictEqual(row.kind, 'pass');
  assert.strictEqual(row.class, 'passed');
  assert.strictEqual(row.outcome.basis, 'forward');
  assert.strictEqual(row.outcome.side, 'long');
  assert.strictEqual(row.outcome.R, 1.25);
  // A pass whose read has no side: both sides, and no single R.
  const range = briefing('range', 'up', 'up');
  const both = audit({ stateRead: stateRead('STATE: 4h range | 1h up | 15m up', range), decision: decision('none') });
  assert.strictEqual(both.class, 'passed');
  assert.strictEqual(both.outcome.side, null);
  assert.strictEqual(both.outcome.R, null);
  assert.strictEqual(both.outcome.long, 1.25);
  assert.strictEqual(both.outcome.short, -1);
  // A pass on a read the consistency table would hold an entry to (all ranging: no side) is still passed, nothing broken.
  const flat = briefing('range', 'range', 'range');
  const pass = audit({ stateRead: stateRead('STATE: 4h range | 1h range | 15m range', flat), decision: decision('none') });
  assert.strictEqual(pass.class, 'passed');
  assert.deepStrictEqual(pass.broken, []);
  const entry = audit({ stateRead: stateRead('STATE: 4h range | 1h range | 15m range', flat), decision: decision('long', 1) });
  assert.strictEqual(entry.class, 'acted-wrong');
  assert.deepStrictEqual(entry.broken, ['no-own-side']);
});

test('unscorable: no record, no STATE line, an unfilled entry, an entry with no decision record, no forward bars', () => {
  assert.strictEqual(audit({ stateRead: null, decision: decision('none') }).unscorable, 'no state record');
  assert.strictEqual(audit({ stateRead: stateRead('no line here', UP), decision: decision('none') }).unscorable, 'no STATE line (status none)');
  assert.strictEqual(audit({ stateRead: { error: 'boom' }, decision: decision('none') }).unscorable, 'state record error');
  const unfilled = audit({ stateRead: stateRead('STATE: 4h up | 1h up', UP), decision: decision('long') });
  assert.strictEqual(unfilled.class, null);
  assert.strictEqual(unfilled.kind, 'entry');
  assert.match(unfilled.unscorable, /not filled/);
  const unjoined = audit({ stateRead: stateRead('STATE: 4h up | 1h up', UP), decision: null, orders: [{ side: 'buy', gate: 'allowed' }], result: 'CYCLE RESULT: executed - long' });
  assert.strictEqual(unjoined.kind, 'entry');
  assert.strictEqual(unjoined.side, 'long');
  assert.match(unjoined.unscorable, /no decision record/);
  const late = audit({ stateRead: stateRead('STATE: 4h up | 1h up', UP), decision: decision('none'), bars: bars({ n: CYCLE + 2 }) });
  assert.match(late.unscorable, /no forward bars yet/);
  // The outcome is still shown for an unscorable row when it can be computed (the record lacks the read, not the market).
  const noRead = audit({ stateRead: null, decision: decision('none') });
  assert.strictEqual(noRead.outcome.long, 1.25);
});

test('a cycle in a trade is not an entry or pass decision: kind in-trade, never classed', () => {
  const row = audit({ stateRead: stateRead('STATE: 4h up | 1h up', UP), decision: decision('none', undefined, { inTrade: true }) });
  assert.strictEqual(row.kind, 'in-trade');
  assert.strictEqual(row.class, null);
  assert.strictEqual(audit({ stateRead: null, decision: null, result: 'CYCLE RESULT: managed - holding' }).kind, 'in-trade');
});

// ---- No look-ahead ----

test('look-ahead: poisoning every bar after the cycle bar leaves columns 1 and 2 identical; only the outcome may change', () => {
  const sr = stateRead('STATE: 4h up | 1h up | 15m range | frames disagree', briefing('up', 'up', 'range'));
  const clean = bars({ after: rising });
  const poisoned = clean.map((b, i) => (i > CYCLE ? { ...b, o: 1e6, h: 1e6 + 1, l: -1e6, c: -1e6 } : b));
  for (const d of [decision('none'), decision('long', 1.2)]) {
    const a = audit({ stateRead: sr, decision: d, bars: clean });
    const b = audit({ stateRead: sr, decision: d, bars: poisoned });
    assert.deepStrictEqual(b.read, a.read);
    assert.deepStrictEqual(b.state, a.state);
    assert.deepStrictEqual(b.misread, a.misread);
    assert.deepStrictEqual(b.broken, a.broken);
    if (d.actual.action === 'none') assert.notDeepStrictEqual(b.outcome, a.outcome, 'the outcome reads the bars after');
    else assert.deepStrictEqual(b.outcome, a.outcome, 'an entry\'s outcome is its recorded trade R');
  }
  // Bars past the forward window change nothing at all.
  const past = clean.map((b, i) => (i > CYCLE + CFG.forwardBars ? { ...b, h: 1e6, l: -1e6, c: 0 } : b));
  assert.deepStrictEqual(audit({ stateRead: sr, decision: decision('none'), bars: past }), audit({ stateRead: sr, decision: decision('none'), bars: clean }));
});

// ---- The report ----

/** Rows on several days: misreads, each read-right class, passes, unscorables. */
function sample() {
  const right = stateRead('STATE: 4h up | 1h up | 15m up | frames agree', UP);
  const wrong = stateRead('STATE: 4h up | 1h down | 15m up', UP);
  const rows = [];
  const day = k => `2021-06-${String(10 + k).padStart(2, '0')}`;
  for (let k = 0; k < 3; k += 1) {
    rows.push({ ...audit({ stateRead: wrong, decision: decision('long', -1.02) }), day: day(k) });
    rows.push({ ...audit({ stateRead: right, decision: decision('long', 2) }), day: day(k) });
    rows.push({ ...audit({ stateRead: right, decision: decision('long', -1) }), day: day(k) });
    rows.push({ ...audit({ stateRead: right, decision: decision('none') }), day: day(k) });
  }
  rows.push({ ...audit({ stateRead: right, decision: decision('long', 9) }), day: day(0) }); // the best day's big winner
  rows.push({ ...audit({ stateRead: null, decision: decision('long', -1) }), day: day(1) });
  rows.push({ ...audit({ stateRead: right, decision: decision('none', undefined, { inTrade: true }) }), day: day(1) });
  return rows;
}

test('summary: counts and net R per class with n, entries and passes apart, unscorable counted on its own', () => {
  const s = A.summarize(sample());
  assert.strictEqual(s.decisions, 15);
  assert.strictEqual(s.inTrade, 1);
  assert.strictEqual(s.unscorable.n, 1);
  assert.deepStrictEqual(s.unscorable.why, { 'no state record': 1 });
  assert.strictEqual(s.unscorable.outcome.entries.netR, -1, 'an unscorable row\'s outcome is still shown, apart');
  assert.strictEqual(s.classes.misread.n, 3);
  assert.strictEqual(s.classes.misread.entries.n, 3);
  assert.strictEqual(s.classes.misread.entries.netR, -3.06);
  assert.strictEqual(s.classes.misread.passes.n, 0);
  assert.strictEqual(s.classes.misread.passes.netR, null, 'no R is unknown, never 0');
  assert.strictEqual(s.classes['acted-right'].entries.n, 4);
  assert.strictEqual(s.classes['acted-right'].entries.netR, 15);
  assert.strictEqual(s.classes['market-turned'].entries.n, 3);
  assert.strictEqual(s.classes.passed.passes.n, 3);
  assert.strictEqual(s.classes.passed.passes.netR, 3.75);
  assert.strictEqual(s.classes['acted-wrong'].n, 0);
  assert.strictEqual(s.scorable, 13);
  // Under the experience index's minimum n or days: too few, no interval.
  assert.strictEqual(s.classes['acted-right'].tooFew, true);
  assert.strictEqual(s.classes['acted-right'].lo, null);
});

test('summary: without the best day, the cell\'s net R and n drop that day\'s rows', () => {
  const s = A.summarize(sample());
  const c = s.classes['acted-right'].entries;
  assert.strictEqual(c.withoutBest.day, '2021-06-10');
  assert.strictEqual(c.withoutBest.n, 2);
  assert.strictEqual(c.withoutBest.netR, 4);
});

test('summary: entry losers by class (misread, acted wrong, market turned, small loss, unscorable)', () => {
  const right = stateRead('STATE: 4h up | 1h up | 15m up', UP);
  const s = A.summarize([...sample(), { ...audit({ stateRead: right, decision: decision('long', 0) }), day: '2021-06-12' }]);
  assert.strictEqual(s.classes['small-loss'].entries.n, 1, 'a scratch at 0 is small loss, and no loser (R < 0)');
  assert.strictEqual(s.entryLosers.n, 7);
  assert.deepStrictEqual(s.entryLosers.byClass, { misread: 3, 'acted-wrong': 0, 'market-turned': 3, 'small-loss': 0 });
  assert.deepStrictEqual(s.entryLosers.unscorable, { 'no state record': 1 });
});

test('summary: the misread fields by forward R lost, and every field split by its result', () => {
  const s = A.summarize(sample());
  const first = s.misreadFields[0];
  assert.strictEqual(first.field, '1h');
  assert.strictEqual(first.entries.n, 3);
  assert.strictEqual(first.entries.netR, -3.06);
  assert.strictEqual(first.entries.losers, 3);
  assert.deepStrictEqual(s.misreadFields.map(x => x.field).sort(), [...A.FIELDS].sort());
  assert.strictEqual(s.byField['1h'].mismatch.n, 3);
  assert.strictEqual(s.byField['1h'].match.n, 10);
  assert.strictEqual(s.byField.frames.unstated.n, 3, 'the misread rows did not state frames');
  // The day so far (recorded context, never scored): the classes by its word.
  assert.strictEqual(s.byDayState.directional.misread, 3);
});

test('summary: intervals once the experience index\'s minimum n and days are met', () => {
  const right = stateRead('STATE: 4h up | 1h up | 15m up', UP);
  const wrong = stateRead('STATE: 4h down | 1h up | 15m up', UP);
  const EI = require('../../scripts/lib/tunables').training().experienceIndex;
  // Enough days for the minimum days, and two read-right entries a day for the minimum n (pins only tighten: derived).
  const nDays = Math.max(EI.minDays, Math.ceil(EI.minN / 2)) + 2;
  const rows = [];
  for (let k = 0; k < nDays; k += 1) {
    const day = new Date(Date.parse('2021-07-01T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
    rows.push({ ...audit({ stateRead: right, decision: decision('long', 1 + (k % 3)) }), day });
    rows.push({ ...audit({ stateRead: right, decision: decision('long', 2) }), day });
    rows.push({ ...audit({ stateRead: wrong, decision: decision('long', -1) }), day });
  }
  const s = A.summarize(rows);
  const c = s.classes['acted-right'];
  assert.ok(!c.tooFew);
  assert.ok(c.lo <= c.share && c.share <= c.hi, JSON.stringify(c));
  assert.ok(c.entries.lo <= c.entries.meanR && c.entries.meanR <= c.entries.hi, JSON.stringify(c.entries));
  // Deterministic: the same rows give the same report.
  assert.deepStrictEqual(A.summarize(rows), s);
  const text = A.renderAudit(s);
  assert.match(text, /OUTCOME/);
  assert.match(text, /acted right/i);
  assert.match(text, new RegExp(`n ${2 * nDays}\\b`));
});

// ---- The run, the CLI ----

/** A synthetic run home: its replay store (one day, a pass and an entry), bars archive and runner config. */
function runHome() {
  const runId = 'arm-pc-t20210611.abc.0';
  const home = path.join(tmpDir(), runId); // inside a runs folder of its own
  const dir = path.join(home, 'replay', runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'bars'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ v: 1, runId }));
  fs.writeFileSync(path.join(dir, 'autotrader.json'), JSON.stringify({ timeframe: 3, symbols: ['MNQ'] }));
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ contractId: 'MNQ', bars: bars({ after: rising }) }));
  const sr = stateRead('STATE: 4h up | 1h up | 15m up', UP);
  const line = (t, result, orders = []) => JSON.stringify({ v: 1, t, day: '2021-06-11', kind: 'trade', ran: [{ action: 'trade', symbols: ['MNQ'], result }], cycles: [{ action: 'trade', result, orders, stateRead: sr }] });
  fs.writeFileSync(path.join(dir, '2021-06-11.jsonl'), `${[
    line(T(CYCLE + 1), 'CYCLE RESULT: no-trade - nothing at a level'),
    line(T(CYCLE + 1).replace('.000Z', '.500Z'), 'CYCLE RESULT: executed - long', [{ side: 'buy', gate: 'allowed' }]),
    JSON.stringify({ v: 1, t: T(CYCLE + 2), day: '2021-06-11', kind: 'eod' }),
  ].join('\n')}\n`);
  const decisions = path.join(home, 'decisions');
  fs.mkdirSync(decisions);
  fs.writeFileSync(path.join(decisions, 'pc-t20210611.abc.-decisions.json'), JSON.stringify([
    { key: `${T(CYCLE + 1)}|MNQ`, t: T(CYCLE + 1), symbol: 'MNQ', inTrade: false, actual: { action: 'none' }, trade: null, run: 'pc-t20210611.abc.0' },
    { key: `${T(CYCLE + 1).replace('.000Z', '.500Z')}|MNQ`, t: T(CYCLE + 1).replace('.000Z', '.500Z'), symbol: 'MNQ', inTrade: false, actual: { action: 'long' }, trade: { r: 2.4 }, run: 'pc-t20210611.abc.0' },
    { key: `${T(CYCLE + 1)}|MNQ`, t: T(CYCLE + 1), symbol: 'MNQ', inTrade: false, actual: { action: 'long' }, trade: { r: -5 }, run: 'another-run.0' },
  ]));
  return { home, dir, decisions, runId };
}

test('a run: the store\'s trade cycles joined to their decision records by exact key and run, the bars from the run home', () => {
  const { home, decisions } = runHome();
  const D = A.loadDecisions([decisions]);
  const { rows, runId } = A.runRows(home, { decisions: D, cfg: CFG });
  assert.strictEqual(runId, 'arm-pc-t20210611.abc.0');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].kind, 'pass');
  assert.strictEqual(rows[0].class, 'passed');
  assert.strictEqual(rows[0].outcome.R, 1.25);
  assert.strictEqual(rows[1].kind, 'entry');
  assert.strictEqual(rows[1].outcome.R, 2.4, 'its own run\'s record, never another run\'s on the same key');
  assert.strictEqual(rows[1].class, 'acted-right');
  // A run's own archive ends with the run: a pass near its end has no forward bars; the data the run replayed (--bars)
  // gives them.
  fs.writeFileSync(path.join(home, 'bars', 'MNQ-3m.json'), JSON.stringify({ bars: bars({ n: CYCLE + 3, after: rising }) }));
  const short = A.runRows(home, { decisions: D, cfg: CFG }).rows[0];
  assert.match(short.unscorable, /no forward bars yet/);
  const data = path.join(home, 'MNQ-data.json');
  fs.writeFileSync(data, JSON.stringify(bars({ after: rising })));
  const full = A.runRows(home, { decisions: D, cfg: CFG, barsFiles: { MNQ: data } }).rows[0];
  assert.strictEqual(full.class, 'passed');
  assert.strictEqual(full.outcome.R, 1.25);
  // --days keeps only those days.
  assert.strictEqual(A.runRows(home, { decisions: D, cfg: CFG, days: ['2021-06-12'] }).rows.length, 0);
});

test('the CLI: a run home, a runs folder or a replay run dir; text and --json; a bad path exits 1', () => {
  const { home, dir, decisions } = runHome();
  const cli = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'read-audit.js'), ...args], { encoding: 'utf8' });
  const text = cli(['--run', home, '--decisions', decisions]);
  assert.strictEqual(text.status, 0, text.stderr);
  assert.match(text.stdout, /OUTCOME/);
  assert.match(text.stdout, /passed/i);
  for (const target of [path.dirname(home), dir]) {
    const j = cli(['--run', target, '--decisions', decisions, '--json']);
    assert.strictEqual(j.status, 0, j.stderr);
    const parsed = JSON.parse(j.stdout);
    assert.ok(parsed.runs.includes('arm-pc-t20210611.abc.0'), target);
    assert.strictEqual(parsed.classes['acted-right'].entries.netR, 2.4);
  }
  const days = JSON.parse(cli(['--run', home, '--decisions', decisions, '--days', '2021-06-12', '--json']).stdout);
  assert.strictEqual(days.decisions, 0);
  const bad = cli(['--run', path.join(home, 'nope')]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /usage/);
});

test('a measurement only: nothing in scripts/ requires the read audit but its own CLI', () => {
  const out = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => (e.isDirectory() ? walk(path.join(d, e.name))
    : e.name.endsWith('.js') && /require\([^)]*read-audit/.test(fs.readFileSync(path.join(d, e.name), 'utf8')) && out.push(path.relative(ROOT, path.join(d, e.name)))));
  walk(path.join(ROOT, 'scripts'));
  assert.deepStrictEqual(out, ['scripts/read-audit.js']);
});
