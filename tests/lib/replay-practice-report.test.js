'use strict';

// The replay report's setup-focused practice counts (scripts/lib/replay/practice-report.js, via report.js summarize),
// and the learning report's note that a run was setup-focused (learning-report.js).
const test = require('node:test');
const assert = require('node:assert');
const P = require('../../scripts/lib/replay/practice-report');
const { summarize, toMarkdown, toText } = require('../../scripts/lib/replay/report');
const L = require('../../scripts/lib/learning/learning-report');

const ran = (ms = 120000) => ({ ran: [{ action: 'trade', ok: true, result: 'CYCLE RESULT: no-trade' }], cycles: [{ action: 'trade', ok: true, durationMs: ms }] });
const line = (why, extra = {}) => ({ kind: 'trade', t: 'x', events: why ? [`practice_${why}`] : [], ran: [], cycles: [], refusals: [], trades: [], ...extra });

test('practiceSummary: moments, quiet, managed and skipped bars, cycles, and the time saved at the median cycle', () => {
  const days = {
    '2022-03-01': [
      line('moment', ran(100000)), line('none'), line('none'), line('quiet', ran(140000)), line('manage', ran(120000)),
      { kind: 'eod', events: [], ran: [{ action: 'eod', ok: true }], cycles: [] },
    ],
    '2022-03-02': [line('none'), line('unavailable', ran(120000)), line(null, ran(5)), line(null)],
  };
  const p = P.practiceSummary(days);
  assert.deepStrictEqual(p, { bars: 9, moments: 1, quiet: 1, managed: 1, unavailable: 1, skipped: 3, cycles: 5, medianCycleMs: 120000, savedMs: 360000 });
  assert.strictEqual(P.practiceSummary({ d: [line(null, ran())] }), null, 'no practice event: a full-day run');
  // Two symbols in one pass: the strongest choice counts (one ran, so the pass ran).
  assert.strictEqual(P.choiceOf({ events: ['practice_none', 'practice_moment'] }), 'moment');
  const s = summarize(days);
  assert.deepStrictEqual(s.practice, p);
  assert.match(toMarkdown(s, { runId: 'r' }), /## Setup-focused practice[\s\S]*cycles run: 5; bars skipped \(no cycle, the clock advanced\): 3 \(33%\)[\s\S]*Setup moments found: 1[\s\S]*Estimated time saved: 0\.1 h/);
  assert.match(toText(s), /setup-focused practice: 9 bars, 5 cycles, 3 skipped; 1 moments, 1 quiet, 1 managed; saved about 0\.1 h/);
  assert.ok(!('practice' in summarize({ d: [line(null, ran())] })), 'a full-day run\'s summary is as before');
  assert.strictEqual(P.practiceSummary({ d: [line('none')] }).savedMs, null, 'no timed cycle: unknown, never zero');
});

test('learning report: a setup-focused run says so; a full-day run is as before', () => {
  const practice = { mode: 'setup-focus', setupTf: 15, quietSample: 0.15, seed: 1, levels: 'key', reactions: ['rejected', 'broke'] };
  const m = L.learningMeasures({ practice });
  assert.deepStrictEqual(m.practice, practice);
  assert.match(L.learningMarkdown(m), /## Learning\n\n- This run was setup-focused practice: cycles only at 15m candles/);
  assert.match(L.learningText(m), /^learning \(setup-focused practice\): /);
  const full = L.learningMeasures({});
  assert.strictEqual(full.practice, null);
  assert.doesNotMatch(L.learningMarkdown(full), /setup-focused/);
});
