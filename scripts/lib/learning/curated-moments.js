'use strict';

/**
 * The curated training lists' moments (the owner's curated, date-mixed practice set; curated-lists.js selects from
 * them): every setup moment of the history library (setup-library.js: the setup timeframe's completed candle reacting
 * at a fixed key level or a fair value gap's edge), with what the trend was when it happened, every read TRUE at its
 * decision bar, and the library's standard trade measured at it.
 *
 * Scanned on practice-train (use 'practice') for the training lists, or on practice-validate (use 'validate') for the
 * validation list, never test or final (learning/splits.js assertUse). The scan is the library's own walk
 * (setup-library.js scanLibrary: the reaction bar, then each confirming close until one composes, composeAt, the
 * experience log's limitOutcome), here with the use named and the briefing window a parameter: the default is the
 * live runner's history (mtf.js HISTORY_HOURS), so the 1h and 4h trend facts are the ones live reads. With the
 * library's window (700 bars) it gives the library's records (a test pins that parity).
 *
 * The trend (classify), from the briefing at the reaction bar (the reaction candle's close: only what was known then):
 *   clear up       the 1h and the 4h trend are both up (h1.h1.trend, h1.h4.trend), the 1h structure holds (its latest
 *                  break, h1.lastBreak.last, BOS or CHoCH, is up), no 15m CHoCH down is the latest 15m break
 *                  (m15.lastBreak.last), and the regime (m3.regime.primary) is not range. Clear down mirrors it.
 *   trend-end      the 4h trend is up (down), the 1h trend is not against it, and the latest 1h or 15m break is a
 *                  CHoCH against it: the trend breaking.
 *   chop           neither, and the regime is range or the 1h or 4h trend is range.
 *   mixed          anything else (no list).
 * The list (listOf):
 *   trend-up       a clear uptrend and a reaction with it at a key level (a long): a pullback's rejection, or a
 *                  breakout (a candle that broke a level up; a bearish gap's failure through its far edge is one).
 *   trend-down     the same in a clear downtrend (rejected or broke down, a short).
 *   counter-trend  a clear trend and the reaction against it (either kind).
 *   trend-end      a trend-end moment, either side.
 *   chop           a chop moment, either side.
 *   (none)         a mixed trend.
 * Each moment's reaction kind (reactionKindOf): rejection or breakout, at a level or a gap's edge (fvg rejection, fvg
 * breakout); the coverage splits by it.
 *
 * The reads (readsAt): every read of compose_check's vocabulary (composed-reads.js) the briefing at the decision bar
 * can state for the side (the trends, breaks, regime, day type, prior RTH range, trend rule and alignment; the reaction
 * level, VWAP and value; the reaction, CISDs, OTE, sweeps and setup-candle patterns; the base candle's close,
 * momentum, volume, participation, patterns and absorption; the standard's stop and target when it traded), run
 * through checkReads one step at a time, kept when TRUE ({ step, skill, read, agrees }). The skill of each read is
 * the trade-lifecycle crosswalk's (skills/trade-lifecycle/SKILL.md, its step table), one per read kind (READ_SKILL;
 * a test holds every one to its step's row). The library's own labels are normalised to the crosswalk's (SKILL_ALIAS:
 * its bias label mtf-bias-filter counts as multi-timeframe-analysis). pullback-vs-reversal has no read of its own: it is
 * counted when the reads show one exactly (shapeOf): a pullback is a true trend read the side's way, the side's
 * timeframe alignment read as pullback (m15.alignment: the higher frames with the side, the lowest against it, the
 * counter-move) and a rejection the side's way; a reversal is a true CHoCH the side's way.
 *
 * The outcome: the library's standard (status traded, no-room, not-composable, stop-under-floor, no-confirmation,
 * no-entry-window), with its R when traded and filled (result win, loss, scratch or unfilled). The gate's view: the
 * trend rule for the side (mtf.js trendRule on the multi-timeframe record built from the same bars, as the runner
 * writes it), and against a prevailing trend D2 (lifecycle-gate.js reversalAllowed, the gate's own function and
 * D2_TIERS on that record) on the standard's reads plus the CHoCH and 4h rejection reads true the side's way.
 * expected: take when the standard traded and the gate would allow it (the trend rule, or D2), else pass.
 *
 * The window (windowOf): from LEAD_SETUP setup candles before the reaction candle opened (so the facts build) to the
 * end of the reaction's confirmation window (or the decision close, if later), never past end of day. Never the
 * standard's exit: the pinned windows sit in the run home, and an end at the exit would tell the model the outcome
 * (what is open after a window is managed bar by bar until flat: curated-lists.js curatedPoints).
 *
 *   USES                                    the uses a scan takes: practice (practice-train), validate (practice-validate)
 *   scanMoments({ bars, root, minutes, tick, from, to, use, setupTf, eodOf, inSession, windowBars, stats })   [moment]
 *                                           (stats, when given, counts the briefings built)
 *   classify(briefing)                      { trend: 'up' | 'down' | null, state: clear | trend-end | chop | mixed, facts }
 *   listOf(state, trendDir, side, reaction) the list name, or null
 *   readsAt(briefing, { side, reaction, setupTf, standard, tick })   [{ step, skill, read, agrees }] (true reads)
 *   READ_SKILL, skillOfRead(step, read)      the crosswalk's skill for a read; normalSkill(label) the library's labels
 *   shapeOf(reads, side), reactionKindOf(reaction)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildBriefing, sessionWindow } = require('../trading/briefing');
const { checkReads, parseRead, levelName, ENTRY_PATTERNS } = require('../trading/composed-reads');
const { buildRecord, writeRecord } = require('../trading/mtf-state');
const { trendRule, RULE_FRAMES, HISTORY_HOURS } = require('../trading/mtf');
const { reversalAllowed } = require('../trading/lifecycle-gate');
const { limitOutcome } = require('./experience-log');
const { setupMoment, DEFAULTS } = require('./setup-moments');
const { composeAt, entryRead, setupKeyOf } = require('./setup-library');
const { assertUse, sessionDate } = require('./splits');
const { LISTS } = require('./curated-lists');

const VERSION = 1;
const USES = Object.freeze(['practice', 'validate']);
const LEAD_SETUP = 2;
/** The history library's skill labels that differ from the crosswalk's (setup-library.js labels its bias reads so). */
const SKILL_ALIAS = Object.freeze({ 'mtf-bias-filter': 'multi-timeframe-analysis' });
const SHAPE_SKILL = 'pullback-vs-reversal';
const FIRST_BAR = 300;

