'use strict';

/**
 * Prepare ahead's shadow log read back (docs/PREPARE-AHEAD.md, "Reading a shadow replay"): the cycle records' `prepare`
 * field (prepare-shadow.js: { shadow, made }) under a run home's logs/cycles/<day>/, summarized. Read only.
 *
 *   readRecords(home, { from, to })   every cycle record of the days from..to (YYYY-MM-DD, inclusive; none: all)
 *   report(records)                   { cycles, shadowed, status, voidBy, planned, rates: { void, outside, nothingFired },
 *                                       outsideByKind, agreement: { agree, disagree, unknown, rate }, confirms, confirmMs,
 *                                       made, skippedBy, prepareMs, aborted, tokens: { prepare, confirm },
 *                                       forbidden: { denied: { tool: n }, attempted: { tool: n }, gateRefusals },
 *                                       on: { closes, paths, shares, voidBy, confirms, confirmTurn: { ms, runMs, readsMs,
 *                                       to }, closeToOrder: { all, deskRan, deskCached, confirmed, fallback, byPath: { confirm |
 *                                       fallback:<path> | fallback:void:<reason> | fallback:confirm-<outcome>: { all, deskRan,
 *                                       deskCached } } }, phase2Ms: { confirm, fallback }, executorMs: { confirm, fallback },
 *                                       late, outsideByKind } | null }
 *   text(report)                      the report as lines
 */

const fs = require('fs');
const path = require('path');
const { stat } = require('./cycle-timing');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const count = (o, k) => { o[k] = (o[k] || 0) + 1; return o; };
const PLANNED = new Set(['valid', 'void', 'outside', 'nothing-fired']);

/** Every cycle record of the home's days from..to. */
function readRecords(home, { from = null, to = null } = {}) {
  const dir = path.join(home, 'logs', 'cycles');
  if (!fs.existsSync(dir)) return [];
  const days = fs.readdirSync(dir).filter(d => DAY.test(d) && (!from || d >= from) && (!to || d <= to)).sort();
  return days.flatMap(d => fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith('.json')).sort().map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, d, f), 'utf8')); } catch (_err) { return null; }
  }).filter(Boolean));
}

/** The time stat with its max (cycle-timing.js stat: nearest rank). */
const msOf = xs => ({ ...stat(xs), max: xs.length ? Math.max(...xs) : null });
const tokensOf = list => list.reduce((t, u) => {
  const x = isObj(u) && isObj(u.total) ? u.total : null;
  if (x) for (const k of ['input', 'cacheRead', 'cacheCreation', 'output']) t[k] += Number(x[k]) || 0;
  return t;
}, { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 });

/**
 * "on" (PR B2): each close's path (the confirm, or why the full head trader ran), the confirms' outcomes and fallbacks,
 * close to order (the cycle timing's latencyMs.order) of the closes that ordered, all, by whether the desk ran this close
 * or was served cached, and of the closes the confirm decided; the late refusals by kind; outside the plan by level kind.
 * PR A2: the confirm turn's own time (spawn to its compose's result, or its pass; of the confirms that decided), close to
 * order by path (the confirm, each fallback by its reason) each by desk ran or cached, and phase 2's and the executor's
 * runs on the confirm's closes and the fallbacks' apart. null when no record is an "on" one.
 */
