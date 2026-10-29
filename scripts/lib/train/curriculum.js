'use strict';

/**
 * The probe round's curriculum (docs/TRAINING.md, "The trend curriculum"): the loop config's `probe.curriculum`.
 *
 *   all     (the default) the probe round replays the curated windows (probe.replay, probe.windows) and, with
 *           probe.trend, the trend set too: today's round
 *   trend   the probe round replays the trend set only (probe.trend: its legs' stepped windows, their control windows,
 *           and the regression days); no curated replay. The findings and the screens read the trend runs alone: the
 *           trend-blocker and exit findings as before, and the read findings from the trend runs' own decisions (their
 *           skill usage, scorecard and compose records), each kept only where the screen's targetScope reaches minPairs
 *
 * The keep rule (model-verifier.js, the loop's full tuning windows) is the same under both. A curriculum is a loop
 * config's: switching it is a new loop (a new loopId), never mid-loop.
 *
 * The round report's mastery read (the owner's pre-registered bar is text in docs/TRAINING.md, never code here): on a
 * side's confirm half, the legs caught, R caught / R available, the control windows' false starts, and two counts that
 * are not the same thing: keepRuleBlows, the keep rule's combine blows (model-verifier.js rule (a): the challenger's
 * real attempts and resampled paths over the tuning windows; only a combined change the keep rule judged has them), and
 * floorBreaches, the trend runs' own scorecard decisions at or past the account's floor (each run a fresh attempt a day:
 * never a combine). And the keep rule's combine pass rate (the challenger's real attempts that passed, pooled over the
 * keep rule's windows: its archive entry's model.windows[].challenger), when the keep rule judged it. The read prints the
 * measures; it decides nothing (the owner's bar is text in docs/TRAINING.md).
 * A false start: a trade that lost (R under 0) and whose best R (its peak) never rose above
 * config/training.json trendReport.falseStartPeakR. The control-window share: of the trades opened in control windows
 * (no leg there) the side stepped to their end, the false starts among those whose R and peak are known.
 *
 *   CURRICULA, DEFAULT
 *   curriculumOf(probe)                       the resolved probe setting's curriculum ('all' when it names none)
 *   readPart({ data, scorecard })             one trend run's read data: probeData's output and the run's scorecard,
 *                                             reduced ({ side: screen.js sideOf, usage, refusals })
 *   readSideOf(parts)                         one side's runs merged: { side, skills, refusals } (as the curated side's)
 *   falseStarts(exits, { controls, sessions, peakR })   { windows, entries, falseStarts, unknown, share }, or null when
 *                                             the side's exits are unknown (exits: probe.js exitsOf's, each with its unit)
 *   mastery({ ride, floorBreaches, keepRuleBlows, keepRulePass, controls })   { legs, caught, caughtShare, rCaught,
 *                                             rAvailable, rShare, rUnknown, controls, combinePass, keepRuleBlows, floorBreaches } (ride: trend-screen.js
 *                                             rideOfSide's; keepRuleBlows null when the keep rule did not judge it)
 *   keepRulePass(entry)                       { passed, attempts, rate, ess }: the challenger's combine attempts that
 *                                             passed, pooled over the keep rule's windows: every rolling start counts and
 *                                             neighbouring starts overlap, so ess (the windows' effective sample sizes summed,
 *                                             the independent starts; null when a window has none) stands beside it; null
 *                                             when a window has no attempts
 *   keepRuleBlows(entry)                      the challenger's blows over the keep rule's windows (its archive entry's
 *                                             model.windows[].blows.b, as rule (a) sums them), or null when it has none
 *   masteryText(m)                            one line of it
 */

const SC = require('./screen');
const F = require('./findings');

const DEFAULT = 'all';
const CURRICULA = Object.freeze([DEFAULT, 'trend']);

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round4 = x => Math.round(x * 10000) / 10000;

const curriculumOf = probe => (probe && probe.curriculum) || DEFAULT;

function readPart({ data, scorecard = [] }) {
  const d = data || {};
  return {
    side: SC.sideOf({ decisions: d.decisions || [], scorecard, usage: [], points: d.points || [] }),
    usage: d.usage || { skills: [] },
    refusals: F.refusalsOf(scorecard, d.records || []),
  };
}

function readSideOf(parts) {
  const list = (Array.isArray(parts) ? parts : []).filter(Boolean);
  const skills = F.mergeUsage(list.map(p => p.usage));
  const sides = list.map(p => p.side);
  return {
    side: {
      decisions: sides.flatMap(s => s.decisions || []),
      exitPlans: [...new Set(sides.flatMap(s => s.exitPlans || []))].sort(),
      scorecard: sides.flatMap(s => s.scorecard || []),
      usage: SC.sideOf({ usage: skills }).usage,
    },
    skills,
    refusals: list.flatMap(p => p.refusals || []),
  };
}

