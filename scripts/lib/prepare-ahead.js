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
 *   MODES, modeProblem(value, harness), shadowOn(cfg)      the runner config's key (off, shadow, on), onOn(cfg)
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
 *   firedReads({ scan, listed }), matchScenario(plan, fired), readKind(read)   the at-close match (every scenario that fired)
 *   matchedScenarios(plan, match)                         the matched scenarios themselves, in plan order, with their kinds
 *   preparePrompt(parts), confirmPrompt(parts)            the two runs' prompts
 *   confirmPath({ plan, at, fired, killSwitch, flat })    "on" at the close: the confirm, or the full head trader and why
 *   confirmSuffix({ matched | scenario, kind, unplanned })   "on": the confirm's message after the at-close facts
 *   standingLine(k)                                       a standing scenario's line (the confirm's and the shadow's)
 *   forbiddenIn(output, allowed)                          a run's forbidden-tool attempts, from its transcript
 *   parseDecision(text), fullDecisionOf({ result, entry }), agreement(shadow, full)   the comparison
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./harness-run');

const MODES = Object.freeze(['off', 'shadow', 'on']);
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
  if (v !== 'shadow' && v !== 'on') return `prepareAhead: "off", "shadow" or "on" (got ${JSON.stringify(v)})`;
  return harness === 'claude' ? null : `prepareAhead: for harness "claude" only (harness ${harness})`;
}

/** "on" needs headSkillsInPrompt (autotrader.js validateConfig refuses it otherwise, as does the training preflight). */
const ON_NEEDS = 'prepareAhead: "on" needs headSkillsInPrompt: true (the head trader\'s skills embedded and attested on the confirm\'s own run: the prepare\'s skill loads are never in the confirm\'s stream, so without it every confirm\'s entry is refused at the executor [skills-loaded])';

/** Shadow mode on (Claude Code, prepareAhead "shadow"). */
const shadowOn = cfg => Boolean(cfg) && cfg.harness === 'claude' && cfg.prepareAhead === 'shadow';
/** "on" (Claude Code, prepareAhead "on"): the confirm decides (PR B2). */
const onOn = cfg => Boolean(cfg) && cfg.harness === 'claude' && cfg.prepareAhead === 'on';

/**
 * The deadline: the earliest of the next close less the margin, the end of day less the margin, and now plus the most a
 * run may take, each less the kill grace (`graceMs`: a run stopped at its deadline is gone before the bound, the SIGKILL
 * after SIGTERM included). Less than the grace left: no time (0).
 */
