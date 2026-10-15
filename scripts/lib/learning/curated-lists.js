'use strict';

/**
 * The curated training lists (the owner's practice set for a model that can't afford weeks of full-day replays): a
 * seeded selection of setup moments (curated-moments.js), balanced across years, into named lists, a run mix over them,
 * and their coverage, under one content fingerprint; a practice replay pins one (the mix or a list) and runs only its
 * windows (setup-focused practice, learning/setup-moments.js, inside them; the run gate, learning/run-gate.js, as
 * for any practice run), managing anything still open after a window bar by bar until it is flat.
 *
 * Lists (curated-moments.js listOf): trend-up and trend-down (a rejection or a breakout at a key level with a clear
 * 1h/4h trend), trend-end (a CHoCH against the trend: mostly passes or D2 reversals), chop (mostly passes) and
 * counter-trend (mostly passes, plus the few D2 allows). A training document is built from practice-train moments only
 * (use 'practice'), a validation document from practice-validate moments only (use 'validate'): never mixed, and a
 * validation document never runs on practice-train (curatedForRun). Neither feeds the experience index (it is built
 * from practice-train runs' experience logs, learning/experience-index.js). A document is one market's: its root(s),
 * bar and setup timeframes (`market`), and a run on another is refused.
 *
 * Selection (selectList), per list, of its share of `total` (mix), one moment at a time, the best candidate by, in order:
 *   - the skills it exercises that are still under minSkill (where the data has them), the scarcest weighing most
 *     (each counts one over the number of candidates that have it);
 *   - the list's pass share (a list with one takes passes until it holds its share, then takes: D2 reversals);
 *   - balanced by year: the year with the fewest moments so far first, and no year past YEAR_CAP times its even share
 *     of the years that have candidates (the list is short rather than one year filling it);
 *   - winners and losers of the standard's trades kept level;
 *   - the skills that line up (agreeing reads);
 *   - then a seeded hash.
 * The mix is every list's moments in time order: a replay plays its windows in time order (its clock moves forward only,
 * and the experience index is walk-forward by day, so another order would leak); the selection balances it across years.
 *
 *   DEFAULTS                                  { total, mix, minSkill, passShare, seed }
 *   listSizes(total, mix)                    each list's share of total, whole numbers adding up to total exactly
 *   accountOpen({ positions, orders })       whether the account holds a position (any listed; a size that can't be
 *                                            read is open) or a working order
 *   buildLists(moments, { use, seed, total, mix, minSkill, passShare, sources })   the document, fingerprinted
 *   selectList(candidates, { name, size, seed, minSkill, passShare })   [moment]
 *   coverageOf(selected, candidates, { minSkill })   per skill (count, available, combinations, under), outcomes, years,
 *                                            and per reaction kind (rejection, breakout, at a level or a gap's edge)
 *   coverageText(doc)                        the coverage report, as text
 *   fingerprintOf(doc), writeLists(dir, doc), readLists(file)
 *   validateCuratedConfig(raw)               a replay config's `curatedList`: { file, list }
 *   curatedForRun({ file, list, start, end, symbols, timeframe, setupTf })
 *                                            { file, list, fingerprint, use, role, market, windows }
 *   curatedPoints(points, curated, delayMs)  the decision times a curated run steps: from the first window on, the
 *                                            trade times in a window and the window days' premarket and end of day;
 *                                            every other time marked `manage` (stepped only while something is open:
 *                                            replay/driver.js), so a position carried past a window or a day is managed
 *   emptyWindows(points, curated, delayMs)   the windows no decision time falls in (the run's sessions miss them)
 *   pinCurated(runHome, curated), loadPinnedCurated(home)   the run's copy: its windows only, never the outcomes
 *   dayChunks(from, to, n)                   [from, to) split into n runs of whole session dates (a parallel scan)
 *   curatedSelect({ windows, barClose, open, select })   the practice selector inside the list's windows
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { assertUse, sessionDate } = require('./splits');
// curated-moments.js (the scan, and the crosswalk's skills) is loaded when lists are built: a replay's config reads only this.
const momentsLib = () => require('./curated-moments');

const VERSION = 1;
const KIND = 'curated-lists';
const PINNED = 'curated-pinned.json';
const ROLE = Object.freeze({ practice: 'practice-train', validate: 'practice-validate' });
const LISTS = Object.freeze(['trend-up', 'trend-down', 'trend-end', 'chop', 'counter-trend']);
const DEFAULTS = Object.freeze({
  total: 200,
  mix: Object.freeze({ 'trend-up': 0.35, 'trend-down': 0.35, 'trend-end': 0.1, chop: 0.1, 'counter-trend': 0.1 }),
  minSkill: 3,
  passShare: Object.freeze({ 'trend-end': 0.6, chop: 0.7, 'counter-trend': 0.7 }),
  seed: 1,
});
/** Every skill a read maps to (curated-moments.js READ_SKILL, the crosswalk's). */
const skillsOf = () => [...new Set([...Object.values(momentsLib().READ_SKILL).flatMap(Object.values), momentsLib().SHAPE_SKILL])].sort();
/** A year holds at most this many times its even share of a list (the years that have candidates). */
const YEAR_CAP = 1.5;
const OUTCOMES = ['win', 'loss', 'scratch', 'unfilled', 'no-room', 'not-composable', 'stop-under-floor', 'no-confirmation', 'no-entry-window'];

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const hashOf = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex');
const DAY = 86400000;
const nextDay = d => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const tally = (list, key) => { const o = {}; for (const x of list) { const k = key(x); o[k] = (o[k] || 0) + 1; } return Object.fromEntries(Object.entries(o).sort()); };

