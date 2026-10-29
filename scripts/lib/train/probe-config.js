'use strict';

/**
 * The training loop's `probe` setting (Propose-Probe-Compose, docs/TRAINING.md): with it, each iteration's proposals
 * come from the probe round (train/probe.js) instead of one proposer reply judged edit by edit.
 *
 *   probe {
 *     curriculum 'all' (the default: the curated windows and, with `trend`, the trend set) or 'trend' (the trend set
 *                only: curriculum.js; `trend` then required, `replay` and `windows` left out). A loop config's: a switch
 *                is a new loop (a new loopId)
 *     replay     a stage-1 replay config (an object or a path, as the loop's `replay`): a curated practice list and
 *                its practice settings; the probes' runs, the champion's and each edit's, use it with the loop's seed.
 *                Its `autotrader` is the loop's (left out: the loop's is used), so the probes and the keep rule run the
 *                same model and runner config
 *     windows    [{ from, to }] session dates, each inside practice-train: the curated moments the probes replay
 *                (split by session date into a probe half and a confirm half: screen.js halfOf)
 *     k          edits the proposer writes per round (1-8, default 4)
 *     trend      optional: { replay, census, from, to, batch, regression } (resolveTrend below): the census's legs, screened on
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
 *   resolveProbe(raw, { read, readCensus, modelScore, autotrader, tuningWindows })   the resolved setting, or null without one; throws
 *                                             with every error. autotrader: the loop's replay's, resolved. tuningWindows:
 *                                             the keep rule's; a probe window that shares a session date with one is
 *                                             refused (the dates edits are chosen on never judge them)
 *   overlaps(a, b)                            whether two { from, to } session-date windows (to exclusive) share a date
 */

const { rolesBetween } = require('../learning/splits');
const { tradingDayStart } = require('../trading/clock');

const PROBE_KEYS = Object.freeze(['replay', 'windows', 'k', 'parallel', 'trend', 'curriculum']);
const CU = require('./curriculum');
const TREND_KEYS = Object.freeze(['replay', 'census', 'from', 'to', 'batch', 'regression', 'moments']);
// The batch settings a loop config may set for itself (the rest, and every default: config/training.json trendBatch).
const BATCH_KEYS = Object.freeze(['start', 'max', 'half']);
// [default, min, max] of each (config/training.json probe).
const PROBE_LIMITS = Object.freeze(Object.fromEntries(Object.entries(require('../tunables').training().probe).map(([k, r]) => [k, Object.freeze([r.default, r.min, r.max])])));
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const sessionStart = d => tradingDayStart(new Date(`${d}T12:00:00Z`));
/** JSON with its object keys sorted: two configs equal whatever their key order. */
const canonical = x => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));

const overlaps = (a, b) => a.from < b.to && b.from < a.to;

function resolveProbe(raw, { read, resolvePath = p => p, readCensus = () => { throw new Error('no census reader'); }, modelScore = null, autotrader = null, tuningWindows = [] } = {}) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`probe: { ${PROBE_KEYS.join(', ')} }`);
  const errors = [];
  for (const k of Object.keys(raw)) if (!PROBE_KEYS.includes(k)) errors.push(`probe.${k}: not a setting (${PROBE_KEYS.join(', ')})`);
  if (!modelScore) errors.push('probe: the combined change goes through the full keep rule: set modelScore');
  const curriculum = raw.curriculum === undefined ? CU.DEFAULT : raw.curriculum;
  if (!CU.CURRICULA.includes(curriculum)) errors.push(`probe.curriculum: one of ${CU.CURRICULA.join(', ')} (default ${CU.DEFAULT})`);
  // The trend curriculum replays the trend set only: no curated replay or windows to set, and the trend set required.
  const trendOnly = curriculum === 'trend';
  if (trendOnly) {
    for (const k of ['replay', 'windows']) if (raw[k] !== undefined) errors.push(`probe.${k}: not read under curriculum trend (the round replays the trend set only): leave it out`);
    if (raw.trend === undefined) errors.push('probe.trend: curriculum trend replays the trend set: set it');
  }
  // Under curriculum trend no curated window: none to check (an empty list, so every reader of it reads none).
  const windows = trendOnly ? [] : raw.windows;
  if (!trendOnly && (!Array.isArray(windows) || !windows.length)) errors.push('probe.windows: one or more { from, to } session-date windows in practice-train');
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
  try { replay = trendOnly ? null : read(raw.replay); } catch (err) { errors.push(`probe.replay: ${err.message}`); }
  if (replay) {
    if (replay.stage !== 1) errors.push('probe.replay.stage: 1 (learn to trade): the probe screen reads stage-1 decisions');
    if (!replay.curatedList || typeof replay.curatedList !== 'object') errors.push('probe.replay.curatedList: the curated practice list the probes replay');
    if (replay.dayAttempts !== undefined) errors.push('probe.replay.dayAttempts: set by the loop for each run (replay/day-attempts.js), never in the config');
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
  const trend = raw.trend === undefined ? null : resolveTrend(raw.trend, { read, readCensus, resolvePath, tuningWindows, errors, sameTrader, parallel });
  if (errors.length) throw new Error(errors.join('\n- '));
  // 'all' (the default) adds no key: the resolved setting is the one before curricula existed.
  return { replay, windows, k, parallel, ...(trend ? { trend } : {}), ...(trendOnly ? { curriculum } : {}) };
}

