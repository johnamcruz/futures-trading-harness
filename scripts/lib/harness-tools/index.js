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

const strategies = require('./strategies');
const marketSnapshot = require('./market-snapshot');
const mtf = require('./mtf');
const blackouts = require('./blackouts');
const bars = require('./bars');
const combine = require('./combine');
const lessons = require('./lessons');
const reconcile = require('./reconcile');
const briefing = require('./briefing');
const reasons = require('./reasons');
const skills = require('./skills');

const OPERATIONS = {
  strategies_list: strategies.list,
  strategies_show: strategies.show,
  strategies_validate: strategies.validate,
  strategies_scan: strategies.scan,
  strategies_recent: strategies.recent,
  order_plan: strategies.plan,
  market_snapshot: marketSnapshot.snapshot,
  mtf: mtf.mtf,
  blackouts_list: blackouts.list,
  blackouts_add: blackouts.add,
  bars_fetch: bars.fetch,
  combine_status: combine.status,
  lessons: lessons.lessons,
  reconcile: reconcile.reconcile,
  bar_briefing: briefing.barBriefing,
  reason_check: reasons.check,
  skill_lookup: skills.skillLookup,
};

module.exports = { OPERATIONS };