/** The trade-lifecycle crosswalk's skill for each kind of read, per step (its table, skills/trade-lifecycle/SKILL.md). */
const READ_SKILL = Object.freeze({
  bias: Object.freeze({ trend: 'multi-timeframe-analysis', trendRule: 'multi-timeframe-analysis', alignment: 'multi-timeframe-analysis', break: 'bos-vs-choch', priorRth: 'daily-bias', dayType: 'daily-bias', regime: 'trend-vs-range' }),
  location: Object.freeze({ at: 'levels-and-reactions', atFvg: 'fair-value-gaps', vwap: 'vwap-volume-profile', value: 'vwap-volume-profile' }),
  setup: Object.freeze({ rejected: 'rejection', broke: 'breakout', fvg: 'fair-value-gaps', pattern: 'candle-reading', cisd: 'cisd', ote: 'cisd', swept: 'breakout-vs-fakeout' }),
  entry: Object.freeze({ close: 'candle-reading', pattern: 'candle-reading', momentum: 'momentum-and-volume', volume: 'momentum-and-volume', participation: 'momentum-and-volume', absorption: 'absorption' }),
  stop: Object.freeze({ stop: 'invalidation' }),
  target: Object.freeze({ target: 'take-profit' }),
});

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const tfLabel = m => (m % 60 === 0 ? `${m / 60}h` : `${m}m`);
const sideOf = dir => (dir === 'up' ? 'long' : dir === 'down' ? 'short' : null);
const dirOf = side => (side === 'long' ? 'up' : side === 'short' ? 'down' : null);
const against = d => (d === 'up' ? 'down' : d === 'down' ? 'up' : null);
const sec = (b, name) => (isObj(b) && isObj(b.sections) && isObj(b.sections[name]) && isObj(b.sections[name].data) ? b.sections[name].data : {});

/** The crosswalk's skill for a read at its step, or null (a kind the step doesn't take). */
function skillOfRead(step, read) {
  const p = parseRead(read);
  const row = READ_SKILL[step] || {};
  if (p.kind === 'at') return /^(1m|3m|5m|15m|1h|4h) fvg$/.test(p.level) ? row.atFvg : row.at;
  if (p.kind === 'relation') return / fvg (low|high)$/.test(p.level) ? row.fvg : row[p.rel] || null;
  return row[p.kind] || null;
}

