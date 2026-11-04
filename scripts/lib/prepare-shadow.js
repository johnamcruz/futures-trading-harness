'use strict';

/**
 * Prepare ahead, shadow mode (docs/PREPARE-AHEAD.md, PR B1): what the runner does after a cycle whose result is final,
 * with the runner config's prepareAhead "shadow" (runner.js; wired by runner-wiring.js prepareShadowFor). The old path
 * has decided; nothing here composes, orders, launches a role or writes live state (the runs' tools: autotrader.js
 * claudePrepareTools). Two steps, both before the next close less config/runner.json prepare.marginMs (the harness clock):
 *
 *   1. The shadow confirm of the plan made for this close (prepare-ahead.js readPlan, keyed by this bar): validated against
 *      the inputs the real cycle at this close started from (validate), what fired matched to its scenarios
 *      (matchScenario), and when valid and matched, the confirm run: a fork of the prepare's session (--resume
 *      --fork-session), the at-close facts first, then its scenario; its DECISION line beside the full cycle's decision.
 *   2. The prepare of the next bar's plan, when shouldPrepare holds (flat by a fresh account read, a candidate, in session,
 *      the kill switch off, time left): the prepare briefing ("Possible at the next close", from the closed bars only),
 *      the plan written whole with its session and input versions (writePlan). Done after its deadline: aborted, no plan.
 *
 * Both are recorded in the cycle's log as its `prepare` field ({ shadow, made }: cycle-log.js amendCycleLog), and nowhere
 * else. Every time is the injected clock's (`now`: the runner's harness clock); the wall clock is never read here.
 *
 *   createShadow({ cfg, root, home, runPrepare, now, sectionOpts, newsAt, chainSideOf })
 *     .after(input) -> { shadow, made }
 *   input: { symbol, minutes, bar, bars, windowBars, briefing, factsKey, reports, scan, listed, result, cycleLog,
 *            killSwitch(), accountAfter(), phase1KeyOf(acct), eodMs, inSession(date) }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PA = require('./prepare-ahead');
const { tradingDayKey } = require('./trading/clock');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const SUMMARY_END = '\n\nDetail by timeframe:';

/** The chain side on the last of these bars (chain-side.js, the side the shipped entry rule allows), or null. */
function chainSideOn(bars, minutes) {
  try { const s = require('./trading/chain-side').chainSideSeries(bars, { minutes }); return s.length ? s[s.length - 1] : null; } catch (_err) { return null; }
}

/** The kinds of the reads no scenario covered: { kind: count } (prepare-ahead.js readKind). */
const kindsOf = reads => (reads || []).reduce((o, r) => { const k = PA.readKind(r); o[k] = (o[k] || 0) + 1; return o; }, {});

/** The account read after the cycle is flat: no position and no working order (an unread one is not). */
const flatOf = a => (isObj(a) && !a.error && Array.isArray(a.positions) && Array.isArray(a.orders) ? !a.positions.length && !a.orders.length : null);

