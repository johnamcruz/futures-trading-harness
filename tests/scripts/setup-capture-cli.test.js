'use strict';

// scripts/setup-capture.js end to end on tiny synthetic run homes (tests/fixtures/setup-capture-homes.js): the report of
// one arm and of two, and `accept` against a criteria file: PASS (exit 0), each FAIL kind (exit 1), insufficient data
// (exit 2), a malformed criteria file (exit 3). The checker itself is regression-tested here; its thresholds are the
// test's, never the repo's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('../fixtures/setup-capture-homes');
const { writeCensus } = require('../../scripts/lib/learning/leg-census');
const { tmpDir } = require('../helpers');

const CLI = path.resolve(__dirname, '..', '..', 'scripts', 'setup-capture.js');
const quiet = is => is.map(i => ({ i }));
const ok = (id, i, side) => ({ id, side, i, ok: true, reads: [side === 'long' ? '15m rejected VWAP (rth) up' : '15m rejected VWAP (rth) down'] });

/** Control catches the long leg and is refused late (chased) on the short; "on" catches both on its confirm path. */
function setup() {
  const root = tmpDir();
  const census = writeCensus(path.join(root, 'census'), F.census());
  const a = path.join(root, 'control');
  const b = path.join(root, 'on');
  F.makeHome(a, 'day-20210614', {
    cycles: [...quiet([2, 3, 10, 12]), { i: 4, entry: { record: 'l1', outcome: 'executed' } }, { i: 11, entry: { record: 's1', outcome: 'late', why: 'chased', late: { kind: 'chased-entry', side: 'short', entry: 21528, stop: 21538, target: 21508, price: 21524, movedR: 0.4, record: 's1' } } }],
    records: [ok('l1', 4, 'long'), ok('s1', 11, 'short')], orders: [{ orderId: 7, i: 4, record: 'l1', side: 'long' }], fills: [{ orderId: 7, i: 4, r: 2 }],
  });
  const on = { path: 'confirm', confirm: { fellBack: false } };
  F.makeHome(b, 'day-20210614', {
    // and one chased refusal of its own, after both legs (as many per decision time as control: 1 of 27)
    cycles: [...quiet([2, 3, 10]), { i: 4, entry: { record: 'l1', outcome: 'executed' }, on }, { i: 11, entry: { record: 's1', outcome: 'executed' }, on }, { i: 24, entry: { record: 's2', outcome: 'late', why: 'chased', late: { kind: 'chased-entry', side: 'short', entry: 21490, stop: 21500, target: 21470, price: 21486, movedR: 0.4, record: 's2' } } }],
    records: [ok('l1', 4, 'long'), ok('s1', 11, 'short'), ok('s2', 24, 'short')], orders: [{ orderId: 7, i: 4, record: 'l1', side: 'long' }, { orderId: 8, i: 11, record: 's1', side: 'short' }],
    fills: [{ orderId: 7, i: 4, r: 2 }, { orderId: 8, i: 11, r: 1.5 }], skipped: [20], // one decision time passed while a cycle ran (1 of 27)
  });
  return { root, census, a, b };
}

const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const criteriaFile = (root, list, name = 'criteria.json') => { const f = path.join(root, name); fs.writeFileSync(f, JSON.stringify({ level: 0.9, criteria: list })); return f; };

test('setup-capture CLI: report on one arm, then two; the same input prints the same text', () => {
  const { census, a, b } = setup();
  const one = run(['report', '--census', census, '--a', a]);
  assert.strictEqual(one.status, 0, one.stderr);
  assert.match(one.stdout, /legs \(all\): 1\/2 caught/);
  assert.match(one.stdout, /late refusals 1: \{"chased-entry":1\}/);
  const two = run(['report', '--census', census, '--a', a, '--b', b, '--names', 'control,on']);
  assert.strictEqual(two.status, 0, two.stderr);
  assert.match(two.stdout, /legs caught \(all\): control 1\/2 .* on 2\/2/);
  assert.match(two.stdout, /entries by prepare path: control \{"n\/a":1\}; on \{"confirm":2\}/);
  assert.strictEqual(run(['report', '--census', census, '--a', a, '--b', b, '--names', 'control,on']).stdout, two.stdout);
  const json = JSON.parse(run(['report', '--census', census, '--a', a, '--b', b, '--json']).stdout);
  assert.deepStrictEqual([json.a.totals.all.caught, json.b.totals.all.caught, json.compare.legs.all.bOnly], [1, 2, 1]);
});

