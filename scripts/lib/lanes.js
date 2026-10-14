'use strict';

/**
 * The runner's timeframe lanes: one runner per account, each lane a bar size
 * with the strategies and policy strategies that trade it and what starts its
 * cycle. The runner config's optional `lanes`:
 *
 *   "lanes": [{ "timeframe": 3, "trigger": "bar", "policies": ["prop_portfolio"] },
 *             { "timeframe": 1, "trigger": "signal", "strategies": ["..."] }]
 *
 * Without `lanes`, the config's `timeframe` and `trigger` are its one lane, and
 * every strategy on that timeframe is in it (as before lanes existed).
 *
 *   parseLanes(cfg, raw)                 { lanes, errors }: the lanes, shape-checked (timeframes valid and unique)
 *   lanesOf(cfg)                         a validated config's lanes (the legacy one-lane form when it has none)
 *   laneStrategies(strategies, lane)     the strategies a lane scans: those on its timeframe, narrowed to its lists
 *                                        (a listed policy's own strategies stay in: their scan is its setups)
 *   lanePolicies(strategies, lane)       the lane's policy strategies
 *   laneStrategyErrors(lanes, strategies) every listed name exists, is of its list's kind, and is on its lane's timeframe
 *   signalLaneErrors(lanes, strategies)  a trigger "signal" lane with no mechanical strategy (only positions would cycle)
 *   describeLane(lane, strategies)       one line for the preflight report
 *
 * Each agent role may name its own timeframe: `timeframe` in its agents/<role>.md frontmatter (none: the first
 * lane's), and the runner config's `agents: { "<role>": { "timeframe": "15m" } }` overrides it. Only the analysts
 * (roles-ran ANALYSTS) read their own: each gets a bar briefing and bars of its timeframe (trading/briefing.js), and its
 * report is reused until its own next bar close (trading/report-cache.js). The risk manager, the executor and the
 * gate decide once per cycle on the cycle's bars, so any other role off the first lane's timeframe is refused.
 * An analyst's timeframe is a lane's, or whole bars of the first lane that divide the hour (built from its bars).
 *
 *   tfMinutes(tf)                        "15m" -> 15, "1h" -> 60, "1d" -> 1440; null when not a timeframe
 *   tfLabel(minutes)                     60 -> "1h", 15 -> "15m"
 *   agentOverrideErrors(agents)          the config's `agents` map: shape and timeframes
 *   agentErrors(cfg, agents)             each role named exists; each role's timeframe valid, and off the first lane's
 *                                        only for an analyst on a timeframe it can be given (frameError)
 *   agentTimeframes(cfg, agents)         [{ role, timeframe, from: 'config' | 'agent' | 'lane' }]
 *   frameError(minutes, lanes)           why an analyst can't read `minutes`-minute bars under these lanes, or null
 *   analystFrames(cfg, agents)           the analysts on a timeframe other than the first lane's:
 *                                        [{ role, minutes, lane }] (lane: the lane of that timeframe's index, or -1: built)
 *   omittedPolicyErrors(cfg, strategies, attemptRunning)  a lane's policies list leaving out a policy with a running attempt
 *   startErrors(cfg, strategies, agents, attemptRunning) every refusal the runner checks at start (lanes, signal lanes, agents)
 *
 * Several lanes cycle together (runner.js, lane-cycle.js): a bar clock per symbol and lane, and the lanes whose
 * bars closed on a pass go into one cycle. The first lane is the runner's own (its timeframe and trigger are the
 * config's): its bars feed the multi-timeframe record, the bar briefing and the trailing stops.
 */

const { onTimeframe, retiredNote } = require('./trading/strategies');
const { familyRoot } = require('./trading/contracts');
const { ANALYSTS } = require('./trading/roles-ran');

const LANE_KEYS = ['timeframe', 'trigger', 'strategies', 'policies'];
const TRIGGERS = ['bar', 'signal'];
const NAME = /^[a-z0-9][a-z0-9_-]*$/;

const TIMEFRAME = /^([1-9]\d*)(m|h|d)$/;

const tfOf = lane => `${lane.timeframe}m`;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nameList = v => Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'string' && NAME.test(n)) && new Set(v).size === v.length;

/**
 * The lanes of a runner config. `cfg` is the config with its defaults, `raw`
 * the file as written. Without `raw.lanes`: one lane from `timeframe` and
 * `trigger`. With it: each lane checked, and the first lane's timeframe and
 * trigger are the config's (a `timeframe` or `trigger` that disagrees is refused).
 */
