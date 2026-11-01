'use strict';

/**
 * Setup-focused practice (the owner's practice mode): which closed bars of a practice replay run a model cycle. A
 * replay runs the full live cycle on every bar; most bars have no setup, so a practice run may run cycles only at the
 * bars that matter and let the replay clock (and the broker's fills and brackets) advance between them with no model
 * call. Everything else is the live runner: lanes, gate, records, timing, the experience log.
 *
 * A bar runs a cycle when, in this order:
 *   manage    a position or working order of the symbol's family is open (every bar while it is: the runner reads it)
 *   moment    the setup timeframe's last COMPLETED candle (the briefing's `candles` block, candle-facts.js: the same
 *             facts the model reads, never the candle forming) reacted at a key level (`reactions`: rejected, broke,
 *             or both):
 *               levels 'key' (default)  a FIXED key level, complete before the candle opened (KEY_LEVEL: prior RTH
 *                                       high/low/close, overnight high/low, IB, opening range, the prior VAH/VAL/POC,
 *                                       the 1h and 15m swings still holding), the VWAP (the owner's key level, moving:
 *                                       at its value when the candle closed), or a fair value gap's edge;
 *               levels 'wide'           those, and the developing session profile (VAH/VAL/POC, MOVING_LEVEL), a
 *                                       previous-candle level rejected (the previous candle's or a CRT range's high or
 *                                       low: the failed break; a plain break of the previous candle is continuation),
 *                                       and a sweep of the previous candle that closed back inside.
 *             On the parity fixtures 'wide' selects most bars (the developing profile and the previous candle's levels
 *             are met by nearly every candle), so 'key' is the default. `phase` is `reaction` on the entry bar that completed that candle,
 *             `confirmation` on the entry-timeframe closes after it while it is still the last completed candle (the
 *             window ends when the next setup candle completes: it is superseded). The reaction bar is the entry (the
 *             setup is the entry; no confirming read is needed), and the later closes stay selected while the setup
 *             stands; the setup timeframe holds at least two runner bars (autotrader.js validateConfig);
 *   quiet     a seeded sample of the other bars (quietSample, deterministic by seed, symbol and bar), so the model still
 *             practises passing on quiet bars;
 *   none      otherwise: no cycle (the bar is still polled, briefed, scanned and recorded as live).
 * Premarket and end of day are never filtered (the runner's clock actions). Causal by construction: the candles block
 * holds only candles completed by the bar's close, and the sample reads only the bar's own time.
 *
 * Config (a replay's `practice`, carried into the run's runner config; learning/run-gate.js allows it only on a
 * practice-train or practice-validate learning run, the runner only on a replay of one):
 *   { mode: 'setup-focus', setupTf: 15 (5, 15 or 60 minutes), quietSample: 0.15 (0 to 1), seed: 0 (an integer),
 *     levels: 'key' | 'wide', reactions: ['rejected', 'broke'] }
 *
 *   validatePractice(raw)                     { practice (defaults filled) | null, errors }
 *   reactionsOf(candle, { levels, reactions })   the candle's reactions at key levels [{ kind, name, price, rel, dir }]
 *   setupMoment(candles, { setupTf, barClose, levels, reactions })   { available, moment, phase, candle, reactions, reason }
 *   quietPick({ seed, symbol, bar, rate })     whether a bar is in the quiet sample
 *   selectBar({ practice, candles, symbol, bar, barClose, open })   { run, why, moment, reason }
 *   practiceLine(practice)                     one line naming the mode, for reports
 *   checkLine(candles, { barClose, et, setupTf, entries, max })   the briefing's "Setups to check" line (the setup
 *                                             moment, as the model reads it), or null: no moment, no completed setup
 *                                             candle, or no entries in this window
 */

const crypto = require('crypto');

