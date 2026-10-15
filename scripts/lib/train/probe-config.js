'use strict';

/**
 * The training loop's `probe` setting (Propose-Probe-Compose, docs/TRAINING.md): with it, each iteration's proposals
 * come from the probe round (train/probe.js) instead of one proposer reply judged edit by edit.
 *
 *   probe {
 *     replay     a stage-1 replay config (an object or a path, as the loop's `replay`): a curated practice list and
 *                its practice settings; the probes' runs, the champion's and each edit's, use it with the loop's seed
 *     windows    [{ from, to }] session dates, each inside practice-train: the curated moments the probes replay
 *     k          edits the proposer writes per round (1-8, default 4)
 *     parallel   probes replayed at once (1-4, default 1: one after another). Raise it only when the local model
 *                server serves that many prompts at once (its own concurrency setting, in your local config): the
 *                replay charges each cycle's real time, so probes that queue at the server are slower than the champion
 *   }
 *
 * It needs `modelScore`: the combined change goes through the full keep rule (train/model-verifier.js), never the
 * screen alone.
 *
 *   PROBE_KEYS, PROBE_LIMITS
 *   resolveProbe(raw, { read, modelScore })   the resolved setting, or null without one; throws with every error
 */

const { rolesBetween } = require('../learning/splits');
const { tradingDayStart } = require('../trading/clock');

const PROBE_KEYS = Object.freeze(['replay', 'windows', 'k', 'parallel']);
const PROBE_LIMITS = Object.freeze({ k: [4, 1, 8], parallel: [1, 1, 4] });
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const sessionStart = d => tradingDayStart(new Date(`${d}T12:00:00Z`));

function resolveProbe(raw, { read, modelScore = null } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`probe: { ${PROBE_KEYS.join(', ')} }`);
  const errors = [];
  for (const k of Object.keys(raw)) if (!PROBE_KEYS.includes(k)) errors.push(`probe.${k}: not a setting (${PROBE_KEYS.join(', ')})`);
  if (!modelScore) errors.push('probe: the combined change goes through the full keep rule: set modelScore');
  const windows = raw.windows;
  if (!Array.isArray(windows) || !windows.length) errors.push('probe.windows: one or more { from, to } session-date windows in practice-train');
  else {
    windows.forEach((w, i) => {
      if (!(w && DATE.test(w.from) && DATE.test(w.to) && w.from < w.to && Object.keys(w).length === 2)) { errors.push(`probe.windows[${i}]: { from, to }, YYYY-MM-DD, from before to`); return; }
      let roles;
      try { roles = rolesBetween(sessionStart(w.from), sessionStart(w.to)); } catch (err) { roles = [err.message]; }
      if (!(roles.length === 1 && roles[0] === 'practice-train')) errors.push(`probe.windows ${w.from}..${w.to}: probes run on practice-train only (this touches ${roles.join(' + ')})`);
    });
  }
  let replay = null;
  try { replay = read(raw.replay); } catch (err) { errors.push(`probe.replay: ${err.message}`); }
  if (replay) {
    if (replay.stage !== 1) errors.push('probe.replay.stage: 1 (learn to trade): the probe screen reads stage-1 decisions');
    if (!replay.curatedList || typeof replay.curatedList !== 'object') errors.push('probe.replay.curatedList: the curated practice list the probes replay');
    if (!replay.practice || typeof replay.practice !== 'object') errors.push('probe.replay.practice: a curated run runs through setup-focused practice');
    if (replay.learning === false) errors.push('probe.replay.learning: a probe is a practice-train learning run');
  }
  const int = (k) => {
    const [def, min, max] = PROBE_LIMITS[k];
    const v = raw[k];
    if (v === undefined) return def;
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`probe.${k}: a whole number from ${min} to ${max}`);
    return v;
  };
  const k = int('k');
  const parallel = int('parallel');
  if (errors.length) throw new Error(errors.join('\n- '));
  if (typeof replay.autotrader === 'string') replay = { ...replay, autotrader: read(replay.autotrader) };
  return { replay, windows, k, parallel };
}

module.exports = { PROBE_KEYS, PROBE_LIMITS, resolveProbe };
