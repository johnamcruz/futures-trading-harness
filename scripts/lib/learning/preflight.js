'use strict';

/**
 * The training preflight: before a learning replay (practice, validate, test or final) starts, one check that the run
 * is set up for the owner's two goals, learning to trade and passing the prop firm. Any FAIL refuses the run; N/A (a
 * check whose feature isn't merged yet, or that doesn't apply to the run) and WARN never do. scripts/replay.js run calls
 * it for every learning run before its learning gate and records the result in the run home (preflight.jsonl);
 * scripts/training-preflight.js runs it alone.
 *
 * Each check is a small named function of one context, `ctx`, and returns { check, status, detail }:
 *   ctx.run       the resolved replay config (replay/config.js resolveReplay)
 *   ctx.gate      the learning gate's options (replay.js run): from, to, runId, learning, candidate, evaluation, ...
 *   ctx.read      the injected readers (defaultReaders: the repository, the bar files, the ledger), so the checks are pure
 *
 * Learning to trade: strategy, strategy-valid-bars, skills-crosswalk, head-prompt, head-composed-reads,
 * adapters-in-sync, no-web-in-replay (no agent reaches the web: replay/web-access.js), facts, curated-list, curated-source (its moments' prices against the run's bars), split-window, latency, practice-mode, library-display, experience-index,
 * risk-record (N/A when off), ledger-look, stage (the replay config's preset: replay/stage.js), scorecard-composed. Passing the prop firm:
 * prop-portfolio, rulebook-values, rulebook-missing, account-states, account-facts, monte-carlo. The fine-tuning adapter
 * the runner config declares: adapter (N/A with none; learning/adapter.js adapterCheck). A check of a feature
 * on another branch (NEEDS) says "not available (needs <branch>)" until that branch is merged; the merged ones are
 * judged, and a run or prompt without them FAILs. Stage 2's own requirements (stage): the account states on a
 * practice-train run, the prop risk rules and the Monte Carlo.
 *
 *   CHECKS                                  [check function], in report order
 *   runChecks(ctx)                          { ok, results }; a check that throws is a FAIL with its message
 *   formatReport({ ok, results })           one line per check: PASS, FAIL, WARN or N/A, the check and its reason
 *   defaultReaders(root, env, { barsFiles })   the readers on the repository, the bar files given and the ledger
 *   gateOptions(run, flags)                 the learning gate's options from a run and the replay CLI's flags (scripts/replay.js
 *                                           run builds its gate with it: lookArm, setupHash, setupBase, setupFixed)
 *   preflightForRun(run, gate, { root, env, barsFiles, noBars, log, read })   null for a run declared not learning; else runs
 *                                           (noBars: why there are no bars to give, e.g. the training loop without a data
 *                                           source: the facts check is N/A with it; every other check runs)
 *                                           every check, logs each line, throws on any FAIL, and returns
 *                                           { ok, results, record(runHome) } (record appends the result to
 *                                           <runHome>/preflight.jsonl)
 */

const fs = require('fs');
const path = require('path');
const { rolesBetween, assertUse } = require('./splits');

const PASS = 'PASS';
const FAIL = 'FAIL';
const NA = 'N/A';
const WARN = 'WARN';
const r = (check, status, detail) => ({ check, status, detail });
const na = (check, needs) => r(check, NA, `not available (needs ${needs})`);

// The branches whose features some checks wait for.
// (valid_bars and latency, #190; libraryDisplay, #189; curatedList, #191; the head prompt's composed reads, #188 are
// merged: their checks judge them, and a run or prompt without them FAILs.)
const NEEDS = Object.freeze({
  scorecardComposed: 'fix/scorecard-composed: the scorecard knows composed setups, exporting SCORES_COMPOSED',
  propMissing: 'feat/prop-portfolio-missing: loss_streak_stop and the exit mode',
  accountFacts: 'the attempt line\'s facts (combine.attemptFacts, shown by the runner\'s account text)',
  monteCarlo: 'the 30-day Monte Carlo (prop/model-score.js)',
});

const LIFECYCLE = 'trade_lifecycle';
const POLICY = 'prop_portfolio';
const MAX_RISK_USD = 300;
const MIN_RR = 2;
const MAX_VALID_BARS = 3;
const FRAMES = Object.freeze(['3m', '5m', '15m', '1h', '4h']);
const FVG_FRAMES = Object.freeze(['5m', '15m', '1h']);
const STEPS = Object.freeze(['bias', 'location', 'setup', 'entry', 'stop', 'target']);
/** The split role a learning run is in -> the use it makes of it (splits.js USES). */
const USE_OF = Object.freeze({ 'practice-train': 'practice', 'practice-validate': 'validate', test: 'test', final: 'final' });
/** A curated list's use for the run's role (curated-lists.js ROLE). */
const CURATED_USE = Object.freeze({ 'practice-train': 'practice', 'practice-validate': 'validate' });
const WINDOW_BARS = 700;
const MINUTE = 60000;

const errText = e => String((e && e.message) || e).split('\n').join(' ');

/** The run's split role, or null when the window has none or spans two (split-window says which). */
function roleOf(ctx) {
  try {
    const roles = rolesBetween(ctx.gate.from, ctx.gate.to);
    return roles.length === 1 ? roles[0] : null;
  } catch (_err) {
    return null;
  }
}

function lifecycleOf(ctx) {
  return (ctx.read.strategies() || []).find(s => s.name === LIFECYCLE) || null;
}

// --- Learning to trade -------------------------------------------------------------------------------------------

function strategy(ctx) {
  const s = lifecycleOf(ctx);
  if (!s) return r('strategy', FAIL, `${LIFECYCLE} is not a strategy`);
  if (!s.valid) return r('strategy', FAIL, `${LIFECYCLE} is invalid: ${(s.errors || []).join('; ')}`);
  const risk = s.risk || {};
  const bad = [];
  if (s.status !== 'active') bad.push(`status ${s.status}, not active`);
  if (s.signal !== 'composed') bad.push(`signal ${s.signal}, not composed`);
  if (!(typeof risk.max_risk_usd === 'number' && risk.max_risk_usd > 0 && risk.max_risk_usd <= MAX_RISK_USD)) bad.push(`risk.max_risk_usd ${risk.max_risk_usd}, not above 0 and at most ${MAX_RISK_USD}`);
  if (!(typeof risk.min_rr === 'number' && risk.min_rr >= MIN_RR)) bad.push(`risk.min_rr ${risk.min_rr}, under ${MIN_RR}`);
  if (risk.stop !== 'structure') bad.push(`risk.stop ${JSON.stringify(risk.stop)}, not structure`);
  if (bad.length) return r('strategy', FAIL, `${LIFECYCLE}: ${bad.join('; ')}`);
  return r('strategy', PASS, `${LIFECYCLE} active, composed, max risk $${risk.max_risk_usd}, min R:R ${risk.min_rr}, stop structure`);
}

