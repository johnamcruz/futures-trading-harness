'use strict';

/**
 * P1, the MTF entry arm (config/runner.json mtfEntry): entries on the multi-timeframe structure read's ready candidates
 * (mtf-structure.js), the side the 1h STRUCTURE's (the record's parent side), never against it; the 4h is context only.
 * The one home of the arm's mode and of the check an MTF entry passes: compose_check (composed-reads.js) and the order
 * gate (lifecycle-gate.js, order-gate.js) both call readyOf on the cycle bar's briefing, so they refuse the same entry.
 * Pure but for replayRun (the harness clock: local state only). Every check fails closed: anything missing, unreadable,
 * stale, withheld or of another arm refuses.
 *
 *   ARMS             A: mtf_only on the intraday hierarchy (1h > 15m > 3m); B: mtf_only on the execution one (15m > 3m
 *                    > 1m, on the 1m data lane's bars); AB: both; D: today (no MTF entry)
 *   replayRun(env)   true only under a replay clock the harness accepts (harness-now.js replayAt): an MTF arm runs only
 *                    there until the owner opts in to live (the coordinator's decision, 2026-11-18)
 *   modeOf(cfg, env, { isReplay })   { arm, entryMode, hierarchies, exitMode, minStage, models, sideMode, mtf,
 *                    refused }: refused (a reason) for a bad block, or an MTF arm outside a replay; never read as today
 *   recordMode(mode)                 what a record carries
 *   candidatesOf(rec, mode)          { side1h, list, chosen: { long, short } }: each hierarchy's primary ready (stage,
 *                    trigger, rank in the 1h leg, stop, target, age, withheld); one per side, the earliest not withheld
 *                    (a tie: the intraday)
 *   readyOf({ briefing, side, mode, model })   { ok, problem, candidate, side1h, context }
 *   mtfOnlyMode(briefing)            the briefing's MTF record's mode in an mtf_only arm, else null (prepare-ahead
 *                    prepares none of today's setups then)
 *   entryModeProblems({ mtf, mode }) the mode's refusals of an entry that is (mtf) or is not an MTF one
 *   startProblems({ mode, minuteDataLane })   the runner's start refusals (lanes.js startErrors)
 *   sizeHint({ stopPts, tick, tickValue, capUsd, minContracts, stretchUsd, slipTicks, feePerSide })   the stop's points,
 *                    its all-in dollars a contract (size-translate.js allInRisk), the contracts the cap fits, the floor
 *   candidateLines(rec, mode, { level, sizing, price, bytes, at })   the briefing's candidate lines (at: the bar's close,
 *                    the turn's age)
 */

const { allInRisk } = require('../prop/size-translate');

const ARMS = Object.freeze({
  A: Object.freeze({ entryMode: 'mtf_only', hierarchies: Object.freeze(['intraday']) }),
  B: Object.freeze({ entryMode: 'mtf_only', hierarchies: Object.freeze(['execution']) }),
  AB: Object.freeze({ entryMode: 'mtf_only', hierarchies: Object.freeze(['intraday', 'execution']) }),
  D: Object.freeze({ entryMode: 'today', hierarchies: Object.freeze([]) }),
});
const EXIT_MODES = Object.freeze(['trail', 'prev_high_or_trail']);
const MIN_STAGES = Object.freeze(['established', 'developing', 'potential']);
const MODELS = Object.freeze(['aggressive', 'balanced', 'conservative']);
const SIDES = Object.freeze(['long', 'short']);
const TIMING = Object.freeze({ intraday: '3m', execution: '1m' });
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const wayOf = side => (side === 'long' ? 'up' : 'down');
const r2 = x => Math.round(x * 100) / 100;

function replayRun(env = process.env) {
  if (!env || !env.FTH_REPLAY_NOW) return false;
  try { return require('./harness-now').replayAt(env) !== null; } catch (_err) { return false; }
}

