'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lessonDay, scopedLessons, lessonSide, lessonDirection, isBroad, lessonRecord, adviceText } = require('../../scripts/lib/trading/lesson-advice');
const { instincts, digest, graded } = require('../../scripts/lib/trading/instincts');

const ROOT = path.resolve(__dirname, '..', '..');
const MIN = require('../../scripts/lib/tunables').runner().prompt.lessonMinPlans;
const LATER = new Date('2024-07-01T14:00:00.000Z');
const NOW = new Date('2024-06-11T14:00:00.000Z');
const lesson = (ts, text, tags = ['setup:prop_portfolio', 'MNQ']) => ({ ts, kind: 'lesson', text, tags });
const review = (ts, result, r, text) => ({ ts, kind: 'review', text, tags: [`result:${result}`, 'setup:prop_portfolio', `r:${r}`] });
// A composed plan's shadow outcome: filled at `at` + 3 min, out 30 min later.
const plan = (at, side, R, root = 'MNQ') => ({ id: at + root, root, side, at, bar: at, entryTime: new Date(Date.parse(at) + 180000).toISOString(), exitTime: new Date(Date.parse(at) + 1980000).toISOString(), exitReason: R > 0 ? 'target' : 'stop', R });

test('scope: the run\'s own lessons only, written by now, across attempts; undated or no clock: none', () => {
  const old = lesson('2024-05-24T19:51:00.000Z', 'Rule: no prop_portfolio entry until the cause is journaled.');
  const today = lesson('2024-06-11T13:40:00.000Z', 'Two stop-outs on 3m reclaims below the 15m EMA20.');
  const otherRun = lesson('2026-05-02T19:50:00.000Z', 'From a later run in the same journal.');
  assert.deepStrictEqual(scopedLessons([old, today, otherRun, { kind: 'note', ts: today.ts }], { now: NOW }), [old, today], 'an earlier day\'s lesson persists as advice; a later run\'s never shows');
  assert.deepStrictEqual(scopedLessons([old, today], { now: NOW, from: Date.parse('2024-06-01T00:00:00Z') }), [old, today], 'a fresh attempt keeps the run\'s earlier lessons: the lesson from a blow is the one to learn from');
  assert.deepStrictEqual(scopedLessons([{ kind: 'lesson', text: 'undated' }, { kind: 'lesson', ts: 'yesterday', text: 'x' }], { now: NOW }), []);
  assert.deepStrictEqual(scopedLessons([today], { now: null }), []);
  assert.deepStrictEqual(scopedLessons([today], { now: new Date('nope') }), []);
  assert.deepStrictEqual(scopedLessons(null, { now: NOW }), []);
  assert.strictEqual(lessonDay(today), '2024-06-11');
  assert.strictEqual(lessonDay({ kind: 'lesson' }), null);
  assert.strictEqual(lessonDay(lesson('2024-06-11T23:30:00.000Z', 'x')), '2024-06-11', 'written 19:30 ET: that calendar date, not the next trading day');
});

