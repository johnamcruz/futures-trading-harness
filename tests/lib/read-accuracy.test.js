'use strict';

// The read report (learning/read-accuracy.js, scripts/read-accuracy.js): how often the head trader's STATE read agrees
// with the briefing's own labels, per field and frame, with n and day-clustered intervals. Read only.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const RA = require('../../scripts/lib/learning/read-accuracy');
const { scoreState, parseStateLine, stateFacts } = require('../../scripts/lib/trading/state-read');
const { runDir, tmpHome } = require('../fixtures/learning');

const ROOT = path.resolve(__dirname, '..', '..');
const briefing = ({ h4 = 'up', h1 = 'up', m15 = 'up', dayType = null } = {}) => ({
  sections: { m3: { data: { today: { dayType } } }, m15: { data: { frame: { trend: m15 } } }, h1: { data: { h4: { trend: h4 }, h1: { trend: h1 } } } },
});
/** A cycle log's state record for a line against a briefing (cycle-log.js stateRead's shape). */
function rec(line, b) {
  const p = parseStateLine(line);
  return { status: p.status, line: p.line, read: p.read, missing: p.missing, bad: p.bad, symbol: 'MNQ', bar: null, briefing: null, ...scoreState(p.read, b), facts: stateFacts(b) };
}

test('tally: per field the agreement over the cycles it could be scored on, n, days, the unknowns by why and a read-by-fact table', () => {
  const cycles = [
    { day: '2023-03-15', stateRead: rec('STATE: 4h up | 1h up | day trending', briefing({ h1: 'up', dayType: 'trend up' })) },
    { day: '2023-03-15', stateRead: rec('STATE: 4h up | 1h up | day trending', briefing({ h1: 'range' })) },
    { day: '2023-03-16', stateRead: rec('STATE: 4h down | 1h transition', briefing({ h4: 'up' })) },
    { day: '2023-03-16', stateRead: rec('CYCLE RESULT: no-trade', briefing()) },
    { day: '2023-03-16', stateRead: rec('STATE: the market is choppy', briefing()) },
    { day: '2023-03-17', stateRead: null },
  ];
  const t = RA.tally(cycles);
  assert.strictEqual(t.cycles, 6);
  assert.deepStrictEqual(t.status, { read: 3, none: 1, unparsable: 1, conflicting: 0, unrecorded: 1, error: 0 });
  const h4 = t.fields['4h'];
  assert.deepStrictEqual([h4.stated, h4.match, h4.mismatch, h4.unknown, h4.n, h4.days], [3, 2, 1, 0, 3, 2]);
  assert.strictEqual(h4.agreement, 0.6667);
  assert.deepStrictEqual(h4.confusion, { up: { up: 2 }, down: { up: 1 } });
  const h1 = t.fields['1h'];
  assert.deepStrictEqual([h1.match, h1.mismatch, h1.unknown, h1.n], [1, 1, 1, 2]);
  assert.deepStrictEqual(h1.unknownWhy, { 'the briefing has no transition label for 1h': 1 });
  // The day: one scored (trend up), one before the initial balance (unknown); the table names the raw day type.
  const day = t.fields.day;
  assert.deepStrictEqual([day.match, day.unknown, day.n], [1, 1, 1]);
  assert.deepStrictEqual(day.confusion, { trending: { 'trend up': 1, none: 1 } });
  // A field never stated: zero, no rate.
  assert.deepStrictEqual([t.fields['15m'].stated, t.fields['15m'].agreement], [0, null]);
  // Intervals from whole days resampled (seeded: the same tally twice is the same); one day only: none.
  assert.ok(h4.lo !== null && h4.lo <= h4.agreement && h4.agreement <= h4.hi);
  assert.deepStrictEqual(RA.tally(cycles).fields['4h'], h4);
  assert.deepStrictEqual([h1.lo, h1.hi], [null, null], 'scored on one day only: no interval');
});

test('runCycles: a replay run\'s trade cycles with their state records, from its store lines; renderReads names agreement, not accuracy', () => {
  const T0 = '2023-03-15T14:00:00.000Z';
  const T1 = '2023-03-15T14:03:00.000Z';
  const { dir } = runDir({ times: [T0, T1], barRows: [[1, 1, 1, 1]], cycleOf: { [T0]: { stateRead: rec('STATE: 4h up', briefing()) } } });
  const cycles = RA.runCycles(dir);
  assert.deepStrictEqual(cycles.map(c => [c.day, c.stateRead ? c.stateRead.status : null]), [['2023-03-15', 'read'], ['2023-03-15', null]]);
  const text = RA.renderReads(RA.tally(cycles));
  assert.match(text, /agreement with the briefing's label/);
  assert.doesNotMatch(text, /accuracy/i);
  assert.match(text, /4h +1\/1 +100%/);
  assert.match(text, /no state record 1/);
});

test('read-accuracy CLI: a run dir, a run home\'s cycle logs, --json; a bad path is a usage error', () => {
  const T0 = '2023-03-15T14:00:00.000Z';
  const { dir } = runDir({ times: [T0], barRows: [[1, 1, 1, 1]], cycleOf: { [T0]: { stateRead: rec('STATE: 4h up | frames agree', briefing()) } } });
  const cli = args => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'read-accuracy.js'), ...args], { encoding: 'utf8' });
  const out = cli([dir]);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout, /frames +1\/1/);
  const json = JSON.parse(cli([dir, '--json']).stdout);
  assert.strictEqual(json.fields['4h'].match, 1);
  // A run home (live or replay): its cycle logs' lines.
  const home = tmpHome();
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs', 'cycles-2023-03-15.jsonl'), [{ action: 'trade', cycleAt: T0, stateRead: rec('STATE: 4h down', briefing()) }, { action: 'premarket', cycleAt: T0 }].map(l => `${JSON.stringify(l)}\n`).join(''));
  const h = JSON.parse(cli(['--home', home, '--json']).stdout);
  assert.deepStrictEqual([h.cycles, h.fields['4h'].mismatch], [1, 1]);
  const bad = cli([path.join(home, 'nothing-here')]);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /usage|no replay run/);
  assert.strictEqual(cli([]).status, 1);
});