function parseLanes(cfg, raw = {}) {
  const r = raw || {};
  if (r.lanes === undefined) return { lanes: [{ timeframe: cfg.timeframe, trigger: cfg.trigger, strategies: null, policies: null }], errors: [] };
  const errors = [];
  if (!Array.isArray(r.lanes) || r.lanes.length === 0) return { lanes: [], errors: ['lanes: a non-empty list of { timeframe, trigger, strategies?, policies? }'] };
  const lanes = [];
  r.lanes.forEach((l, i) => {
    const at = `lanes[${i}]`;
    if (!isObject(l)) {
      errors.push(`${at}: an object { timeframe, trigger, strategies?, policies? }`);
      return;
    }
    for (const k of Object.keys(l)) if (!LANE_KEYS.includes(k)) errors.push(`${at}: unknown key "${k}" (${LANE_KEYS.join(', ')})`);
    if (!(Number.isInteger(l.timeframe) && l.timeframe >= 1 && l.timeframe <= 60)) errors.push(`${at}.timeframe: minutes per bar, 1 to 60`);
    const trigger = l.trigger === undefined ? 'bar' : l.trigger;
    if (!TRIGGERS.includes(trigger)) errors.push(`${at}.trigger: "bar" or "signal"`);
    for (const k of ['strategies', 'policies']) {
      if (l[k] !== undefined && !nameList(l[k])) errors.push(`${at}.${k}: a non-empty list of strategy names, each once`);
    }
    lanes.push({ timeframe: l.timeframe, trigger, strategies: l.strategies === undefined ? null : l.strategies, policies: l.policies === undefined ? null : l.policies });
  });
  const tfs = lanes.map(l => l.timeframe).filter(t => Number.isInteger(t));
  const dup = tfs.find((t, i) => tfs.indexOf(t) !== i);
  if (dup !== undefined) errors.push(`lanes: timeframe ${dup} appears in more than one lane (one lane per timeframe)`);
  const names = lanes.flatMap(l => [...(Array.isArray(l.strategies) ? l.strategies : []), ...(Array.isArray(l.policies) ? l.policies : [])]);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) errors.push(`lanes: ${twice} is listed more than once (a strategy belongs to one lane, the one of its timeframe)`);
  // The cross-checks against the first lane, only when it parsed (else its own refusal says why).
  const first = isObject(r.lanes[0]) ? lanes[0] : null;
  if (first && 'timeframe' in r && r.timeframe !== first.timeframe) errors.push(`timeframe: with lanes, the first lane's timeframe (${first.timeframe}) is the runner's; leave timeframe out or set it equal`);
  if (first && 'trigger' in r && r.trigger !== first.trigger) errors.push(`trigger: with lanes, the first lane's trigger (${first.trigger}) is the runner's; leave trigger out or set it equal`);
  return { lanes, errors };
}

/** A validated config's lanes: its `lanes`, or the one lane its `timeframe` and `trigger` make. */
function lanesOf(cfg) {
  if (Array.isArray(cfg.lanes) && cfg.lanes.length) return cfg.lanes;
  return [{ timeframe: cfg.timeframe, trigger: cfg.trigger || 'bar', strategies: null, policies: null }];
}

/**
 * The strategies a lane scans, in registry order: those on its timeframe; with
 * `policies`, only those policy strategies; with `strategies`, only those
 * others, plus the strategies its policies trade (their scan results are the
 * policies' setups). A list left out takes every one of its kind.
 */
function laneStrategies(strategies, lane) {
  const on = onTimeframe(strategies, tfOf(lane));
  const policies = on.filter(s => s.signal === 'policy' && (!lane.policies || lane.policies.includes(s.name)));
  const traded = new Set(policies.flatMap(p => (Array.isArray(p.strategies) ? p.strategies : [])));
  return on.filter(s => (s.signal === 'policy' ? policies.includes(s) : !lane.strategies || lane.strategies.includes(s.name) || traded.has(s.name)));
}

const lanePolicies = (strategies, lane) => laneStrategies(strategies, lane).filter(s => s.signal === 'policy');

