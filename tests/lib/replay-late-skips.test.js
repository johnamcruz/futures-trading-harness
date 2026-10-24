'use strict';

// The late-entry skips and their counterfactual (scripts/lib/replay/late-skips.js): every composed entry the late-entry
// rule passed on, from the runner's entry records and the gate log, and whether the plan's target or stop traded first
// after it, so the threshold is tuned from data ("we need to make sure we catch good moves too").

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const LS = require('../../scripts/lib/replay/late-skips');
const { tmpDir } = require('../helpers');

// The live smoke's long: entry 13853.00, stop 13838.75, target 13895.50; skipped at 14:30:05 with the price at 13840.75.
const LONG = { side: 'long', entry: 13853, stop: 13838.75, target: 13895.5, price: 13840.75, kind: 'missed-entry', movedR: 0.86, share: 0.25 };
const bar = (t, h, l) => ({ t, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1 });

test('firstHit: target or stop first from the bars after the skip; a bar reaching both is the stop; neither; unknown without bars or a target', () => {
  const s = { ...LONG, at: '2026-10-07T14:30:05.000Z' };
  // The bar the skip fell in (opened 14:30) and on: the target at 14:33 before any stop.
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:29:00Z', 13800, 13700), bar('2026-10-07T14:30:00Z', 13850, 13840), bar('2026-10-07T14:33:00Z', 13896, 13850)]), 'target', 'a bar before the skip never counts');
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:31:00Z', 13845, 13838.75), bar('2026-10-07T14:32:00Z', 13900, 13850)]), 'stop');
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:31:00Z', 13900, 13830)]), 'stop', 'both in one bar: the stop (conservative)');
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:31:00Z', 13860, 13845)]), 'neither');
  // The bar the skip fell in (opened 14:30, before the skip at 14:30:05) traded its stop before the skip: never counted.
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:30:00Z', 13850, 13838), bar('2026-10-07T14:31:00Z', 13896, 13850)]), 'target', 'from the bar after the skip');
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:30:00Z', 13850, 13838)]), 'unknown', 'only the skip\'s own bar: none after it');
  // Within the skip's trading day only (2026-10-07's ends 16:00 CT, 21:00Z): the next day's stop is not the plan's.
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T20:59:00Z', 13860, 13845), bar('2026-10-07T22:00:00Z', 13860, 13830), bar('2026-10-08T14:00:00Z', 13900, 13850)]), 'neither', 'neither within its trading day');
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T22:00:00Z', 13860, 13830)]), 'unknown', 'no bar in its trading day');
  assert.strictEqual(LS.firstHit(s, null), 'unknown');
  assert.strictEqual(LS.firstHit(s, [bar('2026-10-07T14:20:00Z', 13860, 13845)]), 'unknown', 'no bar after the skip');
  assert.strictEqual(LS.firstHit({ ...s, target: null }, [bar('2026-10-07T14:31:00Z', 13900, 13845)]), 'unknown');
  // A short, mirrored: its target below, its stop above.
  const sh = { ...s, side: 'short', stop: 13867.25, target: 13810.5 };
  assert.strictEqual(LS.firstHit(sh, [bar('2026-10-07T14:31:00Z', 13860, 13810)]), 'target');
  assert.strictEqual(LS.firstHit(sh, [bar('2026-10-07T14:31:00Z', 13867.25, 13850)]), 'stop');
});