function modeOf(cfg, env = process.env, { isReplay = replayRun } = {}) {
  const bad = why => ({ arm: isObj(cfg) ? cfg.arm : null, entryMode: null, hierarchies: [], exitMode: null, minStage: null, sideMode: null, mtf: true, refused: `config/runner.json mtfEntry: ${why}; no entry (fails closed)` });
  if (!isObj(cfg)) return bad('missing');
  const arm = ARMS[cfg.arm];
  if (!arm || !Object.prototype.hasOwnProperty.call(ARMS, cfg.arm)) return bad(`arm ${JSON.stringify(cfg.arm)} is not one of ${Object.keys(ARMS).join(', ')}`);
  if (!EXIT_MODES.includes(cfg.exitMode)) return bad(`exitMode ${JSON.stringify(cfg.exitMode)} is not one of ${EXIT_MODES.join(', ')}`);
  if (!MIN_STAGES.includes(cfg.minStage)) return bad(`minStage ${JSON.stringify(cfg.minStage)} is not one of ${MIN_STAGES.join(', ')}`);
  // The owner's MTF spec: the entry models that may become candidates (no default model); the loader requires
  // the key, a caller without it means all three.
  const models = cfg.models === undefined ? [...MODELS] : cfg.models;
  if (!Array.isArray(models) || !models.length || !models.every(x => MODELS.includes(x)) || new Set(models).size !== models.length) return bad(`models ${JSON.stringify(cfg.models)} must list some of ${MODELS.join(', ')}, each once`);
  const mtf = arm.entryMode !== 'today';
  if (!mtf && (cfg.exitMode !== 'trail' || cfg.minStage !== 'established')) return bad('arm D (today) takes exitMode trail and minStage established');
  const out = { arm: cfg.arm, entryMode: arm.entryMode, hierarchies: [...arm.hierarchies], exitMode: cfg.exitMode, minStage: cfg.minStage, models: [...models], sideMode: mtf ? 'parent' : 'rule', mtf, refused: null };
  if (mtf && !isReplay(env)) out.refused = `MTF entry arm ${cfg.arm} runs only in a replay until the owner opts in (config/runner.json mtfEntry.arm); no entry`;
  return out;
}

/** Today's mode (arm D): what a caller that names no mode is judged under (the MTF reads refused). */
const TODAY = Object.freeze({ arm: 'D', entryMode: 'today', hierarchies: Object.freeze([]), exitMode: 'trail', minStage: 'established', models: Object.freeze([...MODELS]), sideMode: 'rule', mtf: false, refused: null });
const recordMode = mode => ({ arm: mode.arm, entryMode: mode.entryMode, hierarchies: [...mode.hierarchies], exitMode: mode.exitMode, minStage: mode.minStage });

const primaryOf = rec => (isObj(rec) && Array.isArray(rec.levels) ? rec.levels.find(l => isObj(l) && l.role === 'primary') || null : null);
const sameMode = (rec, mode) => isObj(rec) && isObj(rec.mode) && ['arm', 'entryMode', 'exitMode', 'minStage'].every(k => rec.mode[k] === mode[k]);
const ms = iso => (typeof iso === 'string' ? Date.parse(iso) : NaN);

