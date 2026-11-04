'use strict';

/**
 * The confirm's base (prepare ahead "on": docs/PREPARE-AHEAD.md, "On: the transcript cut"). The confirm is a fork of the
 * prepare's Claude Code session (--resume <prepare> --fork-session): its session file copies the prepare's lines first,
 * each with its ORIGINAL message uuid (and the fork's own sessionId, so the session id can't tell them apart), then its
 * own. The runner, which wrote the prepare's plan record, records there the prepare session's uuids (`base`, sealed with
 * their hash), and names that record to the confirm's run as FTH_CONFIRM_BASE (autotrader.js childEnv). A check that
 * must judge only the close's turns (the roles that ran and the phase-2 report: roles-ran.js readTranscript, from the
 * order gate) reads a hook's transcript of the confirm without the base's lines (cut). A base named but missing,
 * unreadable, outside the runner's prepare folder, through a link or forged, and a transcript that is not that fork,
 * are errors: the check refuses (fails closed). Reads only local files; never writes.
 *
 *   baseOf(sessionFile)                  { transcript, uuids, sha } of a session file's message uuids, or null (the runner's)
 *   baseRecord(transcript, uuids)        the same, sealed (sha256 of the uuids in order)
 *   readBase(file, home)                 { uuids: Set } | { error }: the plan record FTH_CONFIRM_BASE names
 *   cut(text, base, { main })            { text } without the base's lines | { error } (main: the session's own file, which
 *                                        must be the fork: the base's lines first)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const sha = uuids => crypto.createHash('sha256').update(uuids.join('\n')).digest('hex');
const uuidOf = l => { try { const e = JSON.parse(l); return isObj(e) && typeof e.uuid === 'string' && e.uuid ? e.uuid : null; } catch (_err) { return null; } };

const baseRecord = (transcript, uuids) => ({ transcript, uuids: [...uuids], sha: sha(uuids) });

function baseOf(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_err) { return null; }
  const uuids = text.split('\n').map(uuidOf).filter(Boolean);
  return uuids.length ? baseRecord(file, uuids) : null;
}

function readBase(file, home) {
  const f = String(file || '');
  if (!path.isAbsolute(f)) return { error: `FTH_CONFIRM_BASE ${JSON.stringify(f)} is not an absolute path` };
  const dir = path.join(String(home || ''), 'prepare');
  let real;
  try { real = fs.realpathSync(path.dirname(f)) === fs.realpathSync(dir); } catch (_err) { real = false; }
  if (path.dirname(path.resolve(f)) !== path.resolve(dir) || !real) return { error: `FTH_CONFIRM_BASE ${f} is not in the runner's prepare folder (${dir})` };
  let st;
  try { st = fs.lstatSync(f); } catch (_err) { return { error: `FTH_CONFIRM_BASE ${f} can't be read` }; }
  if (st.isSymbolicLink()) return { error: `FTH_CONFIRM_BASE ${f} is a link` };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_err) { return { error: `FTH_CONFIRM_BASE ${f} can't be read` }; }
  const b = isObj(rec) && isObj(rec.base) ? rec.base : null;
  if (!b || !Array.isArray(b.uuids) || !b.uuids.length || !b.uuids.every(u => typeof u === 'string' && u)) return { error: `FTH_CONFIRM_BASE ${f} holds no base (the prepare's uuids)` };
  if (b.sha !== sha(b.uuids)) return { error: `FTH_CONFIRM_BASE ${f}: its base is forged (the uuids are not the ones the runner sealed)` };
  return { uuids: new Set(b.uuids) };
}

function cut(text, base, { main = true } = {}) {
  const lines = String(text || '').split('\n');
  if (main) {
    // The fork's order: the copied lines (the base's) first, then its own; none of the base's, or one after its own, is
    // not this confirm's fork of that prepare.
    const ids = lines.map(uuidOf).filter(Boolean);
    const firstOwn = ids.findIndex(u => !base.uuids.has(u));
    const copied = firstOwn === -1 ? ids.length : firstOwn;
    if (copied === 0 || ids.slice(copied).some(u => base.uuids.has(u))) return { error: 'the transcript is not the fork of the prepare its base names (the prepare\'s lines are not first)' };
  }
  return { text: lines.filter(l => { const u = uuidOf(l); return !(u && base.uuids.has(u)); }).join('\n') };
}

module.exports = { baseOf, baseRecord, readBase, cut };
