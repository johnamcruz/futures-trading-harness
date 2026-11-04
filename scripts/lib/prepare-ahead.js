'use strict';

/**
 * Prepare ahead, shadow mode (docs/PREPARE-AHEAD.md, PR B1): the pure logic the runner's shadow runs on. The old path
 * keeps deciding everything; with the runner config's `prepareAhead: "shadow"` (Claude Code only) the runner, after a
 * cycle's result is final, (1) runs the shadow confirm of the plan prepared for this close and logs its decision next to
 * the cycle's own, then (2) prepares the next bar's plan. Neither composes, orders, launches a role or writes live
 * state: their runs are kept off compose_check, the order tools, the subagent tool and the data fetches by a narrower
 * --allowedTools (autotrader.js claudePrepareTools; the --disallowedTools, model, plugin dir and system-prompt file stay
 * the head trader's, so the prompt cache holds), and what they decide goes only into the cycle log's `prepare` field.
 *
 * Every time comes from the caller (the runner's harness clock, trading/harness-now.js); this module never reads the
 * wall clock.
 *
 *   MODES, modeProblem(value, harness), shadowOn(cfg)      the runner config's key ("on" is refused until B2)
 *   deadlineOf({ nowMs, nextCloseMs, eodMs, marginMs, maxMs })  { atMs, budgetMs, by }: the earliest of the next close
 *                                                         minus the margin, the end of day and now plus the most a run takes
 *   overran(deadline, nowMs)                              done after the deadline (an unreadable clock: yes)
 *   shouldPrepare({ killSwitch, flat, section, inSession, budgetMs })   { ok, why }
 *   windowOf(bars, windowBars), sectionFor(input)         the closed bars the prepare reads, and the "Possible at the next
 *                                                         close" section on them (the one adapter of next-close.js)
 *   deskKeys(reports), versionsOf(parts)                  the input versions a plan records and a close is compared by
 *   validate(plan, atClose)                               { status: valid | none | stale | void, reason, detail }
 *   planFile, writePlan, readPlan                         <home>/prepare/<symbol>-<bar>.json, atomic, keyed by the bar
 *   makePlan(parts), parsePlan(text)                      the plan record and its SCENARIO / STAND DOWN / INVALID lines
 *   firedReads({ scan, listed }), matchScenario(plan, fired), readKind(read)   the at-close match
 *   preparePrompt(parts), confirmPrompt(parts)            the two runs' prompts
 *   parseDecision(text), fullDecisionOf({ result, entry }), agreement(shadow, full)   the comparison
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./harness-run');

const MODES = Object.freeze(['off', 'shadow']);
/**
 * What the prepare and the shadow confirm may not use, beyond the head trader's own deny rules (kept identical, for the
 * prompt cache): by name from the harness tools' registry (harness-tools/registry.js) and the broker interface (autotrader.js claudePrepareTools takes
 * every other read from them). compose_check (the confirm decides nothing in shadow), the data fetches (a bar closing
 * inside the forming bar is a look-ahead: bars_fetch, get_bars, get_quote), the writes (blackouts_add; reconcile's
 * records). The order tools and the journal's write are no reads of the interface's; the subagent tool is never given.
 * The scripts: the reads only (no bars fetch, blackouts or lessons write, reconcile).
 */
const PREPARE_DENIED = Object.freeze({ harness: Object.freeze(['compose_check', 'bars_fetch', 'blackouts_add', 'reconcile']), broker: Object.freeze(['get_bars', 'get_quote']) });
const PREPARE_SCRIPTS = Object.freeze(['strategies.js', 'market-snapshot.js', 'mtf.js']);
const PLAN_DIR = 'prepare';
const SECTIONS = ['m3', 'm15', 'h1', 'day'];
const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/** The runner config's prepareAhead: the problem with it, or null (absent or "off": no delivery on any harness). */
function modeProblem(v, harness) {
  if (v === undefined || v === 'off') return null;
  if (v === 'on') return 'prepareAhead: "on" is not built yet (the confirm deciding comes in PR B2); use "shadow" to measure it beside the old path, or "off"';
  if (v !== 'shadow') return `prepareAhead: "off" or "shadow" (got ${JSON.stringify(v)})`;
  return harness === 'claude' ? null : `prepareAhead: for harness "claude" only (harness ${harness})`;
}

/** Shadow mode on (Claude Code, prepareAhead "shadow"). */
const shadowOn = cfg => Boolean(cfg) && cfg.harness === 'claude' && cfg.prepareAhead === 'shadow';

