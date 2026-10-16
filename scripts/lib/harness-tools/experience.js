'use strict';

/**
 * experience_lookup (the composed-entry design, section 4.4; scripts/experience-lookup.js; the harness tool): the
 * model's own record for the candidate it composed, from the run's pinned experience index
 * (learning/experience-index.js loadPinned). Read-only. The candidate is the latest verified trade_lifecycle record
 * for the root that hasn't expired at the harness clock (learning/lifecycle-record.js), so its reads and context
 * are the ones code checked, never restated. `alternative` (at most two) swaps one step's skill to ask how a nearby
 * combination did.
 *
 * Walk-forward: every statistic and every past decision shown is from trading days strictly before the candidate's
 * bar's session (experience-index.js cellAt, examplesBefore), so a practice run never sees its own day or later.
 *
 * Output, plain text, at most MAX_BYTES: the signatures and context; the cells, exact first (the read signature in
 * the full context), then the skill signature in the full context, one context key at a time, and alone; each with
 * n, days, the win rate and mean R with their 90% intervals (each cell one of many: an interval describes, it
 * proves nothing alone), the median MAE and MFE in R with their intervals and count (`insufficient` under the minimum), last
 * seen, `shifted` with its latest year's n, or `too few samples`; then up to three past decisions of the same skill
 * signature, the closest context first, with their reads, why, decision and outcome (R, grade, MAE and MFE); a cell's
 * count of curated runs' decisions and an example's `(curated)`, with one line saying what that means (CURATED_NOTE);
 * and the index's hash and the days it showed. With no index pinned, or no match, it says so. It never says what
 * to do.
 *
 * The history library (learning/setup-library.js), only when the run pinned one AND enabled its display (the replay
 * config's libraryDisplay, kept in the pin: setup-library.js libraryShown; pinning alone shows nothing): a section of
 * its own, after the model's record and apart from it, headed as code-measured and not the model's decisions: the
 * candidate's read signature (this context, any context) and its setup reaction alone (this context, any context, with
 * the reactions that had no room at 2:1) as code measured them with one fixed standard trade, walk-forward the same
 * way: counts, the win rate and the no-room days only, never an R (the library measures one fixed plan, not the
 * model's trades). The cap drops the library's lines before the model's own cells.
 *
 * The model's risk record (learning/risk-record-index.js), only when the run pinned one AND enabled its display (the
 * replay config's riskRecordDisplay, kept in the pin: riskShown): a section of its own, last, "your risk record": by
 * account state, what reverting each of the model's own risk decisions (standing down, sizing under the ceiling,
 * exiting early, stopping for the day) did to the blows and passes of the Monte Carlo, each line with its sample size,
 * or "too few" under the minimum; practice-train days before the bar's session only. Counts and outcomes, no advice.
 * The cap drops it before anything else, so before the model's own cells.
 *
 * Budget (D22): at most two answered calls per cycle bar and root; a third is refused. Each answered call is
 * recorded (learning/experience-lookups.js reserveLookup: counted and appended under a lock, so two calls at once
 * can't both take the last one). Like skill_lookup's record, the budget and the record need the runner's cycle
 * (FTH_CYCLE_TRANSCRIPT, a streamed transcript): outside one (a person at a terminal, a harness without a streamed
 * transcript) nothing is counted or recorded. The gate doesn't require a lookup yet (D15).
 *
 *   experience_lookup { symbol, alternative?, role? }
 */

const { harnessHome } = require('../paths');
const { readRecords, CONTEXT_KEYS } = require('../learning/lifecycle-record');
const { loadPinned, cellAt, examplesBefore, cellKey, contextKey } = require('../learning/experience-index');
const { sessionDate } = require('../learning/splits');
const { MAX_PER_BAR, reserveLookup } = require('../learning/experience-lookups');
const { loadPinnedLibrary, libraryShown, libraryCellAt, noRoomBefore, setupKeyOf } = require('../learning/setup-library');
const { loadPinnedRiskRecord, riskShown, riskRecordLines } = require('../learning/risk-record-index');
const { familyRoot } = require('../trading/contracts');
const { daysNear } = require('../trading/trade-lifecycle');
const { context } = require('./cli');