const MODES = Object.freeze(['setup-focus']);
const SM = require('../tunables').replay().setupMoments; // config/replay.json setupMoments
// The reactions a "Setups to check" line lists: the candle lines' own cap (candle-facts.js MAX_LEVELS).
const MAX_CHECKS = require('../tunables').analysis().candles.maxLevels;
const SETUP_TFS = SM.setupTfs;
const LEVEL_SETS = Object.freeze(['key', 'wide']);
const REACTION_KINDS = Object.freeze(['rejected', 'broke']);
const DEFAULTS = Object.freeze({ mode: 'setup-focus', setupTf: SM.setupTf, quietSample: SM.quietSample, seed: SM.seed, levels: SM.levels, reactions: REACTION_KINDS });
const KNOWN = Object.freeze(['mode', 'setupTf', 'quietSample', 'seed', 'levels', 'reactions']);

// The key levels a reaction counts at (candle-facts.js level names, briefing.js levelsAt): the fixed ones, complete
// before the candle opened, and the VWAP (the owner names it a key level); round numbers are not one. 'wide' adds the
// developing session profile.
const KEY_LEVEL = /^(prior RTH (high|low|close)|overnight (high|low)|IB (high|low)|opening range (high|low)|prior (VAH|VAL|POC)|1h swing|15m swing|VWAP)/;
const MOVING_LEVEL = /^session (VAH|VAL|POC)/;
// The previous candle's levels (its own and a CRT range's): only a rejection (the failed break) is a reaction.
const PREVIOUS_LEVEL = /^(previous |CRT )/;

const tfLabel = m => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);

function validatePractice(raw) {
  if (raw === undefined || raw === null) return { practice: null, errors: [] };
  const errors = [];
  if (typeof raw !== 'object' || Array.isArray(raw)) return { practice: null, errors: ['practice: an object, e.g. { "mode": "setup-focus", "setupTf": 15, "quietSample": 0.15, "seed": 1 }'] };
  for (const k of Object.keys(raw)) if (!KNOWN.includes(k)) errors.push(`practice.${k}: unknown (${KNOWN.join(', ')})`);
  const p = { ...DEFAULTS, ...raw };
  if (!MODES.includes(p.mode)) errors.push(`practice.mode: one of ${MODES.join(', ')}`);
  if (!SETUP_TFS.includes(p.setupTf)) errors.push(`practice.setupTf: one of ${SETUP_TFS.join(', ')} (minutes)`);
  if (!(typeof p.quietSample === 'number' && p.quietSample >= 0 && p.quietSample <= 1)) errors.push('practice.quietSample: a share from 0 to 1');
  if (!Number.isSafeInteger(p.seed)) errors.push('practice.seed: an integer');
  if (!LEVEL_SETS.includes(p.levels)) errors.push(`practice.levels: one of ${LEVEL_SETS.join(', ')}`);
  const kinds = Array.isArray(p.reactions) ? [...new Set(p.reactions)] : null;
  if (!kinds || !kinds.length || !kinds.every(k => REACTION_KINDS.includes(k))) errors.push(`practice.reactions: a non-empty list of ${REACTION_KINDS.join(', ')}`);
  if (errors.length) return { practice: null, errors };
  return { practice: { mode: p.mode, setupTf: p.setupTf, quietSample: p.quietSample, seed: p.seed, levels: p.levels, reactions: REACTION_KINDS.filter(k => kinds.includes(k)) }, errors };
}

/** A completed candle's reactions at key levels (see the header), strongest kind first as the candle lists them. */
function reactionsOf(c, { levels = DEFAULTS.levels, reactions = DEFAULTS.reactions } = {}) {
  if (!c || typeof c !== 'object') return [];
  const wide = levels === 'wide';
  const counts = new Set(reactions);
  const out = [];
  for (const r of Array.isArray(c.relations) ? c.relations : []) {
    if (!r || typeof r.name !== 'string' || !counts.has(r.rel)) continue;
    if (KEY_LEVEL.test(r.name) || (wide && MOVING_LEVEL.test(r.name))) out.push({ kind: 'level', name: r.name, price: r.price, rel: r.rel, dir: r.dir });
    else if (wide && PREVIOUS_LEVEL.test(r.name) && r.rel === 'rejected') out.push({ kind: 'previous', name: r.name, price: r.price, rel: r.rel, dir: r.dir });
  }
  for (const z of Array.isArray(c.fvgRelations) ? c.fvgRelations : []) {
    if (z && typeof z.name === 'string' && counts.has(z.rel)) out.push({ kind: 'fvg', name: z.name, price: z.price, rel: z.rel, dir: z.dir });
  }
  if (wide && counts.has('rejected') && c.sweep && c.sweep.closedBack === true) out.push({ kind: 'sweep', name: c.sweep.of, price: null, rel: 'swept', dir: /high/.test(c.sweep.of) && !/low/.test(c.sweep.of) ? 'down' : /low/.test(c.sweep.of) && !/high/.test(c.sweep.of) ? 'up' : null });
  return out;
}