function onReport(ons) {
  if (!ons.length) return null;
  const paths = {};
  const voidBy = {};
  const confirms = {};
  const late = {};
  const outsideByKind = {};
  for (const o of ons) {
    count(paths, o.path);
    if (o.path === 'void') count(voidBy, o.reason);
    if (isObj(o.confirm)) { count(confirms, o.confirm.outcome); if (o.confirm.fellBack) count(confirms, 'fellBack'); }
    for (const k of Array.isArray(o.late) ? o.late : []) count(late, k);
    if (o.path === 'outside') for (const [k, n] of Object.entries(o.unplannedKinds || {})) outsideByKind[k] = (outsideByKind[k] || 0) + n;
  }
  const ordered = ons.filter(o => Number.isFinite(o.closeToOrderMs));
  const ms = list => msOf(list.map(o => o.closeToOrderMs));
  const byDesk = list => ({ all: ms(list), deskRan: ms(list.filter(o => o.desk === 'ran')), deskCached: ms(list.filter(o => o.desk === 'cached')) });
  // The closes the confirm decided; every other one ran the full head trader (a fallback, by its reason).
  const decided = o => o.path === 'confirm' && !(isObj(o.confirm) && o.confirm.fellBack);
  const pathKey = o => (decided(o) ? 'confirm' : o.path === 'confirm' ? `fallback:confirm-${(o.confirm && o.confirm.outcome) || 'unknown'}` : o.path === 'void' ? `fallback:void:${o.reason || 'unknown'}` : `fallback:${o.path}`);
  const keys = [...new Set(ordered.map(pathKey))].sort();
  const turns = ons.filter(o => decided(o) && isObj(o.confirm));
  const finite = (list, f) => list.map(f).filter(Number.isFinite);
  const to = {};
  for (const o of turns) if (typeof o.confirm.turnTo === 'string') count(to, o.confirm.turnTo);
  const parts = k => ({ confirm: msOf(finite(ons.filter(decided), o => o[k])), fallback: msOf(finite(ons.filter(o => !decided(o)), o => o[k])) });
  return {
    closes: ons.length, paths, shares: Object.fromEntries(Object.entries(paths).map(([k, n]) => [k, n / ons.length])), voidBy, confirms,
    // The confirm turn's own time (spawn to its compose's result, or its pass), its run, the reads before its spawn.
    confirmTurn: { ms: msOf(finite(turns, o => o.confirm.turnMs)), runMs: msOf(finite(turns, o => o.confirm.runMs)), readsMs: msOf(finite(turns, o => o.confirm.readsMs)), to },
    closeToOrder: {
      ...byDesk(ordered), confirmed: ms(ordered.filter(decided)), fallback: byDesk(ordered.filter(o => !decided(o))),
      byPath: Object.fromEntries(keys.map(k => [k, byDesk(ordered.filter(o => pathKey(o) === k))])),
    },
    // Phase 2's and the executor's runs (the entry's timing), on the confirm's closes and the fallbacks' apart.
    phase2Ms: parts('phase2Ms'), executorMs: parts('executorMs'),
    late, outsideByKind,
  };
}

function report(records) {
  const all = records || [];
  const p = all.map(r => (r && isObj(r.prepare) ? r.prepare : null)).filter(Boolean);
  const shadows = p.map(x => x.shadow).filter(isObj);
  const mades = p.map(x => x.made).filter(isObj);
  const ons = p.map(x => x.on).filter(isObj);
  const status = {};
  const voidBy = {};
  const outsideByKind = {};
  for (const s of shadows) {
    count(status, s.status);
    if (s.status === 'void') count(voidBy, s.reason);
    if (s.status === 'outside') for (const [k, n] of Object.entries(s.unplannedKinds || {})) outsideByKind[k] = (outsideByKind[k] || 0) + n;
  }
  const planned = shadows.filter(s => PLANNED.has(s.status)).length;
  const rate = n => (planned ? n / planned : null);
  const confirmed = shadows.filter(s => isObj(s.confirm));
  const agree = confirmed.filter(s => s.agreesWithFull === true).length;
  const disagree = confirmed.filter(s => s.agreesWithFull === false).length;
  const made = {};
  const skippedBy = {};
  for (const m of mades) { count(made, m.outcome); if (m.outcome === 'skipped') count(skippedBy, m.why); }
  return {
    cycles: all.length, shadowed: p.length, status, voidBy, planned,
    rates: { void: rate(status.void || 0), outside: rate(status.outside || 0), nothingFired: rate(status['nothing-fired'] || 0) },
    outsideByKind,
    agreement: { agree, disagree, unknown: confirmed.length - agree - disagree, rate: agree + disagree ? agree / (agree + disagree) : null },
    confirms: confirmed.length,
    confirmMs: msOf(confirmed.map(s => s.confirm.ms).filter(Number.isFinite)),
    made, skippedBy,
    prepareMs: msOf(mades.filter(m => m.outcome === 'done' || m.outcome === 'aborted').map(m => m.ms).filter(Number.isFinite)),
    aborted: made.aborted || 0,
    tokens: { prepare: tokensOf(mades.map(m => m.usage)), confirm: tokensOf(confirmed.map(s => s.confirm.usage)) },
    // The hourly-close counterfactual: the plans void only by the 1h close, and of them those valid, and matched, without it.
    hourClose: shadows.filter(s => s.reason === 'htf-close:h1').reduce((h, s) => {
      h.void += 1;
      if (s.ifHourIgnored && s.ifHourIgnored.status === 'valid') { h.wouldBeValid += 1; if (s.ifHourIgnored.match === 'matched') h.wouldMatch += 1; }
      return h;
    }, { void: 0, wouldBeValid: 0, wouldMatch: 0 }),
    initMs: msOf([...mades, ...confirmed.map(s => s.confirm)].map(r => r.initMs).filter(Number.isFinite)),
    // The forbidden-tool attempts of every run: the CLI's denials by tool, every attempt from the run's own transcript (a
    // hook's refusal comes before the CLI's denial: prepare-ahead.js forbiddenIn), the gate's refusals in the shadow's log.
    forbidden: [...mades, ...confirmed.map(s => s.confirm)].reduce((f, r) => {
      for (const t of Array.isArray(r.denied) ? r.denied : []) f.denied[t] = (f.denied[t] || 0) + 1;
      for (const t of Array.isArray(r.forbidden) ? r.forbidden : []) f.attempted[t] = (f.attempted[t] || 0) + 1;
      f.gateRefusals += Number.isInteger(r.gateRefusals) ? r.gateRefusals : 0;
      return f;
    }, { denied: {}, attempted: {}, gateRefusals: 0 }),
    on: onReport(ons),
  };
}

