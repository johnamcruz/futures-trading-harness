'use strict';

/**
 * A replay run's pins at its start (scripts/replay.js run): the experience index (experience-index.js pinIndex) and
 * the history library with its display (setup-library.js pinLibrary), from the run's config. A run's look (its arm,
 * config and base: learning/looks.js) is taken from its config at its first start, so a resume keeps what it pinned:
 * a resume whose config names an index or library the run never pinned, or no longer names one it pinned, is refused
 * (pinning one only on a resume would show the model something its look never named).
 *
 *   pinForRun(run, { fresh })   [line] said by the driver; throws when a resume would change the run's pins
 */

const fs = require('fs');
const path = require('path');
const { pinIndex } = require('./experience-index');
const { pinLibrary } = require('./setup-library');

const PINS = [
  { key: 'experienceIndex', file: 'pinned.json', what: 'an experience index' },
  { key: 'setupLibrary', file: 'library-pinned.json', what: 'a history library' },
];

function pinForRun(run, { fresh }) {
  const dir = path.join(run.paths.runHome, 'experience');
  if (!fresh) {
    for (const p of PINS) {
      const pinned = fs.existsSync(path.join(dir, p.file));
      if (run[p.key] && !pinned) throw new Error(`replay refused: this run started without ${p.what}; a resume can't pin one (${p.key}), start another runId`);
      if (!run[p.key] && pinned) throw new Error(`replay refused: this run pinned ${p.what} at its start; a resume keeps it (name it in ${p.key}), or start another runId`);
    }
  }
  const lines = [];
  if (run.experienceIndex) lines.push(`experience index pinned: ${pinIndex(run.paths.runHome, run.experienceIndex).hash.slice(0, 16)}`);
  if (run.setupLibrary) {
    const display = run.libraryDisplay === true;
    lines.push(`history library pinned: ${pinLibrary(run.paths.runHome, run.setupLibrary, { display }).hash.slice(0, 16)}${display ? ', shown to the model' : ', not shown to the model (libraryDisplay off)'}`);
  }
  return lines;
}

module.exports = { pinForRun };
