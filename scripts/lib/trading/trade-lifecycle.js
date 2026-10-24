'use strict';

/**
 * The trade lifecycle's record (the trade-lifecycle design: its record and plan): what compose_check
 * (harness-tools/compose.js) works out from the model's checked reads (composed-reads.js) and appends, one line per
 * call, to <FTH_HOME>/trade-lifecycle/<ROOT>/<day>.jsonl: one shard per family and trading day, the day the session
 * date (clock.js tradingDayKey, the 18:00 ET rollover) of the record's bar (its `at` when it has no bar). Keyed on
 * the bar, never the wall clock: a record composed on the 17:57 bar is in that bar's day however late it was
 * written, and the gate, which looks a record up by its cycle bar, reads that one shard. Append-only, never in the
 * repository, never read back as a verdict: the order gate (PR C) re-runs the checker on a record's reads against
 * the cycle bar's briefing and never trusts its `ok`.
 *
 * An older home's single file (<FTH_HOME>/trade-lifecycle/<ROOT>.jsonl, before the shards) is still read, never
 * written: a day's read takes its records of that day, a full read all of them. A file over MAX_BYTES, or one that
 * exists and can't be read, throws (never read as no records): the gate refuses the entry on it. An older file over
 * MAX_BYTES (the run that outgrew it) refuses every composed entry in that home, saying so: continue in a new home.
 *
 * The plan, in code, never the model's arithmetic:
 *   entry    a limit at the reference price (the briefing's last close), valid until the record expires (expiresAt:
 *            `validBars` base bars after its bar's close, the strategy's valid_bars: expiryOf)
 *   stop     the verified invalidation level with D3's buffer: the strategy's risk.stop_buffer_ticks beyond it, on the
 *            tick (a long's below, a short's above). Stop ticks = ceil(|entry - stop| / tick). D13's floor: at least
 *            max(risk.stop_floor_ticks, risk.stop_floor_atr x ATR(20) of the base bars, half the briefing's 0.5 x
 *            ATR(20) reference stop); a closer stop is refused, never widened (a wider stop would not be the level the
 *            model named). The three numbers' one home is the strategy's STRATEGY.md (stopRuleOf); none: no plan
 *   target   the verified level, floored toward the entry on the tick
 *   R:R      target ticks over stop ticks, at least the strategy's risk.min_rr
 *   size     the model's stated size (contracts, from the sizing skills); its dollar risk at most the strategy's
 *            risk.max_risk_usd (required); maxSize the most that cap allows
 *   inTheWay the first level between the entry and the target (m3.nearestLiquidity) and its R
 *
 *   recordFile(home, root, day)                  a root family's shard for a trading day (MNQ and NQ share one)
 *   legacyFile(home, root)                       the family's single file from before the shards (read only)
 *   shardDay(record), dayOf(time)                the trading day a record's shard is, of a time; null when undated
 *   daysNear(time)                               the trading days before, of and after a time (the shards a record
 *                                                live at that time can be in)
 *   planOf({ checked, briefing, side, size, tick, tickValue, minRR, maxRiskUsd, stopRule, suggestion })   { plan, problems }
 *                                                (suggestion: a prop attempt's size, never refused over the cap)
 *   stopRuleOf(risk)                             { bufferTicks, floorTicks, floorAtr } from a strategy's risk, or null
 *   stopFloorTicks(briefing, tick, stopRule)     D13's floor in ticks, or null when ATR(20) is unknown
 *   expiryOf(briefing, validBars)                when a record on the briefing's bar expires (ms): `validBars` base bars
 *                                                after its close (m3.validUntil, the next close, plus validBars - 1 bars);
 *                                                the next close when the bar's minutes can't be read; NaN without one
 *   buildRecord({ ... })                         the record (schema: RECORD_KEYS)
 *   appendRecord(home, record)                   to the record's day shard
 *   readRecords(home, root, { days })            the records of a root's family (every family: root null), oldest
 *                                                first; `days`: only those days' shards (and the old file's records
 *                                                of those days); throws on a file that can't be read
 *   renderRecord(record, checked, hints)         the record as text, for the model (hints: a refusal's compose-hints.js
 *                                                lines, shown only when the record is not OK)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { familyRoot } = require('./contracts');
const { tradingDayKey, tradingDayStart } = require('./clock');
const { renderCheck } = require('./composed-reads');

const STRATEGY = 'trade_lifecycle';
const SCHEMA = 1;
// config/runner.json `lifecycle` (the size cap only falls). The stop's buffer (D3) and floor (D13) are the strategy's
// own: its STRATEGY.md risk (stopRuleOf).
const MAX_SIZE = require('../tunables').runner().lifecycle.maxSize;
const DIR = 'trade-lifecycle';
// A file (a day's shard, or an older home's single file) larger than this throws.
const MAX_BYTES = require('../tunables').runner().limits.lifecycleBytes;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FAMILY = /^[A-Z0-9]{1,8}$/;
// lane: the bars the reads were checked on (the briefing's base timeframe); contract: the briefing's contract;
// exploratory: false until practice exploration (the learning loop's) is built.
const RECORD_KEYS = ['schema', 'id', 'at', 'strategy', 'root', 'symbol', 'contract', 'lane', 'side', 'bar', 'expiresAt', 'cycleId', 'exploratory', 'ok', 'problems', 'reads', 'signature', 'skillSignature', 'context', 'plan'];

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round2 = x => Math.round(x * 100) / 100;

const familyDir = (home, root) => path.join(home, DIR, familyRoot(root));
const legacyFile = (home, root) => path.join(home, DIR, `${familyRoot(root)}.jsonl`);
function recordFile(home, root, day) {
  if (!DAY.test(String(day))) throw new Error(`not a trading day: ${JSON.stringify(day)}`);
  return path.join(familyDir(home, root), `${day}.jsonl`);
}

const msOf = time => (typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : time instanceof Date ? time.getTime() : NaN);

/** The trading day (session date, 18:00 ET rollover) of a time, or null when it isn't one. */
function dayOf(time) {
  const t = msOf(time);
  return Number.isFinite(t) ? tradingDayKey(new Date(t)) : null;
}