/** Every name a lane lists is a valid strategy of its list's kind on the lane's timeframe; else the refusals. */
function laneStrategyErrors(lanes, strategies) {
  const errors = [];
  lanes.forEach((lane, i) => {
    for (const k of ['strategies', 'policies']) {
      for (const n of lane[k] || []) {
        const s = strategies.find(x => x.name === n);
        const at = `lanes[${i}].${k}`;
        if (!s) errors.push(`${at}: no strategy named ${n}${retiredNote(n)}`);
        else if (!s.valid) errors.push(`${at}: ${n} is not valid (${(s.errors || []).join('; ') || 'see strategies_validate'})`);
        else if (k === 'policies' && s.signal !== 'policy') errors.push(`${at}: ${n} is signal: ${s.signal}, not a policy strategy (list it under strategies)`);
        else if (k === 'strategies' && s.signal === 'policy') errors.push(`${at}: ${n} is a policy strategy (list it under policies)`);
        else if (s.timeframe !== tfOf(lane)) errors.push(`${at}: ${n} trades ${s.timeframe} bars, not the ${tfOf(lane)} lane's (a strategy belongs to the lane of its timeframe)`);
      }
    }
  });
  return errors;
}

/** A trigger "signal" lane needs a mechanical strategy that isn't disabled: otherwise only open positions start its cycles. */
function signalLaneErrors(lanes, strategies) {
  return lanes.filter(l => l.trigger === 'signal')
    .filter(l => !laneStrategies(strategies, l).some(s => s.valid && s.status !== 'disabled' && s.signal !== 'manual'))
    .map(l => `trigger "signal" with timeframe ${l.timeframe}: no active mechanical strategy uses ${tfOf(l)}, so only open positions would ever start a cycle. Use trigger "bar" or a matching timeframe.`);
}

/**
 * A lane whose `policies` list leaves out a policy on its timeframe that can trade now (active, or any not disabled
 * in a paper run; on one of the runner's index families) and has an attempt running: that policy owns its
 * strategies' setups, so a lane without it would offer them as plain setups the gate refuses. Refused at start.
 * `attemptRunning(account)`: whether that prop account's attempt is started (prop-state readAttempt).
 */
function omittedPolicyErrors(cfg, strategies, attemptRunning = () => false) {
  const fams = new Set((cfg.symbols || []).map(familyRoot));
  const errors = [];
  lanesOf(cfg).forEach((lane, i) => {
    if (!lane.policies) return;
    for (const s of onTimeframe(strategies, tfOf(lane))) {
      if (!(s.valid && s.signal === 'policy') || lane.policies.includes(s.name)) continue;
      if (!(s.status === 'active' || (cfg.paper && s.status !== 'disabled'))) continue;
      if (!(s.instruments || []).some(x => fams.has(familyRoot(x))) || !attemptRunning(s.account)) continue;
      errors.push(`lanes[${i}].policies: leaves out ${s.name}, a policy on ${tfOf(lane)} with a running ${s.account} attempt: it owns its strategies' setups, which this lane would offer as plain setups the gate refuses. List ${s.name} in the lane, or stop its attempt`);
    }
  });
  return errors;
}

/** One line on a lane: its bar, trigger, and the strategies and policies it scans. */
function describeLane(lane, strategies) {
  const list = laneStrategies(strategies, lane).filter(s => s.valid && s.status !== 'disabled');
  const names = kind => list.filter(s => (kind === 'policy') === (s.signal === 'policy')).map(s => s.name);
  const show = a => (a.length ? a.join(', ') : 'none');
  return `${tfOf(lane)} bars, trigger ${lane.trigger}; strategies: ${show(names('rules'))}${lane.strategies ? ' (listed)' : ''}; policies: ${show(names('policy'))}${lane.policies ? ' (listed)' : ''}`;
}

/** A timeframe's name from its minutes: 60 -> "1h", 15 -> "15m" (as the config writes it). */
const tfLabel = m => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);

/** Minutes in a timeframe ("3m", "1h", "1d"); null when it is not one. */
function tfMinutes(tf) {
  const m = TIMEFRAME.exec(typeof tf === 'string' ? tf : '');
  return m ? Number(m[1]) * { m: 1, h: 60, d: 1440 }[m[2]] : null;
}

/** The runner config's `agents` overrides: a map of role -> { timeframe }, each a timeframe (the roles: agentErrors). */
function agentOverrideErrors(agents) {
  if (agents === undefined) return [];
  if (!isObject(agents)) return ['agents: a map of role -> { "timeframe": "15m" }'];
  const errors = [];
  for (const [role, o] of Object.entries(agents)) {
    const at = `agents.${role}`;
    if (!NAME.test(role)) errors.push(`agents: "${role}" is not a role name (agents/<role>.md)`);
    if (!isObject(o)) {
      errors.push(`${at}: an object { "timeframe": "15m" }`);
      continue;
    }
    for (const k of Object.keys(o)) if (k !== 'timeframe') errors.push(`${at}: unknown key "${k}" (timeframe)`);
    if (o.timeframe === undefined) continue;
    if (tfMinutes(o.timeframe) === null) errors.push(`${at}.timeframe: a timeframe such as "3m", "15m", "1h"`);
  }
  return errors;
}