/** The deadline: the earliest of the next close minus the margin, the end of day, and now plus the most a run may take. */
function deadlineOf({ nowMs, nextCloseMs, eodMs = null, marginMs, maxMs }) {
  const cands = [['next-close', nextCloseMs - marginMs], ['end-of-day', Number.isFinite(eodMs) ? eodMs : Infinity], ['max', nowMs + maxMs]];
  const [by, atMs] = cands.reduce((a, b) => (b[1] < a[1] ? b : a));
  const budgetMs = Number.isFinite(nowMs) && Number.isFinite(atMs) ? Math.max(0, atMs - nowMs) : 0;
  return { atMs, budgetMs, by };
}

/** A run done after its deadline (judged by the clock given): aborted. An unreadable clock: aborted. */
const overran = (deadline, nowMs) => !(Number.isFinite(nowMs) && isObj(deadline) && Number.isFinite(deadline.atMs) && nowMs <= deadline.atMs);

/** Whether a prepare runs after this cycle: { ok, why } (the kill switch first). */
function shouldPrepare({ killSwitch, flat, section, inSession, budgetMs }) {
  const why = killSwitch !== false ? 'kill-switch'
    : flat !== true ? 'not-flat'
      : !isObj(section) ? 'no-section'
        : section.none || !Array.isArray(section.candidates) || !section.candidates.length ? 'nothing-can-fire'
          : inSession !== true ? 'out-of-session'
            : !(budgetMs > 0) ? 'no-time' : null;
  return { ok: why === null, why };
}

/** The bars the prepare reads: the last windowBars - 1 (the close reads them plus the new bar: docs/PREPARE-AHEAD.md). */
const windowOf = (bars, windowBars) => (Array.isArray(bars) && Number.isInteger(windowBars) && bars.length >= windowBars ? bars.slice(bars.length - (windowBars - 1)) : (bars || []));

/**
 * The "Possible at the next close" section for the prepare, from the closed bars up to the briefing's bar only (any bar
 * after it is never read), in the window the close will read. The one place next-close.js is called (its options pass
 * through). null when not flat.
 */
function sectionFor({ symbol, bars, minutes, briefing, flat, windowBars, ...opts }) {
  if (flat !== true) return null;
  if (!isObj(briefing) || typeof briefing.asOf !== 'string') throw new Error('prepare-ahead: the briefing of the last closed bar is required');
  const upTo = (bars || []).filter(b => b && Date.parse(b.t) <= Date.parse(briefing.asOf));
  if (!upTo.length || upTo[upTo.length - 1].t !== briefing.asOf) throw new Error('prepare-ahead: the briefing is not the last closed bar\'s (its bar is not among the bars)');
  return require('./trading/next-close').possibleAtNextClose({ symbol, bars: windowOf(upTo, windowBars), minutes, briefing, flat: true, ...opts });
}

/** Each desk report keyed by its role and text, with its end: { role: { key, until } }. */
function deskKeys(reports) {
  const out = {};
  for (const r of Array.isArray(reports) ? reports : []) {
    if (!r || typeof r.role !== 'string') continue;
    out[r.role] = { key: sha(`${r.role}\n${r.text || ''}`), until: typeof r.until === 'string' ? r.until : null };
  }
  return out;
}

/**
 * The input versions of a briefing's bar: its parts' versions and ends, the trend rule, the window's entries, and the
 * other parts the caller reads (the chain side on these bars, the phase-1 facts key, the desk's report keys, the
 * trading day, the news state at this close).
 */
function versionsOf({ briefing, chainSide = null, factsKey = null, desk = {}, day = null, news = null }) {
  const b = isObj(briefing) ? briefing : {};
  const s = isObj(b.sections) ? b.sections : {};
  const m3 = isObj(s.m3) && isObj(s.m3.data) ? s.m3.data : {};
  return {
    asOf: b.asOf || null, closedAt: b.closedAt || null,
    sections: Object.fromEntries(SECTIONS.map(p => [p, { version: isObj(s[p]) ? s[p].version || null : null, until: isObj(s[p]) ? s[p].validUntil || null : null }])),
    chainSide: Number.isFinite(chainSide) ? chainSide : null, trendRule: typeof m3.trendRule === 'string' ? m3.trendRule : null,
    window: typeof m3.windowEntries === 'string' ? m3.windowEntries : null,
    factsKey: typeof factsKey === 'string' && factsKey ? factsKey : null, desk: isObj(desk) ? desk : {}, day, news: isObj(news) ? { inBlackout: news.inBlackout ?? null } : { inBlackout: null },
  };
}