/** One hierarchy's candidate from its record's primary (null when it holds no entry). */
function candidateFrom(lv, { hierarchy, leg1h, since, windowStart = null }) {
  if (!isObj(lv) || !isObj(lv.entry)) return null;
  const e = lv.entry;
  const i = isObj(lv.instance) ? lv.instance : null;
  let rank = i && Number.isInteger(i.rank) ? i.rank : null;
  let withheld = lv.entryWithheld || null;
  if (hierarchy === 'execution') {
    // Ranked in the 1h leg: its pullbacks (DEVELOPING) the pullback's way since the 1h leg's break.
    const at = leg1h && ms(leg1h.at);
    const way = i ? i.pullbackWay : null;
    const developed = i && i.developing;
    // A POTENTIAL (not developed yet): the rank it takes if it develops, the next one.
    const n = Number.isFinite(at) && way && Array.isArray(lv.pullbacks) ? lv.pullbacks.filter(p => p && p.way === way && ms(p.at) >= at).length : null;
    rank = n === null ? null : developed ? n || null : n + 1;
    // a 1h leg begun before the 1m window holds pullbacks this window never saw: the rank is unknown.
    if (!(ms(windowStart) <= at)) rank = null;
    if (!withheld && !(ms(e.since && e.since.at) > ms(since))) withheld = 'no 1m trigger since the previous close';
  }
  return {
    hierarchy, instanceId: i && i.openedAt && i.openedAt.at && e.since && e.since.at ? `${hierarchy}|${i.openedAt.at}|${e.since.at}|${e.model}` : null, timing: TIMING[hierarchy], side: e.side, model: e.model, stage: lv.stage, early: e.early || null,
    trigger: { kind: e.by || (e.model === 'aggressive' ? null : 'BOS'), frame: TIMING[hierarchy], at: e.since ? e.since.at : null, et: e.since ? e.since.et : null, price: Number.isFinite(e.triggerClose) ? e.triggerClose : null },
    rank, leg: hierarchy === 'execution' ? leg1h || null : (i && i.leg) || null, stop: e.stop,
    // instanceId (the coordinator's ruling: STABLE across cycles, so a WAIT carries): the hierarchy, the pullback instance's
    // opening time, the trigger's bar time and the model; the same candidate keeps it in every cycle it stays valid.
    // The context (mtf-context.js): its parent frame's turn and the impulse's quality; the pullback's structural depth (the
    // module's own: the retrace of the parent impulse and its class, config's bounds; the owner's spec, item 5).
    parentFrame: lv.frames ? lv.frames.parent : null, turn: lv.parent && lv.parent.turn ? lv.parent.turn : null,
    impulse: e.context ? e.context.impulse : null, depth: i && Number.isFinite(i.depth) ? i.depth : null, impulseExtreme: i && Number.isFinite(i.impulseExtreme) ? i.impulseExtreme : null, depthClass: i && typeof i.depthClass === 'string' ? i.depthClass : null, origin: e.origin, target: Number.isFinite(e.target) ? e.target : null, targetR: Number.isFinite(e.targetR) ? e.targetR : null,
    age: e.since ? { barsAgo: e.since.barsAgo, minAgo: e.since.minAgo, et: e.since.et } : null, withheld,
    maxRun: Number.isFinite(e.maxRun) ? e.maxRun : null,
  };
}

/**
 * The candidate's price facts at the bar's close `price` : its drift past the trigger's close in the
 * trigger's R (its close to its structural stop). The void is sticky: the largest drift over the closes since the trigger
 * (the record's maxRun) or now, past `voidDriftR` (config/analysis.json mtfStructure), voids it for good ("price ran NR
 * past the trigger"); a trigger older than `maxAgeMin` minutes is void; a trigger from an earlier session never carries
 * over (`at`, the bar's close). A drift that can't be read (no price, no trigger close, no maxRun) is void too: fails
 * closed. A new retest of the level is a new trigger (the record's): its own close, its own drift.
 */
function priceFacts(c, rec, price, { voidDriftR, maxAgeMin, at }) {
  const dir = c.side === 'long' ? 1 : -1;
  const unit = Number.isFinite(c.trigger.price) && Number.isFinite(c.stop) ? Math.abs(c.trigger.price - c.stop) : NaN;
  const fin = Number.isFinite(price);
  c.driftR = fin && unit > 0 ? r2((dir * (price - c.trigger.price)) / unit) : null;
  // No negative zero (a short exactly at its trigger prints 0R, not -0R).
  if (c.driftR === 0) c.driftR = 0;
  c.maxDriftR = c.driftR !== null && Number.isFinite(c.maxRun) ? Math.max(c.driftR, r2(c.maxRun / unit)) : null;
  if (c.withheld) return;
  const { sessionsBetween } = require('./mtf-context');
  if (at && !(sessionsBetween(c.trigger.at, at) === 0)) c.withheld = 'previous session';
  else if (c.maxDriftR === null) c.withheld = 'drift unknown';
  else if (c.maxDriftR > voidDriftR) c.withheld = 'ran past';
  else if (!(c.age && Number.isFinite(c.age.minAgo) && c.age.minAgo <= maxAgeMin)) c.withheld = 'too old';
}

