'use strict';

/**
 * The prompt-cache lifetime a harness run asks for, from how often that run comes back: its stable prefix (the system
 * prompt, its skills file) stays cached only if the next run of the same prefix comes before the entry expires.
 *
 *   A role runs once per close of its own timeframe (the analysts' `timeframe`, agents/<role>.md or the runner config's
 *   `agents` override: lanes.js agentTimeframes); every other run (the head trader, phase 2, the trade-executor) on the
 *   first lane's. A 3m run is back within 5 minutes, a 15m or 1h analyst's isn't.
 *
 *   ttlFor(minutes, ttls)        the shortest lifetime (config/runner.json prompt.cacheTtlMinutes: value -> minutes) that
 *                                lasts at least `minutes`, else the longest; null with none configured or no interval
 *   intervalOf(cfg, role, agents)   the run's interval in minutes: the role's timeframe (null role: the head trader's, the
 *                                first lane's); null when it can't be read
 *   ttlOfRun(cfg, role, agents)  ttlFor(intervalOf(...)) with the configured lifetimes
 *
 * Measurement and cost only: a longer lifetime costs more to write and nothing more to read; nothing decides by it.
 */

const TTLS = () => require('./tunables').runner().prompt.cacheTtlMinutes; // config/runner.json

function ttlFor(minutes, ttls = TTLS()) {
  if (!Number.isFinite(minutes) || minutes <= 0 || !ttls || typeof ttls !== 'object') return null;
  const all = Object.entries(ttls).filter(([k, v]) => typeof k === 'string' && k && Number.isFinite(v) && v > 0).sort((a, b) => a[1] - b[1]);
  if (!all.length) return null;
  const fits = all.find(([, v]) => v >= minutes);
  return (fits || all[all.length - 1])[0];
}

function intervalOf(cfg, role, agents) {
  const L = require('./lanes');
  try {
    if (!role) return L.lanesOf(cfg)[0].timeframe;
    const t = L.agentTimeframes(cfg, (agents || []).filter(a => a && a.name === role));
    return t.length ? L.tfMinutes(t[0].timeframe) : L.lanesOf(cfg)[0].timeframe;
  } catch (_err) {
    return null;
  }
}

const ttlOfRun = (cfg, role, agents, ttls = TTLS()) => ttlFor(intervalOf(cfg, role, agents), ttls);

module.exports = { ttlFor, intervalOf, ttlOfRun };
