'use strict';

// The field-reading score (scripts/lib/eval/position-quote.js, DESIGN 4.8, review m8): the R numbers an answer states
// for the open trade against the Position line's, and any use of the broker snapshot's own R.

const test = require('node:test');
const assert = require('node:assert');
const { positionQuote } = require('../../scripts/lib/eval/position-quote');

// 2021-09-01 13:57Z: now +1.39R, MFE +4.16R, MAE -0.29R, giveback 2.77R, working stop +0.34R (a fill gives back 3.82R), lock +0.34R.
const READ = { nowR: 1.39, mfeR: 4.16, maeR: -0.29, give: 2.77, workR: 0.34, atStopGive: 3.82, lockR: 0.34 };

test('every R the answer states for the trade, by field, against the line', () => {
  const a = 'PLAN 9 Manage: long from 15659.5, now +1.39R, MFE +4.16R, giveback 2.77R (67%); the stop rests at the lock (+0.34R).\nSTOP hold: hold';
  const q = positionQuote(a, READ);
  assert.deepStrictEqual(q.quoted.map(x => [x.field, x.value, x.ok]), [['now', 1.39, true], ['mfe', 4.16, true], ['give', 2.77, true], ['stop', 0.34, true]]);
  assert.deepStrictEqual([q.n, q.ok, q.share], [4, 4, 1]);
  // A recomputed number off the line is a miss; best/worst read as MFE/MAE; "a fill there gives back" is the stop's.
  const b = positionQuote('now +1.4R, best +4.2R, worst -0.29R, a fill at the stop gives back 3.82R', READ);
  assert.deepStrictEqual(b.quoted.map(x => [x.field, x.ok]), [['now', false], ['mfe', false], ['mae', true], ['give', true]]);
  assert.strictEqual(b.share, 0.5);
  // No R stated: nothing to score (null share, not 100%).
  assert.deepStrictEqual([positionQuote('STOP hold: hold', READ).n, positionQuote('STOP hold: hold', READ).share], [0, null]);
});

test('the broker snapshot\'s R (its own risk basis) is flagged wherever it appears', () => {
  const q = positionQuote('MFE +4.39R on the snapshot, now +1.39R', READ, { snapshot: [4.39] });
  assert.deepStrictEqual(q.snapshot, [4.39]);
  assert.strictEqual(q.quoted.find(x => x.field === 'mfe').ok, false);
  assert.deepStrictEqual(positionQuote('now +1.39R', READ, { snapshot: [4.39] }).snapshot, []);
  // A short's numbers are the same signs (R is side-signed by the line).
  assert.strictEqual(positionQuote('MAE -0.24R', { maeR: -0.24 }).share, 1);
});

test('the unit\'s definition is no quoted value; a typographic minus reads as a minus', () => {
  const q = positionQuote('initial stop 13756.25 (82.25 pts = 1R), working stop 13756.25 (\u22121R); 1R = 9.5 pts; the long risks 1R to the stop', { workR: -1 });
  assert.deepStrictEqual(q.quoted.map(x => [x.field, x.value, x.ok]), [['stop', -1, true]]);
  // A stated "gives back 1R" where the line says 1.84R is a miss.
  assert.strictEqual(positionQuote('a fill there gives back 1R', { atStopGive: 1.84, give: 1.27 }).share, 0);
});

