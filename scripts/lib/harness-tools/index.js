'use strict';

/**
 * The script operations the skills and agents tell an agent to run, by one
 * name each: what a harness-tools server can offer as tools. Each is
 * `(args, { env, now, root }) -> { text, stderr?, code? }` (cli.js), the same
 * function its CLI calls. bars_fetch is async.
 *
 * Not here, on purpose: combine start / stop / record-day (the user's: they
 * change the attempt the gate trades under).
 */

/**
 * Each module loads on its first call, not when the server starts: a module whose constants read a refused config
 * file (config/training.json, config/replay.json) throws the critical error from its call, so the harness tools
 * still load and list, and only the operation that needs the file reports it.
 */
const lazy = (file, name) => (...args) => require(`./${file}`)[name](...args);

const OPERATIONS = {
  strategies_list: lazy('strategies', 'list'),
  strategies_show: lazy('strategies', 'show'),
  strategies_validate: lazy('strategies', 'validate'),
  strategies_scan: lazy('strategies', 'scan'),
  strategies_recent: lazy('strategies', 'recent'),
  order_plan: lazy('strategies', 'plan'),
  market_snapshot: lazy('market-snapshot', 'snapshot'),
  mtf: lazy('mtf', 'mtf'),
  blackouts_list: lazy('blackouts', 'list'),
  blackouts_add: lazy('blackouts', 'add'),
  bars_fetch: lazy('bars', 'fetch'),
  combine_status: lazy('combine', 'status'),
  lessons: lazy('lessons', 'lessons'),
  reconcile: lazy('reconcile', 'reconcile'),
  bar_briefing: lazy('briefing', 'barBriefing'),
  reason_check: lazy('reasons', 'check'),
  skill_lookup: lazy('skills', 'skillLookup'),
  compose_check: lazy('compose', 'composeCheck'),
  experience_lookup: lazy('experience', 'experienceLookup'),
};

module.exports = { OPERATIONS };
