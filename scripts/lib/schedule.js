'use strict';

/**
 * The schedule: which days are for what, as config (config/schedule.json, loaded by config-files.js), never as code.
 * One file holds both schedules the harness keeps, so they can't disagree:
 *
 *   data       start (the history's first month) and flowCoverage ([from, to) of the replay server's flow fields)
 *   learning   the learning loop's split (learning/splits.js): open { practice-train, practice-validate } and sealed
 *              { windows { test, final }, lookBudgets { test, final }, finalNeedsTestPass, validateRunsPerCandidate,
 *              recordedLooks } (learning/looks.js)
 *   prop       the promotion schedule (prop/splits.js): open { train, select } and sealed { blocks { oos, recent },
 *              llmFrom, reserveMinMonths, lookBudget, recordedLooks } (prop/looks.js). The promotion gate's
 *              thresholds stay frozen code (prop/promotion.js): only when its windows fall comes from here.
 *
 * Each window is [from, to), session dates 'YYYY-MM-DD', `to` exclusive. Validation fails closed: a missing or
 * unreadable file, an unknown or missing key, a bad date, an empty window, windows out of order or overlapping, or a
 * recorded look outside its window refuses the whole schedule, and with it every role, look and run that needs it.
 *
 * The sealed rule (tamper evidence). Every ledger entry (both ledgers, prop/ledger-file.js appendLook) and every run
 * (learning-run.json, the replay manifest) records the schedule's fingerprint { version, hash, sealed: { learning,
 * prop } }: hash is the whole file's (canonical JSON), sealed.<domain> the hash of that domain's `sealed` object only.
 * Then, against a ledger (sealedRefusals):
 *
 * - once a domain has a sealed look (learning: any entry at test or final, or without a role; prop: any look), a
 *   schedule whose sealed part for that domain differs from the one the look was taken under is refused, whatever
 *   its version: test and final windows, budgets and recorded looks never change after a look;
 * - the open parts (practice-train, practice-validate, train, select) and the data dates may change, as long as the
 *   sealed parts stay identical;
 * - a changed file carries a new `version`: a schedule whose version names a hash the ledger already has, under
 *   another hash, is refused. scheduleVersion(entry) and versionsOf(ledger) report which version each entry used.
 *
 * Ledger entries written before fingerprints, and the recorded looks, were taken under the first schedule (LEGACY):
 * its version, hash and sealed hashes are pinned here, and tests/lib/schedule.test.js keeps the pin true.
 *
 *   SPEC                           the schedule's schema for config-files.js (validate, tightenOnly)
 *   load(file)                     a schedule from a file (pure: tests and the preflight); throws when refused
 *   current()                      the committed schedule, loaded once per process; throws (every call) when refused
 *   fingerprint(s)                 { version, hash, sealed: { learning, prop } }
 *   resolve(day, use)              use 'learning' | 'prop': { use, day, role, ..., look } (the day's role and the look
 *                                  rule it requires), or { use, day, role: null, look: null } outside the schedule
 *   sealedRefusals(domain, ledger, s)   [why] the sealed rule refuses s (default current()) against a ledger
 *   assertSealed(domain, ledger, s)     throws with those reasons
 *   scheduleVersion(entry)         the version an entry was written under (LEGACY's for an entry without one)
 *   versionsOf(ledger)             [{ version, hash, entries }] in first-seen order
 */

const { loadConfigFile, hashOf, fingerprintOf } = require('./config-files');

const NAME = 'schedule';
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LEARNING_OPEN = Object.freeze(['practice-train', 'practice-validate']);
const LEARNING_SEALED = Object.freeze(['test', 'final']);
const PROP_OPEN = Object.freeze(['train', 'select']);
const PROP_SEALED = Object.freeze(['oos', 'recent']);
const DOMAINS = Object.freeze(['learning', 'prop']);

/**
 * The first schedule (config/schedule.json version v1, the windows the code held before it): what every ledger entry
 * without a fingerprint, and every recorded look, was taken under.
 */
const LEGACY = Object.freeze({
  version: 'v1',
  hash: 'df9c16c8d70ce613c41bafedfefd192c4b71d46cb63cb2252d379c51b7367df8',
  sealed: Object.freeze({ learning: '529046373e1b038034c7b81861c7ddc3dded28d7e4f8c770ed77b680925ecc38', prop: '612e72a551796cc9caac44f50c4923978fea5cb810de4d876b2bd41dcfbb9b41' }),
});

const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isDate = v => typeof v === 'string' && ISO.test(v) && (() => { const t = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v; })();
const firstOfMonth = v => isDate(v) && v.endsWith('-01');
const posInt = v => Number.isInteger(v) && v >= 1;