function strategyValidBars(ctx) {
  const s = lifecycleOf(ctx);
  const v = s ? s.valid_bars : undefined;
  if (!(Number.isInteger(v) && v >= 1 && v <= MAX_VALID_BARS)) return r('strategy-valid-bars', FAIL, `${LIFECYCLE} valid_bars ${JSON.stringify(v)}: a whole number of base bars from 1 to ${MAX_VALID_BARS}`);
  return r('strategy-valid-bars', PASS, `${LIFECYCLE} valid_bars ${v}`);
}

/** The trade-lifecycle skill's step table (its crosswalk): { step: [skill] }, from the skill's text. */
function crosswalkOf(text) {
  const out = {};
  let inTable = false;
  for (const line of String(text || '').split('\n')) {
    const cells = line.trim().startsWith('|') ? line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()) : null;
    if (!cells) { if (inTable) break; continue; }
    if (/^step$/i.test(cells[0]) && /skill/i.test(cells[cells.length - 1])) { inTable = true; continue; }
    if (!inTable || /^-+$/.test(cells[0])) continue;
    out[cells[0]] = [...cells[cells.length - 1].matchAll(/`([a-z0-9][a-z0-9-]*)`/g)].map(m => m[1]);
  }
  return out;
}

function skillsCrosswalk(ctx) {
  const table = crosswalkOf(ctx.read.skillText('trade-lifecycle'));
  const steps = Object.keys(table);
  const missingSteps = STEPS.filter(s => !(table[s] && table[s].length));
  if (missingSteps.length) return r('skills-crosswalk', FAIL, `the trade-lifecycle crosswalk has no skill for ${missingSteps.join(', ')}`);
  const names = [...new Set(steps.flatMap(s => table[s]))];
  const missing = names.filter(n => !ctx.read.skillExists(n));
  if (missing.length) return r('skills-crosswalk', FAIL, `the trade-lifecycle crosswalk names skills that don't exist: ${missing.join(', ')}`);
  return r('skills-crosswalk', PASS, `${names.length} skills over ${steps.length} steps, every one exists`);
}

/** Why the head prompt doesn't apply to this run (another harness, full mode), or null. */
function headNotApplicable(ctx) {
  const harness = ctx.run.cfg && ctx.run.cfg.harness;
  if (harness !== 'opencode') return `the head prompt is opencode's; this run's harness is ${harness}`;
  const mode = ctx.read.roleSkillsMode();
  if (mode !== 'index') return `role skills in ${mode} mode: no embedded head prompt`;
  return null;
}

function headPromptCheck(ctx) {
  const why = headNotApplicable(ctx);
  if (why) return r('head-prompt', NA, why);
  const h = ctx.read.head();
  if (!h.prompt) return r('head-prompt', FAIL, 'the workspace opencode.json has no head prompt (run node scripts/sync-harness.js)');
  const missing = h.core.filter(s => !h.embedded.includes(s));
  if (missing.length) return r('head-prompt', FAIL, `the head prompt doesn't embed the current text of ${missing.join(', ')} (run node scripts/sync-harness.js)`);
  if (!h.attestation || h.attestation.sha256 !== h.expectedSha256) return r('head-prompt', FAIL, `the attestation hash ${h.attestation ? h.attestation.sha256.slice(0, 12) : 'none'} is not the generated prompt's ${String(h.expectedSha256).slice(0, 12)} (run node scripts/sync-harness.js)`);
  return r('head-prompt', PASS, `embeds its ${h.core.length} core skills; attestation ${h.expectedSha256.slice(0, 12)} matches`);
}

function headComposedReads(ctx) {
  const h = ctx.read.head();
  const why = headNotApplicable(ctx);
  if (why) return r('head-composed-reads', NA, why);
  if (!Array.isArray(h.composedReads)) return r('head-composed-reads', FAIL, 'head-prompt.js lists no composed reads (COMPOSED_READS)');
  const notCore = h.composedReads.filter(s => !h.core.includes(s));
  const notIn = h.composedReads.filter(s => !h.embedded.includes(s));
  if (h.composedReads.length < 4 || notCore.length || notIn.length) {
    return r('head-composed-reads', FAIL, `the composed reads (${h.composedReads.join(', ') || 'none'}): ${[...notCore.map(s => `${s} not in the core`), ...notIn.map(s => `${s} not embedded`)].join('; ') || 'fewer than 4'}`);
  }
  return r('head-composed-reads', PASS, `embeds the ${h.composedReads.length} composed reads (${h.composedReads.join(', ')})`);
}

function adaptersInSync(ctx) {
  const stale = ctx.read.syncStale();
  if (stale.length) return r('adapters-in-sync', FAIL, `stale generated files: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', ...' : ''} (run node scripts/sync-harness.js)`);
  return r('adapters-in-sync', PASS, 'the generated adapters match their sources');
}

/**
 * No web in a replay: the replay step's effective permissions (replay/web-access.js) let no agent search or fetch the
 * web, nor the head trader launch a role whose tools reach it: on a replayed date the web holds what came next.
 */
function noWebInReplay(ctx) {
  // A custom command is the user's own argv: no permission of the harness's to read. A learning run needs the replay
  // config's attestation (noWeb: true) that it is kept off the web; any other run is warned.
  if ((ctx.run.cfg || {}).harness === 'custom') {
    if (ctx.run.noWeb === true) return r('no-web-in-replay', PASS, 'a custom command, attested off the web by the replay config (noWeb: true)');
    const learning = ctx.run.learning === true || (ctx.gate || {}).learning === true;
    const why = 'a custom command: its web access is its own, not the harness\'s to read; keep it off the web (it runs with the replay clock, FTH_REPLAY_NOW)';
    return learning ? r('no-web-in-replay', FAIL, `${why}, and attest it in the replay config (noWeb: true)`) : r('no-web-in-replay', WARN, why);
  }
  const step = ctx.read.replayStep(ctx.run);
  const found = require('../replay/web-access').webFindings(step);
  if (found.length) return r('no-web-in-replay', FAIL, `the replay could reach the web: ${found.slice(0, 4).join('; ')}${found.length > 4 ? `; and ${found.length - 4} more` : ''}`);
  return r('no-web-in-replay', PASS, `${step.harness}: no agent may search or fetch the web${step.webRoles.length ? `, and ${step.webRoles.join(', ')} is not launched` : ''}`);
}