/**
 * The setup moment at a bar: the briefing's `candles` block as of the bar's close, the setup timeframe, and the bar's
 * close (ms or ISO). An unavailable setup candle is said (available false), never read as no moment.
 */
function setupMoment(candles, { setupTf = DEFAULTS.setupTf, barClose, levels = DEFAULTS.levels, reactions: kinds = DEFAULTS.reactions } = {}) {
  const key = tfLabel(setupTf);
  const c = candles && typeof candles === 'object' ? candles[key] : null;
  if (!c || c.unavailable || !c.closedAt) {
    return { available: false, moment: false, phase: null, candle: null, reactions: [], reason: `no completed ${key} candle in the briefing${c && c.unavailable ? ` (${c.unavailable})` : ''}` };
  }
  const reactions = reactionsOf(c, { levels, reactions: kinds });
  const close = typeof barClose === 'string' ? Date.parse(barClose) : barClose;
  const phase = !reactions.length ? null : Number.isFinite(close) && close === Date.parse(c.closedAt) ? 'reaction' : 'confirmation';
  const candle = { t: c.t, closedAt: c.closedAt };
  if (!reactions.length) return { available: true, moment: false, phase, candle, reactions, reason: `the last ${key} candle met no key level` };
  const top = reactions[0];
  return { available: true, moment: true, phase, candle, reactions, reason: `${key} ${top.rel} ${top.name}${reactions.length > 1 ? ` (+${reactions.length - 1})` : ''}, ${phase === 'reaction' ? 'reaction (the setup, on its own bar)' : phase}` };
}

/** Whether a bar is in the quiet sample: sha256(seed|symbol|bar) as a share, below the rate. */
function quietPick({ seed = 0, symbol = '', bar, rate = 0 }) {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const h = crypto.createHash('sha256').update(`${seed}|${symbol}|${bar}`).digest();
  return h.readUInt32BE(0) / 0x100000000 < rate;
}

/** Whether a practice bar runs a cycle, and why (manage, moment, quiet, unavailable, none). */
function selectBar({ practice, candles, symbol, bar, barClose, open = false }) {
  const p = { ...DEFAULTS, ...(practice || {}) };
  if (open) return { run: true, why: 'manage', moment: null, reason: 'practice: a position or working order is open, managed every bar' };
  const m = setupMoment(candles, { setupTf: p.setupTf, barClose, levels: p.levels, reactions: p.reactions });
  // No setup candle to read: the bar runs (practice never hides a bar it can't judge).
  if (!m.available) return { run: true, why: 'unavailable', moment: m, reason: `practice: ${m.reason}; the bar runs` };
  if (m.moment) return { run: true, why: 'moment', moment: m, reason: `practice: setup moment (${m.reason})` };
  if (quietPick({ seed: p.seed, symbol, bar, rate: p.quietSample })) return { run: true, why: 'quiet', moment: m, reason: `practice: quiet sample (${m.reason})` };
  return { run: false, why: 'none', moment: m, reason: `practice: no setup moment (${m.reason}); the clock advances` };
}

function practiceLine(p) {
  if (!p) return null;
  return `setup-focused practice: cycles only at ${tfLabel(p.setupTf)} candles that ${(p.reactions || DEFAULTS.reactions).join(' or ')} a ${p.levels === 'wide' ? 'key or moving level' : 'fixed key level or the VWAP'}, and their confirmation window, a ${Math.round(p.quietSample * 100)}% quiet sample (seed ${p.seed}), every bar with something open, premarket and end of day; not comparable bar for bar with a full-day run`;
}

