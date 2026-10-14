'use strict';

/**
 * The exit plan an open position keeps when its strategy stops loading. The runner's trailing manager
 * (runner.js) manages a fill by its strategy's exit plan; a strategy that turns invalid while a position
 * is open (its account's rulebook edited into a refusal, say) refuses new entries, but the position it
 * opened still needs its trail. This remembers the last valid version of each strategy seen (in memory
 * and in <FTH_HOME>/exit-plans.json, so a restarted runner has it too) and gives it for exits only.
 *
 *   createExitMemory(file, { onError, onDrop })   { strategyFor(name, strategies, context) }
 *   strategyFor(name, strategies)     the strategy now when valid (remembered); else the last valid one
 *                                     remembered, marked { valid: false, remembered: true }, if its exit
 *                                     passes the strategy exit checks; an invalid one is cleared from the
 *                                     file, reported (onError, and onDrop({ strategy, reason, file, ...context }):
 *                                     context names the position), and null; else null
 */

const { readJson, writeJsonAtomic } = require('../harness-run');
const { exitErrors } = require('./strategies');

/** What an exit plan needs of a strategy (evaluator.exitPlan, the timeframe for a time stop). */
const kept = s => ({ name: s.name, timeframe: s.timeframe ?? null, risk: s.risk ?? null, exit: s.exit ?? null });

function createExitMemory(file, { onError = () => {}, onDrop = () => {} } = {}) {
  let mem = null;
  const load = () => {
    if (!mem) {
      const j = readJson(file, {});
      mem = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    }
    return mem;
  };
  return {
    strategyFor(name, strategies, context = {}) {
      const s = (strategies || []).find(x => x && x.name === name);
      if (s && s.valid) {
        const k = kept(s);
        const m = load();
        if (JSON.stringify(m[name]) !== JSON.stringify(k)) {
          m[name] = k;
          try { writeJsonAtomic(file, m); } catch (err) { onError(`could not remember ${name}'s exit plan: ${err.message}`); }
        }
        return s;
      }
      const r = Object.hasOwn(load(), name) ? load()[name] : null;
      if (!r || typeof r !== 'object') return null;
      // A remembered plan passes the same exit checks a strategy's does (a corrupted or hand-edited file
      // never reaches the trail): an invalid one is dropped with an alert, and the broker's stop stays.
      const why = [
        ...(r.exit === null || r.exit === undefined ? [] : exitErrors(r.exit)),
        ...(r.risk && typeof r.risk === 'object' && typeof r.risk.min_rr === 'number' && Number.isFinite(r.risk.min_rr) && r.risk.min_rr > 0 ? [] : ['risk.min_rr: a number above 0']),
        ...(r.timeframe === null || r.timeframe === undefined || typeof r.timeframe === 'string' ? [] : ['timeframe: text such as 3m']),
      ];
      if (why.length) {
        // Dropped, and cleared from the file so it isn't read again: the position goes on as one the runner
        // doesn't trail (its broker stop stays; end of day and the account's checks still apply).
        const reason = why.join('; ');
        delete load()[name];
        try { writeJsonAtomic(file, load()); } catch (err) { onError(`could not clear ${name}'s remembered exit plan: ${err.message}`); }
        onError(`${file}: the remembered exit plan for ${name} is invalid (${reason}); dropped: the position loses its trail and its time stop, and the broker's stop stays where it is`);
        try { onDrop({ strategy: name, reason, file, ...context }); } catch (_err) { /* best effort */ }
        return null;
      }
      return { name, timeframe: r.timeframe || undefined, risk: r.risk, ...(r.exit ? { exit: r.exit } : {}), valid: false, remembered: true };
    },
  };
}

module.exports = { createExitMemory };
