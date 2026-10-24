'use strict';

/**
 * The training loop's `probe` setting (Propose-Probe-Compose, docs/TRAINING.md): with it, each iteration's proposals
 * come from the probe round (train/probe.js) instead of one proposer reply judged edit by edit.
 *
 *   probe {
 *     replay     a stage-1 replay config (an object or a path, as the loop's `replay`): a curated practice list and
 *                its practice settings; the probes' runs, the champion's and each edit's, use it with the loop's seed.
 *                Its `autotrader` is the loop's (left out: the loop's is used), so the probes and the keep rule run the
 *                same model and runner config
 *     windows    [{ from, to }] session dates, each inside practice-train: the curated moments the probes replay
 *                (split by session date into a probe half and a confirm half: screen.js halfOf)
 *     k          edits the proposer writes per round (1-8, default 4)
 *     trend      optional: { replay, set, regression } (resolveTrend below): the trend set's whole sessions, screened on
 *                the legs caught (trend-screen.js), and the regression days (harm only)
 *     parallel   probes replayed at once (1-4, default 1: one after another). More than 1 only with
 *                `replay.latency: false`: a replay that charges each cycle's real time would charge probes queued at
 *                the model server more than the champion, whose probe run runs alone; with no latency charged, both
 *                are charged alike (none)
 *   }
 *
 * It needs `modelScore`: the combined change goes through the full keep rule (train/model-verifier.js), never the
 * screen alone.
 *
 *   PROBE_KEYS, PROBE_LIMITS
 *   resolveProbe(raw, { read, readSet, modelScore, autotrader, tuningWindows })   the resolved setting, or null without one; throws
 *                                             with every error. autotrader: the loop's replay's, resolved. tuningWindows:
 *                                             the keep rule's; a probe window that shares a session date with one is
 *                                             refused (the dates edits are chosen on never judge them)
 *   overlaps(a, b)                            whether two { from, to } session-date windows (to exclusive) share a date
 */

const { rolesBetween } = require('../learning/splits');
const { tradingDayStart } = require('../trading/clock');

const PROBE_KEYS = Object.freeze(['replay', 'windows', 'k', 'parallel', 'trend']);
const TREND_KEYS = Object.freeze(['replay', 'set', 'batch', 'half', 'regression']);
// [default, min, max] of each (config/training.json probe).
const PROBE_LIMITS = Object.freeze(Object.fromEntries(Object.entries(require('../tunables').training().probe).map(([k, r]) => [k, Object.freeze([r.default, r.min, r.max])])));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const sessionStart = d => tradingDayStart(new Date(`${d}T12:00:00Z`));
/** JSON with its object keys sorted: two configs equal whatever their key order. */
const canonical = x => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

const overlaps = (a, b) => a.from < b.to && b.from < a.to;

function resolveProbe(raw, { read, readSet = () => { throw new Error('no trend-set reader'); }, modelScore = null, autotrader = null, tuningWindows = [] } = {}) {
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
      // Disjoint from the keep rule's windows: an edit chosen on a date is never judged on it (selection bias).
      for (const t of (Array.isArray(tuningWindows) ? tuningWindows : []).filter(x => x && DATE.test(x.from) && DATE.test(x.to))) {
        if (overlaps(w, t)) errors.push(`probe.windows ${w.from}..${w.to}: shares session dates with the tuning window ${t.from}..${t.to}; the dates edits are found and screened on never judge them: make them disjoint`);
      }
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
  if (replay && parallel > 1 && replay.latency !== false) errors.push('probe.parallel: more than 1 only with probe.replay.latency false (charged latency would differ from the champion\'s, whose probe run runs alone)');
  // The same model and runner config as the keep rule's runs: the loop's own autotrader.
  const sameTrader = (cfg, key) => {
    if (!cfg) return cfg;
    if (cfg.autotrader === undefined) return { ...cfg, autotrader };
    let own = cfg.autotrader;
    try { if (typeof own === 'string') own = read(own); } catch (err) { errors.push(`${key}.autotrader: ${err.message}`); return cfg; }
    if (canonical(own) !== canonical(autotrader)) { errors.push(`${key}.autotrader: the loop's replay.autotrader (the probes and the keep rule run the same model and runner config); leave it out to use the loop's`); return cfg; }
    return { ...cfg, autotrader: own };
  };
  replay = sameTrader(replay, 'probe.replay');
  const trend = raw.trend === undefined ? null : resolveTrend(raw.trend, { read, readSet, tuningWindows, errors, sameTrader, parallel });
  if (errors.length) throw new Error(errors.join('\n- '));
  return { replay, windows, k, parallel, ...(trend ? { trend } : {}) };
}