/**
 * The setup moment as the model reads it in the bar briefing: the setup timeframe's last completed candle's reactions
 * at key levels, each with the side it points, and whether this bar is the reaction (the setup: the entry now, the next
 * bar fills it) or a later close while the setup still stands (no confirming read is needed: the setup is the entry). The same moment setup-focused practice and the curated lists
 * select, so what the model is shown and what it is scored on agree. A setup to check, never a signal: the model
 * composes and checks it, and passes unless every read is true.
 */
function checkLine(candles, { barClose, et = x => x, setupTf = DEFAULTS.setupTf, entries = 'allowed', max = MAX_CHECKS, checks = [], validBars = null } = {}) {
  // No entries in this window: nothing to compose now (the gate refuses one), so no line.
  if (entries !== 'allowed') return null;
  const m = setupMoment(candles, { setupTf, barClose });
  // The briefing's own setups (setupChecks: a compression break, a live CISD, on a side the trend rule allows), as reads.
  const extra = (checks || []).map(c => `"${c.read}" (${[c.side, ...(c.kind === 'cisd' ? [`${c.displacement} displacement`, c.status] : []), ...(c.level ? [`at ${c.level}`] : [])].join(', ')})`);
  const extraSkills = [...new Set((checks || []).map(c => c.kind))];
  if (!m.moment) return extra.length ? `- Setups to check: ${extra.join('; ')}. Compose and check each (trade-lifecycle, ${extraSkills.join(', ')}); pass unless every read is true; SKIP each one you don't compose, with its reason.` : null;
  const key = tfLabel(setupTf);
  // Each reaction as the compose read that states it, quoted, exactly as composed-reads.js parses and checks it
  // ("15m rejected overnight high down"): a copy is a TRUE read; its side and price outside the quotes (a bracket or a
  // price inside a read fails it). One with no direction points no side: not a setup. The same reaction once; the
  // strongest first (setupMoment's order, the one the curated lists score), at most `max` (the candle lines' cap).
  const seen = new Set();
  const shown = m.reactions.filter(r => r.dir === 'up' || r.dir === 'down')
    .filter(r => { const k = `${r.rel}|${r.dir}|${r.price}`; return !seen.has(k) && seen.add(k); }).slice(0, max);
  if (!shown.length && !extra.length) return null;
  if (!shown.length) return `- Setups to check: ${extra.join('; ')}. Compose and check each (trade-lifecycle, ${extraSkills.join(', ')}); pass unless every read is true; SKIP each one you don't compose, with its reason.`;
  const priced = r => (Number.isFinite(r.price) && !String(r.name).endsWith(String(r.price)) ? `, ${r.price}` : '');
  // Its setup candle: the chain's setup frame's last completed candle (candle-facts.js patternsOf's label and its close),
  // never the entry frame's (the owner: "it needs to read candle patterns at the setup").
  const sc = setupCandleText(candles);
  // The level by its read name (composed-reads.js levelName: "VWAP (rth)" is "vwap rth"; a bracket fails a read), as the
  // Standard plan line quotes it: a copy always parses.
  const { levelName } = require('../trading/composed-reads');
  const what = shown.map(r => `"${key} ${r.rel} ${levelName(r.name)} ${r.dir}" (${r.dir === 'up' ? 'long' : 'short'}${priced(r)}${sc ? `; setup candle: ${sc}` : ''})`).join('; ');
  // The compose plan's entry is a limit at the bar's close (trade-lifecycle.js planOf; a cited setup's, at market): it
  // fills only if a later bar trades to it while the record stands (the strategy's valid_bars).
  const within = Number.isInteger(validBars) && validBars > 0 ? `${validBars} bar${validBars === 1 ? '' : 's'}` : 'the record\'s valid_bars';
  const when = m.phase === 'reaction'
    ? `this bar closed the setup, no confirming read needed: the entry is a limit at this close; it fills if a later bar trades to it within ${within}`
    : 'the setup still stands: no confirming read needed';
  return `- Setups to check (the ${key} candle closed ${et(m.candle.closedAt)}): ${[what, ...extra].join('; ')}; ${when}. Compose and check each (trade-lifecycle, ${['rejection', 'breakout', ...extraSkills].join(', ')}); pass unless every read is true; SKIP each one you don't compose, with its reason.`;
}