/** A session date's learning role, or the error's message. */
const roleOf = d => {
  try { return rolesBetween(sessionStart(d), sessionStart(nextDate(d))).join(' + '); } catch (err) { return err.message; }
};
const nextDate = d => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().split('T')[0];

/**
 * probe.trend (trend-set.js, trend-screen.js): { replay, census, from, to, batch, regression }. replay: a stage-1 replay
 * config (no curated list, no practice, no combine or account states, no stepWindows: the loop sets each run's stepped
 * windows around its legs and the control windows, trend-windows.js; each bar of them as a whole session's, as live),
 * the loop's autotrader; its runs carry the loop's trend-set role (the training preflight's loop-role check). census: the trend-leg census file (learning/leg-census.js, scripts/
 * curated-lists.js census); from..to (session dates, to exclusive): the screen period its pool is read from, in
 * practice-train and sharing no session date with the tuning windows (a round's batch, its size and halves:
 * config/training.json trendBatch, trend-curve.js; batch: { start, max, half }, each optional, overrides those three for
 * this loop). regression: { days: [YYYY-MM-DD] } (the trend-move set's), harm only: in practice-train, outside the
 * tuning windows, and never in the pool (left out of it). moments (optional): the curated scan's moments file, for
 * the selection value on the confirm half (selection.js).
 */