/** A session date's learning role, or the error's message. */
const roleOf = d => {
  try { return rolesBetween(sessionStart(d), sessionStart(nextDate(d))).join(' + '); } catch (err) { return err.message; }
};
const nextDate = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().split('T')[0];

/**
 * probe.trend (trend-set.js, trend-screen.js): { replay, set, batch, half, regression }. replay: a stage-1 replay config
 * of whole sessions (no curated list, no practice, no combine or account states: every bar of the runner's session, as
 * live), the loop's autotrader. set: a trend pool file (scripts/trend-set.js build), its days in practice-train and
 * sharing no session date with the tuning windows. batch: the legs a round draws (a whole number, at most the pool's);
 * half: the probe half's share of them (between 0 and 1; the confirm half holds the rest). regression: { days:
 * [YYYY-MM-DD] } (the trend-move set's), harm only: in practice-train, outside the tuning windows and the pool's days.
 */
function resolveTrend(raw, { read, readSet, tuningWindows, errors, sameTrader, parallel }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`probe.trend: { ${TREND_KEYS.join(', ')} }`); return null; }
  for (const k of Object.keys(raw)) if (!TREND_KEYS.includes(k)) errors.push(`probe.trend.${k}: not a setting (${TREND_KEYS.join(', ')})`);
  let replay = null;
  try { replay = read(raw.replay); } catch (err) { errors.push(`probe.trend.replay: ${err.message}`); }
  if (replay) {
    if (replay.stage !== 1) errors.push('probe.trend.replay.stage: 1 (learn to trade): whole sessions, as the keep rule\'s runs');
    for (const k of ['curatedList', 'practice', 'combine', 'accountStates']) if (replay[k] !== undefined) errors.push(`probe.trend.replay.${k}: not here (the trend set replays every bar of its sessions)`);
    if (replay.learning === false) errors.push('probe.trend.replay.learning: a probe is a practice-train learning run');
    if (parallel > 1 && replay.latency !== false) errors.push('probe.parallel: more than 1 only with probe.trend.replay.latency false too');
  }
  replay = sameTrader(replay, 'probe.trend.replay');
  let set = null;
  try { set = readSet(raw.set); } catch (err) { errors.push(`probe.trend.set: ${err.message}`); }
  const tuning = (Array.isArray(tuningWindows) ? tuningWindows : []).filter(x => x && DATE.test(x.from) && DATE.test(x.to));
  const checkDays = (days, key) => {
    for (const d of days) {
      const role = roleOf(d);
      if (role !== 'practice-train') errors.push(`${key} ${d}: probes run on practice-train only (this is ${role})`);
      const t = tuning.find(w => d >= w.from && d < w.to);
      if (t) errors.push(`${key} ${d}: inside the tuning window ${t.from}..${t.to}; the dates edits are found and screened on never judge them`);
    }
  };
  const setDays = set ? set.days.map(d => d.day) : [];
  checkDays(setDays, 'probe.trend.set');
  let regression = null;
  if (raw.regression !== undefined) {
    const days = raw.regression && Array.isArray(raw.regression.days) ? raw.regression.days : null;
    if (!days || !days.length || !days.every(d => DATE.test(String(d))) || Object.keys(raw.regression).some(k => k !== 'days')) errors.push('probe.trend.regression: { days: [YYYY-MM-DD, ...] }');
    else {
      checkDays(days, 'probe.trend.regression');
      const both = days.filter(d => setDays.includes(d));
      if (both.length) errors.push(`probe.trend.regression: ${both.join(', ')} also in the trend set: the regression days judge harm only, never a gain`);
      regression = { days: [...new Set(days)].sort() };
    }
  }
  const legs = set ? set.legs.map(l => l.id) : [];
  if (!(Number.isInteger(raw.batch) && raw.batch >= 1 && (!set || raw.batch <= legs.length))) errors.push(`probe.trend.batch: the legs a round draws, a whole number from 1 to the pool's ${set ? legs.length : 'legs'}`);
  if (!(typeof raw.half === 'number' && raw.half > 0 && raw.half < 1)) errors.push('probe.trend.half: the probe half\'s share of a batch, between 0 and 1 (the confirm half holds the rest)');
  return set ? { replay, set: { file: raw.set, fingerprint: set.fingerprint, days: setDays, legs }, batch: raw.batch, half: raw.half, regression } : null;
}

module.exports = { PROBE_KEYS, TREND_KEYS, PROBE_LIMITS, resolveProbe, overlaps };