function falseStarts(exits, { controls = [], sessions = [], peakR }) {
  if (!Array.isArray(exits)) return null;
  if (num(peakR) === null) throw new Error('falseStarts: peakR (config/training.json trendReport.falseStartPeakR)');
  const done = new Set((Array.isArray(sessions) ? sessions : []).filter(s => s && s.complete).map(s => s.unit));
  const units = new Set((controls || []).filter(u => done.has(u)));
  const inControl = exits.filter(e => e && e.unit && units.has(e.unit));
  const known = inControl.filter(e => num(e.r) !== null && num(e.peakR) !== null);
  const fs = known.filter(e => e.r < 0 && e.peakR <= peakR);
  return { windows: units.size, entries: inControl.length, falseStarts: fs.length, unknown: inControl.length - known.length, share: known.length ? round4(fs.length / known.length) : null };
}

function keepRulePass(entry) {
  const ws = entry && entry.model && Array.isArray(entry.model.windows) ? entry.model.windows : [];
  const ok = c => c && Number.isInteger(c.attempts) && Number.isInteger(c.passed);
  if (!ws.length || !ws.every(w => w && ok(w.challenger))) return null;
  const passed = ws.reduce((s, w) => s + w.challenger.passed, 0);
  const attempts = ws.reduce((s, w) => s + w.challenger.attempts, 0);
  const ess = ws.every(w => Number.isInteger(w.challenger.ess)) ? ws.reduce((s, w) => s + w.challenger.ess, 0) : null;
  return { passed, attempts, rate: attempts ? round4(passed / attempts) : null, ess };
}

function keepRuleBlows(entry) {
  const ws = entry && entry.model && Array.isArray(entry.model.windows) ? entry.model.windows : [];
  if (!ws.length || !ws.every(w => w && w.blows && num(w.blows.b) !== null)) return null;
  return ws.reduce((s, w) => s + w.blows.b, 0);
}

function mastery({ ride = null, floorBreaches = null, keepRuleBlows: kb = null, keepRulePass: kp = null, controls = null } = {}) {
  const r = ride && typeof ride === 'object' ? ride : null;
  const rUnknown = r ? (r.rCaughtUnknown || 0) + (r.rAvailableUnknown || 0) : null;
  return {
    legs: r ? r.legs : null,
    caught: r ? r.caught : null,
    caughtShare: r ? num(r.catchRate) : null,
    rCaught: r ? num(r.rCaught) : null,
    rAvailable: r ? num(r.rAvailable) : null,
    rShare: r && num(r.rAvailable) && r.rAvailable > 0 && num(r.rCaught) !== null ? round4(r.rCaught / r.rAvailable) : null,
    rUnknown,
    controls: controls || null,
    combinePass: kp || null,
    keepRuleBlows: num(kb),
    floorBreaches: num(floorBreaches),
  };
}

const pct = x => (num(x) === null ? 'n/a' : `${round4(x * 100)}%`);

function masteryText(m) {
  if (!m) return 'n/a';
  const c = m.controls;
  const controls = c ? `${pct(c.share)} (${c.falseStarts} of ${c.entries - c.unknown} known trade(s), ${c.unknown} unknown, in ${c.windows} finished control window(s))` : 'n/a (exits unknown)';
  return `legs caught ${pct(m.caughtShare)} (${m.caught === null ? '?' : m.caught} of ${m.legs === null ? '?' : m.legs}), R caught / available ${pct(m.rShare)} (${m.rCaught === null ? '?' : m.rCaught} / ${m.rAvailable === null ? '?' : m.rAvailable}${m.rUnknown ? `, ${m.rUnknown} unknown` : ''}), control false starts ${controls}, combine pass rate ${m.combinePass ? `${pct(m.combinePass.rate)} (${m.combinePass.passed} of ${m.combinePass.attempts} rolling starts, ess ${m.combinePass.ess === null || m.combinePass.ess === undefined ? '?' : m.combinePass.ess} independent; the keep rule's)` : 'n/a (not judged by the keep rule)'}, keep rule's combine blows ${m.keepRuleBlows === null ? 'n/a (not judged by the keep rule)' : m.keepRuleBlows}, floor breaches in the trend runs ${m.floorBreaches === null ? '?' : m.floorBreaches}`;
}

module.exports = { CURRICULA, DEFAULT, curriculumOf, readPart, readSideOf, falseStarts, keepRulePass, keepRuleBlows, mastery, masteryText };