function deadlineOf({ nowMs, nextCloseMs, eodMs = null, marginMs, maxMs, graceMs = 0 }) {
  const cands = [['next-close', nextCloseMs - marginMs], ['end-of-day', Number.isFinite(eodMs) ? eodMs - marginMs : Infinity], ['max', nowMs + maxMs]];
  const [by, bound] = cands.reduce((a, b) => (b[1] < a[1] ? b : a));
  const atMs = bound - graceMs;
  const left = Number.isFinite(nowMs) && Number.isFinite(atMs) ? Math.max(0, atMs - nowMs) : 0;
  return { atMs, budgetMs: left < graceMs ? 0 : left, by };
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
function validate(plan, at, { ignoreHourClose = false } = {}) {
  if (!isObj(plan)) return { status: 'none', reason: 'no-plan' };
  const p = plan.versions || {};
  const next = plan.next || {};
  if (!isObj(at) || at.asOf !== next.t) return { status: 'stale', reason: 'stale', detail: `the plan is for the bar opening ${next.t}, the close is ${at && at.asOf}'s` };
  const ses = plan.session || {};
  if (!ses.id || (ses.transcript && !fs.existsSync(ses.transcript))) return voidOf('session-missing', 'the prepare session\'s file is missing');
  // A stand-down window first: the facts key reads the window too, so a window change would void as `facts` otherwise.
  if (at.window !== 'allowed') return voidOf('window', `entries at the close: ${at.window}`);
  if (!p.factsKey || !at.factsKey) return voidOf('facts-unknown', 'the account\'s facts key is unknown');
  if (p.factsKey !== at.factsKey) return voidOf('facts', 'the account\'s facts changed (a fill, a position or the P&L)');
  if (p.day !== at.day) return voidOf('day', 'the trading day changed');
  const closeMs = Date.parse(next.closedAt);
  for (const part of SECTIONS) {
    const was = (p.sections || {})[part] || {};
    const now = (at.sections || {})[part] || {};
    const rolls = part === 'm3' || Date.parse(was.until) <= closeMs;
    // ignoreHourClose: the counterfactual the shadow log reports (the 1h close as if a scenario covered it; it must
    // still have rolled to the close, and every other input is checked). The day's close is never ignored.
    if (rolls && (part === 'day' || (part === 'h1' && !ignoreHourClose))) return voidOf(`htf-close:${part}`, `the ${part} part closes at the next close: no scenario covers it`);
    const want = rolls ? `${part}@${next.closedAt}` : was.version;
    if (!want || now.version !== want) return voidOf(`bars:${part}`, `the ${part} part is ${now.version}, the plan expected ${want}`);
  }
  if (!Number.isFinite(p.chainSide) || p.chainSide !== at.chainSide) return voidOf('chain-side', `the chain side is ${at.chainSide}, the plan's ${p.chainSide}`);
  if (!p.trendRule || p.trendRule !== at.trendRule) return voidOf('trend-rule', 'the trend rule changed');
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
/**
 * The plan written whole (a temp file renamed over it: harness-run.js writeJsonAtomic); its path. The symbol's plans of
 * earlier trading days are removed then (a plan is read only at its own close), so the folder holds a day's at most.
 */
function writePlan(home, plan) {
  const file = planFile(home, plan.symbol, plan.next.t);
  writeJsonAtomic(file, plan);
  const { tradingDayKey } = require('./trading/clock');
  const day = tradingDayKey(new Date(plan.next.t));
  const dir = path.dirname(file);
  const own = `${String(plan.symbol).replace(/[^A-Za-z0-9]/g, '_')}-`;
  for (const f of fs.readdirSync(dir).filter(x => x.startsWith(own) && x.endsWith('.json') && path.join(dir, x) !== file)) {
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).next.t; } catch (_err) { t = null; }
    if (t && tradingDayKey(new Date(t)) < day) { try { fs.unlinkSync(path.join(dir, f)); } catch (_err) { /* gone */ } }
  }
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

/**
 * The plan record: the session, the input versions, the section's candidates, the text and its parse, an id; `base`: the
 * prepare session's message uuids, sealed (trading/confirm-base.js baseOf: the runner's, read from its session file),
 * which "on" names to the confirm (FTH_CONFIRM_BASE) so the gate reads the fork without them.
 */
function makePlan({ symbol, bar, next, madeAt, ms, session, versions, candidates, text, usage = null, base = null }) {
  const parsed = parsePlan(text);
  const id = sha(`${symbol}|${next.t}|${(session || {}).id || ''}|${madeAt}`);
  return { v: 1, id, symbol, bar, next, madeAt, ms, session: { id: (session || {}).id || null, transcript: (session || {}).transcript || null }, versions, candidates: (candidates || []).map(c => ({ id: c.id, kind: c.kind, read: c.read, side: c.side, tf: c.tf })), text, ...parsed, usage, ...(base ? { base } : {}) };
}

/** A plan's base whole: its uuids, sealed by the runner (trading/confirm-base.js baseRecord). */
const baseWhole = plan => {
  const b = isObj(plan) && isObj(plan.base) ? plan.base : null;
  if (!b || !Array.isArray(b.uuids) || !b.uuids.length || !b.uuids.every(u => typeof u === 'string' && u)) return false;
  return require('./trading/confirm-base').baseRecord(b.transcript, b.uuids).sha === b.sha;
};

/**
 * "on", at the close (docs/PREPARE-AHEAD.md, "On: the confirm decides"): the confirm, or the full head trader's run and
 * why. In order: the kill switch; an open position or working order (`flat` not true: management); no plan, a stale one,
 * a void one (validate: every input version, the session's file); a plan without its whole base (the confirm could not
 * be told from the prepare); what fired outside the plan, or nothing. What fired is always the real at-close scan's
 * (`fired`: firedReads); the plan's thresholds never decide. { path: 'confirm', match, scenario, kind (the primary's: the
 * first matched in plan order, its candidate's kind), matched (every matched scenario in plan order: matchedScenarios),
 * fired, unplanned } or
 * { path: kill-switch | not-flat | no-plan | stale | void | no-base | outside | nothing-fired, reason?, detail?, fired }.
 */
function confirmPath({ plan, at, fired = [], killSwitch = true, flat = null }) {
  if (killSwitch !== false) return { path: 'kill-switch', fired };
  if (flat !== true) return { path: 'not-flat', fired };
  if (!isObj(plan)) return { path: 'no-plan', fired };
  const v = validate(plan, at);
  if (v.status !== 'valid') return { path: v.status === 'void' ? 'void' : v.status === 'stale' ? 'stale' : 'no-plan', ...(v.status === 'void' ? { reason: v.reason } : {}), ...(v.detail ? { detail: v.detail } : {}), fired };
  if (!baseWhole(plan)) return { path: 'no-base', fired };
  const m = matchScenario(plan, fired);
  if (m.status !== 'matched') return { path: m.status, fired };
  const matched = matchedScenarios(plan, m);
  return { path: 'confirm', match: { k: m.k, id: m.id, read: m.read, side: m.side }, scenario: matched[0].scenario, kind: matched[0].kind, matched, fired, unplanned: m.unplanned };
}

/** The one sentence that names the skill teaching the format and the rule (skills/prepare-ahead), in the prepare prompt only: the confirm forks the prepare's session and carries the rule inline, so a lookup there would add a tool turn to the close-to-order path. */
const SKILL_NOTE = 'Read the prepare-ahead skill with skill_lookup for the format and the rule.';

/** The matched scenarios: `matched` ([{ scenario, kind }], plan order), else the one `scenario` with its `kind`. */
const matchedOf = ({ scenario, kind = null, matched }) => (Array.isArray(matched) && matched.length ? matched : [{ scenario, kind }]);
/** "Your plan said: scenario k:" and its line, then each further matched scenario's "scenario k:" and line, in plan order. */
const planSaid = list => `Your plan said: ${list.map(({ scenario: s }) => `scenario ${s.k}:\n${s.line}\n`).join('')}`;
/**
 * A standing scenario (next-close.js: the reaction the briefing lists, its candle closed before the bar): its TAKE needs
 * nothing of the closing candle; said, so none is invented (PR C2's line). The one place it is written: the confirm and
 * the shadow confirm both say it, once per matched standing scenario.
 */
const standingLine = k => `Scenario ${k} is a standing setup: the setup is the reaction the briefing lists, its candle already closed, so its TAKE needs nothing of the closing candle; compose_check on the at-close reads is the check.`;
const standingLines = list => list.filter(x => x.kind === 'standing').map(({ scenario: s }) => ` ${standingLine(s.k)}`).join('');

/**
 * The confirm's user message after the at-close facts (the cycle's own prompt and its reads, which come first): each
 * matched scenario's line in plan order (`matched`, or the one `scenario` and its `kind`), the rule (rule first, bold in
 * the skills: PR C), the standing line for each standing one, what fired outside the plan. It composes through
 * compose_check as the cycle's prompt says, or passes.
 */
function confirmSuffix({ scenario, unplanned = [], kind = null, matched = null }) {
  const list = matchedOf({ scenario, kind, matched });
  const more = (unplanned || []).length ? `\nAlso fired at this close, outside your plan: ${unplanned.map(f => `"${f}"`).join(', ')}: judge it from the facts above, in full.` : '';
  return `\n\nPrepare ahead: you planned this close during the bar (above in this session, from closed bars only). ${planSaid(list)}`
    + `The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass. The at-close facts above decide, never the plan: confirming is compose_check with the reads as these facts give them, then as this cycle's prompt says; passing is its CYCLE RESULT with why.${standingLines(list)}${more}`;
}

/** What fired at the close: the rules strategies the real scan fired, then the at-close briefing's setups to check. */
function firedReads({ scan, listed }) {
  const out = [];
  for (const r of Array.isArray(scan) ? scan : []) if (r && r.candidate && r.signal === 'rules' && (r.direction === 'long' || r.direction === 'short')) out.push(`${r.name} fired ${r.direction === 'long' ? 'up' : 'down'}`);
  for (const l of Array.isArray(listed) ? listed : []) if (typeof l === 'string') out.push(l);
  return [...new Set(out)];
}

/** Each of a plan's scenarios with its candidate (by its id, else by the read it names), in plan order; none: dropped. */
function scenarioCandidates(plan) {
  const cands = (plan && plan.candidates) || [];
  const readOf = s => { const c = s.id ? cands.find(x => x.id === s.id) : cands.find(x => norm(s.candidate).includes(norm(`"${x.read}"`)) || norm(s.candidate) === norm(x.read)); return c || null; };
  return ((plan && plan.scenarios) || []).map(s => ({ s, c: readOf(s) })).filter(x => x.c);
}

/**
 * The scenarios what fired at the close is (by their candidates' reads), or outside the plan, or nothing fired. Matched:
 * `matches`, every scenario that fired, in plan order (each { k, id, read, side, kind }: its candidate's), the first also
 * as the top-level k, id, read, side (the primary, as before PR C3); `unplanned` what fired that no scenario covers.
 */
function matchScenario(plan, fired) {
  const list = (fired || []).filter(Boolean);
  if (!list.length) return { status: 'nothing-fired', fired: [] };
  const scen = scenarioCandidates(plan);
  const hits = scen.filter(x => list.some(f => norm(f) === norm(x.c.read)));
  if (!hits.length) return { status: 'outside', fired: list };
  const [hit] = hits;
  return {
    status: 'matched', k: hit.s.k, id: hit.c.id, read: hit.c.read, side: hit.c.side,
    matches: hits.map(x => ({ k: x.s.k, id: x.c.id, read: x.c.read, side: x.c.side, kind: x.c.kind || null })),
    unplanned: list.filter(f => !scen.some(x => norm(x.c.read) === norm(f))),
  };
}

/**
 * The matched scenarios themselves, in plan order: [{ scenario, kind }] (each its own line, so a plan that numbers two
 * lines alike names both), for the confirm's message and the shadow confirm's prompt. Not matched: [].
 */
function matchedScenarios(plan, m) {
  if (!m || m.status !== 'matched') return [];
  const fired = new Set((m.matches || []).map(x => norm(x.read)));
  return scenarioCandidates(plan).filter(x => fired.has(norm(x.c.read))).map(x => ({ scenario: x.s, kind: x.c.kind || null }));
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
    + `${desk ? `\nThe desk's latest reports:${desk}` : ''}\nThe prepare briefing (closed bars only):\n${briefingText}\nWrite one line per scenario, then the two lines after them, in exactly this form:\n${FORMAT.join('\n')}\nEnd with the line PLAN END. ${SKILL_NOTE}`;
}

/**
 * The shadow confirm's prompt: the at-close facts first, then each matched scenario's line in plan order (as the confirm
 * names them: `matched`, or the one `scenario` and its `kind`), the rule, the standing line for each standing one (what
 * "on" sends), the DECISION line (a TAKE per matched scenario, or PASS).
 */
function confirmPrompt({ atCloseText, fired = [], scenario, kind = null, matched = null, next }) {
  const list = matchedOf({ scenario, kind, matched });
  return `The bar opening ${next.t} has closed (${next.closedAt}). The at-close facts (code, read fresh at the close; they decide, never the plan):\n${atCloseText}\nWhat fired at the close: ${fired.length ? fired.map(f => `"${f}"`).join(', ') : 'nothing'}.\n`
    + `${planSaid(list)}The candle decides: confirm a scenario only if the closed candle meets its TAKE conditions; else pass.${standingLines(list)}\n`
    + `This is a shadow run beside the real cycle: do not call compose_check, place no order and launch no role. End with exactly one line: ${list.map(({ scenario: s }) => `DECISION: TAKE ${s.k} | `).join('')}DECISION: PASS - <why>.`;
}

const DENIED_BY_CLI = /^Permission to use \S+ has been denied/;
/**
 * A run's forbidden-tool attempts, from its own transcript (its stream-json `output`): each tool_use, in order, of a tool
 * its allow list (`allowed`, its --allowedTools: a tool by name or a whole MCP server) does not hold, and each answered
 * by the CLI's own denial (a shell command, which its read-only commands make no allow rule decide). The CLI runs its
 * PreToolUse hooks before the permission check (docs/PREPARE-AHEAD.md), so a call a hook refused is never among its
 * permission_denials: only the transcript shows every attempt. Its tools' names.
 */
function forbiddenIn(output, allowed) {
  const list = Array.isArray(allowed) ? allowed : [];
  const holds = name => list.includes(name) || list.some(a => /^mcp__[a-z0-9-]+$/.test(a) && name.startsWith(`${a}__`));
  const uses = new Map();
  const out = [];
  for (const line of String(output || '').split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    const content = isObj(ev) && isObj(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
    for (const c of content) {
      if (!isObj(c)) continue;
      if (c.type === 'tool_use' && typeof c.name === 'string' && typeof c.id === 'string') {
        uses.set(c.id, c.name);
        if (c.name !== 'Bash' && !holds(c.name)) out.push({ id: c.id, name: c.name });
      }
      if (c.type === 'tool_result' && c.is_error === true && uses.has(c.tool_use_id) && !out.some(x => x.id === c.tool_use_id)) {
        const text = typeof c.content === 'string' ? c.content : (Array.isArray(c.content) ? c.content.map(b => (isObj(b) ? b.text || '' : '')).join('') : '');
        if (DENIED_BY_CLI.test(text.trim())) out.push({ id: c.tool_use_id, name: uses.get(c.tool_use_id) });
      }
    }
  }
  const order = [...uses.keys()];
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map(x => x.name);
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
  if (shadow.decision === 'pass') return true;
  // A take on an unknown side (either one): no verdict.
  return shadow.side && full.side ? shadow.side === full.side : null;
}

module.exports = {
  MODES, ON_NEEDS, FORMAT, SKILL_NOTE, PLAN_DIR, PREPARE_DENIED, PREPARE_SCRIPTS, modeProblem, shadowOn, onOn, deadlineOf, overran, shouldPrepare, windowOf, sectionFor, deskKeys, versionsOf, validate,
  recordSession, readSession, shadowGateLog, planFile, writePlan, readPlan, makePlan, parsePlan, confirmPath, confirmSuffix, standingLine, firedReads, matchScenario, matchedScenarios, readKind, preparePrompt, confirmPrompt, forbiddenIn, parseDecision, fullDecisionOf, agreement,
};