function keys(errors, where, obj, want) {
  if (!isObj(obj)) { errors.push(`${where}: an object with ${want.join(', ')}`); return false; }
  for (const k of want) if (!Object.hasOwn(obj, k)) errors.push(`${where}.${k}: missing`);
  for (const k of Object.keys(obj)) if (!want.includes(k)) errors.push(`${where}.${k}: not a schedule key`);
  return true;
}

function windowOk(errors, where, w, { month = false } = {}) {
  if (!Array.isArray(w) || w.length !== 2 || !w.every(month ? firstOfMonth : isDate)) {
    errors.push(`${where}: [from, to], session dates YYYY-MM-DD${month ? ' on the first of a month' : ''}`);
    return false;
  }
  if (!(w[0] < w[1])) { errors.push(`${where}: from ${w[0]} is not before to ${w[1]}`); return false; }
  return true;
}

/** Windows in order, none overlapping the next (a gap has no role: its days are refused). */
function ordered(errors, where, named) {
  for (let i = 1; i < named.length; i++) {
    const [a, wa] = named[i - 1];
    const [b, wb] = named[i];
    if (wb[0] < wa[1]) errors.push(`${where}: ${b} [${wb[0]}, ${wb[1]}) overlaps or comes before ${a} [${wa[0]}, ${wa[1]}); windows are in order and never overlap`);
  }
}

function recordedOk(errors, where, list, windowOf, roleKey) {
  if (!Array.isArray(list)) { errors.push(`${where}: a list of looks`); return; }
  list.forEach((l, i) => {
    const at = `${where}[${i}]`;
    if (!isObj(l) || !isDate(l.from) || !isDate(l.to) || !(l.from < l.to)) { errors.push(`${at}: a look with from and to, session dates, from before to`); return; }
    const w = windowOf(l[roleKey]);
    if (!w) { errors.push(`${at}: ${roleKey} ${JSON.stringify(l[roleKey])} is not a window of the schedule`); return; }
    if (!(l.from >= w[0] && l.to <= w[1])) errors.push(`${at}: ${l.from}..${l.to} is not inside ${l[roleKey]} [${w[0]}, ${w[1]})`);
  });
}

/** Every reason a schedule document is refused (empty = valid). */
function validate(v) {
  const errors = [];
  if (!keys(errors, 'schedule', v, ['version', 'data', 'learning', 'prop'])) return errors;
  if (typeof v.version !== 'string' || !ID.test(v.version)) errors.push('version: a name (letters, digits, ".", "_", "-"); a changed schedule carries a new one');
  if (keys(errors, 'data', v.data, ['start', 'flowCoverage'])) {
    if (!isDate(v.data.start)) errors.push('data.start: a date YYYY-MM-DD');
    windowOk(errors, 'data.flowCoverage', v.data.flowCoverage);
  }
  const L = v.learning;
  if (keys(errors, 'learning', L, ['open', 'sealed'])) {
    const okOpen = keys(errors, 'learning.open', L.open, LEARNING_OPEN);
    const okSealed = keys(errors, 'learning.sealed', L.sealed, ['windows', 'lookBudgets', 'finalNeedsTestPass', 'validateRunsPerCandidate', 'recordedLooks']);
    const okWin = okSealed && keys(errors, 'learning.sealed.windows', L.sealed.windows, LEARNING_SEALED);
    let good = okOpen && okWin;
    if (okOpen) for (const r of LEARNING_OPEN) good = windowOk(errors, `learning.open.${r}`, L.open[r]) && good;
    if (okWin) for (const r of LEARNING_SEALED) good = windowOk(errors, `learning.sealed.windows.${r}`, L.sealed.windows[r]) && good;
    if (good) ordered(errors, 'learning', [...LEARNING_OPEN.map(r => [r, L.open[r]]), ...LEARNING_SEALED.map(r => [r, L.sealed.windows[r]])]);
    if (okSealed) {
      if (keys(errors, 'learning.sealed.lookBudgets', L.sealed.lookBudgets, LEARNING_SEALED)) {
        for (const r of LEARNING_SEALED) if (!posInt(L.sealed.lookBudgets[r])) errors.push(`learning.sealed.lookBudgets.${r}: a whole number of looks, at least 1`);
      }
      if (typeof L.sealed.finalNeedsTestPass !== 'boolean') errors.push('learning.sealed.finalNeedsTestPass: true or false');
      if (!posInt(L.sealed.validateRunsPerCandidate)) errors.push('learning.sealed.validateRunsPerCandidate: a whole number of runs, at least 1');
      if (good) recordedOk(errors, 'learning.sealed.recordedLooks', L.sealed.recordedLooks, r => (LEARNING_OPEN.includes(r) ? L.open[r] : LEARNING_SEALED.includes(r) ? L.sealed.windows[r] : null), 'role');
    }
  }
  const P = v.prop;
  if (keys(errors, 'prop', P, ['open', 'sealed'])) {
    const okOpen = keys(errors, 'prop.open', P.open, PROP_OPEN);
    const okSealed = keys(errors, 'prop.sealed', P.sealed, ['blocks', 'llmFrom', 'reserveMinMonths', 'lookBudget', 'recordedLooks']);
    const okBlocks = okSealed && keys(errors, 'prop.sealed.blocks', P.sealed.blocks, PROP_SEALED);
    let good = okOpen && okBlocks;
    if (okOpen) for (const b of PROP_OPEN) good = windowOk(errors, `prop.open.${b}`, P.open[b], { month: true }) && good;
    if (okBlocks) for (const b of PROP_SEALED) good = windowOk(errors, `prop.sealed.blocks.${b}`, P.sealed.blocks[b], { month: true }) && good;
    if (good) {
      ordered(errors, 'prop', [...PROP_OPEN.map(b => [b, P.open[b]]), ...PROP_SEALED.map(b => [b, P.sealed.blocks[b]])]);
      // The half-year blocks start where Recent ends, on a half-year: January or July.
      if (!/-(01|07)-01$/.test(P.sealed.blocks.recent[1])) errors.push(`prop.sealed.blocks.recent: it ends on the first of January or July (the half-year blocks start there), not ${P.sealed.blocks.recent[1]}`);
    }
    if (okSealed) {
      if (!firstOfMonth(P.sealed.llmFrom)) errors.push('prop.sealed.llmFrom: a date YYYY-MM-01');
      if (!posInt(P.sealed.reserveMinMonths)) errors.push('prop.sealed.reserveMinMonths: a whole number of months, at least 1');
      if (!posInt(P.sealed.lookBudget)) errors.push('prop.sealed.lookBudget: a whole number of looks, at least 1');
      if (good) recordedOk(errors, 'prop.sealed.recordedLooks', P.sealed.recordedLooks, b => (PROP_OPEN.includes(b) ? P.open[b] : PROP_SEALED.includes(b) ? P.sealed.blocks[b] : null), 'block');
    }
  }
  return errors;
}