const lastBreak = x => (isObj(x) && isObj(x.last) ? { kind: String(x.last.kind || '').toLowerCase(), dir: x.last.direction } : null);

/** The trend at a reaction bar's briefing (see the header). */
function classify(b) {
  const h1 = sec(b, 'h1');
  const facts = {
    h1: isObj(h1.h1) ? h1.h1.trend || null : null, h4: isObj(h1.h4) ? h1.h4.trend || null : null,
    break1h: lastBreak(h1.lastBreak), break15m: lastBreak(sec(b, 'm15').lastBreak),
    regime: isObj(sec(b, 'm3').regime) ? sec(b, 'm3').regime.primary || null : null,
  };
  const chochAgainst = (x, d) => Boolean(x) && x.kind === 'choch' && x.dir === against(d);
  for (const d of ['up', 'down']) {
    if (facts.h1 === d && facts.h4 === d && facts.break1h && facts.break1h.dir === d && !chochAgainst(facts.break15m, d) && facts.regime !== 'range') return { trend: d, state: 'clear', facts };
  }
  for (const d of ['up', 'down']) {
    if (facts.h4 === d && facts.h1 !== against(d) && (chochAgainst(facts.break1h, d) || chochAgainst(facts.break15m, d))) return { trend: d, state: 'trend-end', facts };
  }
  if (facts.regime === 'range' || facts.h1 === 'range' || facts.h4 === 'range') return { trend: null, state: 'chop', facts };
  return { trend: null, state: 'mixed', facts };
}

function listOf(state, trend, side, reaction) {
  if (state === 'trend-end') return 'trend-end';
  if (state === 'chop') return 'chop';
  if (state !== 'clear') return null;
  if (dirOf(side) !== trend) return 'counter-trend';
  return reaction && ['rejected', 'broke'].includes(reaction.rel) ? `trend-${trend}` : null;
}

/** A reaction's kind for the coverage: rejection or breakout, at a level or a gap's edge. */
const reactionKindOf = r => `${r && r.kind === 'fvg' ? 'fvg ' : ''}${r && r.rel === 'broke' ? 'breakout' : 'rejection'}`;

/** The crosswalk's name for a skill label (SKILL_ALIAS), so the library's labels count where the crosswalk's do. */
const normalSkill = skill => SKILL_ALIAS[skill] || skill;

/** pullback or reversal when the reads show one exactly (see the header), else null. */
function shapeOf(reads, side) {
  const d = dirOf(side);
  const ok = r => r.agrees && parseRead(r.read);
  if (reads.some(r => ok(r) && ok(r).kind === 'break' && ok(r).breakKind === 'choch' && ok(r).value === d)) return 'reversal';
  const trend = reads.some(r => ok(r) && ok(r).kind === 'trend' && ok(r).value === d);
  const pullback = reads.some(r => ok(r) && ok(r).kind === 'alignment' && ok(r).side === side && ok(r).value === 'pullback');
  const rejection = reads.some(r => r.step === 'setup' && ok(r) && ok(r).kind === 'relation' && ok(r).rel === 'rejected' && ok(r).value === d);
  return trend && pullback && rejection ? 'pullback' : null;
}

