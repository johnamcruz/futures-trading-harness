'use strict';

/**
 * The training loop's plan, the probe round's part (scripts/train-loop.js plan): nothing runs, nothing is written. The
 * probe replay and the trend replay are resolved as the loop's runs will resolve them (replay/config.js resolveReplay), so
 * a config the first run would refuse (a curated list whose windows miss the runner's sessions, a trend replay that
 * isn't one) fails here; and the trend pool is described (its period, legs, days, the round's batch and halves).
 *
 *   probePlan(loop, { root, env })   [line]; throws with every refusal, each naming the replay it came from
 */

const { resolveReplay } = require('../replay/config');
const { replayFor } = require('./config');
const TS = require('./trend-set');

function probePlan(loop, { root, env = process.env } = {}) {
  const p = loop.probe;
  if (!p) return [];
  const errors = [];
  const lines = [];
  const resolve = (replay, label, window) => resolveReplay(replayFor({ ...loop, replay }, { label, window }), { baseDir: root, env, root });
  for (const [i, w] of p.windows.entries()) {
    try {
      const run = resolve(p.replay, `plan-probe${i}`, w);
      lines.push(`probe replay ${w.from}..${w.to}: resolves (${run.curated ? `${run.curated.windows.length} curated window(s), list ${run.curated.list}` : 'no curated list'}, stage ${run.stage || 'none'})`);
    } catch (err) {
      errors.push(`probe.replay on ${w.from}..${w.to}: ${err.message}`);
    }
  }
  const t = p.trend;
  if (t) {
    const day = t.set.days[0];
    if (day) {
      try {
        resolve(t.replay, 'plan-trend', TS.dayWindows([day])[0]);
        lines.push(`trend replay: resolves on ${day} (stage ${t.replay.stage}; the loop sets each run's stepped windows)`);
      } catch (err) {
        errors.push(`probe.trend.replay on ${day}: ${err.message}`);
      }
    }
    const W = require('../tunables').training().trendWindows;
    const probeLegs = Math.round(t.batch.start * t.batch.half);
    lines.push(`trend pool: ${t.set.from}..${t.set.to}, ${t.set.legs.length} leg(s) on ${t.set.days.length} day(s) (census ${/^.{0,12}/.exec(String(t.set.fingerprint))[0]}); batch ${t.batch.start} leg(s) a round (about ${probeLegs} probe, ${t.batch.start - probeLegs} confirm), up to ${t.batch.max}; stepped around each leg (${W.leadBars} bar(s) before it through its catch window) and ${W.controlPerLeg} control window(s) a leg; regression ${t.regression ? t.regression.days.length : 0} day(s)`);
  }
  if (errors.length) throw new Error(`the probe round's replays are refused:\n- ${errors.join('\n- ')}`);
  return lines;
}

module.exports = { probePlan };
