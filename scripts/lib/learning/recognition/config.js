'use strict';

/**
 * The recognition test's frozen definitions and case list (docs/TRAINING.md, "The recognition test"): config/
 * recognition.json (margins, pace, the chop label's and the signals' thresholds) and the case list it names, refused
 * unless the list's bytes hash to its casesSha256 (the list is frozen before any run). Fails closed: a missing,
 * unreadable or refused file throws a CriticalConfigError (config-files.js), every problem named.
 *
 * A case (the list's own fields): { day, kind: trend | chop, side (long | short; null for chop), start, end (a trend's
 * census leg start and end bar, ISO; chop: null), legCandles, pace (sharp | slow; chop: null), margin, circular,
 * circularNote, selectedBy, label? (chop: the label's values when picked), availableR? (hindsight: the pass check only) }.
 *
 *   load({ file, casesFile, casesSha })   { definitions, cases (each with an id), casesSha256, casesFile, fingerprint };
 *                                         casesFile: another list, taken only with its own casesSha
 *   startCloseOf(case, minutes, defs)     the close of rel 0: a trend's census start bar + one bar; a chop day's window
 *                                         open (chopLabel.window, New York clock) + one bar
 *   endCloseOf(case, minutes)             a trend's census end bar's close, else null
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, CriticalConfigError, loadConfigFile, fingerprintOf, shapes, shapeErrors } = require('../../config-files');
const { parseWindows, zonedTimeToUtc } = require('../../trading/clock');
const { MINUTE } = require('../../backtest/data');

const { num, str, custom } = shapes;
const pos = num({ min: Number.MIN_VALUE });
const whole = num({ min: 1, int: true });
const SHA = /^[0-9a-f]{64}$/;
const schema = {
  version: str(), about: str(), cases: str(), casesSha256: custom(v => (typeof v === 'string' && SHA.test(v) ? null : 'a sha256 in hex'), 'a sha256 in hex'),
  margins: { trend: whole, chop: whole }, sharpMaxCandles: whole,
  chopLabel: { window: custom(v => (parseWindows(v).windows.length === 1 && !parseWindows(v).errors.length ? null : 'one session spec, HH:MM-HH:MM@Zone'), 'a session spec'), minBars: whole, netAtrMax: pos, rangeAtrMin: pos, atrPeriod: whole },
  signals: { crossesChop: whole, crossesTrendMax: whole },
};
const SPEC = { name: 'recognition', validate: v => shapeErrors(schema, v) };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isIso = v => typeof v === 'string' && Number.isFinite(Date.parse(v));

function caseProblems(c, i, defs) {
  const at = `case ${i} (${c && c.day})`;
  if (!c || typeof c !== 'object') return [`${at}: not an object`];
  const out = [];
  if (!DAY.test(String(c.day))) out.push(`${at}: day ${c.day}, not YYYY-MM-DD`);
  if (!['trend', 'chop'].includes(c.kind)) return [...out, `${at}: kind ${c.kind}, not trend or chop`];
  if (c.margin !== defs.margins[c.kind]) out.push(`${at}: margin ${c.margin}, not the ${c.kind} margin ${defs.margins[c.kind]}`);
  if (typeof c.circular !== 'boolean') out.push(`${at}: circular is not true or false`);
  if (c.kind === 'chop') {
    if (c.side !== null) out.push(`${at}: a chop day has no side`);
    return out;
  }
  if (!['long', 'short'].includes(c.side)) out.push(`${at}: side ${c.side}, not long or short`);
  if (!isIso(c.start) || !isIso(c.end) || Date.parse(c.end) < Date.parse(c.start)) out.push(`${at}: start ${c.start} and end ${c.end}, not two ISO times in order`);
  if (!Number.isInteger(c.legCandles) || c.legCandles < 1) out.push(`${at}: legCandles ${c.legCandles}, not a whole number`);
  else if (c.pace !== (c.legCandles <= defs.sharpMaxCandles ? 'sharp' : 'slow')) out.push(`${at}: pace ${c.pace} for a leg of ${c.legCandles} candles (sharp at most ${defs.sharpMaxCandles})`);
  return out;
}

const idOf = c => `${c.day} ${c.kind}${c.side ? ` ${c.side}` : ''}`;

function load({ file = path.join(CONFIG_DIR, 'recognition.json'), casesFile = null, casesSha = null } = {}) {
  const loaded = loadConfigFile(SPEC, { file });
  const defs = loaded.value;
  const where = casesFile ? path.resolve(casesFile) : path.resolve(path.dirname(file), defs.cases);
  const refuse = problems => { throw new CriticalConfigError([{ name: 'recognition-cases', file: where, problems }]); };
  const want = casesFile ? casesSha : defs.casesSha256;
  if (!want || !SHA.test(String(want))) refuse(['another case list needs its own sha256 stated (--cases-sha)']);
  let body;
  try { body = fs.readFileSync(where); } catch (e) { return refuse([`it can't be read (${e.code || e.message})`]); }
  const got = crypto.createHash('sha256').update(body).digest('hex');
  if (got !== want) refuse([`its sha256 is ${got}, not the frozen ${want}: the list changed (frozen before any run)`]);
  let doc;
  try { doc = JSON.parse(body.toString('utf8')); } catch (e) { return refuse([`not JSON (${e.message})`]); }
  const list = doc && Array.isArray(doc.cases) ? doc.cases : null;
  if (!list || !list.length) refuse(['no cases']);
  const problems = list.flatMap((c, i) => caseProblems(c, i, defs));
  const ids = list.map(idOf);
  ids.forEach((id, i) => { if (ids.indexOf(id) !== i) problems.push(`case ${i}: ${id} is listed twice`); });
  if (problems.length) refuse(problems);
  return { definitions: defs, cases: list.map(c => ({ ...c, id: idOf(c) })), casesSha256: got, casesFile: where, fingerprint: fingerprintOf(loaded) };
}

function startCloseOf(c, minutes, defs) {
  const bar = minutes * MINUTE;
  if (c.kind === 'trend') return Date.parse(c.start) + bar;
  const w = parseWindows(defs.chopLabel.window).windows[0];
  const [year, month, day] = c.day.split('-').map(Number);
  return zonedTimeToUtc({ year, month, day, minute: w.start }, w.timeZone).getTime() + bar;
}

const endCloseOf = (c, minutes) => (c.kind === 'trend' ? Date.parse(c.end) + minutes * MINUTE : null);

module.exports = { load, startCloseOf, endCloseOf };