/** The run's 1m bars reach its briefing only through a 1m lane (lanes.js DATA_MINUTES), as the runner builds it. */
const hasMinuteLane = cfg => Array.isArray(cfg.lanes) && cfg.lanes.slice(1).some(l => Number(l.timeframe) === 1);

function facts(ctx) {
  // A caller with no bars to give (the training loop without a data source): N/A, with its reason.
  if (ctx.noBars) return r('facts', NA, ctx.noBars);
  const cfg = ctx.run.cfg || {};
  const symbol = (cfg.symbols || [])[0];
  const tf = Number(cfg.timeframe);
  const sample = ctx.read.sampleBriefing({ symbol, minutes: tf, start: ctx.run.start, end: ctx.run.end, barDelayMs: (cfg.barDelaySeconds || 0) * 1000, minuteLane: hasMinuteLane(cfg) });
  if (sample.error) return r('facts', FAIL, sample.error);
  const { briefing: b, now, limitMin } = sample;
  const d = (b.sections && b.sections.m3 && b.sections.m3.data) || {};
  const off = [];
  const available = v => v && typeof v === 'object' && !v.unavailable;
  for (const f of FRAMES) if (!available(d.candles && d.candles[f])) off.push(`${f} candle${d.candles && d.candles[f] && d.candles[f].unavailable ? ` (${d.candles[f].unavailable})` : ''}`);
  const h1 = (b.sections.h1 && b.sections.h1.data) || {};
  if (!h1.h1) off.push('1h read');
  if (!h1.h4) off.push('4h read');
  if (!(b.sections.m15 && b.sections.m15.data && b.sections.m15.data.frame)) off.push('15m read');
  if (!available(d.structure5m)) off.push(`5m structure${d.structure5m && d.structure5m.unavailable ? ` (${d.structure5m.unavailable})` : ''}`);
  if (!(Array.isArray(b.keyLevels) && b.keyLevels.some(l => /^VWAP/.test(String(l[0]))))) off.push('VWAP among the key levels');
  for (const f of FVG_FRAMES) if (!(d.fvgs && Array.isArray(d.fvgs[f]))) off.push(`${f} FVGs${d.fvgs && typeof d.fvgs[f] === 'string' ? ` (${d.fvgs[f]})` : ''}`);
  const ageMin = (now.getTime() - Date.parse(b.closedAt)) / MINUTE;
  if (!(ageMin >= 0 && ageMin <= limitMin) || !sample.current) off.push(`a briefing ${ageMin.toFixed(1)} min old at its decision time (limit ${limitMin} min)`);
  if (off.length) return r('facts', FAIL, `${symbol} briefing at ${now.toISOString()} lacks: ${off.join('; ')}`);
  return r('facts', PASS, `${symbol} briefing at ${now.toISOString()}: ${FRAMES.join(', ')} frames, VWAP and ${FVG_FRAMES.join('/')} FVGs, ${ageMin.toFixed(1)} min old (limit ${limitMin})`);
}

function curatedList(ctx) {
  if (ctx.run.curated === undefined) return r('curated-list', FAIL, 'the resolved run has no curated list setting (replay/config.js curatedList)');
  const c = ctx.run.curated;
  if (!c) return r('curated-list', PASS, 'none pinned');
  let doc;
  try { doc = ctx.read.curatedDoc(c.file); } catch (e) { return r('curated-list', FAIL, errText(e)); }
  const role = roleOf(ctx);
  const bad = [];
  if (doc.fingerprint !== c.fingerprint) bad.push(`its fingerprint ${String(doc.fingerprint).slice(0, 12)} is not the config's ${String(c.fingerprint).slice(0, 12)}`);
  const cfg = ctx.run.cfg || {};
  const mk = doc.market || {};
  const roots = (cfg.symbols || []).map(s => String(s).toUpperCase());
  if (!(Array.isArray(mk.roots) && mk.roots.length && mk.roots.every(x => roots.includes(x)))) bad.push(`its market ${(mk.roots || []).join(',') || 'none'} is not the run's ${roots.join(',')}`);
  if (mk.minutes !== cfg.timeframe) bad.push(`its ${mk.minutes}m bars are not the run's ${cfg.timeframe}m`);
  if (ctx.run.practice && mk.setupTf !== ctx.run.practice.setupTf) bad.push(`its ${mk.setupTf}m setups are not the run's ${ctx.run.practice.setupTf}m`);
  if (CURATED_USE[role] !== doc.use) bad.push(`a ${doc.use} list on a ${role || 'no-role'} run (practice-train takes practice, practice-validate validate)`);
  const lists = doc.lists || {};
  for (const l of ['trend-up', 'trend-down']) if (!(Array.isArray(lists[l]) && lists[l].length)) bad.push(`its ${l} list is empty`);
  if (bad.length) return r('curated-list', FAIL, bad.join('; '));
  const under = (doc.coverage && doc.coverage.mix && doc.coverage.mix.under) || [];
  if (under.length) return r('curated-list', WARN, `${c.list} of ${doc.fingerprint.slice(0, 12)}: skills under their minimum: ${under.join(', ')}`);
  return r('curated-list', PASS, `${c.list} of ${doc.fingerprint.slice(0, 12)} (${doc.use}), every skill at its minimum`);
}

/**
 * The curated list's source against the run's bars: each list moment the standard traded whose bar is in the bars given
 * (--bars, aggregated to the list's bar timeframe) closed there at the moment's entry (its decision bar's close). A list
 * scanned from another series (raw prices against back-adjusted ones, another contract) disagrees: FAIL. No moment in
 * the bars given: N/A (nothing to compare).
 */
function curatedSource(ctx) {
  const c = ctx.run.curated;
  if (!c) return r('curated-source', NA, 'no curated list');
  let doc;
  try { doc = ctx.read.curatedDoc(c.file); } catch (e) { return r('curated-source', FAIL, errText(e)); }
  const symbol = ((ctx.run.cfg || {}).symbols || [])[0];
  const closes = ctx.read.barCloses(symbol, (doc.market || {}).minutes);
  if (closes.error) return r('curated-source', NA, closes.error);
  const tick = Number(ctx.read.tickOf(symbol)) || 0.25;
  const moments = Object.values(doc.lists || {}).flat().filter(m => m && m.standard && m.standard.plan && Number.isFinite(m.standard.plan.entry) && closes.has(Date.parse(m.bar)));
  if (!moments.length) return r('curated-source', NA, `no list moment in the ${symbol} bars given to compare`);
  const off = moments.filter(m => Math.abs(closes.get(Date.parse(m.bar)) - m.standard.plan.entry) > tick / 2);
  if (off.length) {
    const m = off[0];
    return r('curated-source', FAIL, `${off.length} of ${moments.length} list moment(s) disagree with the run's bars (the first: the ${m.bar} bar closed ${closes.get(Date.parse(m.bar))} in the bars given, ${m.standard.plan.entry} in the list): the list was scanned from another series; scan it from the bars the replay serves`);
  }
  return r('curated-source', PASS, `${moments.length} list moment(s) closed at their entry in the bars given: one source`);
}

