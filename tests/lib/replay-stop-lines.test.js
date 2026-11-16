'use strict';

// The run's STOP lines (scripts/lib/replay/stop-lines.js): managed cycles, stated (of
// them read inline), missing; one threshold (config/replay.json scorecard.maxMissingStopShare, 2%) for the alarm.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const SL = require('../../scripts/lib/replay/stop-lines');

const ev = (stated, extra = {}) => ({ kind: 'stop_line', contractId: 'MNQ', stated, ...extra });

test('stopLineSummary: managed cycles, stated, inline, missing and their share; the alarm only above the threshold', () => {
  // The six recorded mornings before the fix: 157 managed cycles, 16 missing (10.2%): an alarm.
  const before = [...Array(141)].map(() => ev(true)).concat([...Array(16)].map(() => ev(false, { why: 'no STOP line' })));
  assert.deepStrictEqual(SL.stopLineSummary(before, { maxMissingShare: 0.02 }), { managed: 157, stated: 141, inline: 0, missing: 16, share: 0.102, alarm: true, maxMissingShare: 0.02 });
  // After: 11 of them read inline, 5 missing: 3.2%, still an alarm; 3 of 157 (1.9%) is not.
  const after = [...Array(141)].map(() => ev(true)).concat([...Array(11)].map(() => ev(true, { inline: true })), [...Array(5)].map(() => ev(false)));
  assert.deepStrictEqual(SL.stopLineSummary(after, { maxMissingShare: 0.02 }).alarm, true);
  const three = [...Array(154)].map(() => ev(true)).concat([...Array(3)].map(() => ev(false)));
  const s3 = SL.stopLineSummary(three, { maxMissingShare: 0.02 });
  assert.deepStrictEqual([s3.missing, s3.share, s3.alarm], [3, 0.019, false]);
  // Exactly at the threshold: no alarm (above it alarms).
  assert.strictEqual(SL.stopLineSummary([...Array(49)].map(() => ev(true)).concat([ev(false)]), { maxMissingShare: 0.02 }).alarm, false);
  // Other events are not managed cycles; none at all: no summary.
  assert.strictEqual(SL.stopLineSummary([{ kind: 'stop_moved' }], { maxMissingShare: 0.02 }), null);
  // The threshold is the config's by default.
  assert.strictEqual(SL.stopLineSummary(three).maxMissingShare, require('../../scripts/lib/tunables').replay().scorecard.maxMissingStopShare);
});

test('stopLinesOf: the run home\'s event logs; the line says the alarm', () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  const rows = [ev(true), ev(true, { inline: true }), ev(false), { kind: 'account' }];
  fs.writeFileSync(path.join(home, 'logs', 'events-2021-09-01.jsonl'), `${rows.map(x => JSON.stringify(x)).join('\n')}\nnot json\n`);
  const s = SL.stopLinesOf(home);
  assert.deepStrictEqual([s.managed, s.stated, s.inline, s.missing], [3, 2, 1, 1]);
  assert.strictEqual(SL.stopLinesLine(s), 'STOP lines: 3 managed (one per open trade a cycle), 2 stated (1 read from the 9 Manage: line), 1 missing (33.3%): ALARM, above 2% of them.');
  assert.strictEqual(SL.stopLinesLine({ ...s, missing: 0, share: 0, alarm: false }), 'STOP lines: 3 managed (one per open trade a cycle), 2 stated (1 read from the 9 Manage: line), 0 missing (0%).');
  assert.strictEqual(SL.stopLinesOf(tmpDir()), null, 'no logs: none');
  assert.strictEqual(SL.stopLinesLine(null), null);
});

test('the replay report shows the run\'s STOP lines with the alarm', () => {
  const R = require('../../scripts/lib/replay/report');
  const s = { managed: 157, stated: 152, inline: 11, missing: 5, share: 0.032, alarm: true, maxMissingShare: 0.02 };
  const summary = { months: [], total: { label: 'total' }, timing: null, stopLines: s };
  assert.match(R.toMarkdown({ ...summary, total: R.summarize({}).total }, {}), /STOP lines: 157 managed \(one per open trade a cycle\), 152 stated \(11 read from the 9 Manage: line\), 5 missing \(3\.2%\): ALARM, above 2% of them\./);
  assert.match(R.toText({ ...summary, months: [], total: R.summarize({}).total }), /STOP lines: 157 managed/);
});

test('summarize reads the run home\'s STOP lines (the run folder two levels under it)', () => {
  const R = require('../../scripts/lib/replay/report');
  const home = tmpDir();
  const runDir = path.join(home, 'replay', 'run-1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'events-2021-09-01.jsonl'), [ev(true), ev(false)].map(x => JSON.stringify(x)).join('\n') + '\n');
  const s = R.summarize({}, { runDir });
  assert.deepStrictEqual([s.stopLines.managed, s.stopLines.missing], [2, 1]);
  assert.ok(!('stopLines' in R.summarize({})), 'no run folder: none');
});