const USAGE = 'usage: experience-lookup.js --symbol <ROOT> [--alternative <step>:<skill> (at most 2)] [--role <role>]';
const MAX_BYTES = require('../tunables').training().experienceTool.maxBytes; // config/training.json experienceTool
const SIMILAR = require('../tunables').training().experienceTool.similar;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEP = /^[a-z][a-z-]{0,31}$/;

const CURATED_NOTE = 'curated: decisions from curated runs, picked outcome-balanced, not at natural rates: their win rate, mean R and MAE/MFE show the lists\' mix, not the market\'s.';
const f2 = x => (x === null || x === undefined ? '-' : Number(x).toFixed(2));

/** A cell's median MAE and MFE in R with their 90% intervals and count, or `insufficient` with it under the minimum (index: medianOf). */
function excursionText(c) {
  const { mae, mfe } = c;
  if (!mae || !mfe) return '';
  if (mae.median === null || mfe.median === null) return `, MAE/MFE insufficient (n ${Math.min(mae.n, mfe.n)})`;
  return `, median MAE ${f2(mae.median)}R [${f2(mae.lo)}, ${f2(mae.hi)}] MFE ${f2(mfe.median)}R [${f2(mfe.lo)}, ${f2(mfe.hi)}] (n ${mae.n === mfe.n ? mae.n : `${mae.n}/${mfe.n}`})`;
}

function cellLine(label, c) {
  if (!c) return `- ${label}: no record`;
  if (!c.enough) return `- ${label}: ${c.note}`;
  const shift = c.shifted ? `, shifted (${c.latestYear.year}: mean R ${f2(c.latestYear.meanR)} over n ${c.latestYear.n}, the other sign)` : '';
  return `- ${label}: n ${c.n} (${c.days} days; ${c.entries} entered, ${c.passes} passed${c.curated ? `; ${c.curated} curated` : ''}), win ${f2(c.winRate.rate)} [${f2(c.winRate.lo)}, ${f2(c.winRate.hi)}], mean R ${f2(c.meanR.mean)} [${f2(c.meanR.lo)}, ${f2(c.meanR.hi)}]${excursionText(c)}, last ${c.lastSeen}${shift}`;
}

/** The skill signature with one step's skills replaced. */
function swapStep(sig, step, skill) {
  const parts = String(sig).split('+');
  const k = parts.findIndex(p => p.split(':')[0] === step);
  if (k === -1) throw new Error(`alternative: the candidate has no step "${step}"`);
  parts[k] = `${step}:${skill}`;
  return parts.join('+');
}

/** Context keys in common with the candidate's. */
const closeness = (a, b) => CONTEXT_KEYS.filter(k => a && b && a[k] !== null && a[k] === b[k]).length;

function exampleLines(ex) {
  const reads = ex.reads.map(r => `${r.step} ${r.read}${r.why ? ` (${r.why})` : ''}`).join('; ');
  const x = Number.isFinite(ex.maeR) && Number.isFinite(ex.mfeR) ? `, MAE ${f2(ex.maeR)}R MFE ${f2(ex.mfeR)}R` : '';
  return `- ${ex.day} ${ex.side || ''} ${ex.decision}${ex.curated ? ' (curated)' : ''}, ${f2(ex.R)}R${ex.grade ? ` ${ex.grade}` : ''}${x}: ${reads}`;
}

/**
 * The latest verified record for the root that hasn't expired at `now`: read from the root's day shards around `now`
 * alone (a record live at `now` is on a bar of the day before, of or after it: trade-lifecycle.js daysNear), never
 * the whole run's record.
 */
function candidateFor(home, root, now) {
  const t = now.getTime();
  const live = readRecords(home, { root: familyRoot(root), days: daysNear(now) })
    .filter(r => familyRoot(r.root) === familyRoot(root) && r.ok && Date.parse(r.at) <= t && (!r.expiresAt || Date.parse(r.expiresAt) > t));
  return live.length ? live[live.length - 1] : null;
}

/** A library cell: counts and the win rate with its interval (no entries or passes: code's trades; never an R). */
function libraryLine(label, c, noRoom = null) {
  const room = noRoom ? `; ${noRoom} more had no room at 2:1` : '';
  if (!c) return `- ${label}: no record${room}`;
  if (!c.enough) return `- ${label}: ${c.note}${room}`;
  return `- ${label}: n ${c.n} (${c.days} days, ${c.unfilled} unfilled), win ${f2(c.winRate.rate)} [${f2(c.winRate.lo)}, ${f2(c.winRate.hi)}]${room}`;
}