function checkOptions({ total, mix, minSkill, passShare }) {
  const errors = [];
  if (!(Number.isInteger(total) && total > 0)) errors.push('total: a whole number above 0');
  if (!isObj(mix) || !Object.keys(mix).every(k => LISTS.includes(k)) || !Object.values(mix).every(w => typeof w === 'number' && w >= 0)) errors.push(`mix: { <list>: share } over ${LISTS.join(', ')}`);
  else if (Math.abs(Object.values(mix).reduce((a, b) => a + b, 0) - 1) > 1e-6) errors.push('mix: the shares add up to 1');
  if (!(Number.isInteger(minSkill) && minSkill >= 0)) errors.push('minSkill: a whole number, 0 or more');
  if (!isObj(passShare) || !Object.entries(passShare).every(([k, v]) => LISTS.includes(k) && typeof v === 'number' && v >= 0 && v <= 1)) errors.push('passShare: { <list>: share from 0 to 1 }');
  if (errors.length) throw new Error(`curated lists refused: ${errors.join('; ')}`);
}

/** A candidate's place in the selection's order (see the header): compared in turn, higher first. */
function keyOf(state, c) {
  // The scarcest first: each skill under its minimum counts one over the candidates that have it.
  const gain = c.skills.filter(s => (state.count[s] || 0) < state.minSkill).reduce((a, s) => a + 1 / state.avail[s], 0);
  let balance = 0;
  if (state.passTarget !== null) balance = state.pass < state.passTarget ? Number(c.expected === 'pass') : Number(c.expected === 'take');
  const level = c.outcome.result === 'win' ? Number(state.win <= state.loss) : c.outcome.result === 'loss' ? Number(state.loss <= state.win) : 0;
  return [gain, balance, -(state.years.get(c.year) || 0), level, c.aligned.length];
}

function better(state, a, b) {
  const ka = keyOf(state, a);
  const kb = keyOf(state, b);
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] > kb[i];
  return hashOf(state.seed, state.name, a.id) < hashOf(state.seed, state.name, b.id);
}

/**
 * A list's moments: one at a time, the best by the selection's order among the candidates whose year is under its
 * cap (YEAR_CAP times an even share of the years that have candidates), until the list is full or no candidate is left
 * under its cap (the list is then short: no year fills another's place past its cap).
 */
function selectList(candidates, { name, size, seed = DEFAULTS.seed, minSkill = DEFAULTS.minSkill, passShare = null }) {
  const pool = [...candidates];
  const yearsWith = new Set(pool.map(c => c.year)).size;
  const cap = yearsWith ? Math.ceil((YEAR_CAP * size) / yearsWith) : 0;
  const avail = {};
  for (const c of pool) for (const sk of c.skills) avail[sk] = (avail[sk] || 0) + 1;
  const state = { seed, name, minSkill, avail, count: {}, years: new Map(), pass: 0, win: 0, loss: 0, passTarget: typeof passShare === 'number' ? Math.ceil(size * passShare) : null };
  const picked = [];
  while (picked.length < size) {
    let best = -1;
    for (let i = 0; i < pool.length; i += 1) {
      if ((state.years.get(pool[i].year) || 0) >= cap) continue;
      if (best === -1 || better(state, pool[i], pool[best])) best = i;
    }
    if (best === -1) break;
    const c = pool.splice(best, 1)[0];
    picked.push(c);
    state.years.set(c.year, (state.years.get(c.year) || 0) + 1);
    for (const s of c.skills) state.count[s] = (state.count[s] || 0) + 1;
    if (c.expected === 'pass') state.pass += 1;
    if (c.outcome.result === 'win') state.win += 1;
    if (c.outcome.result === 'loss') state.loss += 1;
  }
  return picked.sort((a, b) => Date.parse(a.reactionAt) - Date.parse(b.reactionAt) || (a.id < b.id ? -1 : 1));
}

