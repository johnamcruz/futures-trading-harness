'use strict';

/**
 * Prepare ahead's shadow log read back (docs/PREPARE-AHEAD.md, "Reading a shadow replay"): the cycle records' `prepare`
 * field (prepare-shadow.js: { shadow, made }) under a run home's logs/cycles/<day>/, summarized. Read only.
 *
 *   readRecords(home, { from, to })   every cycle record of the days from..to (YYYY-MM-DD, inclusive; none: all)
 *   report(records)                   { cycles, shadowed, status, voidBy, planned, rates: { void, outside, nothingFired },
 *                                       outsideByKind, agreement: { agree, disagree, unknown, rate }, confirms, confirmMs,
 *                                       made, skippedBy, prepareMs, aborted, tokens: { prepare, confirm },
 *                                       forbidden: { denied: { tool: n }, gateRefusals } }
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

function report(records) {
  const all = records || [];
  const p = all.map(r => (r && isObj(r.prepare) ? r.prepare : null)).filter(Boolean);
  const shadows = p.map(x => x.shadow).filter(isObj);
  const mades = p.map(x => x.made).filter(isObj);
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
    // The forbidden-tool attempts of every run: the CLI's denials by tool, and the gate's refusals in the shadow's log.
    forbidden: [...mades, ...confirmed.map(s => s.confirm)].reduce((f, r) => {
      for (const t of Array.isArray(r.denied) ? r.denied : []) f.denied[t] = (f.denied[t] || 0) + 1;
      f.gateRefusals += Number.isInteger(r.gateRefusals) ? r.gateRefusals : 0;
      return f;
    }, { denied: {}, gateRefusals: 0 }),
  };
}

const pct = x => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
const kv = o => Object.entries(o).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
const ms = s => `median ${s.median ?? 'n/a'}, p90 ${s.p90 ?? 'n/a'}, max ${s.max ?? 'n/a'} (n ${s.n})`;
const tok = t => `input ${t.input}, cache read ${t.cacheRead}, cache created ${t.cacheCreation}, output ${t.output}`;

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
    `forbidden tool attempts: denied ${kv(Object.fromEntries(Object.entries(r.forbidden.denied).sort()))}; gate refusals ${r.forbidden.gateRefusals}`,
    `tokens: prepare ${tok(r.tokens.prepare)}; confirm ${tok(r.tokens.confirm)}`,
  ].join('\n');
}

module.exports = { readRecords, report, text };