const voidOf = (reason, detail) => ({ status: 'void', reason, detail });

/**
 * The plan against the close's versions (docs/PREPARE-AHEAD.md, the failure table): valid, or why not. The close is
 * compared by the inputs the real cycle at the close started from.
 */
function validate(plan, at) {
  if (!isObj(plan)) return { status: 'none', reason: 'no-plan' };
  const p = plan.versions || {};
  const next = plan.next || {};
  if (!isObj(at) || at.asOf !== next.t) return { status: 'stale', reason: 'stale', detail: `the plan is for the bar opening ${next.t}, the close is ${at && at.asOf}'s` };
  const ses = plan.session || {};
  if (!ses.id || (ses.transcript && !fs.existsSync(ses.transcript))) return voidOf('session-missing', 'the prepare session\'s file is missing');
  if (!p.factsKey || !at.factsKey) return voidOf('facts-unknown', 'the account\'s facts key is unknown');
  if (p.factsKey !== at.factsKey) return voidOf('facts', 'the account\'s facts changed (a fill, a position or the P&L)');
  if (p.day !== at.day) return voidOf('day', 'the trading day changed');
  const closeMs = Date.parse(next.closedAt);
  for (const part of SECTIONS) {
    const was = (p.sections || {})[part] || {};
    const now = (at.sections || {})[part] || {};
    const rolls = part === 'm3' || Date.parse(was.until) <= closeMs;
    if (rolls && (part === 'h1' || part === 'day')) return voidOf(`htf-close:${part}`, `the ${part} part closes at the next close: no scenario covers it`);
    const want = rolls ? `${part}@${next.closedAt}` : was.version;
    if (!want || now.version !== want) return voidOf(`bars:${part}`, `the ${part} part is ${now.version}, the plan expected ${want}`);
  }
  if (!Number.isFinite(p.chainSide) || p.chainSide !== at.chainSide) return voidOf('chain-side', `the chain side is ${at.chainSide}, the plan's ${p.chainSide}`);
  if (!p.trendRule || p.trendRule !== at.trendRule) return voidOf('trend-rule', 'the trend rule changed');
  if (at.window !== 'allowed') return voidOf('window', `entries at the close: ${at.window}`);
  if (!at.news || at.news.inBlackout !== false) return voidOf('news', 'a news blackout (or an unreadable blackouts file) at the close');
  for (const [role, k] of Object.entries(p.desk || {})) {
    if (!k || !k.until || Date.parse(k.until) <= closeMs) continue;
    const now = (at.desk || {})[role];
    if (!now || now.key !== k.key) return voidOf('desk', `${role}'s report changed before it was due`);
  }
  return { status: 'valid' };
}

/**
 * The SessionStart hook's record of a prepare's or a shadow confirm's session (env FTH_PREPARE prepare or confirm, and
 * FTH_PREPARE_SESSION an absolute file the runner named): { sessionId, transcript, source }, written whole. Any other
 * run, or an input without a session id: nothing written (false).
 */
function recordSession(env, input) {
  const file = env && env.FTH_PREPARE_SESSION;
  if (!['prepare', 'confirm'].includes(env && env.FTH_PREPARE) || typeof file !== 'string' || !path.isAbsolute(file)) return false;
  if (!isObj(input) || typeof input.session_id !== 'string' || !input.session_id) return false;
  writeJsonAtomic(file, { sessionId: input.session_id, transcript: typeof input.transcript_path === 'string' ? input.transcript_path : null, source: typeof input.source === 'string' ? input.source : null });
  return true;
}
/** The session record (recordSession), or null. */
function readSession(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(s) && typeof s.sessionId === 'string' && s.sessionId ? s : null;
  } catch (_err) {
    return null;
  }
}

/** The gate log of the shadow's runs (<home>/prepare/gate-log.jsonl: autotrader.js childEnv), apart from the old path's. */
const shadowGateLog = home => path.join(home, PLAN_DIR, 'gate-log.jsonl');