function coverageOf(selected, candidates, { minSkill = DEFAULTS.minSkill } = {}) {
  const skills = {};
  const SKILLS = skillsOf();
  for (const s of SKILLS) {
    const withIt = selected.filter(m => m.skills.includes(s));
    const available = candidates.filter(m => m.skills.includes(s)).length;
    const count = withIt.length;
    skills[s] = { count, available, combinations: tally(withIt, m => m.aligned.join('+') || '-'), under: count < minSkill, dataShort: available < minSkill };
  }
  return {
    n: selected.length, candidates: candidates.length, skills,
    outcomes: tally(selected, m => m.outcome.result), expected: tally(selected, m => m.expected), years: tally(selected, m => m.year),
    d2Allowed: selected.filter(m => m.gate && m.gate.d2 && m.gate.d2.allowed).length,
    under: SKILLS.filter(s => skills[s].under),
    reactions: Object.fromEntries(Object.keys(tally(selected, m => m.reactionKind)).map(k => {
      const of = selected.filter(m => m.reactionKind === k);
      return [k, { n: of.length, outcomes: tally(of, m => m.outcome.result), expected: tally(of, m => m.expected), skills: tally(of.flatMap(m => m.skills), x => x) }];
    })),
  };
}

/** Each list's share of total: whole numbers that add up to total (largest remainders, ties in list order). */
function listSizes(total, mix) {
  const raw = LISTS.map(n => total * (mix[n] || 0));
  const out = raw.map(Math.floor);
  const order = LISTS.map((_n, i) => i).sort((a, b) => (raw[b] - out[b]) - (raw[a] - out[a]) || a - b);
  for (let k = 0, left = total - out.reduce((a, b) => a + b, 0); k < order.length && left > 0; k += 1, left -= 1) {
    if (raw[order[k]] > 0) out[order[k]] += 1;
    else left += 1;
  }
  return Object.fromEntries(LISTS.map((n, i) => [n, out[i]]));
}

/** Whether an account state holds a position (any listed one: a size that can't be read is open) or a working order. */
function accountOpen(state) {
  const s = state && typeof state === 'object' ? state : {};
  const flat = p => p && (p.size === 0 || p.size === '0');
  return (Array.isArray(s.positions) ? s.positions : []).some(p => !flat(p)) || (Array.isArray(s.orders) ? s.orders : []).length > 0;
}

function fingerprintOf(doc) {
  const { builtAt: _b, fingerprint: _f, ...rest } = doc;
  return hashOf(JSON.stringify(rest));
}