test('lateSkipReport: the runner\'s skips and the gate\'s (the gateway\'s alone where both judged one order), counted by what traded first; the replay report shows them', () => {
  const home = tmpDir();
  // The runner's entry record (runner-entry.js info.late in the cycle log's file).
  fs.mkdirSync(path.join(home, 'logs', 'cycles', '2026-10-07'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'cycles', '2026-10-07', '143002-trade.json'), JSON.stringify({ cycleAt: '2026-10-07T14:30:02.000Z', entry: { outcome: 'late', late: { ...LONG, root: 'MNQ', at: '2026-10-07T14:30:05.000Z' } } }));
  // The gate's refusal of another (a short), judged by the hook and the gateway: counted once.
  const v = { check: 'late-entry', message: 'missed', late: { side: 'short', entry: 13900, stop: 13914.25, target: 13850, price: 13910, kind: 'missed-entry', movedR: 0.7, share: 0.25 } };
  fs.writeFileSync(path.join(home, 'logs', 'gate-log.jsonl'), [
    { ts: '2026-10-07T15:00:04.000Z', source: 'hook', decision: 'blocked', contractId: 'MNQ', cycle: 'c2', violations: [v] },
    { ts: '2026-10-07T15:00:05.000Z', source: 'gateway', decision: 'blocked', contractId: 'MNQ', cycle: 'c2', violations: [v] },
    { ts: '2026-10-07T15:10:00.000Z', source: 'gateway', decision: 'blocked', contractId: 'MNQ', violations: [{ check: 'max-risk', message: 'other' }] },
  ].map(x => JSON.stringify(x)).join('\n'));
  const bars = [bar('2026-10-07T14:31:00Z', 13900, 13845), bar('2026-10-07T15:01:00Z', 13915, 13905)];
  const r = LS.lateSkipReport(home, { barsFor: root => (root === 'MNQ' ? bars : null) });
  assert.deepStrictEqual([r.total, r.byKind, r.target, r.stop, r.neither, r.unknown], [2, { 'missed-entry': 2 }, 1, 1, 0, 0]);
  assert.deepStrictEqual(r.rows.map(x => [x.from, x.side, x.first]), [['runner', 'long', 'target'], ['gate', 'short', 'stop']]);
  const lines = LS.reportLines(r);
  assert.match(lines[0], /^late-entry skips: 2 \(missed-entry 2\); after the skip the plan's target traded first 1, its stop first 1, neither within its trading day 0, unknown 0/);
  assert.match(lines[1], /long entry 13853 stop 13838\.75 target 13895\.5: price 13840\.75 \(86% of the risk toward the stop\), missed-entry; then target/);
  // Without bars: unknown, never guessed.
  assert.strictEqual(LS.lateSkipReport(home).unknown, 2);
  // The replay report's section (report.js summarize: the run's home, the --bars it replayed).
  const runDir = path.join(home, 'replay', 'run1');
  fs.mkdirSync(runDir, { recursive: true });
  const barsFile = path.join(home, 'MNQ-1m.json');
  fs.writeFileSync(barsFile, JSON.stringify(bars));
  const { summarize, toText, toMarkdown } = require('../../scripts/lib/replay/report');
  const summary = summarize({}, { runDir, barsFiles: { MNQ: barsFile } });
  assert.deepStrictEqual([summary.late.total, summary.late.target, summary.late.stop], [2, 1, 1]);
  assert.match(toText(summary), /late-entry skips: 2 .*target traded first 1, its stop first 1/);
  assert.match(toMarkdown(summary), /## Late-entry skips\n\n- late-entry skips: 2/);
  // The live case: the hook ran with the role's cycle id, the gateway without one; both name the compose record: one skip.
  const home2 = tmpDir();
  fs.mkdirSync(path.join(home2, 'logs'), { recursive: true });
  const rv = { ...v, late: { ...v.late, record: 'rec-1' } };
  fs.writeFileSync(path.join(home2, 'logs', 'gate-log.jsonl'), [
    { ts: '2026-10-07T15:00:04.000Z', source: 'hook', decision: 'blocked', contractId: 'MNQ', cycle: 'c2', violations: [rv] },
    { ts: '2026-10-07T15:00:05.000Z', source: 'gateway', decision: 'blocked', contractId: 'MNQ', violations: [rv] },
    // Another record's skip at the same prices: its own.
    { ts: '2026-10-07T15:20:05.000Z', source: 'gateway', decision: 'blocked', contractId: 'MNQ', violations: [{ ...v, late: { ...v.late, record: 'rec-2' } }] },
  ].map(x => JSON.stringify(x)).join('\n'));
  const skips = LS.readSkips(home2);
  assert.deepStrictEqual(skips.map(x => [x.at, x.record]), [['2026-10-07T15:00:05.000Z', 'rec-1'], ['2026-10-07T15:20:05.000Z', 'rec-2']], 'the gateway\'s kept; each record once');
  // A run with no skip: no section (the report as before).
  assert.strictEqual(summarize({}, { runDir: path.join(tmpDir(), 'replay', 'r') }).late, undefined);
});