function candidatesOf(rec, mode, { at = null, price = null } = {}) {
  const p = primaryOf(rec);
  const side1h = isObj(rec) && isObj(rec.sides) && SIDES.includes(rec.sides.parent) ? rec.sides.parent : null;
  const leg1h = p && isObj(p.parent) && isObj(p.parent.leg) ? p.parent.leg : null;
  const list = [];
  for (const h of mode.hierarchies || []) {
    if (h === 'intraday') { const c = candidateFrom(p, { hierarchy: h }); if (c) list.push(c); }
    if (h === 'execution' && isObj(rec) && isObj(rec.execution) && isObj(rec.execution.record)) {
      const c = candidateFrom(primaryOf(rec.execution.record), { hierarchy: h, leg1h, since: rec.execution.since, windowStart: rec.execution.record.windowStart });
      if (c) list.push(c);
    }
  }
  // The mode's entry models only (mtfEntry.models): a model not listed never becomes a candidate.
  if (Array.isArray(mode.models)) for (let k = list.length - 1; k >= 0; k -= 1) if (!mode.models.includes(list[k].model)) list.splice(k, 1);
  // The turn's age in sessions from the bar (`at`, the briefing's close): "fresh" only this or the previous session.
  const { sessionsBetween } = require('./mtf-context');
  for (const c of list) c.turnSessions = c.turn && c.turn.choch && at ? sessionsBetween(c.turn.choch.at, at) : null;
  const { voidDriftR, maxAgeMin } = require('../tunables').analysis().mtfStructure;
  for (const c of list) priceFacts(c, rec, price, { voidDriftR, maxAgeMin, at });
  const chosen = { long: null, short: null };
  for (const s of SIDES) {
    const ok = list.filter(c => c.side === s && !c.withheld && s === side1h);
    chosen[s] = ok.reduce((best, c) => (!best || ms(c.trigger.at) < ms(best.trigger.at) ? c : best), null);
  }
  return { side1h, list, chosen, context: isObj(rec) && isObj(rec.context) ? rec.context : null };
}

function readyOf({ briefing, side, mode, model, anyModel = false } = {}) {
  const no = problem => ({ ok: false, problem, candidate: null, side1h: null });
  if (!isObj(mode)) return no('no MTF entry mode (config/runner.json mtfEntry)');
  if (mode.refused) return no(mode.refused);
  if (!mode.mtf) return no(`not an MTF entry arm (arm ${mode.arm}, today)`);
  if (!SIDES.includes(side)) return no('the side must be long or short');
  const m3 = isObj(briefing) && isObj(briefing.sections) && isObj(briefing.sections.m3) && isObj(briefing.sections.m3.data) ? briefing.sections.m3.data : null;
  const rec = m3 ? m3.mtfStructure : null;
  if (!isObj(rec)) return no('the briefing holds no MTF structure record (m3.mtfStructure): no MTF entry');
  if (typeof rec.unavailable === 'string') return no(`MTF structure unavailable: ${rec.unavailable}`);
  if (!sameMode(rec, mode)) return no(`the briefing's MTF record was built under another entry arm (${isObj(rec.mode) ? JSON.stringify(rec.mode) : 'none'}), not arm ${mode.arm}'s: no MTF entry`);
  if (mode.hierarchies.includes('execution')) {
    if (!isObj(rec.execution)) return no(`arm ${mode.arm} needs its 1m execution record (the 1m data lane): no MTF entry`);
    if (typeof rec.execution.unavailable === 'string' && mode.hierarchies.length === 1) return no(`the 1m execution: unavailable (${rec.execution.unavailable})`);
  }
  // The bar's close: the drift past the trigger is read from it (a ready past voidDriftR is void); none: fails closed.
  if (!Number.isFinite(m3.price)) return no('the briefing holds no price (m3.price): the drift past the trigger is unknown; no MTF entry');
  // The bar's close time: a trigger from an earlier session never carries over; none: fails closed.
  if (!Number.isFinite(Date.parse(briefing.closedAt))) return no('the briefing holds no close time (closedAt): the trigger\'s session is unknown; no MTF entry');
  // a position open (the runner's held trade): no candidate is a pick.
  if (rec.positionOpen === true) return no('a position is open (the runner\'s held trade): no MTF candidate is a pick');
  const c = candidatesOf(rec, mode, { price: m3.price, at: briefing.closedAt });
  if (!c.side1h) return no('no 1h structure: no MTF entry');
  if (side !== c.side1h) return no(`against the 1h structure (${c.side1h} only): never against the 1h`);
  const pick = c.chosen[side];
  if (!pick) {
    const held = c.list.find(x => x.side === side && x.withheld);
    return no(held ? `the MTF candidate is withheld: ${held.withheld}` : `no ready MTF candidate the 1h's way (${side})`);
  }
  if (!anyModel && pick.model !== model) return no(`the ready candidate is ${pick.model}, not ${model}: read the candidate line`);
  return { ok: true, problem: null, candidate: pick, side1h: c.side1h, context: c.context };
}