const SPEC = Object.freeze({
  name: NAME,
  validate,
  // Budgets only fall, and the final look keeps needing a test pass (tests/lib/schedule.test.js pins each).
  tightenOnly: Object.freeze({
    'learning.sealed.lookBudgets.test': 'down',
    'learning.sealed.lookBudgets.final': 'down',
    'learning.sealed.finalNeedsTestPass': 'true',
    'learning.sealed.validateRunsPerCandidate': 'down',
    'prop.sealed.lookBudget': 'down',
    'prop.sealed.reserveMinMonths': 'up',
  }),
});

function fingerprint(s = current()) {
  return s.fingerprint;
}

/** A schedule from its loaded file: the values its readers use, and its fingerprint. */
function build(loaded) {
  const v = loaded.value;
  const L = v.learning;
  const P = v.prop;
  const fp = Object.freeze({
    ...fingerprintOf(loaded),
    sealed: Object.freeze({ learning: hashOf(L.sealed), prop: hashOf(P.sealed) }),
  });
  return Object.freeze({
    file: loaded.file,
    version: v.version,
    fingerprint: Object.freeze({ version: fp.version, hash: fp.hash, sealed: fp.sealed }),
    data: v.data,
    learning: Object.freeze({
      windows: Object.freeze({ ...L.open, ...L.sealed.windows }),
      lookBudgets: L.sealed.lookBudgets,
      finalNeedsTestPass: L.sealed.finalNeedsTestPass,
      validateRunsPerCandidate: L.sealed.validateRunsPerCandidate,
      recordedLooks: L.sealed.recordedLooks,
    }),
    prop: Object.freeze({
      splits: Object.freeze({ train: P.open.train, select: P.open.select, oos: P.sealed.blocks.oos }),
      recent: P.sealed.blocks.recent,
      llmFrom: P.sealed.llmFrom,
      reserveMinMonths: P.sealed.reserveMinMonths,
      lookBudget: P.sealed.lookBudget,
      recordedLooks: P.sealed.recordedLooks,
    }),
  });
}

const load = file => build(loadConfigFile(SPEC, { file }));

let cached = null;
/** The committed schedule, once per process; a refused one throws on every call (never cached, never a default). */
function current() {
  if (!cached) cached = build(loadConfigFile(SPEC));
  return cached;
}