/** The day a record's shard is: its bar's (the briefing it was checked on), else its `at`'s; null when neither. */
const shardDay = record => (isObj(record) ? dayOf(record.bar) || dayOf(record.at) : null);

/** The trading days before, of and after `time` (a record live at `time` has its bar in one of them). */
function daysNear(time) {
  const t = msOf(time);
  if (!Number.isFinite(t)) return [];
  const start = tradingDayStart(new Date(t)).getTime();
  // A trading day is 23 to 25 hours: 30 hours after its start is in the next one.
  return [...new Set([dayOf(start - 1), dayOf(t), dayOf(start + 30 * 3600000)])];
}

/** Prices on the tick: k ticks, as the tick's own decimals hold it. */
function ticker(tick) {
  const decimals = Math.max(0, (String(tick).split('.')[1] || '').length);
  const at = k => Number((k * tick).toFixed(decimals));
  return { at, down: x => at(Math.floor(x / tick + 1e-9)), up: x => at(Math.ceil(x / tick - 1e-9)) };
}

/**
 * A strategy's stop rule from its STRATEGY.md risk (the numbers' one home; strategies.js requires them for signal:
 * composed): { bufferTicks (D3), floorTicks, floorAtr (D13) }, or null when one is missing or malformed.
 */
function stopRuleOf(risk) {
  const r = isObj(risk) ? risk : {};
  const ok = Number.isInteger(r.stop_buffer_ticks) && r.stop_buffer_ticks >= 0 && Number.isInteger(r.stop_floor_ticks) && r.stop_floor_ticks >= 1
    && num(r.stop_floor_atr) !== null && r.stop_floor_atr >= 0;
  return ok ? Object.freeze({ bufferTicks: r.stop_buffer_ticks, floorTicks: r.stop_floor_ticks, floorAtr: r.stop_floor_atr }) : null;
}

/**
 * D13's floor in ticks: max(floorTicks, floorAtr x ATR(20)) (ATR(20) = twice the briefing's reference stop); null when
 * ATR(20) or the stop rule is unknown.
 */