test('a lesson names its side and is flagged broad when it names no condition the bars can check', () => {
  assert.strictEqual(lessonSide(lesson('t', 'skip shorts with the 3m trend up')), 'short');
  assert.strictEqual(lessonSide(lesson('t', 'MNQ longs below the 15m EMA20')), 'long');
  assert.strictEqual(lessonSide(lesson('t', 'prop_portfolio short/long entries')), null);
  assert.strictEqual(isBroad(lesson('t', 'Rule: skip prop_portfolio entries that have no scan signal until a scan-backed entry shows positive expectancy.')), true);
  assert.strictEqual(isBroad(lesson('t', 'Rule for the next session: no prop_portfolio entry until the target-leg cancel cause is journaled')), true);
  assert.strictEqual(isBroad(lesson('t', 'longs with the 15m close below EMA20 and 3m SuperTrend down: 0W/2L')), false);
  assert.strictEqual(isBroad(lesson('t', 'require the 15m not in a fresh CHoCH down')), false);
  assert.strictEqual(isBroad(lesson('t', 'shorts with the 3m trend up above VWAP: skip')), false);
  // A timeframe or a common word alone is no condition.
  assert.strictEqual(isBroad(lesson('t', 'No trading after a loss; the 5m chart was a mess, close everything')), true);
  assert.strictEqual(isBroad(lesson('t', 'Stop taking longs: 1h high')), true);
  assert.strictEqual(isBroad(lesson('t', 'No trading in the first 15m of the trend day')), true);
  assert.strictEqual(isBroad(lesson('t', 'Skip longs when the 15m: close below the EMA20')), false);
  assert.deepStrictEqual([
    'skip shorts with the 3m trend up', 'favour longs on the 3m trend up', 'the 15m EMA20 matters',
    "Don't take longs below the 15m EMA20: 1W/5L", 'never take shorts above the 15m EMA20', 'take longs at the 15m EMA20',
    "Don't skip longs on the 3m trend up", 'No longs below the 15m EMA20', 'Never go short above the 15m EMA20', 'stand aside on longs at the 15m EMA20', 'pass on shorts',
    // Facts about trades, not directions: no verdict from "stop", "failed", "lost", "lose".
    'Use a 10-tick stop on 3m trend up longs: 4W/1L', 'Longs on a failed breakdown of the 15m low: 5W/1L',
    'Longs into a strong 15m trend down lose: 1W/6L', 'Longs above the 15m EMA20 never lost: 6W/0L', 'Longs taken below the 15m EMA20 lose', 'Stop-outs on longs: 1W/4L',
  ].map(t => lessonDirection(lesson('t', t))), [
    'against', 'for', null, 'against', 'against', 'for', null, 'against', 'against', 'against', 'against',
    null, null, null, null, null, null,
  ]);
});