/**
 * A setup candle's strength the side's way (`dir` up or down), for the order, counting: strong (cisd.js strongCandle's rule on
 * the briefing's candle: a body of at least minBody of its range the side's way, the close in the side's third, and an
 * engulfing or a range of at least minRangeAtr x ATR), its close in the side's third, its close not in the other third.
 * 0 without a candle.
 */
function setupCandleRank(c, dir) {
  if (!c || typeof c !== 'object' || !(c.h > c.l) || (dir !== 'up' && dir !== 'down')) return 0;
  const up = dir === 'up';
  const P = require('../trading/cisd').PARAMS;
  const range = c.h - c.l;
  const body = Math.abs(c.c - c.o) / range;
  const withDir = up ? c.c > c.o : c.c < c.o;
  const sideThird = c.closeLocation === (up ? 'top' : 'bottom');
  const notAgainst = c.closeLocation !== (up ? 'bottom' : 'top');
  const engulfing = c.pattern === (up ? 'bullish engulfing' : 'bearish engulfing');
  const strong = withDir && body >= P.minBody && sideThird && (engulfing || (Number.isFinite(c.rangeAtr) && c.rangeAtr >= P.minRangeAtr));
  return [strong, sideThird, notAgainst].filter(Boolean).length;
}

/** The chain's setup-frame candle as words: its pattern (none: no pattern) and its close's third, or null. */
function setupCandleText(candles) {
  const c = candles && typeof candles === 'object' ? candles[CHAIN.setup] : null;
  if (!c || c.unavailable || !c.closeLocation) return null;
  const pattern = c.pattern && c.pattern !== 'none' ? c.pattern : 'no pattern';
  return `${pattern}, close ${c.closeLocation} third`;
}

/**
 * The setups a bar briefing's Setups-to-check line lists (briefing.js: checkLine with setupChecks), as their reads:
 * what a cycle composes or skips with a reason (setup-skips.js). [] without the line.
 */
function listedReads(b) {
  const m3 = b && b.sections && b.sections.m3 ? b.sections.m3.data : null;
  if (!m3 || !m3.bar || !Number.isFinite(Date.parse(m3.bar.t))) return [];
  const line = checkLine(m3.candles, { barClose: Date.parse(m3.bar.t) + (Number(b.minutes) || 0) * 60000, entries: m3.windowEntries, checks: setupChecks(m3) });
  return line ? [...line.matchAll(/"([^"]+)"/g)].map(x => x[1]) : [];
}

// A live CISD: its OTE zone touched, or bounced from (cisd.js); waiting, weak, void or expired is no setup yet or any more.
const LIVE_CISD = new Set(['touched', 'bounced']);
// The setup frames (chain.js, the shipped chain): a CISD is a setup from the chain's setup frame up to its levels frame
// (the 4h chain: the 15m, and the 1h: the stronger context), a compression break from the setup frame up; one on a lower
// frame (the entry frame's 3m, the 5m) stays a briefing fact, never a setup to check (the entry rule refuses it as one).
const CH = require('../trading/chain');
const CHAIN = CH.chainOf(CH.SHIPPED);
const CISD_FRAMES = Object.freeze(CH.LADDER.filter((tf, i) => i >= CH.LADDER.indexOf(CHAIN.setup) && i <= CH.LADDER.indexOf(CHAIN.levels)));
const COMPRESSION_FRAMES = Object.freeze(CH.LADDER.slice(CH.LADDER.indexOf(CHAIN.setup)));
const minutesOf = tf => { const x = /^(\d+)([mh])$/.exec(String(tf)); return x ? Number(x[1]) * (x[2] === 'h' ? 60 : 1) : 0; };