/** The briefing's MTF record's mode when it is an mtf_only arm (A, B, AB: only MTF candidates are entries), else null. */
function mtfOnlyMode(briefing) {
  const m3 = isObj(briefing) && isObj(briefing.sections) && isObj(briefing.sections.m3) && isObj(briefing.sections.m3.data) ? briefing.sections.m3.data : null;
  const rec = m3 ? m3.mtfStructure : null;
  return isObj(rec) && isObj(rec.mode) && rec.mode.entryMode === 'mtf_only' ? rec.mode : null;
}

function entryModeProblems({ mtf, mode } = {}) {
  if (!isObj(mode)) return ['no MTF entry mode (config/runner.json mtfEntry): no entry'];
  if (mode.refused) return [mode.refused];
  if (mode.entryMode === 'today') return mtf ? [`the MTF entry reads are not in this entry mode (arm ${mode.arm}, today)`] : [];
  if (mode.entryMode === 'mtf_only' && !mtf) return [`entry mode mtf_only (arm ${mode.arm}): only an MTF ready entry (a true "mtf ready <model> long|short" setup read on the cycle bar), no other setup`];
  return [];
}

/** The intraday hierarchy's setup frame in minutes (config/analysis.json mtfStructure: [parent, setup, timing]). */
function setupMinutes() {
  const [, setup] = require('../tunables').analysis().mtfStructure.hierarchies.intraday;
  return setup;
}

/**
 * an MTF check's plan problems: the plan's stop must be the candidate's structural stop (its origin
 * plus the D3 buffer once), else [mtf-stop]; none for a check that holds no MTF candidate.
 */
function mtfPlanProblems(check, plan) {
  if (!isObj(check) || !isObj(check.mtf)) return [];
  const want = check.mtf.stop;
  const got = isObj(plan) && isObj(plan.stop) ? plan.stop.price : null;
  if (got === null || got === undefined) return [`[mtf-stop] no plan: the MTF candidate's structural stop ${want} can't be checked; no entry`];
  // Both on the tick (the plan's ticker, the module's onTick): equal to a millionth of a point.
  return Math.round(got * 1e6) === Math.round(want * 1e6) ? [] : [`[mtf-stop] the plan's stop ${got} is not the MTF candidate's structural stop ${want}; no entry`];
}

/** The runner's start refusals for the arm: an MTF arm outside a replay; the execution frame without a 1m data lane. */
function startProblems({ mode, minuteDataLane = false } = {}) {
  if (!isObj(mode) || !mode.mtf) return [];
  if (mode.refused) return [mode.refused];
  return mode.hierarchies.includes('execution') && !minuteDataLane ? [`MTF entry arm ${mode.arm} reads the 1m execution frame: add a 1m data lane to the runner config (lanes: { "timeframe": 1, "trigger": "data" }); no start without it`] : [];
}

function sizeHint({ stopPts, tick, tickValue, capUsd = null, minContracts = null, stretchUsd = null, slipTicks = 0, feePerSide = null } = {}) {
  const pts = r2(stopPts);
  if (!(tick > 0) || !(tickValue > 0)) return { ticks: null, perContract: null, fits: null, text: `${pts} pts (its dollars unknown: no contract specs)` };
  const ticks = Math.round(stopPts / tick);
  const per = allInRisk({ stopTicks: ticks, tickValue, slipTicks, feePerSide });
  if (!Number.isFinite(per)) return { ticks, perContract: null, fits: null, text: `${pts} pts, $${r2(ticks * tickValue)} a contract before slippage and fees` };
  const perContract = r2(per);
  const fits = capUsd > 0 ? Math.floor(capUsd / per + 1e-9) : null;
  let text = `${pts} pts, $${perContract} a contract all in`;
  if (fits !== null) {
    text += `; the $${capUsd} cap fits ${fits}`;
    if (Number.isInteger(minContracts) && fits < minContracts) {
      const floorUsd = r2(minContracts * per);
      text += `, under the floor of ${minContracts}: ${minContracts} = $${floorUsd}`;
      text += stretchUsd > 0 && floorUsd <= stretchUsd ? ` (the $${stretchUsd} floor stretch only while the attempt is healthy, else skip)` : stretchUsd > 0 ? `, over the $${stretchUsd} floor stretch: skip` : ': skip';
    }
  }
  return { ticks, perContract, fits, text };
}