const pct = x => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const kv = o => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
const ms = s => `median ${s.median ?? 'n/a'}, p90 ${s.p90 ?? 'n/a'}, max ${s.max ?? 'n/a'} (n ${s.n})`;
const tok = t => `input ${t.input}, cache read ${t.cacheRead}, cache created ${t.cacheCreation}, output ${t.output}`;

function onText(o) {
  if (!o) return [];
  return [
    `"on": ${o.closes} closes: ${Object.entries(o.paths).map(([k, n]) => `${k} ${n} (${pct(n / o.closes)})`).join(', ')}`,
    `"on" void by: ${kv(o.voidBy)}; confirms: ${kv(o.confirms)}`,
    `"on" close to order ms: ${ms(o.closeToOrder.all)}; desk ran: ${ms(o.closeToOrder.deskRan)}; desk cached: ${ms(o.closeToOrder.deskCached)}; confirmed: ${ms(o.closeToOrder.confirmed)}`,
    `"on" confirm turn ms (spawn to its compose's result, or its pass): ${ms(o.confirmTurn.ms)}; ended at: ${kv(o.confirmTurn.to)}; its run: ${ms(o.confirmTurn.runMs)}; the reads before it: ${ms(o.confirmTurn.readsMs)}`,
    `"on" close to order ms by path: ${Object.entries(o.closeToOrder.byPath).map(([k, s]) => `${k}: ${ms(s.all)} (desk ran: ${ms(s.deskRan)}; desk cached: ${ms(s.deskCached)})`).join('; ') || 'none'}`,
    `"on" phase 2 ms: confirm ${ms(o.phase2Ms.confirm)}; fallback ${ms(o.phase2Ms.fallback)}`,
    `"on" executor ms: confirm ${ms(o.executorMs.confirm)}; fallback ${ms(o.executorMs.fallback)}`,
    `"on" late refusals: ${kv(o.late)}; outside the plan by kind: ${kv(o.outsideByKind)}`,
  ];
}

function text(r) {
  const a = r.agreement;
  return [
    `Prepare ahead, shadow: ${r.shadowed} of ${r.cycles} cycle records`,
    `closes: ${kv(r.status)}`,
    `void ${r.status.void || 0} of ${r.planned} planned closes (${pct(r.rates.void)}): ${kv(r.voidBy)}`,
    `outside the plan ${r.status.outside || 0} (${pct(r.rates.outside)}): ${kv(r.outsideByKind)}`,
    `agreement with the full cycle: ${a.agree} of ${a.agree + a.disagree} (${pct(a.rate)}); no verdict ${a.unknown}`,
    `confirm ms: ${ms(r.confirmMs)}`,
    `prepares: ${kv(r.made)}; skipped: ${kv(r.skippedBy)}`,
    `prepare ms: ${ms(r.prepareMs)}`,
    `aborted at the deadline: ${r.aborted}`,
    `hourly closes: ${r.hourClose.void} void by the 1h close; without that rule ${r.hourClose.wouldBeValid} valid, ${r.hourClose.wouldMatch} matched`,
    `spawn to init ms: ${ms(r.initMs)}`,
    `forbidden tool attempts: denied ${kv(Object.fromEntries(Object.entries(r.forbidden.denied).sort()))}; gate refusals ${r.forbidden.gateRefusals}; attempted (transcripts) ${kv(Object.fromEntries(Object.entries(r.forbidden.attempted).sort()))}`,
    `tokens: prepare ${tok(r.tokens.prepare)}; confirm ${tok(r.tokens.confirm)}`,
    ...onText(r.on),
  ].join('\n');
}

module.exports = { readRecords, report, text };