function stopFloorTicks(b, tick, rule) {
  const m3 = isObj(b) && isObj(b.sections) && isObj(b.sections.m3) ? b.sections.m3.data : null;
  const half = m3 && isObj(m3.referenceStop) ? num(m3.referenceStop.distance) : null;
  if (!(half > 0) || !(tick > 0) || !isObj(rule)) return null;
  return Math.max(rule.floorTicks, Math.ceil((rule.floorAtr * 2 * half) / tick - 1e-9));
}

/** When a record on this bar expires (ms): `validBars` (a whole number, 1 or more; else 1) base bars after its close. */
function expiryOf(b, validBars = 1) {
  const m3 = isObj(b) && isObj(b.sections) && isObj(b.sections.m3) ? b.sections.m3 : null;
  const next = m3 ? Date.parse(m3.validUntil) : NaN;
  const n = Number.isInteger(validBars) && validBars >= 1 ? validBars : 1;
  const step = Number.isInteger(b && b.minutes) && b.minutes > 0 ? b.minutes * 60000 : null;
  return step === null ? next : next + (n - 1) * step;
}

/** The plan from the checked reads: { plan, problems } (plan null when it can't be worked out). */
function planOf({ checked, briefing, side, size, tick, tickValue, minRR = null, maxRiskUsd = null, stopRule = null, suggestion = false }) {
  const problems = [];
  if (!(tick > 0) || !(tickValue > 0)) return { plan: null, problems: ['the contract\'s tick size and value are unknown'] };
  const rule = isObj(stopRule) ? stopRule : null;
  if (!rule) return { plan: null, problems: [`the ${STRATEGY} strategy states no whole stop rule (risk.stop_buffer_ticks, risk.stop_floor_ticks, risk.stop_floor_atr)`] };
  const buffer = rule.bufferTicks;
  const ref = checked ? num(checked.reference) : null;
  if (ref === null) return { plan: null, problems: ['no reference price (no bar briefing)'] };
  if (!checked.stop || !checked.target) return { plan: null, problems: ['no verified stop and target read'] };
  const t = ticker(tick);
  const long = side === 'long';
  const stopPrice = long ? t.at(Math.floor(checked.stop.level / tick + 1e-9) - buffer) : t.at(Math.ceil(checked.stop.level / tick - 1e-9) + buffer);
  const stopTicks = Math.ceil(Math.abs(ref - stopPrice) / tick - 1e-9);
  const targetPrice = long ? t.down(checked.target.level) : t.up(checked.target.level);
  const targetTicks = Math.round(Math.abs(targetPrice - ref) / tick);
  if ((long ? stopPrice >= ref : stopPrice <= ref)) problems.push(`the stop ${stopPrice} is not on the losing side of the entry ${ref}`);
  if (!(targetTicks > 0) || (long ? targetPrice <= ref : targetPrice >= ref)) problems.push(`the target ${targetPrice} is not on the winning side of the entry ${ref}`);
  const floor = stopFloorTicks(briefing, tick, rule);
  if (floor === null) problems.push('ATR(20) is unknown, so the minimum stop (D13) can\'t be checked');
  else if (stopTicks < floor) problems.push(`the stop is ${stopTicks} ticks, under the minimum ${floor} (max of ${rule.floorTicks} ticks and ${rule.floorAtr} x ATR(20)): refused, never widened; name a level further away, or pass`);
  // Compared unrounded (2.996 is under a min of 3); rounded only for display.
  const rawRR = stopTicks > 0 ? targetTicks / stopTicks : null;
  const rr = rawRR === null ? null : round2(rawRR);
  if (num(minRR) !== null && !(rawRR >= minRR)) problems.push(`R:R ${rawRR === null ? 'unknown' : rawRR.toFixed(3)} is under the strategy's min ${minRR}`);
  if (!(Number.isInteger(size) && size >= 1 && size <= MAX_SIZE)) problems.push(`size: a whole number of contracts, 1 to ${MAX_SIZE}`);
  const perContract = round2(stopTicks * tickValue);
  const riskUsd = Number.isInteger(size) ? round2(perContract * size) : null;
  if (num(maxRiskUsd) === null) problems.push(`the ${STRATEGY} strategy states no risk.max_risk_usd`);
  // `suggestion` (a prop attempt: the size is translated at entry, prop/size-translate.js, and the cap binds on the size
  // ordered there): a stated size over the cap is no problem of the record's.
  else if (!suggestion && riskUsd !== null && riskUsd > maxRiskUsd) problems.push(`size ${size} risks $${riskUsd}, over the strategy's risk.max_risk_usd $${maxRiskUsd} (at most ${Math.floor(maxRiskUsd / perContract)} at this stop)`);
  const between = x => (long ? x > ref && x < targetPrice : x < ref && x > targetPrice);
  const m3 = briefing.sections.m3.data;
  const near = isObj(m3.nearestLiquidity) && Array.isArray(m3.nearestLiquidity[long ? 'above' : 'below']) ? m3.nearestLiquidity[long ? 'above' : 'below'] : [];
  const way = near.find(x => isObj(x) && num(x.price) !== null && between(x.price) && Math.abs(x.price - targetPrice) > tick + 1e-9);
  return {
    problems,
    plan: {
      entry: { type: 'limit', price: ref },
      stop: { source: checked.stop.source, level: checked.stop.level, price: stopPrice, ticks: stopTicks, bufferTicks: buffer, floorTicks: floor },
      target: { source: checked.target.source, level: checked.target.level, price: targetPrice, ticks: targetTicks },
      rr, inTheWay: way ? { name: way.name, price: way.price, R: round2(Math.abs(way.price - ref) / (stopTicks * tick)) } : null,
      size: Number.isInteger(size) ? size : null, riskUsd, perContractUsd: perContract,
      maxSize: num(maxRiskUsd) !== null && perContract > 0 ? Math.floor(maxRiskUsd / perContract) : null, tick, tickValue,
    },
  };
}