/** The lists, the mix and their coverage from scanned moments (see the header). */
function buildLists(moments, { use, seed = DEFAULTS.seed, total = DEFAULTS.total, mix = DEFAULTS.mix, minSkill = DEFAULTS.minSkill, passShare = DEFAULTS.passShare, sources = [], now = new Date() } = {}) {
  if (!ROLE[use]) throw new Error(`curated lists refused: use ${String(use)}; a list is built for ${Object.keys(ROLE).join(' or ')} only (test and final are sealed)`);
  if (!Number.isSafeInteger(seed)) throw new Error('curated lists refused: seed is an integer');
  checkOptions({ total, mix, minSkill, passShare });
  const seen = new Set();
  const all = [];
  for (const m of moments) {
    if (!isObj(m) || m.v !== momentsLib().VERSION || seen.has(m.id)) continue;
    // Every moment of the document's own window: a validation moment never enters a training list, nor the reverse.
    if (m.use !== use) throw new Error(`curated lists refused: moment ${m.id} was scanned for ${m.use}, not ${use}`);
    assertUse(use, sessionDate(m.day), nextDay(sessionDate(m.day)));
    seen.add(m.id);
    all.push(m);
  }
  // One market: the moments' bar and setup timeframes agree (a run checks its own against them).
  const market = { roots: [...new Set(all.map(m => m.root))].sort(), minutes: [...new Set(all.map(m => m.minutes))], setupTf: [...new Set(all.map(m => m.setupTf))] };
  if (market.minutes.length > 1 || market.setupTf.length > 1) throw new Error(`curated lists refused: the moments mix bar timeframes ${market.minutes.join(', ')} or setup timeframes ${market.setupTf.join(', ')}; one document is one market's`);
  market.minutes = market.minutes[0] ?? null;
  market.setupTf = market.setupTf[0] ?? null;
  const lists = {};
  const coverage = {};
  const short = {};
  const sizes = listSizes(total, mix);
  for (const name of LISTS) {
    const size = sizes[name];
    const cands = all.filter(m => m.list === name);
    lists[name] = size > 0 ? selectList(cands, { name, size, seed, minSkill, passShare: passShare[name] ?? null }) : [];
    coverage[name] = coverageOf(lists[name], cands, { minSkill });
    if (lists[name].length < size) short[name] = size - lists[name].length;
  }
  const chosen = LISTS.flatMap(n => lists[n]);
  const order = [...chosen].sort((a, b) => Date.parse(a.reactionAt) - Date.parse(b.reactionAt) || (a.id < b.id ? -1 : 1)).map(m => m.id);
  coverage.mix = coverageOf(chosen, all, { minSkill });
  const hashes = sources.map(s => s.sha256).filter(Boolean);
  if (new Set(hashes).size !== hashes.length) throw new Error('curated lists refused: the same moments file given twice (its sha256 repeats)');
  const doc = {
    v: VERSION, kind: KIND, builtAt: now.toISOString(), use, role: ROLE[use], market, seed, options: { total, mix, minSkill, passShare },
    sources: sources.map(s => ({ file: s.file ? path.basename(s.file) : null, sha256: s.sha256 || null })),
    lists, mix: order, short, coverage,
  };
  return { ...doc, fingerprint: fingerprintOf(doc) };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

function coverageText(doc) {
  const lines = [`curated ${doc.use} lists ${doc.fingerprint.slice(0, 16)} (${doc.role}, ${doc.market.roots.join(',') || '-'} ${doc.market.minutes}m bars, ${doc.market.setupTf}m setups, seed ${doc.seed}): mix ${doc.mix.length} moment(s)${Object.keys(doc.short).length ? `; short: ${Object.entries(doc.short).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''}`];
  for (const name of [...LISTS, 'mix']) {
    const c = doc.coverage[name];
    lines.push('', `${name}: ${c.n} of ${c.candidates} candidate(s); outcomes ${JSON.stringify(c.outcomes)}; expected ${JSON.stringify(c.expected)} (pass ${pct(c.expected.pass || 0, c.n)}); D2 allowed ${c.d2Allowed}; years ${JSON.stringify(c.years)}`);
    for (const [k, r] of Object.entries(c.reactions)) lines.push(`  by reaction: ${k} ${r.n}; outcomes ${JSON.stringify(r.outcomes)}; expected ${JSON.stringify(r.expected)}`);
    for (const s of Object.keys(c.skills)) {
      const k = c.skills[s];
      const top = Object.entries(k.combinations).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([x, n]) => `${n}x ${x}`).join('; ');
      lines.push(`  ${k.under ? 'UNDER ' : ''}${s}: ${k.count} (available ${k.available}${k.dataShort ? ', the data has fewer than the minimum' : ''})${top ? `; ${Object.keys(k.combinations).length} combination(s), top ${top}` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeLists(dir, doc) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `curated-${doc.use}-${doc.fingerprint.slice(0, 16)}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`);
  fs.renameSync(tmp, file);
  return file;
}

function readLists(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isObj(doc) || doc.kind !== KIND || typeof doc.fingerprint !== 'string') throw new Error(`${file}: not a curated lists document`);
  if (doc.v !== VERSION) throw new Error(`${file}: curated lists of version ${doc.v}, not ${VERSION}: rebuild them`);
  if (fingerprintOf(doc) !== doc.fingerprint) throw new Error(`${file}: its content doesn't match its fingerprint (changed after it was built)`);
  if (!ROLE[doc.use] || doc.role !== ROLE[doc.use]) throw new Error(`${file}: use ${doc.use} is not a curated use`);
  return doc;
}

function validateCuratedConfig(raw) {
  if (raw === undefined || raw === null) return { curated: null, errors: [] };
  const errors = [];
  if (!isObj(raw)) return { curated: null, errors: ['curatedList: { "file": "<curated lists>", "list": "mix" }'] };
  for (const k of Object.keys(raw)) if (!['file', 'list'].includes(k)) errors.push(`curatedList.${k}: unknown (file, list)`);
  if (!(typeof raw.file === 'string' && raw.file.trim())) errors.push('curatedList.file: a curated lists document (scripts/curated-lists.js build)');
  const list = raw.list === undefined ? 'mix' : raw.list;
  if (!['mix', ...LISTS].includes(list)) errors.push(`curatedList.list: mix or one of ${LISTS.join(', ')}`);
  return errors.length ? { curated: null, errors } : { curated: { file: raw.file, list }, errors };
}

/** The windows of a document's list, merged and sorted: [{ from, to }] (ms). */
function windowsOf(doc, list) {
  const ids = list === 'mix' ? new Set(doc.mix) : null;
  const picked = list === 'mix' ? LISTS.flatMap(n => doc.lists[n]).filter(m => ids.has(m.id)) : doc.lists[list] || [];
  const ws = picked.map(m => ({ from: Date.parse(m.window.from), to: Date.parse(m.window.to) })).sort((a, b) => a.from - b.from);
  const out = [];
  for (const w of ws) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else out.push({ ...w });
  }
  return out;
}