/** The reads the briefing can state for the side, by step (candidates; readsAt keeps the true ones). */
function candidates(b, { side, reaction, setupTf, standard }) {
  const m3 = sec(b, 'm3');
  const m15 = sec(b, 'm15');
  const h1 = sec(b, 'h1');
  const base = tfLabel(b.minutes);
  const stf = tfLabel(setupTf);
  const d = dirOf(side);
  const out = { bias: [], location: [], setup: [], entry: [], stop: [], target: [] };
  for (const [tf, f] of [['15m', m15.frame], ['1h', h1.h1], ['4h', h1.h4]]) if (isObj(f) && ['up', 'down', 'range'].includes(f.trend)) out.bias.push(`${tf} ${f.trend}`);
  for (const [tf, x] of [[base, m3.lastBreak], ['15m', m15.lastBreak], ['1h', h1.lastBreak]]) {
    const lb = lastBreak(x);
    if (lb && ['bos', 'choch'].includes(lb.kind) && ['up', 'down'].includes(lb.dir)) out.bias.push(`${tf} ${lb.kind} ${lb.dir}`);
  }
  if (isObj(m3.regime) && m3.regime.primary) out.bias.push(`regime ${m3.regime.primary}`);
  if (isObj(m3.today) && m3.today.dayType) out.bias.push(`day type ${m3.today.dayType}`);
  if (isObj(m3.location) && ['above', 'below', 'inside'].includes(m3.location.priorRthRange)) out.bias.push(`${m3.location.priorRthRange} prior rth range`);
  out.bias.push(`trend ${side} allowed`);
  if (isObj(m15.alignment) && m15.alignment[side]) out.bias.push(`read ${side} ${m15.alignment[side]}`);
  const level = levelName(reaction.name);
  out.location.push(reaction.kind === 'fvg' ? `at ${level.split(' ')[0]} fvg` : `at ${level}`);
  if (isObj(m3.vwap) && m3.vwap.side) out.location.push(`vwap ${m3.vwap.side}`);
  if (isObj(m3.location) && m3.location.priorValue) out.location.push(`value ${m3.location.priorValue}`);
  out.setup.push(`${stf} ${reaction.rel} ${level} ${reaction.dir}`);
  for (const [tf, c] of Object.entries(isObj(m3.cisd) ? m3.cisd : {})) {
    if (!isObj(c)) continue;
    const cd = c.dir === 'bullish' ? 'up' : c.dir === 'bearish' ? 'down' : null;
    if (cd) out.setup.push(`${tf} cisd ${cd}`);
    if (c.priceInOte === true) out.setup.push(`${tf} in ote`);
  }
  for (const s of Array.isArray(m3.sweeps) ? m3.sweeps : []) if (isObj(s) && s.name) out.setup.push(`swept ${levelName(s.name)}`);
  const setupCandle = isObj(m3.candles) ? m3.candles[stf] : null;
  for (const p of isObj(setupCandle) && Array.isArray(setupCandle.patterns) ? setupCandle.patterns : []) if (!ENTRY_PATTERNS[p]) out.setup.push(`${stf} pattern ${p}`);
  const c4 = isObj(m3.candles) ? m3.candles['4h'] : null;
  for (const r of isObj(c4) && Array.isArray(c4.relations) ? c4.relations : []) if (isObj(r) && r.rel === 'rejected' && r.dir === d) out.setup.push(`4h rejected ${levelName(r.name)} ${d}`);
  const c = isObj(m3.candles) ? m3.candles[base] : null;
  if (isObj(c) && !c.unavailable) {
    if (c.closeLocation) out.entry.push(`${base} close ${c.closeLocation}`);
    out.entry.push(`${base} momentum ${d}`, `${base} volume high`, 'participation high', `${base} absorption at ${level} ${d}`);
    for (const p of [...new Set([...(Array.isArray(c.patterns) ? c.patterns : []), c.pattern].filter(Boolean))]) if (ENTRY_PATTERNS[p]) out.entry.push(`${base} pattern ${p}`);
  }
  for (const r of standard && Array.isArray(standard.reads) ? standard.reads : []) if (r.step === 'stop' || r.step === 'target') out[r.step].push(r.read);
  return out;
}

/** Every read true at the briefing for the side, checked by checkReads one step at a time: [{ step, skill, read, agrees }]. */
function readsAt(b, { side, reaction, setupTf = DEFAULTS.setupTf, standard = null, tick = 0.25 }) {
  const out = [];
  const seen = new Set();
  for (const [step, list] of Object.entries(candidates(b, { side, reaction, setupTf, standard }))) {
    const reads = [];
    for (const read of list) {
      const skill = skillOfRead(step, read);
      const form = parseRead(read).form;
      if (!skill || seen.has(form)) continue;
      seen.add(form);
      reads.push({ step, skill, read });
    }
    if (!reads.length) continue;
    const ch = checkReads({ reads, side, briefing: b, tick });
    for (const r of ch.reads) if (r.check === true) out.push({ step: r.step, skill: r.skill, read: r.read, agrees: r.agrees === true });
  }
  return out;
}

const resultOf = o => (!o || !o.filled ? 'unfilled' : o.R > 0 ? 'win' : o.R < 0 ? 'loss' : 'scratch');

