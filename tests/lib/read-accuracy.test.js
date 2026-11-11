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
    { day: '2023-03-15', stateRead: rec('STATE: 4h up | 1h up | 15m up | frames agree', briefing({ h1: 'up' })) },
    { day: '2023-03-15', stateRead: rec('STATE: 4h up | 1h up', briefing({ h1: 'range' })) },
    { day: '2023-03-16', stateRead: rec('STATE: 4h down | 1h transition', briefing({ h4: 'up' })) },
    { day: '2023-03-16', stateRead: rec('CYCLE RESULT: no-trade', briefing()) },
    { day: '2023-03-16', stateRead: rec('STATE: the market is choppy', briefing()) },
    { day: '2023-03-17', stateRead: null },
  ];
  cycles[3].result = 'CYCLE RESULT: managed - MNQ long held';
  cycles[0].result = '**CYCLE RESULT:** no-trade - x';
  const t = RA.tally(cycles);
  assert.strictEqual(t.cycles, 6);
  assert.deepStrictEqual(t.status, { read: 3, none: 1, unparsable: 1, conflicting: 0, unrecorded: 1, error: 0 });
  // By the cycle's outcome: a managed cycle's missing line reads apart from a flat one's.
  assert.deepStrictEqual(t.byOutcome, { 'no-trade': { read: 1 }, unknown: { read: 2, unparsable: 1, unrecorded: 1 }, managed: { none: 1 } });
  const h4 = t.fields['4h'];
  assert.deepStrictEqual([h4.stated, h4.match, h4.mismatch, h4.unknown, h4.n, h4.days], [3, 2, 1, 0, 3, 2]);
  assert.strictEqual(h4.agreement, 0.6667);
  assert.deepStrictEqual(h4.confusion, { up: { up: 2 }, down: { up: 1 } });
  const h1 = t.fields['1h'];
  assert.deepStrictEqual([h1.match, h1.mismatch, h1.unknown, h1.n, h1.days], [1, 1, 1, 2, 1], 'an unknown counts in no day');
  assert.deepStrictEqual(h1.unknownWhy, { 'the briefing has no transition label for 1h': 1 });
  // The day and ctx fields (agreement with the briefing's own words) beside the frames; frames scored against the labels
  // and against the read's own frames, apart.
  assert.deepStrictEqual(Object.keys(t.fields), ['4h', '1h', '15m', 'frames', 'day', 'ctx', 'frames-own']);
  assert.deepStrictEqual([t.fields.day.stated, t.fields.ctx.stated], [0, 0], 'no line here states them');
  assert.deepStrictEqual([t.fields.frames.match, t.fields['frames-own'].match], [1, 1]);
  // A field never stated: zero, no rate.
  assert.deepStrictEqual([t.fields['15m'].stated, t.fields['15m'].n], [1, 1]);
  assert.strictEqual(RA.tally([]).fields['15m'].agreement, null);
  // Under the experience index's minimum n or days: too few, no interval.
  assert.deepStrictEqual([h4.lo, h4.hi, h4.tooFew], [null, null, true]);
  assert.match(RA.renderReads(t), /4h {2}2\/3 {2}67% {2}too few \(n 3, days 2\)/);
});

test('tally: the day word against the Day so far word is agreement (a copy measure), said so in the report', () => {
  const b = soFar => { const x = briefing(); x.sections.m3.data.today.soFar = soFar; return x; };
  const t = RA.tally([
    { day: '2023-03-15', stateRead: rec('STATE: 4h up | day chop | ctx continuation', b({ status: 'read', read: 'rotational' })) },
    { day: '2023-03-15', stateRead: rec('STATE: 4h up | day trend | ctx pullback', b({ status: 'read', read: 'rotational' })) },
    { day: '2023-03-16', stateRead: rec('STATE: 4h up | day early', b({ status: 'too early', bars: 3 })) },
  ]);
  assert.deepStrictEqual([t.fields.day.match, t.fields.day.mismatch, t.fields.day.n], [2, 1, 3]);
  assert.deepStrictEqual(t.fields.day.confusion, { chop: { chop: 1 }, trend: { chop: 1 }, early: { early: 1 } });
  assert.deepStrictEqual([t.fields.ctx.match, t.fields.ctx.mismatch], [1, 1]);
  assert.match(RA.renderReads(t), /day and ctx: agreement with the briefing's own words \(the Day so far line, the labels' context\) measures copying, not whether the read was right/);
});

test('tally: enough cycles and days: an interval from whole days resampled, seeded (the same tally twice is the same)', () => {
  const { training } = require('../../scripts/lib/tunables');
  const { minN, minDays } = training().experienceIndex;
  const days = minDays + 2;
  const per = Math.ceil(minN / days) + 1;
  const cycles = [];
  for (let d = 0; d < days; d += 1) {
    for (let k = 0; k < per; k += 1) cycles.push({ day: `2023-04-${String(d + 1).padStart(2, '0')}`, stateRead: rec(`STATE: 4h ${k === 0 && d % 2 ? 'down' : 'up'}`, briefing()) });
  }
  const f = RA.tally(cycles).fields['4h'];
  assert.ok(f.n >= minN && f.days >= minDays && !f.tooFew);
  assert.ok(f.lo !== null && f.lo <= f.agreement && f.agreement <= f.hi && f.lo < f.hi, JSON.stringify(f));
  assert.deepStrictEqual(RA.tally(cycles).fields['4h'], f);
  // One day short of the minimum: too few.
  assert.ok(RA.tally(cycles.filter(c => c.day !== '2023-04-01' && c.day !== '2023-04-02' && c.day !== '2023-04-03')).fields['4h'].tooFew);
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