/** What a model still needs on a hierarchy's primary, the side's way (the waiting clause), or null. */
function waitingOf(lv, timing, mode) {
  if (!isObj(lv) || lv.partial || !isObj(lv.parent)) return null;
  const w = lv.parent.way;
  const o = w === 'up' ? 'down' : 'up';
  const early = { potential: ['POTENTIAL', 'DEVELOPING'], developing: ['DEVELOPING'], established: [] }[mode.minStage] || [];
  if (lv.entry && lv.stage !== 'WEAKENING') return null; // ready (or void): its own line says so
  if (lv.stage === 'ESTABLISHED' || early.includes(lv.stage)) return `${timing} aggressive needs a ${timing} CHoCH or CISD ${w}`;
  if (lv.stage === 'WEAKENING') return `${timing} balanced needs a ${timing} BOS ${w}`;
  if (lv.stage === 'CONFIRMED REVERSAL') return `${timing} conservative needs a ${timing} CHoCH ${o} then a ${timing} BOS ${w}`;
  return null;
}

/** A withheld candidate, said plainly (it is void: never printed as a candidate). */
function voidText(x) {
  const w = {
    'stop traded': 'stop traded',
    warning: 'a close through the protected swing, until the parent frame closes',
    'no 1m trigger since the previous close': 'the 1m trigger fired before the previous close',
    'against the side': 'against the 1h structure',
    'no side': 'no 1h structure',
    'ran past': `price ran ${x.maxDriftR}R past the trigger`,
    'previous session': 'its trigger was in an earlier session',
    'too old': `its trigger ${x.age ? x.age.minAgo : '?'} min old, over the ${require('../tunables').analysis().mtfStructure.maxAgeMin}-minute cap`,
    'drift unknown': 'its drift past the trigger not known',
  }[x.withheld];
  return `${x.timing} ${x.model}: candidate void (${w || x.withheld})`;
}

/** The candidate line's cut levels, in order (the owner: cleanness goes first): full, no cleanness, the turn without its times. */
const LINE_CUTS = Object.freeze(['full', 'cleanness', 'turnTimes']);
const cutAt = (cut, name) => LINE_CUTS.indexOf(name) <= cut;

/** One ready candidate's line at a cut level (LINE_CUTS' index): the core (model, stage, trigger, its age and drift, the
 * rank, the structural stop and its size, the 4h) and the trend's context (the parent's turn, the impulse's strength). */
function candidateLine(x, c, mode, { level, sizing, price, cut, positionOpen }) {
  const MC = require('./mtf-context');
  const chosen = positionOpen ? ' (position open: not a pick)' : c.chosen[x.side] === x ? ' (chosen)' : '';
  const age = !x.age ? '' : x.age.barsAgo === 0 ? ' (new this bar)' : ` (${x.age.minAgo} min ago)`;
  const trig = `trigger ${x.trigger.frame} ${x.trigger.kind || 'break'} ${wayOf(x.side)} ${x.trigger.et}${age}; drift ${x.driftR}R past the trigger`;
  const t = x.turn;
  const fresh = MC.isFresh(t, x.turnSessions);
  const turn = !t ? 'turn not known' : cutAt(cut, 'turnTimes') ? (t.choch ? `${fresh ? 'fresh turn' : 'old turn'}, ${t.bosCount} BOS since` : `no turn, ${t.bosCount} BOS`) : MC.turnText(t, x.parentFrame || '1h', { sessionsAgo: x.turnSessions });
  const rank = Number.isInteger(x.rank) && x.leg ? `pullback #${x.rank} of this 1h leg` : 'its rank in the 1h leg not known';
  // The coordinator's ruling 2: depth as ROOM, never a forecast: the distances to the stop and to the impulse extreme.
  const room = Number.isFinite(price) && Number.isFinite(x.impulseExtreme) ? `: the stop ${r2(Math.abs(price - x.stop))} pts away, the impulse extreme ${r2(Math.abs(x.impulseExtreme - price))} pts away` : '';
  const depth = x.depth === null ? 'depth not known' : `depth ${Math.round(x.depth * 100)}% (${x.depthClass})${room}`;
  const ctx = `context: ${turn}; ${MC.impulseText(x.impulse, { cut: cutAt(cut, 'cleanness') ? 1 : 0 })}; ${rank}; ${depth}`;
  const pts = Number.isFinite(price) ? Math.abs(price - x.stop) : null;
  const size = pts === null ? '' : `: ${sizeHint({ stopPts: pts, ...(sizing || {}) }).text}`;
  // a previous high already behind the price is no exit target (the runner starts none for it).
  const behind = x.target !== null && Number.isFinite(price) && (x.side === 'long' ? 1 : -1) * (x.target - price) <= 0;
  const tgt = mode.exitMode === 'prev_high_or_trail' && x.target !== null ? `; previous ${x.side === 'long' ? 'high' : 'low'} ${level(x.target)} ${behind ? 'already past (no exit target: the trail)' : `(the exit target), ${x.targetR === null ? 'its R unknown' : `${x.targetR}R${x.targetR < 1 ? ' (under 1R)' : ''}`}`}` : '';
  const four = c.context && c.context.frame ? `; ${c.context.frame} structure ${c.context.way ? c.context.way.toUpperCase() : 'none yet'} (context)` : '';
  return `- MTF candidate ${x.side.toUpperCase()}${chosen}: ${x.model} at stage ${x.stage}${x.early ? ' (early)' : ''}, ${trig}; ${ctx}; structural stop ${level(x.stop)}${size}${tgt}${four}.`;
}