/** The record (RECORD_KEYS): the checked reads and the plan, ok only when both stand. */
function buildRecord({ at, root, symbol, side, briefing = null, checked = null, planned = null, problems = [], cycleId = null, validBars = 1 }) {
  const m3 = briefing && isObj(briefing.sections) && isObj(briefing.sections.m3) ? briefing.sections.m3 : null;
  const expiry = m3 ? expiryOf(briefing, validBars) : NaN;
  const all = [...problems, ...(checked ? checked.problems : []), ...(planned ? planned.problems : [])];
  const reads = checked ? checked.reads.map(r => ({
    step: r.step, skill: r.skill, read: r.read, why: r.why, kind: r.kind, form: r.form, field: r.field, value: r.value, check: r.check, fact: r.fact, agrees: r.agrees, ...(r.reversal ? { reversal: true } : {}),
  })) : [];
  const ok = Boolean(checked && checked.ok && planned && planned.plan && !all.length);
  const body = {
    schema: SCHEMA, at, strategy: STRATEGY, root: familyRoot(root), symbol, contract: briefing ? briefing.contractId || null : null,
    lane: briefing && Number.isInteger(briefing.minutes) ? `${briefing.minutes}m` : null, side, bar: briefing ? briefing.asOf : null,
    expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null, cycleId, exploratory: false,
    ok, problems: all, reads, signature: checked ? checked.signature : null, skillSignature: checked ? checked.skillSignature : null,
    context: checked ? checked.context : null, plan: planned ? planned.plan : null,
  };
  const id = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
  return Object.fromEntries(RECORD_KEYS.map(k => [k, k === 'id' ? id : body[k]]));
}

/** Append one record (one line) to its day's shard; the file and its folder made as needed. */
function appendRecord(home, record) {
  const day = shardDay(record);
  if (!day) throw new Error('the record has no bar or time to file it under');
  const file = recordFile(home, record.root, day);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

const unreadable = (what, err) => new Error(`the compose record ${what} can't be read (${err.code || err.message})`);

/** A record file's records (an unreadable line is skipped; no file, none); over MAX_BYTES or unreadable, throws. */
function readFile(file, { legacy = false } = {}) {
  let size;
  try { size = fs.statSync(file).size; } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw unreadable(file, err);
  }
  if (size > MAX_BYTES && legacy) {
    throw new Error(`the compose record ${file}, an older home's single file from before the day shards, is over ${MAX_BYTES} bytes: no reader can use it (no composed entry is judged on it, and the learning loop and experience_lookup refuse it too); continue in a new run home (this one's record stays where it is for review)`);
  }
  if (size > MAX_BYTES) throw new Error(`the compose record ${file} is over ${MAX_BYTES} bytes`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { throw unreadable(file, err); }
  return text.split('\n').filter(Boolean).flatMap(l => { try { const r = JSON.parse(l); return isObj(r) ? [r] : []; } catch (_err) { return []; } });
}

/** A folder's entries; none when it doesn't exist; throws when it can't be read. */
function list(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw unreadable(dir, err);
  }
}

