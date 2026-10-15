'use strict';

/**
 * A replay run's pins at its start (scripts/replay.js run): the experience index (experience-index.js pinIndex) and
 * the history library with its display (setup-library.js pinLibrary), from the run's config. A run's look (its arm:
 * learning/looks.js) is taken from its config at its first start, so a resume keeps what it pinned: a resume whose
 * config names an index or library the run never pinned, or no longer names one it pinned, or a library pinned before
 * the display existed (shown then, hidden now), is refused (the model would be shown something its look never named).
 * What is pinned is what the arm names: the index's and a shown library's hash are checked against it.
 *
 *   pinForRun(run, { fresh, arm })   [line] said by the driver; throws when a resume would change the run's pins
 */

const fs = require('fs');
const path = require('path');
const { pinIndex } = require('./experience-index');
const { pinLibrary } = require('./setup-library');

const PINS = [
  { key: 'experienceIndex', file: 'pinned.json', what: 'an experience index' },
  { key: 'setupLibrary', file: 'library-pinned.json', what: 'a history library' },
];

function pinForRun(run, { fresh, arm }) {
  if (typeof arm !== 'string') throw new Error('pinForRun: the arm its look named (replay/config.js lookArm)');
  const dir = path.join(run.paths.runHome, 'experience');
  if (!fresh) {
    for (const p of PINS) {
      const pinned = fs.existsSync(path.join(dir, p.file));
      if (run[p.key] && !pinned) throw new Error(`replay refused: this run started without ${p.what}; a resume can't pin one (${p.key}), start another runId`);
      if (!run[p.key] && pinned) throw new Error(`replay refused: this run pinned ${p.what} at its start; a resume keeps it (name it in ${p.key}), or start another runId`);
    }
    let lib = null;
    try { lib = JSON.parse(fs.readFileSync(path.join(dir, 'library-pinned.json'), 'utf8')); } catch (_err) { /* none */ }
    if (lib && typeof lib.display !== 'boolean') throw new Error('replay refused: this run pinned its history library before libraryDisplay (it was shown then, hidden now); start another runId');
  }
  const lines = [];
  // The arm's hashes (looks.js ARM: with:<index>, shuffled:<index>, +library:<library>), read when the look was taken.
  const named = re => { const m = re.exec(arm); return m ? m[1] : null; };
  const same = (what, want, got) => { if (want !== got) throw new Error(`replay refused: the ${what} pinned (${got || 'none'}) is not the one its look names (${want || 'none'}): it changed since the look was taken`); };
  if (run.experienceIndex) {
    const h = pinIndex(run.paths.runHome, run.experienceIndex).hash.slice(0, 16);
    same('experience index', named(/^(?:with|shuffled):([0-9a-f]{16})/), h);
    lines.push(`experience index pinned: ${h}`);
  }
  if (run.setupLibrary) {
    const display = run.libraryDisplay === true;
    const h = pinLibrary(run.paths.runHome, run.setupLibrary, { display }).hash.slice(0, 16);
    if (display) same('history library', named(/\+library:([0-9a-f]{16})$/), h);
    lines.push(`history library pinned: ${h}${display ? ', shown to the model' : ', not shown to the model (libraryDisplay off)'}`);
  }
  return lines;
}

module.exports = { pinForRun };