/** The fingerprint an entry was written under: its own, or the first schedule's (an entry from before fingerprints). */
function entryFingerprint(e) {
  const f = e && e.schedule;
  if (isObj(f) && typeof f.hash === 'string' && isObj(f.sealed)) return f;
  return LEGACY;
}

const scheduleVersion = e => entryFingerprint(e).version;

/** Whether a ledger entry is a sealed look: learning, any entry at test or final (or with no role); prop, any look. */
function isSealedLook(domain, e) {
  if (!isObj(e)) return true;
  if (domain === 'prop') return true;
  return !LEARNING_OPEN.includes(e.role);
}

/** The recorded looks of a domain, as ledger entries of the first schedule (they were taken before fingerprints). */
const recordedOf = (domain, s) => (domain === 'learning' ? s.learning.recordedLooks : s.prop.recordedLooks);

function sealedRefusals(domain, ledger, s = current()) {
  if (!DOMAINS.includes(domain)) return [`no schedule domain "${domain}" (${DOMAINS.join(', ')})`];
  if (!Array.isArray(ledger)) return ['the ledger is required, a list of looks'];
  const cur = s.fingerprint;
  const out = [];
  const reused = new Map();
  const sealedUnder = new Map();
  for (const e of [...recordedOf(domain, s).map(l => ({ ...l, schedule: undefined })), ...ledger]) {
    const f = entryFingerprint(e);
    if (f.version === cur.version && f.hash !== cur.hash) reused.set(f.hash, f);
    if (isSealedLook(domain, e) && f.sealed[domain] !== cur.sealed[domain]) {
      const k = `${f.version} ${f.sealed[domain]}`;
      const g = sealedUnder.get(k) || { f, n: 0, first: e };
      g.n += 1;
      sealedUnder.set(k, g);
    }
  }
  for (const f of reused.values()) {
    out.push(`the schedule's version ${cur.version} (hash ${cur.hash.slice(0, 12)}) names another file than the one the ledger's entries of version ${f.version} were written under (hash ${f.hash.slice(0, 12)}): a changed schedule carries a new version name (config/schedule.json version)`);
  }
  for (const { f, n, first } of sealedUnder.values()) {
    const at = first.from && first.to ? ` (the first: ${first.from}..${first.to}${first.role ? `, ${first.role}` : ''})` : '';
    out.push(`the schedule's sealed ${domain} windows (${domain}.sealed: windows, budgets, recorded looks) differ from those of schedule ${f.version}, under which ${n} sealed ${domain} look(s) were taken${at}: sealed windows never change after a look; restore ${domain}.sealed in config/schedule.json (only the open windows and the data dates may change)`);
  }
  return out;
}

function assertSealed(domain, ledger, s = current()) {
  const r = sealedRefusals(domain, ledger, s);
  if (r.length) throw new Error(`the schedule is refused: ${r.join('; ')}`);
  return true;
}

function versionsOf(ledger) {
  const out = new Map();
  for (const e of Array.isArray(ledger) ? ledger : []) {
    const f = entryFingerprint(e);
    const k = `${f.version} ${f.hash}`;
    if (!out.has(k)) out.set(k, { version: f.version, hash: f.hash, entries: 0 });
    out.get(k).entries += 1;
  }
  return [...out.values()];
}

/**
 * A day's role and the look it requires, for a use: 'learning' (learning/splits.js roleOf, learning/looks.js lookRule)
 * or 'prop' (prop/splits.js roleOf, prop/looks.js lookRule). A day outside the schedule has no role and no look.
 */
function resolve(day, use) {
  if (use !== 'learning' && use !== 'prop') throw new Error(`no schedule use "${use}" (learning, prop)`);
  current(); // a refused schedule throws here, never read as a day outside it
  if (use === 'learning') {
    const splits = require('./learning/splits');
    const d = splits.sessionDate(day);
    let role;
    try { role = splits.roleOf(d); } catch (_err) { return { use, day: d, role: null, look: null }; }
    return { use, day: d, role, look: require('./learning/looks').lookRule(role) };
  }
  const splits = require('./prop/splits');
  let unit;
  try { unit = splits.roleOf(day); } catch (_err) { return { use, day, role: null, look: null }; }
  return { use, day, ...unit, look: require('./prop/looks').lookRule(unit) };
}

module.exports = {
  NAME, SPEC, LEGACY, DOMAINS, LEARNING_OPEN, LEARNING_SEALED, PROP_OPEN, PROP_SEALED,
  validate, load, current, fingerprint, resolve, sealedRefusals, assertSealed, isSealedLook, scheduleVersion,
  entryFingerprint, versionsOf,
};