function resolveTrend(raw, { read, readCensus, resolvePath = p => p, tuningWindows, errors, sameTrader, parallel }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`probe.trend: { ${TREND_KEYS.join(', ')} }`); return null; }
  for (const k of Object.keys(raw)) if (!TREND_KEYS.includes(k)) errors.push(`probe.trend.${k}: not a setting (${TREND_KEYS.join(', ')})`);
  let replay = null;
  try { replay = read(raw.replay); } catch (err) { errors.push(`probe.trend.replay: ${err.message}`); }
  if (replay) {
    if (replay.stage !== 1) errors.push('probe.trend.replay.stage: 1 (learn to trade): whole sessions, as the keep rule\'s runs');
    for (const k of ['curatedList', 'practice', 'combine', 'accountStates']) if (replay[k] !== undefined) errors.push(`probe.trend.replay.${k}: not here (the trend set replays the bars of its windows as a whole session would)`);
    if (replay.stepWindows !== undefined) errors.push('probe.trend.replay.stepWindows: set by the loop for each run (trend-windows.js), never in the config');
    if (replay.dayAttempts !== undefined) errors.push('probe.trend.replay.dayAttempts: set by the loop for each run (replay/day-attempts.js), never in the config');
    if (replay.learning === false) errors.push('probe.trend.replay.learning: a probe is a practice-train learning run');
    if (parallel > 1 && replay.latency !== false) errors.push('probe.parallel: more than 1 only with probe.trend.replay.latency false too');
  }
  replay = sameTrader(replay, 'probe.trend.replay');
  let census = null;
  try { census = readCensus(raw.census); } catch (err) { errors.push(`probe.trend.census: ${err.message}`); }
  const period = { from: raw.from, to: raw.to };
  if (!(DATE.test(String(period.from)) && DATE.test(String(period.to)) && period.from < period.to)) errors.push('probe.trend.from, to: the screen period the pool is read from (YYYY-MM-DD session dates, to exclusive)');
  const tuning = (Array.isArray(tuningWindows) ? tuningWindows : []).filter(x => x && DATE.test(x.from) && DATE.test(x.to));
  const checkDays = (days, key) => {
    for (const d of days) {
      const role = roleOf(d);
      if (role !== 'practice-train') errors.push(`${key} ${d}: probes run on practice-train only (this is ${role})`);
      const t = tuning.find(w => d >= w.from && d < w.to);
      if (t) errors.push(`${key} ${d}: inside the tuning window ${t.from}..${t.to}; the dates edits are found and screened on never judge them`);
    }
  };
  let regression = null;
  if (raw.regression !== undefined) {
    const days = raw.regression && Array.isArray(raw.regression.days) ? raw.regression.days : null;
    if (!days || !days.length || !days.every(d => DATE.test(String(d))) || Object.keys(raw.regression).some(k => k !== 'days')) errors.push('probe.trend.regression: { days: [YYYY-MM-DD, ...] }');
    else {
      checkDays(days, 'probe.trend.regression');
      regression = { days: [...new Set(days)].sort() };
    }
  }
  // The pool: the census's legs of the screen period, the regression days left out (they judge harm only, never a gain).
  let legs = [];
  if (census && !errors.some(e => e.startsWith('probe.trend.from'))) {
    try { legs = require('./trend-set').poolOf(census, { ...period, exclude: regression ? regression.days : [] }); } catch (err) { errors.push(`probe.trend.census: ${err.message}`); }
  }
  const setDays = [...new Set(legs.map(id => require('./trend-set').dayOfLeg(id)))].sort();
  checkDays(setDays, 'probe.trend.census');
  for (const t of tuning) if (DATE.test(String(period.from)) && overlaps(period, t)) errors.push(`probe.trend.from..to ${period.from}..${period.to}: shares session dates with the tuning window ${t.from}..${t.to}; the dates edits are found and screened on never judge them`);
  // A batch splits into the screen's two halves (screen.js HALVES): one leg each at the least.
  const halves = require('./screen').HALVES.length;
  if (census && legs.length < halves) errors.push(`probe.trend.census: ${legs.length} leg(s) in ${period.from}..${period.to}; a pool of two legs or more (a batch splits into two halves)`);
  const batch = { ...require('../tunables').training().trendBatch };
  if (raw.batch !== undefined) {
    if (!raw.batch || typeof raw.batch !== 'object' || Array.isArray(raw.batch)) errors.push(`probe.trend.batch: { ${BATCH_KEYS.join(', ')} } (each optional; config/training.json trendBatch otherwise)`);
    else {
      for (const k of Object.keys(raw.batch)) if (!BATCH_KEYS.includes(k)) errors.push(`probe.trend.batch.${k}: not a setting (${BATCH_KEYS.join(', ')})`);
      Object.assign(batch, raw.batch);
    }
  }
  if (!(Number.isInteger(batch.start) && batch.start >= halves)) errors.push('probe.trend.batch.start: a whole number of legs, two or more (a batch splits into two halves)');
  if (!(Number.isInteger(batch.max) && batch.max >= batch.start)) errors.push('probe.trend.batch.max: a whole number of legs, at least start');
  if (!(typeof batch.half === 'number' && batch.half > 0 && batch.half < 1)) errors.push('probe.trend.batch.half: the probe half\'s share of a batch, between 0 and 1 (the confirm half holds the rest)');
  if (raw.moments !== undefined && !(typeof raw.moments === 'string' && raw.moments)) errors.push('probe.trend.moments: the curated scan\'s moments file (curated-lists.js scan), for the selection value');
  const moments = typeof raw.moments === 'string' && raw.moments ? resolvePath(raw.moments) : null;
  // Every census leg of the pool's and the regression days (its day, side, start, end, points): the windows a trend run
  // steps around its legs and the control windows clear of every leg (trend-windows.js) are built from them.
  const spanDays = new Set([...setDays, ...(regression ? regression.days : [])]);
  // A regression day is stepped around its census legs only: one with none would never run, so it is refused.
  if (census && regression && Array.isArray(census.order)) {
    const withLegs = new Set(census.order.map(x => x.day));
    for (const d of regression.days.filter(x => !withLegs.has(x))) errors.push(`probe.trend.regression ${d}: the census holds no leg that day; a trend run steps windows around its legs, so it would never run: leave it out`);
  }
  const spans = census && Array.isArray(census.order) ? Object.fromEntries(census.order.filter(x => spanDays.has(x.day)).map(x => [x.id, { day: x.day, side: x.side, start: x.start, end: x.end, points: x.points }])) : {};
  return census ? { replay, ...(moments ? { moments } : {}), set: { file: raw.census, fingerprint: census.fingerprint, from: period.from, to: period.to, days: setDays, legs, spans }, batch, regression } : null;
}

module.exports = { PROBE_KEYS, TREND_KEYS, BATCH_KEYS, PROBE_LIMITS, resolveProbe, overlaps };