/**
 * The briefing's candidate lines: one per READY candidate the 1h's way (never a withheld or waiting one: a model's name
 * never reads as an offer it isn't), each within `bytes` (mtfStructure.candidateBytes; cut: cleanness first, then the
 * turn's times); none ready: one line saying so, with each void candidate's reason plainly; then one waiting clause.
 */
function candidateLines(rec, mode, { level = x => x, sizing = null, price = null, bytes = Infinity, at = null, positionOpen = false } = {}) {
  const c = candidatesOf(rec, mode, { at, price });
  if (!c.side1h) return ['- MTF candidate: none (no 1h structure: no MTF entry).'];
  const mine = c.list.filter(x => x.side === c.side1h);
  const ready = mine.filter(x => !x.withheld);
  const out = ready.map(x => {
    let line = '';
    for (let cut = 0; cut < LINE_CUTS.length; cut += 1) { line = candidateLine(x, c, mode, { level, sizing, price, cut, positionOpen }); if (Buffer.byteLength(line) <= bytes) break; }
    return line;
  });
  if (!ready.length) {
    const voided = mine.filter(x => x.withheld).map(voidText);
    out.push(`- MTF candidate: none ready the 1h's way (${c.side1h.toUpperCase()})${voided.length ? `; ${voided.join('; ')}` : ''}.`);
  }
  const waits = [];
  const p = primaryOf(rec);
  const way1h = c.side1h === 'long' ? 'up' : 'down';
  if ((mode.hierarchies || []).includes('intraday') && p && p.parent && p.parent.way === way1h) waits.push(waitingOf(p, TIMING.intraday, mode));
  const ex = isObj(rec.execution) && isObj(rec.execution.record) ? primaryOf(rec.execution.record) : null;
  if ((mode.hierarchies || []).includes('execution') && ex && ex.parent && ex.parent.way === way1h) waits.push(waitingOf(ex, TIMING.execution, mode));
  const w = waits.filter(Boolean);
  if (w.length) out.push(`- MTF waiting: ${w.join('; ')}.`);
  return out;
}

/**
 * The reading audit (E1): in an MTF arm today's trend rule refuses no MTF candidate (the gate exempts a verified MTF entry
 * from [mtf-trend]; the candidate's side is the 1h structure's), so its printed refusal clause is dropped there; arm D: as is.
 *   mtfTrendRuleText(text)   "LONG allowed (prevailing 4h up); no short against it." -> "LONG allowed (prevailing 4h up)."
 *   mtfBiasText(line)        "Bias: long only (4h up, 1h up; short refused)" -> "Bias: long only (4h up, 1h up)"
 */
const mtfTrendRuleText = text => String(text).replace(/; no (long|short) against it(\.?)$/, '$2');
const mtfBiasText = line => String(line).replace(/; (long|short) refused\)/, ')');

module.exports = { mtfTrendRuleText, mtfBiasText, mtfOnlyMode, mtfPlanProblems, setupMinutes, startProblems, TODAY, ARMS, replayRun, modeOf, recordMode, candidatesOf, readyOf, entryModeProblems, sizeHint, candidateLines };
