'use strict';

// The leg ledger's CLI (scripts/leg-ledger.js): a training home's round printed by class, as JSON, and the days-before
// view; read only (it writes only --out); a bad flag or a missing home is a usage error.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpDir } = require('../helpers');

const CLI = path.join(__dirname, '..', '..', 'scripts', 'leg-ledger.js');
const run = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
const MIN3 = 3 * 60000;

function home() {
  const h = tmpDir();
  fs.mkdirSync(path.join(h, 'probes', 'trend'), { recursive: true });
  fs.mkdirSync(path.join(h, 'iter-1'), { recursive: true });
  const mk = (day, availableR, blocker) => {
    const start = Date.parse(`${day}T14:27:00.000Z`);
    const bar = new Date(start + MIN3).toISOString();
    return {
      id: `${day}|long|${new Date(start).toISOString()}`, day, side: 'long', start: new Date(start).toISOString(), end: new Date(start + 10 * MIN3).toISOString(), move: { points: 30 }, availableR, estimated: false, captured: false, ride: null,
      cycles: [{ bar, step: blocker === 'no-plan' ? null : 'location', by: blocker === 'no-plan' ? 'head' : 'compose_check', code: blocker, message: 'no-trade' }],
      blocker: { step: null, code: blocker, by: blocker === 'no-plan' ? 'head' : 'compose_check', cycles: 1 },
    };
  };
  const legs = { '2026-03-02': mk('2026-03-02', 2, 'location:false'), '2026-03-03': mk('2026-03-03', 5, 'no-plan') };
  fs.writeFileSync(path.join(h, 'iter-1', 'probe-report.json'), JSON.stringify({ trend: { probe: { days: Object.keys(legs), legs: Object.values(legs).map(l => l.id) } } }));
  for (const [day, l] of Object.entries(legs)) {
    fs.writeFileSync(path.join(h, 'probes', 'trend', `pc-${day}-abcd1234.json`), JSON.stringify({ legs: [[l.id, { day, unit: 'w' }]], sessions: [{ unit: 'w', day, complete: true }], capture: { runId: `r-${day}`, legs: [l] } }));
  }
  return h;
}

test('leg-ledger CLI: prints the round by class with n, the halves, the legs; read only', () => {
  const h = home();
  const before = fs.readdirSync(h).sort();
  const r = run(['--home', h, '--minutes', '3']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /all: 2 leg\(s\), 0 caught, 2 missed/);
  assert.match(r.stdout, /location \| 1 \(n 1 sum 2R/);
  assert.match(r.stdout, /probe: 2 leg\(s\)/);
  assert.match(r.stdout, /listed days with no champion probe doc: none/);
  assert.deepStrictEqual(fs.readdirSync(h).sort(), before);
});

test('leg-ledger CLI: --before shows only the days before; --json and --out write the document', () => {
  const h = home();
  const r = run(['--home', h, '--before', '2026-03-03']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /all: 1 leg\(s\)/);
  assert.doesNotMatch(r.stdout, /no-plan/);
  const out = path.join(tmpDir(), 'ledger.json');
  const j = run(['--home', h, '--json', '--out', out]);
  assert.strictEqual(j.status, 0, j.stderr);
  const doc = JSON.parse(j.stdout);
  assert.deepStrictEqual([doc.rows.length, doc.totals.rAvailable.sum, doc.missingDays.length], [2, 7, 0]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), doc);
});

test('leg-ledger CLI: usage errors exit 1', () => {
  assert.strictEqual(run([]).status, 1);
  assert.strictEqual(run(['--home']).status, 1);
  assert.strictEqual(run(['--home', home(), '--bogus', 'x']).status, 1);
  assert.strictEqual(run(['--home', home(), '--minutes', 'x']).status, 1);
  assert.match(run(['--home', home(), '--before', 'soon']).stderr, /YYYY-MM-DD/);
});
