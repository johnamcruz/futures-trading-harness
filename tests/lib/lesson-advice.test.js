'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lessonDay, scopedLessons, lessonSide, isBroad, lessonRecord, adviceText } = require('../../scripts/lib/trading/lesson-advice');
const { instincts, digest, graded } = require('../../scripts/lib/trading/instincts');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN = require('../../scripts/lib/tunables').runner().prompt.trackRecordMinSlice;
const NOW = new Date('2024-06-11T14:00:00.000Z');
const lesson = (ts, text, tags = ['setup:prop_portfolio', 'MNQ']) => ({ ts, kind: 'lesson', text, tags });
const review = (ts, result, r, text) => ({ ts, kind: 'review', text, tags: [`result:${result}`, 'setup:prop_portfolio', `r:${r}`] });
// A composed plan's shadow outcome: filled at `at` + 3 min, out 30 min later.
const plan = (at, side, R) => ({ id: at, root: 'MNQ', side, at, bar: at, entryTime: new Date(Date.parse(at) + 180000).toISOString(), exitTime: new Date(Date.parse(at) + 1980000).toISOString(), exitReason: R > 0 ? 'target' : 'stop', R });

test('scope: the run\'s own lessons only, written by now and since a fresh attempt\'s start; undated or no clock: none', () => {
  const old = lesson('2024-05-24T19:51:00.000Z', 'Rule: no prop_portfolio entry until the cause is journaled.');
  const today = lesson('2024-06-11T13:40:00.000Z', 'Two stop-outs on 3m reclaims below the 15m EMA20.');
  const otherRun = lesson('2026-05-02T19:50:00.000Z', 'From a later run in the same journal.');
  assert.deepStrictEqual(scopedLessons([old, today, otherRun, { kind: 'note', ts: today.ts }], { now: NOW }), [old, today], 'an earlier day\'s lesson persists as advice; a later run\'s never shows');
  assert.deepStrictEqual(scopedLessons([old, today], { now: NOW, from: Date.parse('2024-06-01T00:00:00Z') }), [today], 'a fresh attempt shows only its own');
  assert.deepStrictEqual(scopedLessons([{ kind: 'lesson', text: 'undated' }, { kind: 'lesson', ts: 'yesterday', text: 'x' }], { now: NOW }), []);
  assert.deepStrictEqual(scopedLessons([today], { now: null }), []);
  assert.deepStrictEqual(scopedLessons([today], { now: new Date('nope') }), []);
  assert.deepStrictEqual(scopedLessons(null, { now: NOW }), []);
  assert.strictEqual(lessonDay(today), '2024-06-11');
  assert.strictEqual(lessonDay({ kind: 'lesson' }), null);
});

test('a lesson names its side and is flagged broad when it names no condition the bars can check', () => {
  assert.strictEqual(lessonSide(lesson('t', 'skip shorts with the 3m trend up')), 'short');
  assert.strictEqual(lessonSide(lesson('t', 'MNQ longs below the 15m EMA20')), 'long');
  assert.strictEqual(lessonSide(lesson('t', 'prop_portfolio short/long entries')), null);
  assert.strictEqual(isBroad(lesson('t', 'Rule: skip prop_portfolio entries that have no scan signal until a scan-backed entry shows positive expectancy.')), true);
  assert.strictEqual(isBroad(lesson('t', 'Rule for the next session: no prop_portfolio entry until the target-leg cancel cause is journaled')), true);
  assert.strictEqual(isBroad(lesson('t', 'longs with the 15m close below EMA20 and 3m SuperTrend down: 0W/2L')), false);
  assert.strictEqual(isBroad(lesson('t', 'require the 15m not in a fresh CHoCH down')), false);
});

