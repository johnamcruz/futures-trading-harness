'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { lessonDay, isActive, activeLessons, adviceText } = require('../../scripts/lib/trading/lesson-expiry');
const { instincts, digest } = require('../../scripts/lib/trading/instincts');

// 2024-06-11 10:00 ET (14:00Z): its trading day began 2024-06-10 22:00Z (clock.js tradingDayStart) and ends 2024-06-11 22:00Z.
const NOW = new Date('2024-06-11T14:00:00.000Z');
const lesson = (ts, text, tags = ['setup:prop_portfolio', 'MNQ']) => ({ ts, kind: 'lesson', text, tags });

test('a lesson is active only on the session day it was written, up to now', () => {
  const eodYesterday = lesson('2024-06-10T19:51:00.000Z', 'Rule: no prop_portfolio entry until the cause is journaled.');
  const thisMorning = lesson('2024-06-11T13:40:00.000Z', 'Two stop-outs on reclaims: weak today.');
  const lastEvening = lesson('2024-06-10T22:30:00.000Z', 'Overnight: thin.'); // after the day's start (22:00Z): today's session day
  const later = lesson('2024-06-11T15:00:00.000Z', 'written after now');
  assert.strictEqual(lessonDay(eodYesterday), '2024-06-10');
  assert.strictEqual(lessonDay(thisMorning), '2024-06-11');
  assert.strictEqual(lessonDay(lastEvening), '2024-06-11');
  assert.strictEqual(isActive(eodYesterday, NOW), false, 'an earlier day\'s lesson has expired at its day\'s end');
  assert.strictEqual(isActive(thisMorning, NOW), true);
  assert.strictEqual(isActive(lastEvening, NOW), true, 'written after the day\'s start: the same session day');
  assert.strictEqual(isActive(later, NOW), false, 'never one from after now (a replay clock)');
  // The day it was written: active until that session's end, expired just after.
  assert.strictEqual(isActive(eodYesterday, new Date('2024-06-10T21:59:59.000Z')), true);
  assert.strictEqual(isActive(eodYesterday, new Date('2024-06-10T22:00:00.000Z')), false);
  assert.deepStrictEqual(activeLessons([eodYesterday, thisMorning, lastEvening, later, { ts: thisMorning.ts, kind: 'note', text: 'n' }], NOW), [thisMorning, lastEvening]);
});

test('fail safe: an undated lesson, a bad clock, or no journal is never active', () => {
  assert.strictEqual(isActive({ kind: 'lesson', text: 'no time' }, NOW), false);
  assert.strictEqual(isActive({ kind: 'lesson', ts: 'yesterday', text: 'bad time' }, NOW), false);
  assert.strictEqual(lessonDay({ kind: 'lesson', text: 'no time' }), null);
  assert.strictEqual(isActive(lesson('2024-06-11T13:40:00.000Z', 'x'), null), false);
  assert.strictEqual(isActive(lesson('2024-06-11T13:40:00.000Z', 'x'), new Date('nope')), false);
  assert.strictEqual(isActive(null, NOW), false);
  assert.deepStrictEqual(activeLessons(null, NOW), []);
});

test('a lesson is shown as advice from its date, never a rule', () => {
  assert.strictEqual(adviceText(lesson('2024-06-11T13:40:00.000Z', '  weak\n on reclaims ')), 'advice from 2024-06-11, not a rule: weak on reclaims');
  assert.strictEqual(adviceText({ kind: 'lesson', text: 'x' }), 'advice from an unknown day, not a rule: x');
});

test('instincts: only today\'s lessons, as advice with their date; none without a clock; the reviews\' evidence stays', () => {
  const journal = [
    ...Array.from({ length: 4 }, (_, k) => ({ ts: `2024-06-0${k + 3}T15:00:00.000Z`, kind: 'review', text: 'stopped', tags: ['result:loss', 'setup:prop_portfolio', 'regime:range', 'r:-1', 'mistake:chased'] })),
    lesson('2024-06-04T19:51:34.000Z', 'Rule: a risk-manager restriction stands until lifted in the journal; over 6 trades.'),
    lesson('2024-06-11T13:40:00.000Z', 'Reclaims without a 3m close: 0W/2L over 2 trades.'),
  ];
  const now = instincts(journal, { now: NOW });
  const lessons = now.filter(x => x.kind === 'lesson');
  assert.deepStrictEqual(lessons.map(x => x.text), ['advice from 2024-06-11, not a rule: Reclaims without a 3m close: 0W/2L over 2 trades.']);
  assert.ok(!now.some(x => /restriction stands/.test(x.text)), 'the expired restriction is not shown');
  assert.ok(now.some(x => x.kind === 'mistake') && now.some(x => x.kind === 'setup'), 'the reviews\' evidence is not a lesson: it stays');
  assert.ok(!instincts(journal).some(x => x.kind === 'lesson'), 'no clock, no lesson');
  const prompt = digest(journal, 10, { kinds: ['mistake', 'lesson'], form: false, now: NOW });
  assert.ok(prompt.some(x => /advice from 2024-06-11, not a rule: Reclaims/.test(x)), prompt.join(' | '));
  assert.ok(!prompt.some(x => /restriction/.test(x)), prompt.join(' | '));
});
