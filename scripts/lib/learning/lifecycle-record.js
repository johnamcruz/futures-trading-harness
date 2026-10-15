'use strict';

/**
 * The one adapter between the trade_lifecycle record (compose_check's append-only record, the composed-entry design,
 * section 3.3, "composed" read as trade_lifecycle) and the learning loop. Everything the loop reads from a record
 * goes through fromLifecycleRecord, so a change to the record's shape is one edit here.
 *
 * The record, as the design states it: the root, contract, side, bar (the briefing's asOf), at, expiresAt, the run
 * id and the lane; the context; each read with its step, skill, read, check and the model's why; the skill and read
 * signatures; the plan (entry reference, stop, target, size); exploratory; ok (verified) or the reasons it is not.
 * Read tolerantly: the plan's fields at the top level or under `plan`, the verification as `ok` or
 * `verification.ok`, the signatures as `signatures.{skill,read}`, `signature` (the read signature) or, when the
 * record has none, computed from the reads (section 3.8: steps in order, sorted within a step by skill then read,
 * prices dropped).
 *
 *   fromLifecycleRecord(raw, { runId })   the loop's view: { root, contract, side, bar, at, expiresAt, runId, lane, ok, reasons,
 *                               reads, signatures: { skill, read }, context, plan: { entry, stop, target, size },
 *                               exploratory } or null (not a record)
 *   recordsDir(home)            where the records live (<FTH_HOME>/trade-lifecycle)
 *   readRecords(home, { runId })   every record of every root, normalized, in time order
 *   skillSignature(reads), readSignature(reads)
 *   CONTEXT_KEYS                the six context keys (section 4.2, D17)
 */

const fs = require('fs');
const path = require('path');
const { parseRead } = require('../trading/composed-reads');

const STEPS = Object.freeze(['bias', 'location', 'setup', 'entry', 'stop', 'target']);
const CONTEXT_KEYS = Object.freeze(['regime', 'volatility', 'window', 'biasSide', 'alignment', 'dayType']);
const DIR = 'trade-lifecycle';
const MAX_BYTES = 64 * 1024 * 1024;