/** The families with records under the home (a shard folder or an older single file), sorted. */
const families = home => [...new Set(list(path.join(home, DIR)).flatMap(e => {
  if (e.isDirectory()) return FAMILY.test(e.name) ? [e.name] : [];
  const m = /^([A-Z0-9]{1,8})\.jsonl$/.exec(e.name);
  return m ? [m[1]] : [];
}))].sort();

/** A family's shard days, sorted (every `<day>.jsonl` in its folder). */
const shardDays = (home, root) => list(familyDir(home, root)).map(e => e.name)
  .filter(n => n.endsWith('.jsonl') && DAY.test(n.slice(0, -6))).map(n => n.slice(0, -6)).sort();

/**
 * The records of a root's family (root null: every family's), oldest first: the older single file's, then each
 * day's shard in day order. `days`: only those days' shards, never a listing of the others (the gate's read is one
 * file), and of the older file only its records of those days. A file that can't be read throws.
 */
function readRecords(home, root = null, { days = null } = {}) {
  if (days !== null && (!Array.isArray(days) || !days.every(d => DAY.test(String(d))))) throw new Error(`not trading days: ${JSON.stringify(days)}`);
  const roots = root === null ? families(home) : [familyRoot(root)];
  return roots.flatMap(r => {
    const old = readFile(legacyFile(home, r), { legacy: true }).filter(x => days === null || days.includes(shardDay(x)));
    const names = days !== null ? [...new Set(days)].sort() : shardDays(home, r);
    return [...old, ...names.flatMap(d => readFile(recordFile(home, r, d)))];
  });
}

/** The record as text: the checked reads, the plan and what stands. */
function renderRecord(r, checked = null, hints = []) {
  const out = [`compose_check ${r.root} ${r.side || '?'} on the bar at ${r.bar || 'unknown'} (record ${r.id}, expires ${r.expiresAt || 'unknown'}):`];
  if (checked) out.push(renderCheck(checked).trimEnd());
  const p = r.plan;
  if (p) {
    out.push(`Plan (code's arithmetic): entry limit ${p.entry.price}; stop ${p.stop.price} (${p.stop.source} ${p.stop.level}, ${p.stop.bufferTicks} tick beyond: ${p.stop.ticks} ticks, minimum ${p.stop.floorTicks ?? 'unknown'}); target ${p.target.price} (${p.target.source} ${p.target.level}: ${p.target.ticks} ticks); R:R ${p.rr}; first level ahead: ${p.inTheWay ? `${p.inTheWay.name} ${p.inTheWay.price} at ${p.inTheWay.R}R (a read; no edge in the census)` : 'none found'}; size ${p.size ?? '?'} risking $${p.riskUsd ?? '?'} ($${p.perContractUsd} a contract, at most ${p.maxSize ?? '?'} by risk.max_risk_usd).`);
  }
  for (const x of r.problems.filter(x => !(checked && checked.problems.includes(x)))) out.push(`- PROBLEM: ${x}`);
  // A refusal's hints (compose-hints.js): what is TRUE on this bar, per flow step; never on an OK record.
  if (!r.ok) for (const h of Array.isArray(hints) ? hints : []) out.push(`- HINT ${h}`);
  out.push(r.ok ? `OK: every read verified and the plan stands (signature ${r.signature}). A calculator and a checker, not advice: whether to trade is yours.`
    : 'NOT OK: no entry on this record. Fix each read or problem named above, or pass.');
  return `${out.join('\n')}\n`;
}

module.exports = { STRATEGY, SCHEMA, RECORD_KEYS, MAX_SIZE, MAX_BYTES, recordFile, legacyFile, dayOf, shardDay, daysNear, stopRuleOf, stopFloorTicks, expiryOf, planOf, buildRecord, appendRecord, readRecords, renderRecord };