/** The gate's view of the side at the decision bar: the trend rule, and D2 against a prevailing trend. */
function gateView({ home, root, bars, side, b, standard, nowMs, tick }) {
  const rec = buildRecord(bars, { symbol: root, now: new Date(nowMs) });
  const biases = Object.fromEntries(RULE_FRAMES.map(m => [m, rec.biases[m] === null ? NaN : rec.biases[m]]));
  const rule = trendRule(biases, side, 'trend');
  const view = { trendAllowed: rule.allowed === true, prevailing: rule.prevailing ? rule.prevailing.label : null, d2: null };
  if (rule.allowed || !rule.prevailing || !standard || standard.status !== 'traded') return view;
  const d = dirOf(side);
  const c4 = sec(b, 'm3').candles && sec(b, 'm3').candles['4h'];
  const rejections = (isObj(c4) && Array.isArray(c4.relations) ? c4.relations : []).filter(r => isObj(r) && r.rel === 'rejected' && r.dir === d).map(r => ({ step: 'setup', read: `4h rejected ${levelName(r.name)} ${d}` }));
  const wanted = [{ step: 'bias', read: `15m choch ${d}` }, { step: 'bias', read: `1h choch ${d}` }, ...rejections].map(r => ({ ...r, skill: skillOfRead(r.step, r.read) }));
  const extra = checkReads({ reads: wanted, side, briefing: b, tick }).reads.filter(r => r.check === true && r.agrees === true);
  const combo = [...standard.reads.map(r => ({ step: r.step, skill: normalSkill(r.skill), read: r.read })), ...extra.map(r => ({ step: r.step, skill: r.skill, read: r.read }))];
  const check = checkReads({ reads: combo, side, briefing: b, tick });
  writeRecord(home, rec);
  const r = reversalAllowed({ home, root, side, check, now: new Date(nowMs) });
  view.d2 = { against: r.against, allowed: r.ok === true, why: r.why };
  return view;
}