/** The history library's section for the candidate (none without a library). */
function librarySection(lib, rec, before) {
  if (!lib) return [];
  // An unreadable library is said in the tail (libraryError), never dropped by the cap.
  if (lib.error) return [];
  const full = contextKey(rec.context);
  const at = key => libraryCellAt(lib, key, before);
  const setup = setupKeyOf(rec.reads);
  return [
    `History library ${lib.hash.slice(0, 16)} (code-measured, not your decisions): every number is the standard plan's (a limit at the confirmation close, the stop one tick past the reaction candle, the first level at 2:1 or more), not your own stop and target; no record for a signature means the standard never composes it, not that it fails:`,
    libraryLine('read signature, this context', at(cellKey('read', rec.signatures.read, full))),
    libraryLine('read signature, any context', at(cellKey('read', rec.signatures.read))),
    ...(setup ? [
      libraryLine(`${setup}, this context`, at(cellKey('setup', setup, full))),
      libraryLine(`${setup}, any context`, at(cellKey('setup', setup)), noRoomBefore(lib, setup, before)),
    ] : ['- no setup reaction read in the candidate']),
  ];
}

/** The line saying the pinned library can't be read (kept in the tail: the cap never hides it), or none. */
const libraryError = lib => (lib && lib.error ? [`History library (code-measured, not your decisions): unreadable (${lib.error}); no library numbers this lookup.`] : []);

/** The risk record's section for the candidate's bar (none without a shown record; an unreadable one is said in the tail). */
function riskSection(risk, before) {
  return risk && !risk.error ? riskRecordLines(risk, before) : [];
}
const riskError = risk => (risk && risk.error ? [`Your risk record: unreadable (${risk.error}); no risk record this lookup.`] : []);

/**
 * Text at most MAX_BYTES: whole lines from the end of each optional block are dropped first: the risk record's, then
 * similar decisions, then the library's, all before the model's cells.
 */
function capped(head, cells, similar, tail, library = [], risk = []) {
  const join = () => [...head, ...cells, ...(similar.length > 1 ? similar : []), ...tail, ...(library.length > 1 ? library : []), ...(risk.length > 1 ? risk : [])].join('\n') + '\n';
  while (Buffer.byteLength(join()) > MAX_BYTES && risk.length > 1) risk.pop();
  while (Buffer.byteLength(join()) > MAX_BYTES && similar.length > 1) similar.pop();
  while (Buffer.byteLength(join()) > MAX_BYTES && library.length > 1) library.pop();
  while (Buffer.byteLength(join()) > MAX_BYTES && cells.length > 2) cells.splice(cells.length - 2, 1);
  const text = join();
  return Buffer.byteLength(text) > MAX_BYTES ? `${Buffer.from(text).subarray(0, MAX_BYTES - 4).toString()}...\n` : text;
}

