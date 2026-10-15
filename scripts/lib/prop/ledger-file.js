'use strict';

/**
 * The look ledger file (docs/LEARNED-RULEBOOK.md R16): read, append and lock, in the one format prop/looks.js
 * defines (JSON lines; a file in the earlier JSON-list format still reads, and its next append rewrites it as
 * lines with every look kept). Every writer (the evaluator, prop/evaluate-run.js; the scorecard,
 * replay/scorecard.js) goes through here, so one ledger file holds one budget for both.
 */

const fs = require('fs');
const path = require('path');
const { parseLedger, formatLedger, isListFormat } = require('./looks');
const schedule = require('../schedule');

/**
 * The ledger's looks. A missing file is refused unless `create` (a new ledger, named on purpose): a mistyped
 * path must not start a fresh look budget. An existing file that is empty is refused, `create` or not (it may
 * be truncated). Throws on a line it can't read.
 */
function readLedger(file, { create = false } = {}) {
  if (!fs.existsSync(file)) {
    if (create) return [];
    throw new Error(`no ledger at ${file}: a look is checked against the existing ledger (start a new one only on purpose: newLedger / --new-ledger)`);
  }
  return parseLedger(fs.readFileSync(file, 'utf8'), file);
}

/** Write the whole file through a synced temporary file and a rename, so a crash leaves the old or the new. */
function rewrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * Append one look to the ledger file, synced before the look is taken. A file in the earlier list format is
 * rewritten as lines, its looks first: none is lost. Call it holding the lock (withLedgerLock). Every entry records
 * the schedule it was written under (schedule.js fingerprint: version, hash, sealed hashes) and the config files'
 * (tunables.js fingerprints: each file's version and hash), replacing any it carried; a refused schedule or config file
 * writes nothing.
 */
function appendLook(file, rawEntry) {
  const entry = { ...rawEntry, schedule: schedule.fingerprint(), configFiles: require('../tunables').fingerprints() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (isListFormat(old)) {
    rewrite(file, formatLedger([...parseLedger(old, file), entry]));
    return;
  }
  const fd = fs.openSync(file, 'a');
  try {
    // A last line without its newline (a hand edit) would join the new look: end it first.
    fs.writeSync(fd, `${old && !old.endsWith('\n') ? '\n' : ''}${formatLedger([entry])}`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run fn holding an exclusive lock beside the ledger (`<ledger>.lock`), so two runs can't both pass the check
 * on the last look of a budget. A lock left by a crashed run is refused, never broken: the user removes it.
 */
function withLedgerLock(file, fn) {
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`no ledger at ${file}: its folder doesn't exist`, { cause: e });
    if (e.code === 'EEXIST') throw new Error(`the ledger is locked by another run (${lock}); if no run is going, remove the lock`, { cause: e });
    throw e;
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

module.exports = { readLedger, appendLook, withLedgerLock };
