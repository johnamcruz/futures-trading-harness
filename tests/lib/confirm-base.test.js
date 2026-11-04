'use strict';

// The confirm's base (scripts/lib/trading/confirm-base.js; docs/PREPARE-AHEAD.md "On: the transcript cut"): the prepare
// session's message uuids, recorded by the runner in the plan record (baseOf), named to the confirm by FTH_CONFIRM_BASE
// (readBase: only the runner's own file, whole and unforged), and the hook transcript of the confirm read without those
// lines (cut: a fork copies them first, with their own uuids; anything else is not this confirm's fork and fails closed).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CB = require('../../scripts/lib/trading/confirm-base');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-confirm-base-'));
const line = (uuid, ev = { type: 'user', message: { content: 'x' } }) => JSON.stringify({ ...ev, uuid, parentUuid: null, sessionId: 'fork' });
const PREP = ['u1', 'u2', 'u3'];
function homeWithBase(uuids = PREP, edit = b => b) {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'prepare'));
  const file = path.join(home, 'prepare', 'MNQ-20260428T041200000Z.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, id: 'p', symbol: 'MNQ', base: edit(CB.baseRecord('/t/prep.jsonl', uuids)) }));
  return { home, file };
}

test('confirm-base: baseOf reads a session file\'s message uuids in order (lines without one skipped, unreadable: null); baseRecord seals them', () => {
  const dir = tmp();
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, [line('a'), JSON.stringify({ type: 'summary', summary: 'no uuid' }), 'not json', line('b')].join('\n'));
  const b = CB.baseOf(f);
  assert.deepStrictEqual(b.uuids, ['a', 'b']);
  assert.strictEqual(b.transcript, f);
  assert.strictEqual(b.sha, CB.baseRecord(f, ['a', 'b']).sha);
  assert.strictEqual(CB.baseOf(path.join(dir, 'gone.jsonl')), null);
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.strictEqual(CB.baseOf(path.join(dir, 'empty.jsonl')), null, 'no uuid at all: no base');
});

test('confirm-base: readBase takes only the runner\'s own plan record under <home>/prepare/, whole and unforged; anything else is an error (fails closed)', () => {
  const { home, file } = homeWithBase();
  const ok = CB.readBase(file, home);
  assert.ok(!ok.error, ok.error);
  assert.deepStrictEqual([...ok.uuids], PREP);
  const err = (f, h = home) => { const r = CB.readBase(f, h); assert.ok(r.error, JSON.stringify(r)); return r.error; };
  assert.match(err(path.join(home, 'prepare', 'gone.json')), /can't be read/);
  assert.match(err('prepare/MNQ.json'), /not an absolute path/);
  // Outside the runner's folder (a file anyone could write), or through a link.
  const elsewhere = path.join(home, 'MNQ.json');
  fs.copyFileSync(file, elsewhere);
  assert.match(err(elsewhere), /not in the runner's prepare folder/);
  const link = path.join(home, 'prepare', 'link.json');
  fs.symlinkSync(elsewhere, link);
  assert.match(err(link), /a link/);
  // The uuids changed after the runner sealed them (forged), none, or not a list of ids.
  const forged = homeWithBase(PREP, b => ({ ...b, uuids: ['u1', 'u2'] }));
  assert.match(err(forged.file, forged.home), /forged/);
  for (const bad of [b => ({ ...b, uuids: [] }), b => ({ ...b, uuids: 'u1' }), b => ({ ...b, uuids: [1, 2] }), () => null]) {
    const h = homeWithBase(PREP, bad);
    assert.match(err(h.file, h.home), /no base|forged/);
  }
  fs.writeFileSync(file, '{"v":1,');
  assert.match(err(file), /can't be read/);
});

test('confirm-base: cut drops the prepare\'s copied lines from the confirm\'s fork (they come first), keeping its own; a transcript that is not that fork fails closed', () => {
  const base = { uuids: new Set(PREP) };
  const fork = [...PREP.map(u => line(u)), line('c1'), JSON.stringify({ type: 'summary' }), line('c2')].join('\n');
  const r = CB.cut(fork, base, { main: true });
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual(r.text.split('\n').map(l => JSON.parse(l).uuid), ['c1', undefined, 'c2']);
  // The CLI copying only part of the history is still the fork (its copied lines first).
  assert.ok(!CB.cut([line('u2'), line('u3'), line('c1')].join('\n'), base, { main: true }).error);
  // No prepare line at all (another session), or one after the confirm's own (not a fork's order): an error.
  assert.match(CB.cut([line('x1'), line('c1')].join('\n'), base, { main: true }).error, /not the fork/);
  assert.match(CB.cut([line('u1'), line('c1'), line('u2')].join('\n'), base, { main: true }).error, /not the fork/);
  // A subagent's own file (not the main session's): only filtered, never required to hold the history.
  assert.deepStrictEqual(CB.cut([line('s1')].join('\n'), base, { main: false }), { text: line('s1') });
});