/** A replay's curated list, checked against its window: the document's use must be the run's (assertUse). */
function curatedForRun({ file, list = 'mix', start, end, symbols = null, timeframe = null, setupTf = null }) {
  const doc = readLists(file);
  // The run's market is the list's: its root among the run's symbols, the same bar and setup timeframes.
  const mk = doc.market || {};
  const roots = (symbols || []).map(x => String(x).toUpperCase());
  if (!mk.roots || !mk.roots.length || !mk.roots.every(r => roots.includes(r))) throw new Error(`curatedList: its moments are ${(mk.roots || []).join(', ') || 'of no root'}; the run trades ${roots.join(', ') || 'nothing'}`);
  if (mk.minutes !== timeframe) throw new Error(`curatedList: its moments are on ${mk.minutes}m bars, the run's on ${timeframe}m`);
  if (mk.setupTf !== setupTf) throw new Error(`curatedList: its moments are ${mk.setupTf}m setups, the run's practice.setupTf is ${setupTf}`);
  if (list !== 'mix' && !doc.lists[list]) throw new Error(`curatedList.list: ${list} is not in ${path.basename(file)}`);
  const windows = windowsOf(doc, list);
  if (!windows.length) throw new Error(`curatedList: ${list} of ${path.basename(file)} has no moments`);
  const s = start.getTime();
  const e = end.getTime();
  assertUse(doc.use, s, e);
  if (windows[0].from < s || windows[windows.length - 1].to > e) throw new Error(`curatedList: its windows (${new Date(windows[0].from).toISOString()} to ${new Date(windows[windows.length - 1].to).toISOString()}) lie outside the run's ${start.toISOString()} to ${end.toISOString()}`);
  return { file, list, fingerprint: doc.fingerprint, use: doc.use, role: doc.role, market: mk, windows };
}

const inside = (windows, ms) => windows.some(w => ms > w.from && ms <= w.to);

/**
 * The decision times a curated run steps (a time is its bar's close plus the runner's poll delay, delayMs), from the
 * first window's opening on (a trade time) and from its day's premarket (the first window day's premarket runs, as on
 * every window day): the trade times whose bar closed in a window, and the window days' premarket and end of
 * day; every other time (the rest of a window's day, and every time of the days after, end of day included) marked
 * `manage`: the driver steps one only while a position or working order is open, as practice manages every bar with
 * something open, so a position the model carries past its window, or past an end of day that didn't flatten it, is
 * still managed.
 */
function curatedPoints(points, curated, delayMs = 0) {
  if (!curated.windows.length) return [];
  const close = p => p.t.getTime() - delayMs;
  const kept = p => p.kind === 'trade' && inside(curated.windows, close(p));
  const days = new Set(points.filter(kept).map(p => p.day));
  const first = curated.windows[0].from;
  // Before the first window only its day's premarket and end of day run (no trade time: none closed in a window).
  return points.filter(p => p.t.getTime() > first || (p.kind !== 'trade' && days.has(p.day))).map(p => (kept(p) || (p.kind !== 'trade' && days.has(p.day)) ? p : { ...p, manage: true }));
}