test('a lesson\'s record: the trades taken since and the composed plans walked forward since, repeats once; provisional, supported or contradicted', () => {
  const l = lesson('2024-06-04T19:51:00.000Z', 'prop_portfolio shorts with the 3m trend up above VWAP: skip.');
  const reviews = graded([
    review('2024-06-03T15:00:00.000Z', 'loss', -1, 'short stopped'), // before the lesson: not its record
    review('2024-06-05T15:00:00.000Z', 'win', 2.1, 'prop_portfolio short 3 MNQ, target'),
    review('2024-06-05T17:00:00.000Z', 'loss', -1, 'prop_portfolio long 3 MNQ, stop'), // the other side
  ]);
  const few = [plan('2024-06-05T14:00:00.000Z', 'short', 2), plan('2024-06-05T14:03:00.000Z', 'short', 2), plan('2024-06-05T15:00:00.000Z', 'long', -1)];
  const r = lessonRecord(l, { reviews, shadow: few });
  assert.deepStrictEqual(r.taken, { n: 1, wins: 1, losses: 0, R: 2.1 });
  assert.deepStrictEqual(r.shadow, { n: 1, wins: 1, losses: 0, R: 2 }, 'the short side only, the repeat while the first was open counted once');
  assert.strictEqual(r.status, 'provisional');
  const day = k => `2024-06-${String(5 + k).padStart(2, '0')}T14:00:00.000Z`;
  const winners = Array.from({ length: MIN }, (_, k) => plan(day(k), 'short', k % 3 === 0 ? -1 : 2));
  assert.strictEqual(lessonRecord(l, { reviews, shadow: winners }).status, `contradicted by n=${MIN} since 2024-06-04`);
  const losers = Array.from({ length: MIN }, (_, k) => plan(day(k), 'short', -1));
  assert.strictEqual(lessonRecord(l, { reviews, shadow: losers }).status, `supported by n=${MIN}`);
  // Unsettled or unfilled plans are no outcome.
  assert.strictEqual(lessonRecord(l, { shadow: [{ ...plan(day(0), 'short', 2), R: null }] }).shadow.n, 0);
  const text = adviceText(l, lessonRecord(l, { reviews, shadow: winners }));
  assert.match(text, /^lesson from 2024-06-04 \(taken since n=1, 1W\/0L, \+2\.1R; composed plans since n=\d+, \d+W\/\d+L, \+[\d.]+R; contradicted by n=\d+ since 2024-06-04\): advice, weigh it: prop_portfolio shorts/);
  assert.match(adviceText(lesson('2024-06-04T19:51:00.000Z', 'skip entries with no scan signal')), /taken since n=0; composed plans since n=0; provisional; broad: names no condition the bars can check\): advice, weigh it: /);
});

test('instincts and the digest show the run\'s lessons with their record; no clock, no lesson; the reviews\' evidence stays', () => {
  const journal = [
    ...Array.from({ length: 4 }, (_, k) => ({ ts: `2024-06-0${k + 3}T15:00:00.000Z`, kind: 'review', text: 'stopped', tags: ['result:loss', 'setup:prop_portfolio', 'regime:range', 'r:-1', 'mistake:chased'] })),
    lesson('2024-06-04T19:51:34.000Z', 'Rule: a risk-manager restriction stands until lifted in the journal; over 6 trades.'),
    lesson('2026-05-01T13:40:00.000Z', 'another run: skip shorts.'),
  ];
  const list = instincts(journal, { now: NOW, shadow: [plan('2024-06-05T14:00:00.000Z', 'long', 2)] });
  const ls = list.filter(x => x.kind === 'lesson');
  assert.strictEqual(ls.length, 1, 'the later run\'s lesson is not this run\'s');
  assert.match(ls[0].text, /^lesson from 2024-06-04 \(taken since n=2, 0W\/2L, -2R; composed plans since n=1, 1W\/0L, \+2R; provisional; broad[^)]*\): advice, weigh it: Rule: a risk-manager restriction stands/);
  assert.ok(list.some(x => x.kind === 'mistake') && list.some(x => x.kind === 'setup'));
  assert.ok(!instincts(journal).some(x => x.kind === 'lesson'), 'no clock, no lesson');
  const prompt = digest(journal, 10, { kinds: ['mistake', 'lesson'], form: false, now: NOW });
  assert.ok(prompt.some(x => /advice, weigh it: Rule: a risk-manager restriction/.test(x)), prompt.join(' | '));
  assert.ok(!prompt.some(x => /another run/.test(x)), prompt.join(' | '));
});

test('no lesson vetoes: the gates never read a lesson, and the risk manager\'s checks name none as a veto', () => {
  for (const f of ['scripts/lib/trading/order-gate.js', 'scripts/lib/trading/account-gate.js', 'scripts/lib/trading/prop-state.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /kind\s*===?\s*['"]lesson['"]|kind:\s*['"]lesson['"]/, `${f} reads no lesson`);
  }
  const rm = fs.readFileSync(path.join(ROOT, 'agents', 'risk-manager.md'), 'utf8');
  assert.doesNotMatch(rm, /restricted by a lesson|Restricted setups|lesson entries that restrict/);
  assert.match(rm, /Stand-down conditions: <any that apply now, never a lesson>/);
  assert.match(rm, /8\. Analysts' reads against, lessons: in the count\./);
  assert.match(fs.readFileSync(path.join(ROOT, 'rules', 'trading', 'journaling.md'), 'utf8'), /Never a rule or a block \(only the gate and rulebook block\)/);
});