function createShadow({ cfg, root, home, runPrepare, now, sectionOpts = () => ({}), newsAt = () => ({ inBlackout: null }), chainSideOf = chainSideOn }) {
  const T = require('./tunables').runner().prepare;
  const nowMs = () => { const d = now(); return d instanceof Date ? d.getTime() : NaN; };
  const sessionFile = () => path.join(home, PA.PLAN_DIR, `session-${crypto.randomBytes(8).toString('hex')}.json`);

  /** One run (a prepare or a confirm) within the deadline, stopped at it: its result and whether it was aborted. */
  async function timed(kind, prompt, deadline, limits) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), deadline.budgetMs);
    const file = sessionFile();
    let res;
    try {
      res = await runPrepare(cfg, kind, prompt, { ...limits, timeoutMs: deadline.budgetMs, signal: ctl.signal, sessionFile: file });
    } finally {
      clearTimeout(timer);
      try { fs.unlinkSync(file); } catch (_err) { /* none written */ }
    }
    return { res, aborted: ctl.signal.aborted || PA.overran(deadline, nowMs()) };
  }

  /** Step 1: the shadow confirm of the plan made for this close. */
  async function confirm(x, deadline) {
    const plan = PA.readPlan(home, x.symbol, x.bar.t);
    const planId = plan ? plan.id : null;
    if (x.killSwitch()) return { status: 'kill-switch', reason: 'kill-switch', planId };
    if (!plan) return { status: 'none', reason: 'no-plan', planId };
    const closeAt = new Date(Date.parse(x.bar.t) + x.minutes * 60000);
    const at = PA.versionsOf({ briefing: x.briefing, chainSide: chainSideOf(x.bars, x.minutes), factsKey: x.factsKey, desk: PA.deskKeys(x.reports), day: tradingDayKey(closeAt), news: newsAt(closeAt) });
    let entry = null;
    try { entry = JSON.parse(fs.readFileSync(x.cycleLog, 'utf8')).entry || null; } catch (_err) { /* no record: the result line alone */ }
    const full = PA.fullDecisionOf({ result: x.result, entry });
    const base = { planId, prepareMs: plan.ms, full };
    const v = PA.validate(plan, at);
    if (v.status !== 'valid') return { status: v.status, reason: v.reason, ...(v.detail ? { detail: v.detail } : {}), ...base, agreesWithFull: null };
    const fired = PA.firedReads({ scan: x.scan, listed: x.listed });
    const m = PA.matchScenario(plan, fired);
    if (m.status !== 'matched') return { status: m.status, fired, unplannedKinds: kindsOf(fired), ...base, agreesWithFull: null };
    const match = { k: m.k, id: m.id, read: m.read, side: m.side };
    const scenario = plan.scenarios.find(s => s.k === m.k);
    const rest = { match, fired, unplanned: m.unplanned, unplannedKinds: kindsOf(m.unplanned), ...base };
    if (!(deadline.budgetMs > 0)) return { status: 'valid', ...rest, confirm: { outcome: 'no-time', decision: null }, agreesWithFull: null };
    const text = require('./trading/briefing').renderBriefing(x.briefing, { now: now() });
    const atCloseText = text.includes(SUMMARY_END) ? text.slice(0, text.indexOf(SUMMARY_END)) : text;
    const prompt = PA.confirmPrompt({ atCloseText, fired, scenario, next: { t: x.bar.t, closedAt: closeAt.toISOString() } });
    const { res, aborted } = await timed('confirm', prompt, deadline, { resume: plan.session.id, context: { action: 'trade', symbols: [{ symbol: x.symbol, bar: { t: x.bar.t, contractId: x.bar.contractId, file: x.bar.file } }] } });
    const parsed = !aborted && res.ok ? PA.parseDecision(res.text) : null;
    const decision = parsed ? { ...parsed, side: parsed.decision === 'take' ? (plan.candidates.find(c => c.id === (plan.scenarios.find(s => s.k === parsed.k) || {}).id) || {}).side || null : null } : null;
    const outcome = aborted ? 'aborted' : !res.ok ? 'error' : parsed ? 'done' : 'no-decision';
    return { status: 'valid', ...rest, confirm: { outcome, decision, ms: res.ms, sessionId: res.sessionId, usage: res.usage || null }, agreesWithFull: PA.agreement(decision, full) };
  }

  /** Step 2: the prepare of the next bar's plan. */
  async function prepare(x, nextCloseMs) {
    const deadlineAt = () => PA.deadlineOf({ nowMs: nowMs(), nextCloseMs, eodMs: x.eodMs, marginMs: T.marginMs, maxMs: T.maxMs });
    const deadline = deadlineAt();
    const at = { deadline: { atMs: deadline.atMs, by: deadline.by } };
    if (x.killSwitch()) return { outcome: 'skipped', why: 'kill-switch', ...at };
    if (!(deadline.budgetMs > 0)) return { outcome: 'skipped', why: 'no-time', ...at };
    const acct = await x.accountAfter();
    const flat = flatOf(acct);
    let section;
    try {
      section = flat ? PA.sectionFor({ symbol: x.symbol, bars: x.bars, minutes: x.minutes, briefing: x.briefing, flat: true, windowBars: x.windowBars, ...sectionOpts() }) : null;
    } catch (err) {
      return { outcome: 'error', why: `the section: ${err.message}`, ...at };
    }
    const next = section ? section.next : null;
    const should = PA.shouldPrepare({ killSwitch: x.killSwitch(), flat, section, inSession: next ? x.inSession(new Date(next.closedAt)) : false, budgetMs: deadlineAt().budgetMs });
    if (!should.ok) return { outcome: 'skipped', why: should.why, ...(section && section.none ? { none: section.none } : {}), ...at };
    const versions = PA.versionsOf({ briefing: x.briefing, chainSide: chainSideOf(x.bars, x.minutes), factsKey: x.phase1KeyOf(acct), desk: PA.deskKeys(x.reports), day: tradingDayKey(new Date(next.closedAt)), news: newsAt(new Date(next.closedAt)) });
    const A = require('./autotrader');
    const briefingText = require('./trading/next-close').renderPrepareBriefing(x.briefing, section, { now: now() });
    const prompt = PA.preparePrompt({ head: A.stableHead(root), account: A.accountText(acct), reports: x.reports, briefingText, next });
    const left = deadlineAt();
    const madeAt = new Date(nowMs()).toISOString();
    let run;
    try {
      run = await timed('prepare', prompt, left, { context: { action: 'trade', symbols: [{ symbol: x.symbol, bar: { t: x.bar.t, contractId: x.bar.contractId, file: x.bar.file } }] } });
    } catch (err) {
      return { outcome: 'error', why: err.message, ...at };
    }
    const { res, aborted } = run;
    if (aborted) return { outcome: 'aborted', ms: res.ms, usage: res.usage || null, ...at };
    if (!res.ok || !res.sessionId) return { outcome: 'error', why: !res.ok ? 'the run failed' : 'no session id', ms: res.ms, ...at };
    const plan = PA.makePlan({ symbol: x.symbol, bar: x.bar.t, next, madeAt, ms: res.ms, session: { id: res.sessionId, transcript: res.transcript }, versions, candidates: section.candidates, text: res.text, usage: res.usage || null });
    PA.writePlan(home, plan);
    return { outcome: 'done', planId: plan.id, ms: res.ms, scenarios: plan.scenarios.length, candidates: plan.candidates.length, usage: plan.usage, ...at };
  }

  async function after(x) {
    // The deadline both steps share: the close of the bar now forming, less the margin (and the end of day, the most a run takes).
    const nextCloseMs = Date.parse(x.bar.t) + 2 * x.minutes * 60000;
    const deadline = () => PA.deadlineOf({ nowMs: nowMs(), nextCloseMs, eodMs: x.eodMs, marginMs: T.marginMs, maxMs: T.maxMs });
    let shadow;
    try { shadow = await confirm(x, deadline()); } catch (err) { shadow = { status: 'error', reason: 'error', detail: err.message, planId: null }; }
    let made;
    try { made = await prepare(x, nextCloseMs); } catch (err) { made = { outcome: 'error', why: err.message }; }
    if (x.cycleLog) { try { require('./cycle-log').amendCycleLog(x.cycleLog, 'prepare', { shadow, made }); } catch (_err) { /* the record only */ } }
    return { shadow, made };
  }

  return { after };
}

module.exports = { createShadow, chainSideOn, flatOf };
