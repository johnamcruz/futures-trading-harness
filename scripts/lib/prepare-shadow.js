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
 *     .mode                 "shadow" or "on" (the runner config's prepareAhead)
 *     .after(input) -> { shadow, made }   ("on": { on, made }: no shadow confirm, the confirm was the cycle's run)
 *     .atClose(input) -> { record, confirm? }   ("on" only: before the head trader's run, the confirm or the full one)
 *   input: { symbol, minutes, bar, bars, windowBars, briefing, factsKey, reports, scan, listed, result, cycleLog,
 *            killSwitch(), accountAfter(), phase1KeyOf(acct), reportsAfter(acct), eodMs, inSession(date) }
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

/** What a run tried and was refused: the CLI's permission denials, every forbidden attempt (its transcript), the gate refusals in the shadow's log. */
const tried = res => ({ denied: Array.isArray(res.denied) ? res.denied : [], forbidden: Array.isArray(res.forbidden) ? res.forbidden : [], gateRefusals: Number.isInteger(res.gateRefusals) ? res.gateRefusals : 0, initMs: Number.isFinite(res.initMs) ? res.initMs : null });

/** The account read after the cycle is flat: no position and no working order (an unread one is not). */
const flatOf = a => (isObj(a) && !a.error && Array.isArray(a.positions) && Array.isArray(a.orders) ? !a.positions.length && !a.orders.length : null);

function createShadow({ cfg, root, home, runPrepare, now, sectionOpts = () => ({}), newsAt = () => ({ inBlackout: null }), chainSideOf = chainSideOn }) {
  const RT = require('./tunables').runner();
  const T = RT.prepare;
  // The runner config's mode: "shadow" (B1: the confirm beside the old path) or "on" (B2: the confirm decides at the close).
  const mode = PA.onOn(cfg) ? 'on' : 'shadow';
  // Every bound keeps the kill grace (a run stopped at it is gone before the bound: runHarness's SIGKILL after it), and
  // the two runs together get maxMs less the account read the prepare makes between them.
  const GRACE = RT.runner.killGraceMs;
  const PAIR_MS = T.maxMs - RT.runner.accountReadMs;
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
    const fired = PA.firedReads({ scan: x.scan, listed: x.listed });
    // Void only by the hourly close: what it would have been without that rule (a record only; no confirm runs).
    const ifHour = () => {
      const w = PA.validate(plan, at, { ignoreHourClose: true });
      if (w.status !== 'valid') return { status: w.status, reason: w.reason };
      const m = PA.matchScenario(plan, fired);
      return { status: 'valid', match: m.status, ...(m.status === 'matched' ? { read: m.read } : {}) };
    };
    if (v.status !== 'valid') return { status: v.status, reason: v.reason, ...(v.detail ? { detail: v.detail } : {}), ...(v.reason === 'htf-close:h1' ? { ifHourIgnored: ifHour() } : {}), ...base, agreesWithFull: null };
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
    // The fork's first turn: what it created in the cache (the first fork after the prepare pays it: plan section 1).
    const first = res.usage && res.usage.first && Number.isFinite(res.usage.first.cacheCreation) ? res.usage.first.cacheCreation : null;
    return { status: 'valid', ...rest, confirm: { outcome, decision, ms: res.ms, sessionId: res.sessionId, usage: res.usage || null, firstCacheCreation: first, ...tried(res) }, agreesWithFull: PA.agreement(decision, full) };
  }

  /** Step 2: the prepare of the next bar's plan. */
  async function prepare(x, nextCloseMs, maxMs) {
    const deadlineAt = () => PA.deadlineOf({ nowMs: nowMs(), nextCloseMs, eodMs: x.eodMs, marginMs: T.marginMs, maxMs: Math.max(0, maxMs), graceMs: GRACE });
    const deadline = deadlineAt();
    const at = { deadline: { atMs: deadline.atMs, by: deadline.by } };
    if (x.killSwitch()) return { outcome: 'skipped', why: 'kill-switch', ...at };
    if (!(deadline.budgetMs > 0)) return { outcome: 'skipped', why: 'no-time', ...at };
    const acct = await x.accountAfter();
    const flat = flatOf(acct);
    let section;
    try {
      section = flat ? PA.sectionFor({ symbol: x.symbol, bars: x.bars, minutes: x.minutes, briefing: x.briefing, flat: true, windowBars: x.windowBars, ...sectionOpts(x.symbol) }) : null;
    } catch (err) {
      return { outcome: 'error', why: `the section: ${err.message}`, ...at };
    }
    const next = section ? section.next : null;
    const should = PA.shouldPrepare({ killSwitch: x.killSwitch(), flat, section, inSession: next ? x.inSession(new Date(next.closedAt)) : false, budgetMs: deadlineAt().budgetMs });
    if (!should.ok) return { outcome: 'skipped', why: should.why, ...(section && section.none ? { none: section.none } : {}), ...at };
    // The desk's latest valid reports, with their ends (the report cache served after the cycle: a report the desk ran
    // this cycle has its end there), else the cycle's own.
    let reports = x.reports;
    try { const r = typeof x.reportsAfter === 'function' ? x.reportsAfter(acct) : null; if (Array.isArray(r)) reports = r; } catch (_err) { /* the cycle's own */ }
    const versions = PA.versionsOf({ briefing: x.briefing, chainSide: chainSideOf(x.bars, x.minutes), factsKey: x.phase1KeyOf(acct), desk: PA.deskKeys(reports), day: tradingDayKey(new Date(next.closedAt)), news: newsAt(new Date(next.closedAt)) });
    const A = require('./autotrader');
    const briefingText = require('./trading/next-close').renderPrepareBriefing(x.briefing, section, { now: now() });
    const prompt = PA.preparePrompt({ head: A.stableHead(root), account: A.accountText(acct), reports, briefingText, next });
    const left = deadlineAt();
    const madeAt = new Date(nowMs()).toISOString();
    let run;
    try {
      run = await timed('prepare', prompt, left, { context: { action: 'trade', symbols: [{ symbol: x.symbol, bar: { t: x.bar.t, contractId: x.bar.contractId, file: x.bar.file } }] } });
    } catch (err) {
      return { outcome: 'error', why: err.message, ...at };
    }
    const { res, aborted } = run;
    if (aborted) return { outcome: 'aborted', ms: res.ms, usage: res.usage || null, ...tried(res), ...at };
    if (!res.ok || !res.sessionId) return { outcome: 'error', why: !res.ok ? 'the run failed' : 'no session id', ms: res.ms, ...tried(res), ...at };
    // The prepare session's uuids, sealed (confirm-base.js): "on" names them to the confirm, whose fork copies them first.
    const base = res.transcript ? require('./trading/confirm-base').baseOf(res.transcript) : null;
    const plan = PA.makePlan({ symbol: x.symbol, bar: x.bar.t, next, madeAt, ms: res.ms, session: { id: res.sessionId, transcript: res.transcript }, versions, candidates: section.candidates, text: res.text, usage: res.usage || null, base });
    PA.writePlan(home, plan);
    return { outcome: 'done', planId: plan.id, ms: res.ms, scenarios: plan.scenarios.length, candidates: plan.candidates.length, usage: plan.usage, ...tried(res), ...at };
  }

  /**
   * "on", at the close before the head trader's run (runner.js): the confirm or the full head trader (PA.confirmPath on
   * the inputs the cycle starts from; what fired from the real at-close scan). { record, confirm? }: the record for the
   * cycle log's prepare field; `confirm` the cycle's run limits (cycle-run.js runCycle confirm): the prepare's session,
   * its plan record as the base (FTH_CONFIRM_BASE), the message after the at-close facts, its bound (prepare.confirmMs)
   * and composed() (a compose record on this bar since now: the confirm composed, so it never falls back).
   * input: { symbol, minutes, bar, bars, briefing, factsKey, reports, scan, listed, killSwitch(), flat }
   */
  function atClose(x) {
    if (mode !== 'on') throw new Error('prepare ahead: the confirm decides at the close in "on" only');
    const plan = PA.readPlan(home, x.symbol, x.bar.t);
    const closeAt = new Date(Date.parse(x.bar.t) + x.minutes * 60000);
    const at = PA.versionsOf({ briefing: x.briefing, chainSide: chainSideOf(x.bars, x.minutes), factsKey: x.factsKey, desk: PA.deskKeys(x.reports), day: tradingDayKey(closeAt), news: newsAt(closeAt) });
    const fired = PA.firedReads({ scan: x.scan, listed: x.listed });
    const p = PA.confirmPath({ plan, at, fired, killSwitch: Boolean(x.killSwitch()), flat: x.flat });
    const record = {
      mode: 'on', path: p.path, planId: plan ? plan.id : null, ...(plan ? { prepareMs: plan.ms } : {}), ...(p.reason ? { reason: p.reason } : {}), ...(p.detail ? { detail: p.detail } : {}),
      fired, ...(p.match ? { match: p.match } : {}), unplannedKinds: kindsOf(p.path === 'confirm' ? p.unplanned : p.path === 'outside' ? fired : []),
    };
    if (p.path !== 'confirm') return { record };
    const TL = require('./trading/trade-lifecycle');
    const day = TL.shardDay({ bar: x.bar.t });
    const composedHere = () => TL.readRecords(home, x.symbol, { days: [day] }).filter(r => r && r.bar === x.bar.t).length;
    const before = composedHere();
    return { record, confirm: { session: plan.session.id, base: PA.planFile(home, x.symbol, x.bar.t), suffix: PA.confirmSuffix({ scenario: p.scenario, unplanned: p.unplanned }), timeoutMs: T.confirmMs, composed: () => composedHere() > before } };
  }

  /** "on": the at-close record with what the cycle did: the confirm's outcome, the late refusals, close to order, the desk. */
  function onRecord(x) {
    const c = x.cycle && x.cycle.confirm ? x.cycle.confirm : null;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(x.cycleLog, 'utf8')); } catch (_err) { rec = null; }
    const ctx = rec && isObj(rec.context) ? rec.context : {};
    const lat = rec && isObj(rec.timing) && isObj(rec.timing.latencyMs) ? rec.timing.latencyMs.order : null;
    return {
      ...(x.on || { mode: 'on', path: 'unknown' }),
      ...(c ? { confirm: { outcome: c.outcome, ms: c.ms, fellBack: c.fellBack, ...(Array.isArray(c.tools) ? { tools: c.tools } : {}), ...(typeof c.tail === 'string' ? { tail: c.tail } : {}) } } : {}),
      ...(c && Array.isArray(c.late) ? { late: c.late } : {}),
      closeToOrderMs: Number.isFinite(lat) ? lat : null,
      desk: isObj(ctx.desk) ? 'ran' : Array.isArray(ctx.cachedRoles) && ctx.cachedRoles.length ? 'cached' : 'none',
    };
  }

  async function after(x) {
    // The deadline both steps share: the close of the bar now forming, less the margin (and the end of day, the most a run takes).
    const nextCloseMs = Date.parse(x.bar.t) + 2 * x.minutes * 60000;
    const deadline = () => PA.deadlineOf({ nowMs: nowMs(), nextCloseMs, eodMs: x.eodMs, marginMs: T.marginMs, maxMs: PAIR_MS, graceMs: GRACE });
    if (mode === 'on') {
      // The confirm was the cycle's own run (atClose): here only the record and, after a cycle that ended, the next prepare.
      const on = onRecord(x);
      let made;
      if (x.cycle && x.cycle.ok === false) made = { outcome: 'skipped', why: 'cycle-failed' };
      else { try { made = await prepare(x, nextCloseMs, PAIR_MS); } catch (err) { made = { outcome: 'error', why: err.message }; } }
      if (x.cycleLog) { try { require('./cycle-log').amendCycleLog(x.cycleLog, 'prepare', { mode, on, made }); } catch (_err) { /* the record only */ } }
      return { on, made };
    }
    let shadow;
    try { shadow = await confirm(x, deadline()); } catch (err) { shadow = { status: 'error', reason: 'error', detail: err.message, planId: null }; }
    let made;
    // prepare.maxMs bounds both runs together: what the confirm took (its run's own measure) comes off the prepare's, so
    // on a frozen replay clock the step never outlasts what its cycle left (the next close bounds them on a running one).
    const confirmMs = shadow && shadow.confirm && Number.isFinite(shadow.confirm.ms) ? shadow.confirm.ms : 0;
    try { made = await prepare(x, nextCloseMs, PAIR_MS - confirmMs); } catch (err) { made = { outcome: 'error', why: err.message }; }
    if (x.cycleLog) { try { require('./cycle-log').amendCycleLog(x.cycleLog, 'prepare', { mode, shadow, made }); } catch (_err) { /* the record only */ } }
    return { shadow, made };
  }

  return { mode, after, atClose };
}

module.exports = { createShadow, chainSideOn, flatOf };