/** The plan file for a symbol's bar (the bar the plan is for: the next bar's open time). */
const planFile = (home, symbol, barT) => path.join(home, PLAN_DIR, `${String(symbol).replace(/[^A-Za-z0-9]/g, '_')}-${String(barT).replace(/[^0-9TZ]/g, '')}.json`);
/** The plan written whole (a temp file renamed over it: harness-run.js writeJsonAtomic); its path. */
function writePlan(home, plan) {
  const file = planFile(home, plan.symbol, plan.next.t);
  writeJsonAtomic(file, plan);
  return file;
}
/** The plan for a symbol's bar, or null (none, unreadable, or a file whose own bar or symbol is another's). */
function readPlan(home, symbol, barT) {
  try {
    const p = JSON.parse(fs.readFileSync(planFile(home, symbol, barT), 'utf8'));
    return isObj(p) && p.symbol === symbol && isObj(p.next) && p.next.t === barT ? p : null;
  } catch (_err) {
    return null;
  }
}

const strip = s => String(s).replace(/\*\*|__|`/g, '');
/** A plan's text read: its SCENARIO lines, STAND DOWN and INVALID. */
function parsePlan(text) {
  const scenarios = [];
  let standDown = null;
  let invalid = null;
  for (const raw of String(text || '').split('\n')) {
    const line = strip(raw).replace(/^[\s>*-]+/, '').trim();
    const m = /^SCENARIO\s+(\d+)\s*:\s*(.+)$/i.exec(line);
    if (m) {
      const [candidate, rest = ''] = m[2].split(/\s*(?:→|->)\s*/);
      const part = (re) => { const x = re.exec(rest); return x ? x[1].trim() : null; };
      const reads = part(/;\s*reads:\s*(.*?)(?:;\s*why:|$)/i);
      const id = /\bP\d+\b/.exec(candidate);
      scenarios.push({ k: Number(m[1]), id: id ? id[0] : null, candidate: candidate.trim(), take: part(/TAKE if\s*(.*?)\s*\|\s*PASS if/i), pass: part(/\|\s*PASS if\s*(.*?)(?:;\s*reads:|;\s*why:|$)/i),
        reads: reads ? [...reads.matchAll(/"([^"]+)"/g)].map(x => x[1]) : [], why: part(/;\s*why:\s*(.*)$/i), line: raw });
      continue;
    }
    const sd = /^STAND DOWN if\s*:\s*(.+)$/i.exec(line);
    if (sd) { standDown = sd[1].trim(); continue; }
    const inv = /^INVALID if\s*:\s*(.+)$/i.exec(line);
    if (inv) invalid = inv[1].trim();
  }
  return { scenarios, standDown, invalid };
}

/** The plan record: the session, the input versions, the section's candidates, the text and its parse, an id. */
function makePlan({ symbol, bar, next, madeAt, ms, session, versions, candidates, text, usage = null }) {
  const parsed = parsePlan(text);
  const id = sha(`${symbol}|${next.t}|${(session || {}).id || ''}|${madeAt}`);
  return { v: 1, id, symbol, bar, next, madeAt, ms, session: { id: (session || {}).id || null, transcript: (session || {}).transcript || null }, versions, candidates: (candidates || []).map(c => ({ id: c.id, kind: c.kind, read: c.read, side: c.side, tf: c.tf })), text, ...parsed, usage };
}

/** What fired at the close: the rules strategies the real scan fired, then the at-close briefing's setups to check. */
function firedReads({ scan, listed }) {
  const out = [];
  for (const r of Array.isArray(scan) ? scan : []) if (r && r.candidate && r.signal === 'rules' && (r.direction === 'long' || r.direction === 'short')) out.push(`${r.name} fired ${r.direction === 'long' ? 'up' : 'down'}`);
  for (const l of Array.isArray(listed) ? listed : []) if (typeof l === 'string') out.push(l);
  return [...new Set(out)];
}

/** The scenario what fired at the close is (by its candidate's read), or outside the plan, or nothing fired. */
function matchScenario(plan, fired) {
  const list = (fired || []).filter(Boolean);
  if (!list.length) return { status: 'nothing-fired', fired: [] };
  const cands = (plan && plan.candidates) || [];
  const readOf = s => { const c = s.id ? cands.find(x => x.id === s.id) : cands.find(x => norm(s.candidate).includes(norm(`"${x.read}"`)) || norm(s.candidate) === norm(x.read)); return c || null; };
  const scen = ((plan && plan.scenarios) || []).map(s => ({ s, c: readOf(s) })).filter(x => x.c);
  const hit = scen.find(x => list.some(f => norm(f) === norm(x.c.read)));
  if (!hit) return { status: 'outside', fired: list };
  return { status: 'matched', k: hit.s.k, id: hit.c.id, read: hit.c.read, side: hit.c.side, unplanned: list.filter(f => !scen.some(x => norm(x.c.read) === norm(f))) };
}

/** A fired read's level kind (v1 lists the fixed levels and momentum only): vwap | profile | fvg | momentum | other. */
function readKind(read) {
  const r = norm(read);
  if (/\bfired (up|down)$/.test(r)) return 'momentum';
  if (/\bvwap\b/.test(r)) return 'vwap';
  if (/\bfvg\b|fair value gap/.test(r)) return 'fvg';
  if (/\b(session|developing) (poc|vah|val)\b|\bprofile\b/.test(r)) return 'profile';
  return 'other';
}

const FORMAT = [
  'SCENARIO k: <candidate id and its read, from "Possible at the next close"> → TAKE if <conditions on the closing candle> | PASS if <...>; reads: <the compose reads, each in quotes, in the briefing\'s read names>; why: <one line>',
  'STAND DOWN if: <account, room, window, news, a level breaking>',
  'INVALID if: <what voids the plan before the close>',
];
/** The prepare's prompt: the head's stable start, the account, the desk's reports, the prepare briefing, the format. */
function preparePrompt({ head, account = '', reports = [], briefingText, next }) {
  const desk = (reports || []).filter(r => r && r.text).map(r => `\n[${r.role}]\n${r.text}`).join('');
  return `${head} Prepare ahead (a bar plan, no trade this run): the bar opening ${next.t} closes at ${next.closedAt}. Reason through the trader process on the closed bars below, as for a cycle, at the same depth, and write the bar plan for that close; no compose_check, no order and no role this run (their tools are not available).${account}`
    + `${desk ? `\nThe desk's latest reports:${desk}` : ''}\nThe prepare briefing (closed bars only):\n${briefingText}\nWrite one line per scenario, then the two lines after them, in exactly this form:\n${FORMAT.join('\n')}\nEnd with the line PLAN END.`;
}

/** The shadow confirm's prompt: the at-close facts first, then the plan's scenario, the rule, the DECISION line. */
function confirmPrompt({ atCloseText, fired = [], scenario, next }) {
  return `The bar opening ${next.t} has closed (${next.closedAt}). The at-close facts (code, read fresh at the close; they decide, never the plan):\n${atCloseText}\nWhat fired at the close: ${fired.length ? fired.map(f => `"${f}"`).join(', ') : 'nothing'}.\n`
    + `Your plan said: scenario ${scenario.k}:\n${scenario.line}\nThe candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass.\n`
    + `This is a shadow run beside the real cycle: do not call compose_check, place no order and launch no role. End with exactly one line: DECISION: TAKE ${scenario.k} | DECISION: PASS - <why>.`;
}

/** The shadow confirm's decision: its last line-start DECISION line (TAKE k or PASS), or null. */
function parseDecision(text) {
  const lines = [...strip(String(text || '')).matchAll(/^[ \t>*-]*DECISION:\s*(TAKE\s+(\d+)|PASS)\b/gim)];
  const m = lines.at(-1);
  if (!m) return null;
  return /^pass/i.test(m[1]) ? { decision: 'pass', k: null } : { decision: 'take', k: Number(m[2]) };
}

/** The full cycle's real decision: executed a take (its side), the head trader's no-trade a pass; else none, why. */
function fullDecisionOf({ result, entry }) {
  const word = require('./autotrader').outcomeOf(result);
  const out = entry && typeof entry.outcome === 'string' ? entry.outcome : null;
  if (!word) return { decision: null, side: null, why: 'no result' };
  if (word === 'executed') { const s = /\b(long|short)\b/.exec(String(result)); return { decision: 'take', side: s ? s[1] : null, why: null }; }
  if (word === 'no-trade' && (!out || out === 'no-trade')) return { decision: 'pass', side: null, why: null };
  return { decision: null, side: null, why: word === 'no-trade' ? out : word };
}

/** The shadow decision against the full cycle's: true, false, or null (either unknown). */
function agreement(shadow, full) {
  if (!shadow || !full || !shadow.decision || !full.decision) return null;
  if (shadow.decision !== full.decision) return false;
  return shadow.decision === 'pass' || !shadow.side || !full.side || shadow.side === full.side;
}

module.exports = {
  MODES, PLAN_DIR, PREPARE_DENIED, PREPARE_SCRIPTS, modeProblem, shadowOn, deadlineOf, overran, shouldPrepare, windowOf, sectionFor, deskKeys, versionsOf, validate,
  recordSession, readSession, shadowGateLog, planFile, writePlan, readPlan, makePlan, parsePlan, firedReads, matchScenario, readKind, preparePrompt, confirmPrompt, parseDecision, fullDecisionOf, agreement,
};