/** The windows no trade decision time falls in (the run's sessions or end of day miss them). */
function emptyWindows(points, curated, delayMs = 0) {
  const closes = points.filter(p => p.kind === 'trade').map(p => p.t.getTime() - delayMs);
  return curated.windows.filter(w => !closes.some(c => c > w.from && c <= w.to));
}

/** [from, to) (session dates) as up to n runs of whole dates, in order: [[from, to]]. */
function dayChunks(from, to, n) {
  const days = [];
  for (let d = sessionDate(from); d < sessionDate(to); d = nextDay(d)) days.push(d);
  const k = Math.max(1, Math.min(Math.floor(n) || 1, days.length));
  const size = Math.ceil(days.length / k);
  const out = [];
  for (let i = 0; i < days.length; i += size) out.push([days[i], i + size < days.length ? days[i + size] : sessionDate(to)]);
  return out;
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };

const pinHash = pin => hashOf(JSON.stringify({ fingerprint: pin.fingerprint, list: pin.list, windows: pin.windows }));

/**
 * Pin the run's curated list: the list the config resolved (its fingerprint, the file read again must be it), as the
 * run's own copy of its windows only (the moments' outcomes never sit in the run home); refused unless the run is a
 * learning practice run of the document's role. A run keeps the list it pinned.
 */
function pinCurated(runHome, curated) {
  const doc = readLists(curated.file);
  if (doc.fingerprint !== curated.fingerprint) throw new Error(`${path.basename(curated.file)} changed since the run's config read it (${String(curated.fingerprint).slice(0, 16)}, now ${doc.fingerprint.slice(0, 16)}): start the run again`);
  const run = readJson(path.join(runHome, 'learning-run.json'));
  if (!run || run.learning !== true) throw new Error('a curated list is for a learning practice run (no learning-run.json, or the run is declared not learning)');
  if (run.role !== doc.role) throw new Error(`a ${doc.use} curated list runs on ${doc.role}, not on this ${run.role} run`);
  if (!run.practice) throw new Error('a curated list runs through setup-focused practice (the replay config\'s practice)');
  const dir = path.join(runHome, 'experience');
  const file = path.join(dir, PINNED);
  const pinned = readJson(file);
  const mine = { fingerprint: doc.fingerprint, list: curated.list };
  if (pinned && JSON.stringify({ fingerprint: pinned.fingerprint, list: pinned.list }) !== JSON.stringify(mine)) {
    throw new Error(`this run pinned curated list ${String(pinned.fingerprint).slice(0, 16)} (${pinned.list}); a run keeps its list (start another runId)`);
  }
  const pin = { kind: 'curated-pin', ...mine, windows: windowsOf(doc, curated.list) };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...pin, hash: pinHash(pin) })}\n`);
  return { file, fingerprint: doc.fingerprint, list: curated.list, windows: pin.windows.length };
}

/** The run's pinned curated windows ({ fingerprint, list, windows }), or null when none is pinned. */
function loadPinnedCurated(home) {
  const pin = readJson(path.join(home, 'experience', PINNED));
  if (!pin) return null;
  if (pin.kind !== 'curated-pin' || !Array.isArray(pin.windows) || pinHash(pin) !== pin.hash) throw new Error('the pinned curated list doesn\'t match its hash (changed after it was pinned)');
  return { fingerprint: pin.fingerprint, list: pin.list, windows: pin.windows };
}

/** Setup-focused practice inside the list's windows: a bar outside them runs only to manage what is open. */
function curatedSelect({ windows, barClose, open, select }) {
  if (open || inside(windows, barClose)) return select();
  return { run: false, why: 'none', moment: null, reason: 'practice: outside the curated list\'s windows; the clock advances' };
}

module.exports = {
  VERSION, KIND, DEFAULTS, LISTS, OUTCOMES, ROLE, YEAR_CAP, skillsOf,
  buildLists, selectList, listSizes, accountOpen, coverageOf, coverageText, fingerprintOf, writeLists, readLists,
  validateCuratedConfig, windowsOf, curatedForRun, curatedPoints, emptyWindows, dayChunks, pinCurated, loadPinnedCurated, curatedSelect,
};