test('setup-capture CLI: accept: PASS exits 0, one line per criterion with its measured value, threshold and verdict', () => {
  const { root, census, a, b } = setup();
  const crit = criteriaFile(root, [
    { id: 'caught', kind: 'caught-rate', legs: 'all', margin: 0.5, minLegs: 2 },
    { id: 'chased', kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 1, minA: 1 },
    { id: 'overran', kind: 'overran-share', arm: 'b', max: 0.05, minDecisions: 2 },
    { id: 'confirm', kind: 'path-share', arm: 'b', path: 'confirm', min: 1, minEntries: 2 },
    { id: 'late-share', kind: 'uncaught-reason-share', arm: 'b', legs: 'all', reason: 'late-chased', max: 0, minLegs: 2 },
    { id: 'net', kind: 'discordant-net-r', min: 1, minDiscordant: 1 },
    { id: 'lost', kind: 'caught-a-uncaught-b', reason: 'any', max: 0, minPairs: 2 },
  ]);
  const out = path.join(root, 'out', 'report.json');
  const r = run(['accept', '--census', census, '--a', a, '--b', b, '--criteria', crit, '--out', out]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.deepStrictEqual(lines.slice(0, 7).map(l => l.split(' ')[0]), ['caught', 'chased', 'confirm', 'late-share', 'lost', 'net', 'overran']);
  assert.match(lines.find(l => l.startsWith('chased')), /measured 0\.037, threshold <= 0\.037: PASS \(a 1 of 27 decision times, b 1 of 27/);
  assert.match(lines.find(l => l.startsWith('net')), /measured 1\.5, threshold >= 1: PASS/);
  assert.strictEqual(lines[lines.length - 1], 'verdict: PASS');
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([doc.verdict, doc.results.length], ['PASS', 7]);
});

test('setup-capture CLI: accept: each FAIL kind exits 1', () => {
  const { root, census, a, b } = setup();
  const fails = [
    [{ kind: 'caught-rate', legs: 'all', margin: 0, minLegs: 2 }, true],
    [{ kind: 'late-refusals', lateKind: 'chased-entry', maxRatio: 0.5, minA: 1 }, false],
    [{ kind: 'overran-share', arm: 'b', max: 0.03, minDecisions: 2 }, false],
    [{ kind: 'path-share', arm: 'a', path: 'confirm', min: 0.5, minEntries: 1 }, false],
    [{ kind: 'uncaught-reason-share', arm: 'a', legs: 'all', reason: 'late-chased', max: 0.5, minLegs: 2 }, false],
    [{ kind: 'discordant-net-r', min: 2, minDiscordant: 1 }, false],
    [{ kind: 'caught-a-uncaught-b', reason: 'late-chased', max: 0, minPairs: 1 }, true],
  ];
  fails.forEach(([c, swap], k) => {
    const crit = criteriaFile(root, [{ id: `c${k}`, ...c }], `fail-${k}.json`);
    const r = run(['accept', '--census', census, '--a', swap ? b : a, '--b', swap ? a : b, '--criteria', crit]);
    assert.strictEqual(r.status, 1, `${c.kind}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`c${k} \\[${c.kind}\\]: .*: FAIL`));
  });
});

test('setup-capture CLI: accept: too little to judge exits 2 and says which; a malformed criteria file exits 3', () => {
  const { root, census, a, b } = setup();
  const thin = criteriaFile(root, [{ id: 'net', kind: 'discordant-net-r', min: 0, minDiscordant: 5 }, { id: 'rate', kind: 'caught-rate', legs: 'aligned', margin: 0.1, minLegs: 1 }], 'thin.json');
  const r = run(['accept', '--census', census, '--a', a, '--b', b, '--criteria', thin]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /net \[discordant-net-r\]: .*INSUFFICIENT \(1 discordant legs under minDiscordant 5\)/);
  assert.match(r.stdout, /rate \[caught-rate\]: .*INSUFFICIENT \(0 paired aligned legs under minLegs 1\)/);
  const bad = criteriaFile(root, [{ id: 'x', kind: 'caught-rate', legs: 'all', minLegs: 1 }], 'bad.json');
  const e = run(['accept', '--census', census, '--a', a, '--b', b, '--criteria', bad]);
  assert.strictEqual(e.status, 3);
  assert.match(e.stderr, /x: caught-rate needs margin/);
  // The criteria are checked before any home is read: a bad file refuses even with homes that don't exist.
  const first = run(['accept', '--census', census, '--a', path.join(root, 'nowhere'), '--b', b, '--criteria', bad]);
  assert.deepStrictEqual([first.status, /needs margin/.test(first.stderr)], [3, true], first.stderr);
  // A misspelled reason is refused too, before any home is read.
  const typo = criteriaFile(root, [{ id: 't', kind: 'caught-a-uncaught-b', reason: 'cycle-overrun', max: 0, minPairs: 1 }], 'typo.json');
  const t = run(['accept', '--census', census, '--a', path.join(root, 'nowhere'), '--b', b, '--criteria', typo]);
  assert.deepStrictEqual([t.status, /reason cycle-overrun/.test(t.stderr)], [3, true], t.stderr);
  const usage = run(['accept', '--census', census, '--a', a]);
  assert.strictEqual(usage.status, 3);
  assert.match(usage.stderr, /usage/);
});

test('setup-capture CLI: accept takes its Wilson level from the file, and a folder child that is no run home is a problem (exit 2)', () => {
  const { root, census, a, b } = setup();
  const crit = path.join(root, 'level.json');
  fs.writeFileSync(crit, JSON.stringify({ level: 0.8, criteria: [{ id: 'net', kind: 'discordant-net-r', min: 1, minDiscordant: 1 }] }));
  const out = path.join(root, 'level-report.json');
  const r = run(['accept', '--census', census, '--a', a, '--b', b, '--criteria', crit, '--out', out]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepStrictEqual([doc.compare.level, doc.compare.legs.all.a.wilson.level], [0.8, 0.8]);
  fs.mkdirSync(path.join(b, 'notes'));
  const p = run(['accept', '--census', census, '--a', a, '--b', b, '--criteria', crit]);
  assert.strictEqual(p.status, 2, p.stdout + p.stderr);
  assert.match(p.stdout, /^problem: b not-a-home: notes: no replay folder$/m);
  assert.match(run(['report', '--census', census, '--a', b]).stdout, /^problem: not-a-home: notes: no replay folder$/m);
});