test('a lesson\'s record: the trades taken since and the composed plans walked forward since, repeats once; provisional, supported or contradicted', () => {
  const l = lesson('2024-06-04T19:51:00.000Z', 'prop_portfolio shorts: skip.');
  const reviews = graded([
    review('2024-06-03T15:00:00.000Z', 'loss', -1, 'short stopped'), // before the lesson: not its record
    review('2024-06-05T15:00:00.000Z', 'win', 2.1, 'prop_portfolio short 3 MNQ, target'),
    review('2024-06-05T17:00:00.000Z', 'loss', -1, 'prop_portfolio long 3 MNQ, stop'), // the other side
  ]);
  const few = [plan('2024-06-05T14:00:00.000Z', 'short', 2), plan('2024-06-05T14:03:00.000Z', 'short', 2), plan('2024-06-05T15:00:00.000Z', 'long', -1)];
  const r = lessonRecord(l, { reviews, shadow: few, now: LATER });
  assert.deepStrictEqual(r.taken, { n: 1, wins: 1, losses: 0, R: 2.1 });
  assert.deepStrictEqual(r.shadow, { n: 1, wins: 1, losses: 0, R: 2 }, 'the short side only, the repeat while the first was open counted once');
  assert.strictEqual(r.status, 'provisional');
  const day = k => `2024-06-${String(5 + k).padStart(2, '0')}T14:00:00.000Z`;
  const winners = Array.from({ length: MIN }, (_, k) => plan(day(k), 'short', k % 3 === 0 ? -1 : 2));
  assert.strictEqual(lessonRecord(l, { reviews, shadow: winners, now: LATER }).status, `contradicted by n=${MIN} since 2024-06-04`);
  const losers = Array.from({ length: MIN }, (_, k) => plan(day(k), 'short', -1));
  assert.strictEqual(lessonRecord(l, { reviews, shadow: losers, now: LATER }).status, `supported by n=${MIN}`);
  // A lesson for a setup: the same winners support it; a broad one, or one of no clear direction, gets no verdict.
  const favour = lesson('2024-06-04T19:51:00.000Z', 'favour shorts');
  assert.strictEqual(lessonRecord(favour, { shadow: winners, now: LATER }).status, `supported by n=${MIN}`);
  assert.strictEqual(lessonRecord(lesson('2024-06-04T19:51:00.000Z', 'skip entries entirely'), { shadow: winners, now: LATER }).status, 'no verdict', 'no side: no population to judge');
  // A conditional lesson is judged against the plans of its side only if its condition were checked: it is not, so the
  // numbers show, labelled, with no verdict (with-trend shorts must not "contradict" skip shorts with the trend up).
  for (const t of ['skip shorts with the 3m trend up', 'prop_portfolio shorts before 09:45 ET: skip', 'avoid shorts when stopped out twice', 'skip shorts below the prior low']) {
    const c = lesson('2024-06-04T19:51:00.000Z', t);
    assert.strictEqual(lessonRecord(c, { shadow: winners, now: LATER }).status, 'no verdict', t);
    assert.match(adviceText(c, lessonRecord(c, { shadow: winners, now: LATER })), /all composed shorts since n=\d+, [^;]*, condition unchecked; no verdict/, t);
  }
  // A capitalised tag that names no symbol the plans are of ("ORB") filters nothing.
  assert.strictEqual(lessonRecord({ ...l, tags: ['setup:prop_portfolio', 'ORB'] }, { shadow: winners, now: LATER }).shadow.n, MIN);
  // Another symbol's plans are not this lesson's (its symbol tag); untagged, every symbol's count.
  const other = Array.from({ length: MIN }, (_, k) => plan(day(k), 'short', 2, 'MES'));
  assert.strictEqual(lessonRecord(l, { shadow: other, now: LATER }).shadow.n, 0);
  assert.strictEqual(lessonRecord({ ...l, tags: ['setup:prop_portfolio', 'lesson'] }, { shadow: other, now: LATER }).shadow.n, MIN);
  // Nothing after now counts (a later review, a plan settled after the clock), 
  const future = graded([review('2026-10-01T15:00:00.000Z', 'win', 2, 'prop_portfolio short 3 MNQ')]);
  assert.strictEqual(lessonRecord(l, { reviews: future, now: NOW }).taken.n, 0);
  assert.strictEqual(lessonRecord(l, { shadow: winners, now: NOW }).shadow.n, 6, 'only the plans settled by 2024-06-11 14:00 (06-05 to 06-10)');
  assert.strictEqual(lessonRecord(l, { reviews, shadow: winners }).taken.n, 0, 'no clock: nothing counts');
  // Unsettled or unfilled plans are no outcome.
  assert.strictEqual(lessonRecord(l, { shadow: [{ ...plan(day(0), 'short', 2), R: null }], now: LATER }).shadow.n, 0);
  const text = adviceText(l, lessonRecord(l, { reviews, shadow: winners, now: LATER }));
  assert.match(text, /^lesson from 2024-06-04 \(taken since n=1, 1W\/0L, \+2\.1R; all composed shorts since n=\d+, \d+W\/\d+L, \+[\d.]+R; contradicted by n=\d+ since 2024-06-04; broad[^)]*\): advice, weigh it: prop_portfolio shorts/);
  assert.match(adviceText(lesson('2024-06-04T19:51:00.000Z', 'skip entries with no scan signal')), /taken since n=0; all composed plans since n=0, condition unchecked; provisional; broad: names no condition the bars can check\): advice, weigh it: /);
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
  assert.match(ls[0].text, /^lesson from 2024-06-04 \(taken since n=2, 0W\/2L, -2R; all composed plans since n=1, 1W\/0L, \+2R, condition unchecked; provisional; broad[^)]*\): advice, weigh it: Rule: a risk-manager restriction stands/);
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

test('a session time window is a checkable condition, so a lesson naming one is not broad', () => {
  for (const t of ['ORB on MNQ before 09:45 ET: 2W/7L', 'Longs after 14:00 ET lose', 'No entries in the first 15 minutes', 'Shorts 09:30-10:00 ET: 1W/5L']) assert.strictEqual(isBroad(lesson('t', t)), false, t);
  assert.strictEqual(isBroad(lesson('t', 'No trading in the first 15m of the trend day')), true);
});