/** The window to replay (see the header): { from, to } ISO. */
function windowOf({ reactionAt, setupTf, eodMs, decisionClose }) {
  const step = setupTf * 60000;
  const reactionClose = Date.parse(reactionAt);
  const from = reactionClose - step - LEAD_SETUP * step;
  let to = Math.max(reactionClose + step, decisionClose);
  if (Number.isFinite(eodMs)) to = Math.min(to, eodMs);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

const idOf = (...parts) => require('crypto').createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/**
 * Every reaction moment of the bars in [from, to) (practice-train for use 'practice', practice-validate for
 * 'validate'), with its trend, list, true reads, the standard's outcome, the gate's view and the window: [moment].
 */
function scanMoments({ bars, root, minutes = 3, tick = 0.25, from, to, use, setupTf = DEFAULTS.setupTf, eodOf, inSession = () => true, windowBars = Math.ceil((HISTORY_HOURS * 60) / minutes), stats = null }) {
  if (!USES.includes(use)) throw new Error(`curated moments: use ${String(use)} refused; a list is scanned for ${USES.join(' or ')} only (test and final are sealed)`);
  assertUse(use, from, to);
  if (!(Number.isInteger(windowBars) && windowBars > FIRST_BAR)) throw new Error(`windowBars: a whole number above ${FIRST_BAR}`);
  const list = bars.map(x => ({ ...x, ms: Date.parse(x.t) }));
  const tfMs = minutes * 60000;
  const stepMs = setupTf * 60000;
  const span = Math.round(setupTf / minutes);
  const window = i => list.slice(Math.max(0, i - windowBars + 1), i + 1).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const st = stats || {};
  st.briefings = st.briefings || 0;
  const brief = i => (st.briefings += 1, buildBriefing({ symbol: root, bars: window(i), minutes, now: new Date(list[i].ms + tfMs) }));
  const first = sessionDate(from);
  const last = sessionDate(to);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-curated-'));
  const out = [];
  try {
    for (let i = FIRST_BAR; i < list.length; i += 1) {
      const close = list[i].ms + tfMs;
      if (close % stepMs !== 0 || !inSession(close)) continue;
      const day = sessionDate(close - 1);
      if (day < first || day >= last) continue;
      const b = brief(i);
      const m = setupMoment(sec(b, 'm3').candles, { setupTf, barClose: close });
      if (!m.moment || m.phase !== 'reaction') continue;
      const reaction = m.reactions[0];
      const side = sideOf(reaction.dir);
      if (!side) continue;
      // The library's walk: each confirming close after the reaction bar, while its candle is the last completed one.
      let at = { i, b, status: 'no-confirmation', why: null, standard: null };
      let tried = null;
      for (let j = i + 1; j < Math.min(list.length, i + span); j += 1) {
        const cj = list[j].ms + tfMs;
        if (cj % stepMs === 0 || !inSession(cj) || sessionDate(cj - 1) !== day) break;
        if (sessionWindow(new Date(cj)).entries !== 'allowed') {
          if (at.status === 'no-confirmation') at = { ...at, status: 'no-entry-window', why: sessionWindow(new Date(cj)).text, skipped: j };
          continue;
        }
        const bj = brief(j);
        const cand = sec(bj, 'm3').candles[tfLabel(setupTf)];
        if (!cand || cand.closedAt !== m.candle.closedAt) break;
        if (!entryRead(sec(bj, 'm3').candles[tfLabel(minutes)], side, tfLabel(minutes))) continue;
        const r = composeAt(bj, reaction, { side, tick, setupTf });
        tried = { i: j, b: bj };
        at = { i: j, b: bj, status: r.status, why: r.why || null, standard: r.status === 'traded' ? r : null };
        if (r.status === 'traded') break;
      }
      // The decision bar: the close tried last (its briefing), else the reaction bar; a no-entry-window moment is
      // recorded at its skipped close (the library's bar) but read and judged on the reaction bar's briefing.
      const decision = tried || { i, b };
      const recordBar = at.status === 'no-entry-window' && !tried ? at.skipped : decision.i;
      const decisionClose = list[decision.i].ms + tfMs;
      let outcome = null;
      if (at.standard) {
        const p = at.standard.plan;
        outcome = limitOutcome({ bars: list, tfMs, side, entry: p.entry.price, stop: p.stop.price, target: p.target.price, fromMs: decisionClose, expiresMs: new Date(at.b.sections.m3.validUntil).getTime(), eodMs: eodOf(decisionClose), tick });
      }
      const cls = classify(b);
      const listName = listOf(cls.state, cls.trend, side, reaction);
      const reads = readsAt(decision.b, { side, reaction, setupTf, standard: at.standard, tick });
      const gate = gateView({ home, root, bars: window(decision.i), side, b: decision.b, standard: at.standard, nowMs: decisionClose, tick });
      const regime = cls.facts.regime;
      const shape = shapeOf(reads, side);
      const skills = [...new Set([...reads.map(r => r.skill), ...(shape ? [SHAPE_SKILL] : [])])].sort();
      const aligned = [...new Set([...reads.filter(r => r.agrees).map(r => r.skill), ...(shape ? [SHAPE_SKILL] : [])])].sort();
      out.push({
        v: VERSION, use, id: idOf(root, m.candle.closedAt, reaction.name, reaction.rel), root, day, year: day.slice(0, 4), reactionAt: m.candle.closedAt,
        minutes, setupTf, bar: list[recordBar].t, reaction: { kind: reaction.kind, name: reaction.name, rel: reaction.rel, dir: reaction.dir, price: reaction.price },
        reactionKind: reactionKindOf(reaction), side, list: listName, trend: { state: cls.state, dir: cls.trend, ...cls.facts }, regime,
        reads, shape, skills, aligned,
        standard: { status: at.status, why: at.why, setupKey: at.standard ? setupKeyOf(at.standard.reads) : null, plan: at.standard ? { entry: at.standard.plan.entry.price, stop: at.standard.plan.stop.price, target: at.standard.plan.target.price, rr: at.standard.plan.rr } : null },
        outcome: at.status === 'traded' ? { result: resultOf(outcome), R: outcome && outcome.filled ? outcome.R : null, exitReason: outcome ? outcome.exitReason : null } : { result: at.status, R: null, exitReason: null },
        gate, expected: at.status === 'traded' && (gate.trendAllowed || (gate.d2 && gate.d2.allowed)) ? 'take' : 'pass',
        window: windowOf({ reactionAt: m.candle.closedAt, setupTf, eodMs: eodOf(decisionClose), decisionClose: Math.max(decisionClose, list[recordBar].ms + tfMs) }),
      });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  return out;
}

module.exports = { VERSION, USES, LISTS, LEAD_SETUP, READ_SKILL, SKILL_ALIAS, SHAPE_SKILL, skillOfRead, normalSkill, shapeOf, reactionKindOf, classify, listOf, readsAt, windowOf, scanMoments };