const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = x => (typeof x === 'string' && x.trim() ? x.trim() : null);
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
/** A plan price: a number (older lines), or the record's object ({ price } for stop and target; entry { price | limit | ref }). */
const price = x => (isObj(x) ? num(x.price ?? x.limit ?? x.ref) : num(x));
const iso = x => {
  const t = typeof x === 'number' ? x : Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** A read's form without prices (a stop is its source, not 21512.75), lower case, single-spaced. */
function readForm(read) {
  return String(read || '').toLowerCase().replace(/\s+\d+(?:\.\d+)?\b/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * A read's normalized form, prices dropped: the record's own `form` (the checker's), else the checker's parse of
 * the read (composed-reads.js parseRead: `15-min ...` and `60 min up` are `15m ...` and `1h up`), else the read.
 */
function formOf(r) {
  if (typeof r.form === 'string' && r.form.trim()) return readForm(r.form);
  let parsed = null;
  try { parsed = parseRead(String(r.read || '')); } catch (_err) { /* not a form */ }
  return readForm(parsed && parsed.form ? parsed.form : r.read);
}

const stepIndex = s =>(STEPS.includes(s) ? STEPS.indexOf(s) : STEPS.length);
const ordered = reads => reads.slice().sort((a, b) => stepIndex(a.step) - stepIndex(b.step) || String(a.step).localeCompare(String(b.step))
  || a.skill.localeCompare(b.skill) || formOf(a).localeCompare(formOf(b)));

/** Step -> skills (sorted within a step), steps in the fixed order: `bias:bos-vs-choch,daily-bias+location:...`. */
function skillSignature(reads) {
  const by = new Map();
  for (const r of ordered(reads)) {
    if (!by.has(r.step)) by.set(r.step, []);
    if (!by.get(r.step).includes(r.skill)) by.get(r.step).push(r.skill);
  }
  return [...by].map(([step, skills]) => `${step}:${skills.join(',')}`).join('+');
}

/** Step -> read form, prices dropped: `bias:1h-bos-up+entry:3m-close-top+...`. */
function readSignature(reads) {
  return ordered(reads).map(r => `${r.step}:${formOf(r).replace(/ /g, '-')}`).join('+');
}

/** The trend rule for the order's side as with or against (the briefing's words kept when neither). */
function sideOfTrend(v) {
  const s = str(v);
  if (!s) return null;
  if (/against|blocked|counter/i.test(s)) return 'against';
  if (/allow|with|aligned/i.test(s)) return 'with';
  return s.toLowerCase();
}

function contextOf(raw) {
  const c = isObj(raw.context) ? raw.context : {};
  const regime = isObj(c.regime) ? c.regime : {};
  const label = v => (str(v) ? str(v).toLowerCase() : null);
  return {
    regime: label(regime.primary ?? c.regime),
    volatility: label(regime.volatility ?? c.volatility),
    window: label(c.window ?? c.session),
    biasSide: sideOfTrend(c.biasSide ?? c.trendSide ?? c.trendRule),
    alignment: label(c.alignment),
    dayType: label(c.dayType),
  };
}

function readsOf(raw) {
  const list = Array.isArray(raw.reads) ? raw.reads : [];
  return list.filter(isObj).map(r => ({
    step: str(r.step) || 'unknown', skill: str(r.skill) || 'unknown', read: str(r.read) || '', form: formOf(r),
    why: str(r.why), check: typeof r.check === 'boolean' ? String(r.check) : str(r.check) || (r.ok === true ? 'true' : r.ok === false ? 'false' : null),
    agrees: typeof r.agrees === 'boolean' ? r.agrees : null,
  }));
}

/** The loop's view of one trade_lifecycle record, or null when it isn't one. */
function fromLifecycleRecord(raw, { runId = null } = {}) {
  if (!isObj(raw)) return null;
  const side = raw.side === 'long' || raw.side === 'short' ? raw.side : null;
  const root = str(raw.root) ? str(raw.root).toUpperCase() : null;
  const bar = iso(raw.bar ?? raw.asOf);
  if (!side || !root || !bar) return null;
  const reads = readsOf(raw);
  const plan = isObj(raw.plan) ? raw.plan : raw;
  const ver = isObj(raw.verification) ? raw.verification : raw;
  const sigs = isObj(raw.signatures) ? raw.signatures : {};
  return {
    root, contract: str(raw.contract), side, bar, at: iso(raw.at) || bar, expiresAt: iso(raw.expiresAt),
    runId: str(raw.runId) || runId, lane: raw.lane ?? null,
    ok: ver.ok === true, reasons: (Array.isArray(ver.reasons) ? ver.reasons : Array.isArray(ver.problems) ? ver.problems : []).map(String),
    reads,
    signatures: {
      skill: str(sigs.skill) || str(raw.skillSignature) || (reads.length ? skillSignature(reads) : null),
      read: str(sigs.read) || str(raw.signature) || str(raw.readSignature) || (reads.length ? readSignature(reads) : null),
    },
    context: contextOf(raw),
    plan: {
      entry: price(plan.entry ?? plan.entryReference), stop: price(plan.stop ?? plan.stopPrice), target: price(plan.target ?? plan.targetPrice),
      size: num(plan.size ?? plan.maxSize), rr: num(plan.rr),
    },
    exploratory: raw.exploratory === true,
  };
}

const recordsDir = home => path.join(home, DIR);

/** Every record under the home, normalized, oldest first (a line that isn't a record is skipped). */
function readRecords(home, { runId = null } = {}) {
  const dir = recordsDir(home);
  let names;
  try { names = fs.readdirSync(dir).filter(n => /^[A-Z0-9]{1,8}\.jsonl$/.test(n)).sort(); } catch (_err) { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    if (fs.statSync(file).size > MAX_BYTES) throw new Error(`${file}: over ${MAX_BYTES} bytes`);
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let raw;
      try { raw = JSON.parse(line); } catch (_err) { continue; }
      const r = fromLifecycleRecord(raw, { runId });
      if (r) out.push(r);
    }
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

module.exports = { STEPS, CONTEXT_KEYS, fromLifecycleRecord, recordsDir, readRecords, skillSignature, readSignature, readForm, formOf };