/** Each role's timeframe: the config's override, else its agent file's, else the lane's. `agents`: harness-sync loadAgents. */
function agentTimeframes(cfg, agents) {
  const over = isObject(cfg.agents) ? cfg.agents : {};
  return agents.map(a => {
    const o = isObject(over[a.name]) && over[a.name].timeframe !== undefined ? over[a.name].timeframe : undefined;
    if (o !== undefined) return { role: a.name, timeframe: o, from: 'config' };
    if (a.timeframe !== undefined) return { role: a.name, timeframe: a.timeframe, from: 'agent' };
    return { role: a.name, timeframe: tfOf(lanesOf(cfg)[0]), from: 'lane' };
  });
}

/**
 * Why an analyst can't be given `minutes`-minute bars and a briefing on them, or null: a lane's timeframe (its bars),
 * or whole bars of the first lane that divide the hour (15m and 1h from 3m bars), built from the first lane's bars.
 */
function frameError(minutes, lanes) {
  if (lanes.some(l => l.timeframe === minutes)) return null;
  const first = lanes[0].timeframe;
  if (Number.isInteger(minutes) && minutes <= 60 && 60 % minutes === 0 && minutes % first === 0) return null;
  return `an analyst's timeframe is a lane's (${lanes.map(tfOf).join(', ')}) or whole ${first}m bars that divide the hour (built from the first lane's bars), not ${minutes}m`;
}

/** The roles the config names exist; every role's timeframe is valid, and off the first lane's only for an analyst that can read it. */
function agentErrors(cfg, agents) {
  const roles = new Set(agents.map(a => a.name));
  const errors = Object.keys(isObject(cfg.agents) ? cfg.agents : {}).filter(r => !roles.has(r))
    .map(r => `agents.${r}: no such role (agents/${r}.md; roles: ${[...roles].join(', ')})`);
  const lanes = lanesOf(cfg);
  const lane = lanes[0];
  for (const t of agentTimeframes(cfg, agents).filter(x => x.from !== 'lane')) {
    const at = t.from === 'config' ? `agents.${t.role}.timeframe` : `agents/${t.role}.md timeframe`;
    const m = tfMinutes(t.timeframe);
    if (m === null) errors.push(`${at}: a timeframe such as "3m", "15m", "1h" (got ${JSON.stringify(t.timeframe)})`);
    else if (m === lane.timeframe) continue;
    else if (!ANALYSTS.includes(t.role)) errors.push(`${at}: ${t.timeframe}, not the first lane's ${tfOf(lane)}: only the analysts (${ANALYSTS.join(', ')}) read their own timeframe; ${t.role} decides once per cycle on the cycle's bars (leave it unset)`);
    else if (frameError(m, lanes)) errors.push(`${at}: ${frameError(m, lanes)}`);
  }
  return errors;
}

/**
 * The analysts on a timeframe other than the first lane's (a valid one: the rest are refused at start), in role
 * order: [{ role, minutes, lane }], `lane` the index of the lane on that timeframe (its bars), or -1 (built from
 * the first lane's bars). None: every role reads the first lane's bars, as before.
 */
function analystFrames(cfg, agents) {
  const lanes = lanesOf(cfg);
  return agentTimeframes(cfg, agents).filter(t => ANALYSTS.includes(t.role)).map(t => ({ role: t.role, minutes: tfMinutes(t.timeframe) }))
    .filter(t => t.minutes !== null && t.minutes !== lanes[0].timeframe && !frameError(t.minutes, lanes))
    .map(t => ({ ...t, lane: lanes.findIndex(l => l.timeframe === t.minutes) }));
}

/** Every refusal the runner checks at start against the strategies and agent roles. */
const startErrors = (cfg, strategies, agents, attemptRunning = () => false) => [
  ...laneStrategyErrors(lanesOf(cfg), strategies), ...signalLaneErrors(lanesOf(cfg), strategies),
  ...omittedPolicyErrors(cfg, strategies, attemptRunning), ...agentErrors(cfg, agents),
];

module.exports = {
  LANE_KEYS, TRIGGERS, parseLanes, lanesOf, laneStrategies, lanePolicies, laneStrategyErrors, signalLaneErrors, describeLane,
  tfMinutes, tfLabel, agentOverrideErrors, agentErrors, agentTimeframes, frameError, analystFrames, omittedPolicyErrors, startErrors,
};