/**
 * The briefing's setups beside the setup moment's reactions, on a side the trend rule allows (reasons.js trendRuleOf:
 * true), while the window allows entries: each timeframe's compression expanding out of its box (compression.js, the
 * read compose_check verifies: "<tf> compression break <dir>"), and its live CISD ("<tf> cisd <dir>"). The higher
 * timeframe first, at most `max`: [{ kind, tf, dir, side, read, level?, status?, displacement? }] (level: a compression
 * box at a key level, the name of the nearest at the break's edge, else at the other edge; a CISD's swept level: the
 * briefing's own facts, never inferred). A CISD only on the 15m or 1h, tradeable now; the stronger first.
 */
function setupChecks(m3, { max = MAX_CHECKS } = {}) {
  const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(m3) || m3.windowEntries !== 'allowed') return [];
  const rule = require('../trading/reasons').trendRuleOf(m3.trendRule);
  const sideOf = dir => (dir === 'up' ? 'long' : dir === 'down' ? 'short' : null);
  const out = [];
  for (const [tf, x] of Object.entries(isObj(m3.compression) ? m3.compression : {})) {
    const dir = isObj(x) && x.state === 'expanding' && isObj(x.break) ? x.break.dir : null;
    // At a key level: the box's levels (compression.js levelsAt: within its levelBandAtr of an edge, config), the break's
    // edge first; one inside the box is no edge.
    const edges = isObj(x) && isObj(x.box) && Array.isArray(x.box.levels) ? x.box.levels.filter(l => isObj(l) && (l.edge === 'top' || l.edge === 'bottom')) : [];
    const at = edges.find(l => l.edge === (dir === 'up' ? 'top' : 'bottom')) || edges[0] || null;
    if (COMPRESSION_FRAMES.includes(tf) && sideOf(dir) && rule[sideOf(dir)] === true) out.push({ kind: 'compression', tf, dir, side: sideOf(dir), read: `${tf} compression break ${dir}`, ...(at ? { level: at.name } : {}) });
  }
  // A CISD on the setup frames only (the 3m and 5m time the entry: the owner's top-down rule), tradeable now: its OTE
  // touched or bounced from, or freshly confirmed on its frame's last completed candle.
  for (const [tf, x] of Object.entries(isObj(m3.cisd) ? m3.cisd : {})) {
    if (!CISD_FRAMES.includes(tf) || !isObj(x)) continue;
    const fresh = x.status === 'waiting' && isObj(m3.candles) && isObj(m3.candles[tf]) && x.confirmedClose && x.confirmedClose === m3.candles[tf].closedAt;
    const dir = LIVE_CISD.has(x.status) || fresh ? (x.dir === 'bullish' ? 'up' : x.dir === 'bearish' ? 'down' : null) : null;
    if (!sideOf(dir) || rule[sideOf(dir)] !== true) continue;
    out.push({ kind: 'cisd', tf, dir, side: sideOf(dir), read: `${tf} cisd ${dir}`, status: fresh ? 'fresh confirmation' : `${x.status} OTE`,
      displacement: String(x.displacement || 'strong'), ...(isObj(x.sweep) && x.sweep.name ? { level: x.sweep.name } : {}) });
  }
  // The stronger setup candle first (the owner: read its strength and close, not its name): cisd.js's strong candle
  // the side's way (an engulfing one ranks with any other strong one, never above it), then its close third the side's
  // way, then the higher timeframe.
  const rank = c => setupCandleRank(isObj(m3.candles) ? m3.candles[c.tf] : null, c.dir);
  return out.sort((a, b) => rank(b) - rank(a) || minutesOf(b.tf) - minutesOf(a.tf)).slice(0, max);
}

module.exports = {
  CISD_FRAMES, COMPRESSION_FRAMES, setupCandleText, setupCandleRank, MODES, SETUP_TFS, LEVEL_SETS, REACTION_KINDS, DEFAULTS, KEY_LEVEL, MOVING_LEVEL, PREVIOUS_LEVEL, validatePractice, reactionsOf, setupMoment, quietPick, selectBar, practiceLine, tfLabel, checkLine, setupChecks, listedReads };
