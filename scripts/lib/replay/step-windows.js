'use strict';

/**
 * A replay's stepped windows (the replay config's `stepWindows`): the training loop's trend-set runs (train/trend-windows.js
 * builds them, train/probe.js sets them) step only these stretches of their sessions, as a curated run steps its list's
 * windows (learning/curated-lists.js curatedPoints, reused): the trade times whose bar closed in a window, the window days'
 * premarket and end of day, and every other time of the run only while a position or working order is open (managed,
 * then skipped once flat). Nothing of the windows reaches the runner config, the environment or the run home: the model
 * reads a bar exactly as on a whole-session run (no practice mode, no list pinned, no prompt line).
 *
 * Only the training loop's trend-set role may run one (the training preflight's loop-role check: learning/preflight.js).
 *
 *   KINDS                                    the kinds of stepped windows: 'trend-set'
 *   validateStepWindows(raw)                 { stepWindows: { kind, windows: [{ from, to }] (ISO) } | null, errors }
 *   stepWindowsForRun(sw, { start, end })    { kind, windows: [{ from, to }] (bar-close ms, from exclusive, to inclusive),
 *                                            hash }: inside the run, in order, never overlapping; throws otherwise
 */

const crypto = require('crypto');

const KINDS = Object.freeze(['trend-set']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

function validateStepWindows(raw) {
  if (raw === undefined || raw === null) return { stepWindows: null, errors: [] };
  const errors = [];
  if (!isObj(raw)) return { stepWindows: null, errors: [`stepWindows: { kind (${KINDS.join(', ')}), windows: [{ from, to }] }`] };
  for (const k of Object.keys(raw)) if (!['kind', 'windows'].includes(k)) errors.push(`stepWindows.${k}: unknown (kind, windows)`);
  if (!KINDS.includes(raw.kind)) errors.push(`stepWindows.kind: ${KINDS.join(' or ')}`);
  const ws = raw.windows;
  if (!Array.isArray(ws) || !ws.length) errors.push('stepWindows.windows: one or more { from, to } (ISO 8601 UTC bar-close bounds, from exclusive, to inclusive)');
  else {
    ws.forEach((w, i) => {
      if (!(isObj(w) && ISO.test(String(w.from)) && ISO.test(String(w.to)) && Date.parse(w.from) < Date.parse(w.to) && Object.keys(w).sort().join() === 'from,to')) errors.push(`stepWindows.windows[${i}]: { from, to }, ISO 8601 UTC, from before to`);
    });
    if (!errors.length) {
      for (let i = 1; i < ws.length; i += 1) if (Date.parse(ws[i].from) < Date.parse(ws[i - 1].to)) errors.push(`stepWindows.windows[${i}]: in order and never overlapping the window before it`);
    }
  }
  return errors.length ? { stepWindows: null, errors } : { stepWindows: { kind: raw.kind, windows: ws.map(w => ({ from: w.from, to: w.to })) }, errors: [] };
}

function stepWindowsForRun(sw, { start, end }) {
  const windows = sw.windows.map(w => ({ from: Date.parse(w.from), to: Date.parse(w.to) }));
  const s = start.getTime();
  const e = end.getTime();
  const out = windows.find(w => w.from < s || w.to > e);
  if (out) throw new Error(`stepWindows: the window ${new Date(out.from).toISOString()} to ${new Date(out.to).toISOString()} lies outside the run's ${start.toISOString()} to ${end.toISOString()}`);
  const hash = crypto.createHash('sha256').update(JSON.stringify({ kind: sw.kind, windows })).digest('hex');
  return { kind: sw.kind, windows, hash };
}

module.exports = { KINDS, validateStepWindows, stepWindowsForRun };