function splitWindow(ctx) {
  let roles;
  try { roles = rolesBetween(ctx.gate.from, ctx.gate.to); } catch (e) { return r('split-window', FAIL, errText(e)); }
  if (roles.length !== 1) return r('split-window', FAIL, `the run spans ${roles.join(' + ')}; a learning run lies inside one window`);
  try { assertUse(USE_OF[roles[0]], ctx.gate.from, ctx.gate.to); } catch (e) { return r('split-window', FAIL, errText(e)); }
  return r('split-window', PASS, `${roles[0]} (${USE_OF[roles[0]]})`);
}

function latency(ctx) {
  if (ctx.run.latency === undefined) return r('latency', FAIL, 'the resolved run has no latency setting (replay/config.js latency)');
  // A resume of a run started before the setting keeps its pinned clock (replay/config.js startedPinned): it passes, noted.
  if (ctx.run.latency === false && ctx.run.latencyPinnedResume === true) return r('latency', PASS, 'pinned: a resume of a run started before latency was charged keeps its clock (a new run charges it)');
  if (ctx.run.latency !== true) return r('latency', FAIL, 'a learning run charges each cycle\'s real time (latency: true), as live');
  return r('latency', PASS, 'charged');
}

function practiceMode(ctx) {
  const role = roleOf(ctx);
  if (role !== 'practice-train') return r('practice-mode', PASS, `not practice (${role || 'no role'}): not needed`);
  if (!ctx.run.practice) return r('practice-mode', FAIL, 'a practice-train run sets its practice mode (the replay config\'s practice)');
  return r('practice-mode', PASS, `${ctx.run.practice.mode}, ${ctx.run.practice.setupTf}m setups`);
}

function libraryDisplay(ctx) {
  if (ctx.run.libraryDisplay === undefined) return r('library-display', FAIL, 'the resolved run has no libraryDisplay setting (replay/config.js)');
  if (ctx.run.libraryDisplay !== true) return r('library-display', PASS, 'off');
  // A library comparison arm is an arm of an evaluation (learning/looks.js): its look names the evaluation.
  if (!ctx.gate.evaluation) return r('library-display', FAIL, 'libraryDisplay is on, but the run is no library comparison arm (an evaluation\'s arm: --evaluation)');
  return r('library-display', PASS, `on: a library comparison arm of evaluation ${ctx.gate.evaluation}`);
}

