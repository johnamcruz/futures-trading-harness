'use strict';

// learning/run-pins.js: a replay run pins its experience index and history library at its start; a resume keeps them.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pinForRun: pinWith } = require('../../scripts/lib/learning/run-pins');
const X = require('../../scripts/lib/learning/experience-index');
const L = require('../../scripts/lib/learning/setup-library');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-run-pins-'));
const rec = day => ({ v: L.VERSION, validBars: 2, id: day, root: 'MNQ', day, bar: `${day}T15:00:00.000Z`, status: 'traded', side: 'long', reads: [], signature: 'bias:x', setupKey: 'setup:y', context: {}, outcome: { filled: true, R: 1, exitTime: `${day}T16:00:00.000Z` } });

test('pinForRun: a fresh run pins what its config names; a resume keeps its pins and never adds or drops one', () => {
  const built = tmp();
  const lib = L.writeLibrary(path.join(built, 'lib'), L.buildLibraryIndex([rec('2022-03-01')], { reps: 20 }));
  const idx = X.writeIndex(path.join(built, 'idx'), X.buildIndex([], { reps: 20 }));
  // The arm the run's look names (replay/config.js lookArm), unless the test names another.
  const armFor = r => `${X.armOf(r.experienceIndex)}${r.setupLibrary && r.libraryDisplay ? `+library:${L.readLibrary(r.setupLibrary).hash.slice(0, 16)}` : ''}`;
  const pinForRun = (r, o) => pinWith(r, { arm: armFor(r), ...o });
  const run = (home, o = {}) => ({ paths: { runHome: home }, experienceIndex: null, setupLibrary: null, libraryDisplay: false, ...o });

  // Fresh: nothing named, nothing pinned.
  const none = tmp();
  assert.deepStrictEqual(pinForRun(run(none), { fresh: true }), []);
  // The reviewer's case: a run started without a library (its look a hidden arm) can't pin a shown one on a resume.
  assert.throws(() => pinForRun(run(none, { setupLibrary: lib, libraryDisplay: true }), { fresh: false }), /started without a history library; a resume can't pin one/);
  assert.throws(() => pinForRun(run(none, { setupLibrary: lib }), { fresh: false }), /started without a history library/);
  assert.throws(() => pinForRun(run(none, { experienceIndex: idx }), { fresh: false }), /started without an experience index; a resume can't pin one/);
  assert.strictEqual(L.libraryShown(none), false);
  assert.strictEqual(fs.existsSync(path.join(none, 'experience')), false, 'nothing pinned by a refused resume');

  // Fresh with both: pinned, said; the display kept in the pin.
  const both = tmp();
  const lines = pinForRun(run(both, { experienceIndex: idx, setupLibrary: lib, libraryDisplay: true }), { fresh: true });
  assert.match(lines[0], /^experience index pinned: [0-9a-f]{16}$/);
  assert.match(lines[1], /^history library pinned: [0-9a-f]{16}, shown to the model$/);
  assert.strictEqual(L.libraryShown(both), true);
  // A resume with the same config: the same pins.
  assert.strictEqual(pinForRun(run(both, { experienceIndex: idx, setupLibrary: lib, libraryDisplay: true }), { fresh: false }).length, 2);
  // A resume dropping one, or switching the display, is refused.
  assert.throws(() => pinForRun(run(both, { experienceIndex: idx }), { fresh: false }), /pinned a history library at its start; a resume keeps it/);
  assert.throws(() => pinForRun(run(both, { setupLibrary: lib, libraryDisplay: true }), { fresh: false }), /pinned an experience index at its start/);
  assert.throws(() => pinForRun(run(both, { experienceIndex: idx, setupLibrary: lib }), { fresh: false }), /display on; a run keeps it/);

  // A library pinned before libraryDisplay (no display key: shown then) can't resume, hidden or shown.
  const old = tmp();
  pinForRun(run(old, { setupLibrary: lib }), { fresh: true });
  const pinFile = path.join(old, 'experience', 'library-pinned.json');
  const { display: _d, ...preFlag } = JSON.parse(fs.readFileSync(pinFile, 'utf8'));
  fs.writeFileSync(pinFile, JSON.stringify(preFlag));
  assert.throws(() => pinForRun(run(old, { setupLibrary: lib }), { fresh: false }), /pinned its history library before the display was recorded/);
  assert.throws(() => pinForRun(run(old, { setupLibrary: lib, libraryDisplay: true }), { fresh: false }), /before the display was recorded/);

  // What is pinned is what the arm names (a file replaced at its path after the look was taken is refused).
  const ih = X.armOf(idx).slice(-16);
  const lh = L.readLibrary(lib).hash.slice(0, 16);
  assert.strictEqual(pinForRun(run(tmp(), { experienceIndex: idx, setupLibrary: lib, libraryDisplay: true }), { fresh: true, arm: `with:${ih}+library:${lh}` }).length, 2);
  const mismatched = tmp();
  assert.throws(() => pinForRun(run(mismatched, { experienceIndex: idx }), { fresh: true, arm: `with:${'0'.repeat(16)}` }), /the experience index pinned \([0-9a-f]{16}\) is not the one its look names \(0{16}\)/);
  assert.strictEqual(fs.existsSync(path.join(mismatched, 'experience')), false, 'checked before anything is pinned');
  const libMismatch = tmp();
  assert.throws(() => pinForRun(run(libMismatch, { experienceIndex: idx, setupLibrary: lib, libraryDisplay: true }), { fresh: true, arm: `with:${ih}+library:${'0'.repeat(16)}` }), /the history library pinned .* is not the one its look names/);
  assert.strictEqual(fs.existsSync(path.join(libMismatch, 'experience')), false, 'the index is not pinned either');
  assert.throws(() => pinForRun(run(tmp(), { experienceIndex: idx }), { fresh: true, arm: 'without' }), /is not the one its look names \(none\)/);
  assert.strictEqual(pinForRun(run(tmp(), { setupLibrary: lib }), { fresh: true, arm: 'without' }).length, 1, 'a hidden library is in no arm');

  assert.throws(() => pinWith(run(tmp()), { fresh: true }), /the arm its look named/);

  // Hidden by default.
  const hidden = tmp();
  assert.match(pinForRun(run(hidden, { setupLibrary: lib }), { fresh: true })[0], /not shown to the model \(libraryDisplay off\)$/);
  assert.strictEqual(L.libraryShown(hidden), false);
});