function experienceLookup({ symbol, alternative = [], role = null } = {}, ctx) {
  const c = { ...context(ctx), wallNow: ctx && typeof ctx.wallNow === 'function' ? ctx.wallNow : null };
  if (!/^[A-Z0-9]{1,8}$/.test(String(symbol || ''))) throw new Error(`--symbol: a contract root, e.g. MNQ (${USAGE})`);
  if (role !== null && !NAME.test(String(role))) throw new Error(`--role: a role's name (${USAGE})`);
  const alts = Array.isArray(alternative) ? alternative : [];
  if (alts.length > 2) throw new Error('alternative: at most two');
  for (const a of alts) if (!a || !STEP.test(String(a.step)) || !NAME.test(String(a.skill))) throw new Error(`alternative: { step, skill }, e.g. { "step": "setup", "skill": "breakout-vs-fakeout" } (${USAGE})`);
  const home = harnessHome(c.env);
  const now = c.now();
  const rec = candidateFor(home, symbol, now);
  if (!rec) throw new Error(`no verified trade_lifecycle record for ${symbol} on this bar: experience_lookup reads the candidate compose_check verified (call it first)`);
  for (const a of alts) swapStep(rec.signatures.skill, a.step, a.skill); // a step the candidate lacks is refused before the budget
  const index = loadPinned(home);
  let library;
  // Shown only when the run enabled the display; pinned alone, the library is code's (the scan, the training lists).
  try { library = libraryShown(home) ? loadPinnedLibrary(home) : null; } catch (err) { library = { error: err.message }; }
  // Counted and recorded together, under the lock: a third call on the bar is refused.
  let risk;
  try { risk = riskShown(home) ? loadPinnedRiskRecord(home) : null; } catch (err) { risk = { error: err.message }; }
  const taken = reserveLookup(c.env, { role, root: rec.root, bar: rec.bar, side: rec.side, signature: rec.signatures.read, index: index ? index.hash : null, ...(library && !library.error ? { library: library.hash } : {}), ...(risk && !risk.error ? { risk: risk.hash } : {}) }, c.wallNow ? c.wallNow() : Date.now());
  if (!taken) throw new Error(`experience_lookup: ${MAX_PER_BAR} calls on this bar already (the budget); decide with what they showed`);
  const head = [
    `Experience for ${rec.root} ${rec.side}, bar ${rec.bar}:`,
    `skill signature: ${rec.signatures.skill}`, `read signature: ${rec.signatures.read}`, `context: ${contextKey(rec.context)}`,
  ];
  const before = sessionDate(Date.parse(rec.bar));
  if (!index) return { text: capped([...head, 'No experience index is pinned for this run: no record.'], [], [], [...libraryError(library), ...riskError(risk)], librarySection(library, rec, before), riskSection(risk, before)) };
  let curated = false;
  const at = key => {
    const c = cellAt(index, key, before);
    if (c && c.enough && c.curated) curated = true;
    return c;
  };
  const full = contextKey(rec.context);
  const cells = [
    cellLine('read signature, this context', at(cellKey('read', rec.signatures.read, full))),
    cellLine('skill signature, this context', at(cellKey('skill', rec.signatures.skill, full))),
    ...CONTEXT_KEYS.map(k => cellLine(`skill signature, ${k}=${rec.context[k] ?? '-'}`, at(cellKey('skill', rec.signatures.skill, `${k}=${rec.context[k] ?? '-'}`)))),
    cellLine('skill signature, any context', at(cellKey('skill', rec.signatures.skill))),
    cellLine('read signature, any context', at(cellKey('read', rec.signatures.read))),
  ];
  for (const a of alts) {
    const sig = swapStep(rec.signatures.skill, a.step, a.skill);
    cells.push(cellLine(`alternative ${a.step}:${a.skill}, this context`, at(cellKey('skill', sig, full))));
    cells.push(cellLine(`alternative ${a.step}:${a.skill}, any context`, at(cellKey('skill', sig))));
  }
  const picked = examplesBefore(index, rec.signatures.skill, before).map((e, i) => ({ e, i, near: closeness(e.context, rec.context) }))
    .sort((a, b) => b.near - a.near || a.i - b.i).slice(0, SIMILAR).map(x => x.e);
  const examples = picked.map(exampleLines);
  const similar = ['Similar past decisions (same skills, closest context):', ...(examples.length ? examples : ['- none'])];
  const tail = [`Index ${index.hash.slice(0, 16)}: practice-train days before ${before} only; 90% intervals, each cell one of many (an interval describes, it proves nothing alone); at least ${index.minN} decisions over ${index.minDays} days per statistic.`];
  // Curated runs' decisions are outcome-balanced (experience-index.js): said once, kept by the cap, when any is shown.
  if (curated || picked.some(e => e.curated)) tail.push(CURATED_NOTE);
  return { text: capped([...head, 'Cells:'], cells, similar, [...tail, ...libraryError(library), ...riskError(risk)], librarySection(library, rec, before), riskSection(risk, before)) };
}

/** argv to { symbol, alternative, role }. */
function parseArgv(argv) {
  const o = { symbol: null, alternative: [], role: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const val = () => {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag}: give its value (${USAGE})`);
      return v;
    };
    if (flag === '--symbol') o.symbol = val();
    else if (flag === '--role') o.role = val();
    else if (flag === '--alternative') {
      const [step, skill] = val().split(':');
      o.alternative.push({ step, skill });
    } else throw new Error(`unknown argument: ${argv[i]} (${USAGE})`);
  }
  return o;
}

module.exports = { USAGE, MAX_BYTES, experienceLookup, parseArgv, swapStep, librarySection, capped };