function experienceIndex(ctx) {
  const file = ctx.run.experienceIndex;
  if (!file) return r('experience-index', PASS, 'none named: the run is shown no record (the without arm)');
  let doc;
  try { doc = ctx.read.index(file); } catch (e) { return r('experience-index', FAIL, errText(e)); }
  const bad = [];
  if (doc.walkForward !== true) bad.push('not walk-forward');
  if (JSON.stringify(doc.roles) !== JSON.stringify(['practice-train'])) bad.push(`built from ${JSON.stringify(doc.roles)}, not practice-train only`);
  const months = doc.months || {};
  for (const k of ['from', 'to']) {
    if (!months[k]) continue;
    try { assertUse('index', months[k], new Date(Date.parse(`${months[k]}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)); } catch (e) { bad.push(errText(e)); }
  }
  // Its decisions' outcomes were scored under one exit plan (experience-index.js exitOf): the run's own, or the record
  // it shows measures another trade stream than the one the run trades.
  const exit = ctx.read.runExit(ctx.run);
  if (!doc.exitPlan) bad.push(`built from decisions with no recorded exit plan; the run trades ${exit.mode} (${String(exit.hash).slice(0, 12)}): rebuild it from runs under that plan`);
  else if (doc.exitPlan !== exit.hash) bad.push(`its exit plan (${doc.exit} ${doc.exitPlan.slice(0, 12)}) differs from the run's (${exit.mode} ${String(exit.hash).slice(0, 12)})`);
  if (bad.length) return r('experience-index', FAIL, `${doc.hash.slice(0, 12)}: ${bad.join('; ')}`);
  return r('experience-index', PASS, `${doc.hash.slice(0, 12)}: walk-forward, practice-train-built, under the run's exit plan (${exit.mode}); pinned at the run's start`);
}

/** The model's risk record (learning/risk-record-index.js): shown only from a pinned, practice-train-built record, on practice-train or practice-validate. */
function riskRecord(ctx) {
  if (ctx.run.riskRecordDisplay !== true) return r('risk-record', NA, 'off: the model is shown no risk record');
  const role = roleOf(ctx);
  // Train-derived evidence may be shown on practice-validate (like the walk-forward experience index): the record holds
  // practice-train days only, and validation outcomes never enter it. Test, final and no-role windows are refused.
  if (role !== 'practice-train' && role !== 'practice-validate') return r('risk-record', FAIL, `riskRecordDisplay is on, on a ${role || 'no-role'} run: the risk record is shown on practice-train and practice-validate only (a test or final run's outcomes are judged, never shown)`);
  if (!ctx.run.riskRecord) return r('risk-record', FAIL, 'riskRecordDisplay is on without a risk record to pin (riskRecord)');
  let doc;
  try { doc = ctx.read.riskRecord(ctx.run.riskRecord); } catch (e) { return r('risk-record', FAIL, errText(e)); }
  const bad = [];
  if (doc.walkForward !== true) bad.push('not walk-forward');
  if (JSON.stringify(doc.roles) !== JSON.stringify(['practice-train'])) bad.push(`built from ${JSON.stringify(doc.roles)}, not practice-train only`);
  if (!Array.isArray(doc.entries) || doc.entries.some(e => e.role !== 'practice-train')) bad.push('an entry not of practice-train');
  // A resume keeps the record it pinned, shown: another record, or the display off in the pin, is refused.
  const home = ctx.run.paths && ctx.run.paths.runHome;
  const pin = home ? ctx.read.riskPin(home) : null;
  if (pin && pin.hash !== doc.hash) bad.push(`the run pinned risk record ${String(pin.hash).slice(0, 12)}, not this one`);
  if (pin && pin.display !== true) bad.push('the run pinned its risk record with the display off');
  if (pin && (pin.comparisonArm === true) !== (ctx.run.comparisonArm === true)) bad.push(`the run pinned its risk record ${pin.comparisonArm === true ? 'as' : 'not as'} a declared comparison arm (comparisonArm), and the config says otherwise`);
  if (bad.length) return r('risk-record', FAIL, `${String(doc.hash).slice(0, 12)}: ${bad.join('; ')}`);
  return r('risk-record', PASS, `${doc.hash.slice(0, 12)}: walk-forward, practice-train-built, ${doc.days} day(s); ${pin ? 'pinned' : 'pinned at the run\'s start'}, shown`);
}

function ledgerLook(ctx) {
  let d;
  try { d = ctx.read.learningGate(ctx.gate); } catch (e) { return r('ledger-look', FAIL, errText(e)); }
  if (d.role === 'practice-train') return r('ledger-look', PASS, 'practice: no look');
  if (!d.look) return r('ledger-look', FAIL, `${d.role} is held out: a run on it takes a look in the ledger`);
  return r('ledger-look', PASS, `${d.role}: a ${d.look.purpose} look, evaluation ${d.look.evaluation}`);
}

/** The stage preset's requirements (replay/stage.js): the config refused its contradictions; the run's role and lists here. */
function stage(ctx) {
  const st = ctx.run.stage;
  if (!st) return r('stage', PASS, 'no stage preset');
  const req = require('../replay/stage').stageRequirements(st);
  if (!req) return r('stage', FAIL, `stage ${st}: 1 or 2`);
  const role = roleOf(ctx);
  const bad = [];
  if (!req.roles.includes(role)) bad.push(`a stage ${st} run is practice or validate (${req.roles.join(' or ')}), not ${role || 'no role'}`);
  if (role === req.curatedOn && !ctx.run.curated) bad.push('a stage practice run replays a curated list (curatedList)');
  if (ctx.run.latency !== req.latency) bad.push('latency is charged');
  if (ctx.run.libraryDisplay !== req.libraryDisplay) bad.push('the history library stays hidden (libraryDisplay off)');
  if (ctx.run.riskRecordDisplay === true && req.riskRecordDisplay === 'off') bad.push('the risk record stays hidden (riskRecordDisplay off)');
  if (ctx.run.riskRecordDisplay === true && req.riskRecordDisplay === 'comparison-arm' && ctx.run.comparisonArm !== true) bad.push('the risk record is shown only on a run declared a comparison arm (comparisonArm)');
  if (req.prop === 'none' && ctx.run.prop) bad.push('no prop attempt in stage 1 (account states are stage 2\'s)');
  if (req.accountStates === 'none' && ctx.run.accountStates) bad.push('no account states in stage 1 (they are stage 2\'s)');
  // Stage 2's own: a practice run's days start from drawn account states (a curated run refuses prop, so they are its
  // account), and the prop risk rules and the Monte Carlo are there to judge it.
  if (req.accountStates === role && !ctx.run.accountStates) bad.push(`a stage ${st} practice run starts its days from drawn account states (accountStates: scripts/account-states.js draw)`);
  if (st === 2) {
    const f = ctx.read.features();
    if (!f.lossStreakStop || !f.exitMode) bad.push(`the prop risk rules are needed (${NEEDS.propMissing})`);
    if (!f.monteCarlo) bad.push(`the Monte Carlo is needed (${NEEDS.monteCarlo})`);
  }
  if (bad.length) return r('stage', FAIL, `stage ${st}: ${bad.join('; ')}`);
  const own = st === 2 ? `${ctx.run.accountStates ? `, days from account states ${ctx.run.accountStates.hash.slice(0, 12)}` : ''}, the prop risk rules and the Monte Carlo` : ', no prop';
  return r('stage', PASS, `stage ${st} on ${role}: curated list${role === req.curatedOn ? '' : ' (practice only)'}, latency charged, library hidden${own}`);
}

function scorecardComposed(ctx) {
  if (!ctx.read.features().scorecardComposed) return na('scorecard-composed', NEEDS.scorecardComposed);
  return r('scorecard-composed', PASS, 'the scorecard scores composed setups');
}

// --- Passing the prop firm ---------------------------------------------------------------------------------------

function policyOf(ctx) {
  return (ctx.read.strategies() || []).find(s => s.name === POLICY) || null;
}

function propPortfolio(ctx) {
  const p = policyOf(ctx);
  if (!p) return r('prop-portfolio', FAIL, `${POLICY} is not a strategy`);
  if (!p.valid) return r('prop-portfolio', FAIL, `${POLICY} is invalid: ${(p.errors || []).join('; ')}`);
  const bad = [];
  if (p.status !== 'active') bad.push(`status ${p.status}, not active`);
  if (JSON.stringify(p.strategies) !== JSON.stringify([LIFECYCLE])) bad.push(`strategies ${JSON.stringify(p.strategies)}, not [${LIFECYCLE}]`);
  const book = ctx.read.rulebook(p.account);
  if (!book) bad.push(`its account ${p.account} has no rulebook`);
  else if (!book.valid) bad.push(`its account's rulebook is refused: ${(book.errors || []).join('; ')}`);
  if (bad.length) return r('prop-portfolio', FAIL, `${POLICY}: ${bad.join('; ')}`);
  return r('prop-portfolio', PASS, `${POLICY} active on [${LIFECYCLE}]; account ${p.account}'s rulebook loads`);
}

function rulebookValues(ctx) {
  const p = policyOf(ctx);
  const book = p ? ctx.read.rulebook(p.account) : null;
  if (!book || !book.valid) return r('rulebook-values', FAIL, `no valid rulebook for ${POLICY}'s account`);
  const entry = book.policies && book.policies[POLICY];
  const sizing = (entry && entry.sizing) || {};
  const missing = [];
  if (!(typeof book.daily_loss_soft === 'number' && book.daily_loss_soft > 0)) missing.push('daily_loss_soft');
  for (const k of ctx.read.sizingKeys()) if (sizing[k] === undefined || sizing[k] === null) missing.push(`policies.${POLICY}.sizing.${k}`);
  if (missing.length) return r('rulebook-values', FAIL, `${p.account}: missing ${missing.join(', ')}`);
  return r('rulebook-values', PASS, `${p.account}: daily_loss_soft ${book.daily_loss_soft}, ${ctx.read.sizingKeys().length} sizing keys`);
}

function rulebookMissing(ctx) {
  const f = ctx.read.features();
  if (!f.lossStreakStop || !f.exitMode) return na('rulebook-missing', NEEDS.propMissing);
  const p = policyOf(ctx);
  const book = p ? ctx.read.rulebook(p.account) : null;
  const entry = (book && book.policies && book.policies[POLICY]) || {};
  const missing = [];
  if ((book || {}).loss_streak_stop === undefined && entry.loss_streak_stop === undefined) missing.push('loss_streak_stop');
  if (!(entry.exit && entry.exit.mode)) missing.push(`policies.${POLICY}.exit.mode`);
  if (missing.length) return r('rulebook-missing', FAIL, `${p ? p.account : 'no account'}: missing ${missing.join(', ')}`);
  return r('rulebook-missing', PASS, `loss_streak_stop and exit mode ${entry.exit.mode}`);
}

/**
 * The run's account states (replay/config.js accountStates, prop/account-states.js): the document still the one the
 * config resolved, drawn on the account the policy strategy trades (the runner's attempt is that account's), from
 * practice-train runs only, under the order gate's loss limits now, and every bucket the paths have given a day (else
 * the reweighting can't restore the natural rates). N/A for a run without them.
 */
function accountStates(ctx) {
  const st = ctx.run.accountStates;
  if (!st) return r('account-states', NA, 'the run\'s days start from no drawn account states');
  let doc;
  try { doc = ctx.read.statesDoc(st.file); } catch (e) { return r('account-states', FAIL, errText(e)); }
  const bad = [];
  if (doc.hash !== st.hash) bad.push(`its hash ${doc.hash.slice(0, 12)} is not the config's ${st.hash.slice(0, 12)}`);
  const p = policyOf(ctx);
  if (!p || p.account !== doc.account) bad.push(`drawn on ${doc.account}, but ${POLICY} trades ${p ? p.account : 'no account'}`);
  const roles = [...new Set((doc.source || []).map(x => x.role))];
  if (!roles.length || roles.some(x => x !== 'practice-train')) bad.push(`drawn from ${roles.length ? roles.join(', ') : 'no named'} runs, not practice-train only`);
  const gate = ctx.read.gateLimits();
  if (JSON.stringify(doc.gate) !== JSON.stringify(gate)) bad.push(`drawn under the gate's loss limits ${JSON.stringify(doc.gate)}, not today's ${JSON.stringify(gate)}`);
  const un = st.assignment.unsampled;
  if (un.length) bad.push(`no day of the run starts in ${un.join(', ')}: the reweighting can't restore the natural rates (draw more, or run more days)`);
  if (bad.length) return r('account-states', FAIL, `${doc.hash.slice(0, 12)}: ${bad.join('; ')}`);
  const days = st.assignment.days.length;
  const by = Object.entries(st.assignment.sampledDays).filter(([, n]) => n).map(([b, n]) => `${b} ${n} (weight ${st.assignment.weights[b]})`).join(', ');
  return r('account-states', PASS, `${doc.hash.slice(0, 12)} on ${doc.account}: ${days} day(s): ${by}`);
}

/** Words that would tell the model its account state was drawn: never in the attempt line. */
const DRAWN = /\b(drawn|draws?|sampl\w*|bucket\w*|weight\w*|seed\w*|oversampl\w*)\b/i;

/**
 * The attempt line the model is shown (the runner's account text, from a real attempt record and snapshot: the live
 * path) carries its facts: balance, floor, cushion, profit against the target, the day of the attempt, the profit still
 * needed, the room to the daily limit and the soft stop (where the account has them), today's trades and losses and the
 * losing streak; and nothing that says it was drawn. On the run's account states (an after-losses draw when there is
 * one), else a fresh attempt on the policy's account.
 */
function accountFacts(ctx) {
  if (!ctx.read.features().accountFacts) return na('account-facts', NEEDS.accountFacts);
  const st = ctx.run.accountStates;
  const doc = st ? ctx.read.statesDoc(st.file) : null;
  const p = policyOf(ctx);
  const account = doc ? doc.account : p && p.account;
  const draw = doc ? doc.draws.find(d => d.bucket === 'after-losses') || doc.draws[0] : null;
  if (!account) return r('account-facts', FAIL, `no account to show: ${POLICY} names none and the run has no account states`);
  const line = ctx.read.attemptLine(account, draw ? draw.state : null, ctx.run.start);
  const a = ctx.read.accountProfile(account);
  const want = [/balance \$/, /floor \$/, /cushion \$/, /profit [+-]?\$[\d,.]+ of \$/, /\bday \d+\b/, /needs \$/, /today \d+ trades?, \d+ loss(es)?/, /losing streak \d+/];
  if (a && a.daily_loss_limit > 0) want.push(/daily room \$/);
  if (a && a.daily_loss_soft > 0) want.push(/soft stop \$/);
  const missing = want.filter(re => !re.test(line)).map(re => re.source);
  if (missing.length) return r('account-facts', FAIL, `the attempt line misses ${missing.join(', ')}: ${line.trim().slice(0, 300)}`);
  if (DRAWN.test(line)) return r('account-facts', FAIL, `the attempt line says the state was drawn ("${line.match(DRAWN)[0]}")`);
  if (draw) {
    const s = draw.state;
    const shows = [`today ${s.tradesToday} trade`, `${s.lossesToday} loss`, `losing streak ${s.lossStreak}`, `day ${s.sessionsDone + 1}`];
    const off = shows.filter(x => !line.includes(x));
    if (off.length) return r('account-facts', FAIL, `the seeded attempt line doesn't show its state (${off.join(', ')}): ${line.trim().slice(0, 300)}`);
  }
  return r('account-facts', PASS, `${account}${draw ? ` from a drawn ${draw.bucket} state` : ', a fresh attempt'}: balance, floor, cushion, day, profit needed, the daily and soft room, today's trades, losses and streak shown; nothing says it was drawn`);
}

function monteCarlo(ctx) {
  if (!ctx.read.features().monteCarlo) return na('monte-carlo', NEEDS.monteCarlo);
  return r('monte-carlo', PASS, `the 30-day Monte Carlo scores the run at its end (prop/model-score.js)${ctx.run.accountStates ? ', each decision weighted back to the natural mix of account states' : ''}`);
}

/**
 * The fine-tuning adapter the runner config declares (learning/adapter.js adapterCheck): N/A with none; FAIL on a
 * missing or invalid manifest, a stale one (its skills or prompt digest not the harness's now), or no validation result.
 */
function adapter(ctx) {
  const x = require('./adapter').adapterCheck({ cfg: ctx.run.cfg || {}, role: roleOf(ctx), read: ctx.read });
  return r('adapter', x.status, x.detail);
}

const CHECKS = Object.freeze([
  strategy, strategyValidBars, skillsCrosswalk, headPromptCheck, headComposedReads, adaptersInSync, noWebInReplay, facts, curatedList,
  curatedSource, splitWindow, latency, practiceMode, libraryDisplay, experienceIndex, riskRecord, ledgerLook, stage,
  scorecardComposed, propPortfolio, rulebookValues, rulebookMissing, accountStates, accountFacts, monteCarlo, adapter,
]);

function runChecks(ctx, checks = CHECKS) {
  const results = checks.map(fn => {
    try {
      return fn(ctx);
    } catch (e) {
      return r(fn.name, FAIL, errText(e));
    }
  });
  return { ok: results.every(x => x.status !== FAIL), results };
}

function formatReport({ ok, results }) {
  const lines = results.map(x => `${x.status.padEnd(4)} ${x.check}: ${x.detail}`);
  const n = s => results.filter(x => x.status === s).length;
  lines.push(`training preflight ${ok ? 'passed' : 'FAILED'}: ${n(PASS)} pass, ${n(FAIL)} fail, ${n(WARN)} warn, ${n(NA)} not available`);
  return `${lines.join('\n')}\n`;
}

// --- Readers -----------------------------------------------------------------------------------------------------

/** Load once, then reuse (each reader is called by several checks). */
const once = fn => {
  let done = false;
  let v;
  return (...a) => {
    if (!done) { v = fn(...a); done = true; }
    return v;
  };
};

/** The run's bars (--bars for the symbol) at `minutes` (1m aggregated): Map(open ms -> close), or { error }. */
function barCloses({ barsFiles }, symbol, minutes) {
  const { readBarsArg, barMinutes, aggregate } = require('../backtest/data');
  const file = barsFiles && symbol ? barsFiles[symbol] : null;
  if (!file) return { error: `no ${symbol || 'symbol'} bars given (--bars) to compare the list with` };
  if (!(Number.isInteger(minutes) && minutes > 0)) return { error: 'the list names no bar timeframe' };
  const raw = readBarsArg(file);
  const m = raw.length > 1 ? barMinutes(raw) : minutes;
  let bars;
  if (m === minutes) bars = raw;
  else if (m === 1) bars = aggregate(raw, { unit: 2, unitNumber: minutes, nowMs: Infinity, extraFields: 'drop' });
  else return { error: `${path.basename(file)}: ${m}-minute bars, not the list's ${minutes}m or one-minute` };
  return new Map(bars.map(b => [Date.parse(b.t), b.c]));
}

/** The sample briefing on the run's bar data: its first bar closing after the run's start, built as the runner builds it. */
function sampleBriefing({ barsFiles, env }, { symbol, minutes, start, end, barDelayMs, minuteLane }) {
  const { readBarsArg, barMinutes, aggregate } = require('../backtest/data');
  const { buildBriefing, current } = require('../trading/briefing');
  const { signalMaxAgeMin } = require('../trading/signal-state');
  const file = barsFiles && symbol ? barsFiles[symbol] : null;
  if (!file) return { error: `no bar data for ${symbol || 'the run\'s symbol'}: give the run's bars (--bars ${symbol || 'SYMBOL'}=<file>, one-minute or the run's ${minutes}m)` };
  const raw = readBarsArg(file);
  const m = raw.length > 1 ? barMinutes(raw) : minutes;
  let base;
  let fine = null;
  if (m === minutes) base = raw;
  else if (m === 1) {
    base = aggregate(raw, { unit: 2, unitNumber: minutes, nowMs: Infinity, extraFields: 'drop' }).map(b => ({ ...b, ms: Date.parse(b.t) }));
    fine = raw;
  } else return { error: `${path.basename(file)}: ${m}-minute bars; the run trades ${minutes}-minute bars (give one-minute bars or the run's)` };
  const tfMs = minutes * MINUTE;
  const i = base.findIndex(b => b.ms + tfMs > start.getTime());
  if (i === -1 || base[i].ms + tfMs > end.getTime()) return { error: `${path.basename(file)} has no ${minutes}m bar closing in the run's window ${start.toISOString()} to ${end.toISOString()}` };
  const close = base[i].ms + tfMs;
  const now = new Date(close + barDelayMs);
  const strip = list => list.map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
  const bars = strip(base.slice(Math.max(0, i - WINDOW_BARS + 1), i + 1));
  // The runner's briefing gets 1m bars only from a 1m lane; without one it builds no 5m facts from 3m bars, nor does this.
  const fineBars = fine && minuteLane ? strip(fine.filter(b => b.ms + MINUTE <= close && b.ms + MINUTE > close - WINDOW_BARS * tfMs)) : null;
  const briefing = buildBriefing({ symbol, bars, minutes, fineBars, now });
  const gc = require('../trading/config').loadConfig(env);
  const limitMin = signalMaxAgeMin(`${minutes}m`, { bars: gc.signalMaxAgeBars, capMin: gc.signalMaxAgeCapMin, ceilingMin: gc.signalMaxAgeCeilingMin });
  return { briefing, now, limitMin, current: current(briefing, now) };
}

/** Whether the module at scripts/lib/<parts> under root exports the function `name` (never from its text). */
function exported(root, parts, name) {
  try { return typeof require(path.join(root, 'scripts', 'lib', ...parts))[name] === 'function'; } catch (_err) { return false; }
}

/**
 * The attempt line the runner would show for an attempt on account `name` (from `state`, a drawn account state, or a
 * fresh attempt) at `at`: the live path, in a scratch home: the attempt record (prop-state seedAttempt or startAttempt),
 * the runner's first snapshot, its summaries (prop/live-runner.js) and its account text (autotrader.js accountText).
 */
function attemptLine(root, env, name, state, at = new Date()) {
  const os = require('os');
  const ps = require('../trading/prop-state');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fth-preflight-'));
  try {
    const account = require('../trading/accounts').accountNamed(root, name, env);
    const now = new Date(at);
    if (state) ps.seedAttempt(home, account, { day: require('../trading/clock').tradingDayKey(now), at: now.toISOString(), state });
    else ps.startAttempt(home, account, now);
    const balance = state ? state.balance : account.starting_balance;
    ps.snapshot(home, account, balance, now, { open: 0 });
    const { strategies } = require('../trading/strategies').loadStrategies(root, env);
    const hooks = require('../prop/live-runner').createPropHooks({ root, env, home, client: null, accountId: null, strategies: () => strategies });
    const attempts = hooks.summaries(now, balance);
    return require('../autotrader').accountText({ id: 'account', at: now.toISOString(), balance, positions: [], workingOrders: 0, attempts });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function defaultReaders(root, env = process.env, { barsFiles = {} } = {}) {
  const exists = rel => fs.existsSync(path.join(root, rel));
  return {
    strategies: once(() => require('../trading/strategies').loadStrategies(root, env).strategies),
    skillText: name => fs.readFileSync(path.join(root, 'skills', name, 'SKILL.md'), 'utf8'),
    skillExists: name => /^[a-z0-9][a-z0-9-]*$/.test(name) && exists(path.join('skills', name, 'SKILL.md')),
    roleSkillsMode: () => require('../role-skills').modeOf(env),
    head: once(() => {
      const hp = require('../head-prompt');
      const config = path.join(root, 'workspace', 'opencode.json');
      const prompt = hp.headPromptIn(config);
      return {
        prompt, core: [...hp.CORE], composedReads: Array.isArray(hp.COMPOSED_READS) ? [...hp.COMPOSED_READS] : null,
        embedded: hp.embeddedSkills(prompt, root), attestation: hp.attestation(config, root),
        expectedSha256: hp.sha256(hp.headPrompt(hp.headPlan(root, 'index'))),
      };
    }),
    replayStep: run => require('../replay/web-access').replayStep(run, { root, env }),
    syncStale: once(() => require('../harness-sync').syncHarness(root, { check: true, mode: require('../role-skills').modeOf(env) })),
    sampleBriefing: opts => sampleBriefing({ barsFiles, env }, opts),
    barCloses: (symbol, minutes) => barCloses({ barsFiles }, symbol, minutes),
    tickOf: symbol => { const s = require('../trading/contracts').specFor(symbol); return s ? s.tickSize : null; },
    curatedDoc: file => require('./curated-lists').readLists(file),
    index: file => require('./experience-index').readIndex(file),
    runExit: run => require('./run-experience').plannedExit(run, { root, env }),
    riskRecord: file => require('./risk-record-index').readRiskIndex(file),
    riskPin: home => require('./risk-record-index').riskPin(home),
    learningGate: gate => require('./run-gate').checkLearningRun({ ...gate, env }),
    rulebook: name => {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(String(name || ''))) return null;
      const rb = require('../trading/rulebook');
      const dir = require('../trading/accounts').accountDirs(root, env).find(d => fs.existsSync(path.join(d, name, 'ACCOUNT.md')));
      return dir ? rb.loadRulebookFile(path.join(dir, name, rb.FILE)) : null;
    },
    sizingKeys: () => [...require('../trading/rulebook').SIZING_KEYS],
    statesDoc: file => require('../prop/account-states').readDocument(file),
    gateLimits: () => ({ ...require('../prop/attempts').gateLimits(env) }),
    accountProfile: name => { try { return require('../trading/accounts').accountNamed(root, name, env); } catch (_err) { return null; } },
    attemptLine: (name, state, at) => attemptLine(root, env, name, state, at),
    // The selected fine-tuning adapter's manifest, the training spec, and the harness's skills and prompt digests now.
    adapterManifest: file => require('./adapter').readJsonFile(file),
    adapterSpec: () => require('./adapter').readJsonFile(path.join(root, require('./adapter').SPEC_FILE)),
    harnessDigests: once(() => require('./adapter').currentDigests(root)),
    features: once(() => {
      const rb = require('../trading/rulebook');
      // The scorecard scores composed setups when its module says so (an exported SCORES_COMPOSED: true, as the rulebook's
      // ITEMS say loss_streak_stop exists), never from its text: a comment naming "composed" is no feature.
      let scorecardComposed = false;
      try { scorecardComposed = require(path.join(root, 'scripts', 'lib', 'replay', 'scorecard.js')).SCORES_COMPOSED === true; } catch (_err) { /* none */ }
      // The skill-usage report is merged when its module exports the reader (readSkillUsage), as the scorecard's flag.
      let skillUsage = false;
      try { skillUsage = typeof require(path.join(root, 'scripts', 'lib', 'learning', 'skill-usage.js')).readSkillUsage === 'function'; } catch (_err) { /* none */ }
      return {
        scorecardComposed,
        lossStreakStop: Object.hasOwn(rb.ITEMS, 'loss_streak_stop'),
        exitMode: rb.EXIT_KEYS.includes('mode'),
        skillUsage,
        // The attempt line's facts are merged when the runner's account text and the facts function are exported; the
        // Monte Carlo when the model score is.
        accountFacts: exported(root, ['autotrader.js'], 'accountText') && exported(root, ['trading', 'combine.js'], 'attemptFacts'),
        monteCarlo: exported(root, ['prop', 'model-score.js'], 'scoreRun'),
      };
    }),
  };
}

/** The learning gate's options from a resolved run and the replay CLI's flags, as scripts/replay.js run builds them. */
function gateOptions(run, { candidate = null, evaluation = null, validate = false, reasoningFix = false } = {}) {
  const { setupHash, setupBase, setupFixed, lookArm } = require('../replay/config');
  // The arm its look names (with the library's when shown), the setup, its base without the display, and the setup
  // without its code digest (what a resumed look keeps: learning/looks.js).
  return { from: run.start, to: run.end, runId: run.runId, learning: run.learning, candidate, evaluation, validate, reasoningFix, endOfDay: run.endOfDay, practice: run.practice, runDir: run.paths.runDir, arm: lookArm(run), config: setupHash(run), base: setupBase(run), setup: setupFixed(run) };
}

const RECORD = 'preflight.jsonl';

function preflightForRun(run, gate, { root, env = process.env, barsFiles = {}, noBars = null, log = () => {}, read = null, now = () => new Date() } = {}) {
  if (!run.learning) return null;
  const result = runChecks({ run, gate, noBars, read: read || defaultReaders(root, env, { barsFiles }) });
  const text = formatReport(result);
  if (!result.ok) throw new Error(`training preflight refused the run:\n${text}`);
  for (const line of text.trimEnd().split('\n')) log(`preflight ${line}`);
  const record = runHome => {
    fs.mkdirSync(runHome, { recursive: true });
    fs.appendFileSync(path.join(runHome, RECORD), `${JSON.stringify({ at: now().toISOString(), runId: run.runId, ok: result.ok, results: result.results })}\n`);
    return path.join(runHome, RECORD);
  };
  return { ...result, record };
}

module.exports = {
  PASS, FAIL, NA, WARN, NEEDS, CHECKS, RECORD, FRAMES,
  strategy, strategyValidBars, skillsCrosswalk, headPromptCheck, headComposedReads, adaptersInSync, facts, curatedList,
  curatedSource, splitWindow, latency, practiceMode, libraryDisplay, experienceIndex, riskRecord, ledgerLook, stage,
  scorecardComposed, propPortfolio, rulebookValues, rulebookMissing, accountStates, accountFacts, monteCarlo, noWebInReplay, adapter,
  crosswalkOf, attemptLine, runChecks, formatReport, defaultReaders, sampleBriefing, gateOptions, preflightForRun,
};
