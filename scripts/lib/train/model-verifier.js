'use strict';

/**
 * The training loop's model-scoring verifier (docs/TRAINING.md, "The keep rule"): a champion and a challenger are
 * judged on the model's own trades. Both trees replay the same windows (the loop's replay config, its seed), and then:
 *
 *   - the paired 30-day Monte Carlo of the two runs of each window (prop/model-score.js pairRuns: the same start days,
 *     the same resampled day blocks, the same faults; A is the champion, B the challenger, every difference A minus B);
 *   - the paired decision measures (train/paired.js pairUp and tally): process adherence (the scorecard's category per
 *     decision, right or not) and the correct-read rate (a decision's reads all verified true or not), each by an exact
 *     one-sided McNemar test.
 *
 * KEEP_RULE and decide() are the one place the keep rule lives. In order:
 *
 *   (a) zero blows on the challenger's side, in every real attempt and resampled path of every window: a hard rule;
 *   (b) no significantly worse blow rate in any window (the 90% paired interval of A minus B wholly below 0);
 *   (c) a gain, in every window: a better pass rate within the account's sessions (A minus B wholly below 0) or fewer
 *       median days to pass (A minus B wholly above 0), with neither measure significantly worse in any window; a window
 *       shorter than one attempt (the account's sessions) shows nothing;
 *   (d) process adherence and the correct-read rate not significantly worse (McNemar, the loop's decision rule:
 *       at least minDiscordant discordant decisions and p <= alpha), in any window.
 *
 * Any of (a), (b), the worse half of (c) or (d) rejects; a change that adds return but adds a blow is rejected. No gain
 * is not kept (rejected: nothing shows it better). A measure that can't be read (a run without its reads, a score that
 * fails) is never a pass: the verdict is `blocked` or `inconclusive`, never `kept`.
 *
 * Splits and looks: tuning windows lie in practice-train (learning/splits.js) only; held-out windows each lie in one held-
 * back learning window (practice-validate, test, final), read through the learning ledger's looks the runs took before
 * their first cycle (learning/run-gate.js; pairRuns checks each run's look, prop/evaluator.js checkModelWindow). A
 * diagnostic score (a curated or setup-focused run) can keep a change on tuning, labelled diagnostic, but never on
 * held-out months, and never promotes. The frozen promotion gate (prop/promotion.js) stays the final gate: held-out
 * judging reports the challenger's verdict from it (`promotion`), and a kept change is never a promotion.
 *
 * A kept change is a PR for the owner (train/loop.js promote): nothing here merges, pushes or edits a document.
 *
 *   KEEP_RULE
 *   resolveModelScore(raw)                 the loop config's `modelScore` ({ account, paths, reps, faults }) or null
 *   windowErrors(tuning, heldOut)          [error]: tuning outside practice-train, held-out outside one held-back window
 *   adherence(base, cand), reads(base, cand)   the paired decision measures (tally: b fixed, c broken, pWorse)
 *   decide(windows, { rule, heldOut })     { verdict: kept | rejected | inconclusive, reasons, diagnostic }
 *   verify({ cfg, pairs, seed, root, candidateRoot, env, heldOut, rule, deps })   the verifier: { available, verdict, ... }
 *   combine({ panel, model, evaluator, rule })   the loop's verdict: the keep rule decides; the panel's harms, its blows
 *                                          and the mechanical evaluator's failures can only reject
 */

const { DECISION_RULE, pairUp, tally, harmReasons } = require('./paired');
const { rolesBetween } = require('../learning/splits');

const KEEP_RULE = Object.freeze({ maxChallengerBlows: 0, level: 0.9 });
const HELD_BACK = Object.freeze(['practice-validate', 'test', 'final']);
const KEYS = ['account', 'paths', 'reps', 'faults'];

function resolveModelScore(raw) {
  if (raw === undefined || raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('modelScore: an object { account, paths, reps, faults }');
  const errors = [];
  for (const k of Object.keys(raw)) if (!KEYS.includes(k)) errors.push(`modelScore.${k}: not a setting (${KEYS.join(', ')}); the seed is the loop's, the same for both sides`);
  if (typeof raw.account !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.account)) errors.push('modelScore.account: the account profile the attempts run under (accounts/<name>)');
  for (const k of ['paths', 'reps']) if (raw[k] !== undefined && !(Number.isInteger(raw[k]) && raw[k] >= 200 && raw[k] <= 20000)) errors.push(`modelScore.${k}: a whole number from 200 to 20000`);
  let faults = {};
  try { faults = require('../prop/model-score').parseFaults(raw.faults); } catch (err) { errors.push(`modelScore.faults: ${err.message}`); }
  if (errors.length) throw new Error(errors.join('\n'));
  return Object.freeze({ account: raw.account, paths: raw.paths || 2000, reps: raw.reps || 2000, faults });
}

/** Tuning only on practice-train; each held-out window inside one held-back learning window (its looks are the ledger's). */
function windowErrors(tuning = [], heldOut = []) {
  const roles = w => { try { return rolesBetween(w.from, w.to); } catch (err) { return [`(${err.message})`]; } };
  const out = [];
  for (const w of tuning || []) {
    const r = roles(w);
    if (!(r.length === 1 && r[0] === 'practice-train')) out.push(`tuningWindows ${w.from}..${w.to}: the model-scored loop tunes on practice-train only (this touches ${r.join(' + ')})`);
  }
  for (const w of heldOut || []) {
    const r = roles(w);
    if (!(r.length === 1 && HELD_BACK.includes(r[0]))) out.push(`heldOutWindows ${w.from}..${w.to}: the model-scored loop judges held out inside one of ${HELD_BACK.join(', ')}, through its learning looks (this touches ${r.join(' + ')})`);
  }
  return out;
}

const records = list => (list || []).filter(d => d && d.key && d.category).map(d => ({ key: d.key, repeat: 0, category: d.category, blow: d.blow === true }));

/** Process adherence: each decision right or not, paired (a decision only the challenger made counts against it). */
function adherence(base, cand) {
  const judged = pairUp(records(base), records(cand)).filter(p => p.base.category !== 'unchecked');
  return { ...tally(judged, r => r.category !== 'right'), decisions: judged.length };
}

/** The correct-read rate: on the decisions both sides read on, each read all true or not. base, cand: Map key -> reads. */
function reads(base, cand) {
  const ok = rs => rs.every(r => r && (r.check === true || r.check === 'true'));
  const keys = [...base.keys()].filter(k => cand.has(k) && (base.get(k) || []).length && (cand.get(k) || []).length);
  const side = m => keys.map(k => ({ key: k, repeat: 0, category: ok(m.get(k)) ? 'right' : 'false read' }));
  return { ...tally(pairUp(side(base), side(cand)), r => r.category !== 'right'), decisions: keys.length };
}

const worse = (m, rule) => Boolean(m) && m.n >= rule.minDiscordant && m.pWorse <= rule.alpha;
const span = i => (i && i.lo !== null && i.lo !== undefined ? `${i.diff} [${i.lo}, ${i.hi}]` : 'none');

/**
 * The keep rule (the module head). windows: [{ label, mc (pairRuns' result), adherence, reads, sessions?, promotion? }].
 * heldOut: a diagnostic score never judges there.
 */
function decide(windows, { rule = DECISION_RULE, heldOut = false } = {}) {
  if (!Array.isArray(windows) || !windows.length) return { verdict: 'inconclusive', reasons: ['no window was scored'], diagnostic: false };
  const rejected = [];
  const open = [];
  const blows = windows.reduce((s, w) => s + Number((w.mc && w.mc.blows && w.mc.blows.b) || 0), 0);
  const diagnostic = windows.some(w => /^diagnostic/.test(String(w.mc && w.mc.a && w.mc.a.score)) || /^diagnostic/.test(String(w.mc && w.mc.b && w.mc.b.score)));
  // (a) zero blows for the challenger: a hard rule, whatever else it gains.
  if (!(blows <= KEEP_RULE.maxChallengerBlows)) rejected.push(`(a) ${blows} blow(s) on the challenger's side over the windows' attempts and paths: zero blows is a hard rule`);
  const gains = [];
  for (const w of windows) {
    const d = w.mc && w.mc.diff && w.mc.diff.resampled;
    if (!d || !d.passRate || !d.blowRate) { open.push(`${w.label}: no paired Monte Carlo`); continue; }
    if (!(Number(w.mc.inputs && w.mc.inputs.level) >= KEEP_RULE.level)) open.push(`${w.label}: the paired intervals are under ${KEEP_RULE.level}`);
    const days = d.medianDaysToPass || {};
    // (b) the blow rate, A minus B: wholly below 0 is the challenger blowing more.
    if (d.blowRate.hi < 0) rejected.push(`(b) ${w.label}: blow rate significantly worse (champion minus challenger ${span(d.blowRate)})`);
    // (c), the worse half: a pass rate or days to pass significantly worse is a trade-off, never a gain.
    if (d.passRate.lo > 0) rejected.push(`(c) ${w.label}: pass rate significantly worse (champion minus challenger ${span(d.passRate)})`);
    if (days.hi !== null && days.hi !== undefined && days.hi < 0) rejected.push(`(c) ${w.label}: median days to pass significantly more (champion minus challenger ${span(days)})`);
    // (d) the decision measures, not significantly worse.
    if (worse(w.adherence, rule)) rejected.push(`(d) ${w.label}: process adherence significantly worse (${w.adherence.c} decision(s) broken, ${w.adherence.b} fixed, p ${w.adherence.pWorse})`);
    if (worse(w.reads, rule)) rejected.push(`(d) ${w.label}: correct-read rate significantly worse (${w.reads.c} broken, ${w.reads.b} fixed, p ${w.reads.pWorse})`);
    if (!w.adherence) open.push(`${w.label}: process adherence not measured`);
    if (!w.reads) open.push(`${w.label}: correct-read rate not measured${w.readsWhy ? ` (${w.readsWhy})` : ''}`);
    const sessions = Number(w.mc.inputs && w.mc.inputs.sessions);
    if (!(Number(w.mc.inputs && w.mc.inputs.days) >= sessions)) open.push(`${w.label}: ${w.mc.inputs && w.mc.inputs.days} day(s), shorter than one ${sessions}-session attempt: it shows nothing`);
    // (c), the gain: a pass rate better, or fewer median days to pass, the interval clear of 0.
    gains.push({ label: w.label, gain: d.passRate.hi < 0 || (days.lo !== null && days.lo !== undefined && days.lo > 0), d });
  }
  if (rejected.length) return { verdict: 'rejected', reasons: rejected, diagnostic };
  if (heldOut && diagnostic) open.push('a diagnostic score (curated or setup-focused) never judges held-out months and never promotes: only full-day runs');
  if (open.length) return { verdict: 'inconclusive', reasons: open, diagnostic };
  const none = gains.filter(g => !g.gain);
  if (none.length) return { verdict: 'rejected', reasons: none.map(g => `(c) ${g.label}: no significant gain (pass rate ${span(g.d.passRate)}, median days ${span(g.d.medianDaysToPass)}, champion minus challenger): nothing shows the challenger better`), diagnostic };
  return { verdict: 'kept', reasons: [`zero challenger blows; a significant gain in every window (${gains.map(g => `${g.label}: pass rate ${span(g.d.passRate)}, median days ${span(g.d.medianDaysToPass)}`).join('; ')}); adherence and reads not worse${diagnostic ? '; a diagnostic score: never a promotion' : ''}`], diagnostic };
}

/** The run's decisions' reads by key (root|bar): ab-compare.js decisionsByKey when on this branch, else the same key here. */
function readsByKey(runDir, { root }) {
  const { decisions } = require('../learning/run-experience').runDecisions(runDir, { root });
  let byKey = null;
  try { byKey = require('./ab-compare').decisionsByKey; } catch (_err) { /* not merged here */ }
  if (typeof byKey === 'function') return new Map([...byKey(decisions)].filter(([, x]) => x.reads).map(([k, x]) => [k, x.reads]));
  const m = new Map();
  for (const d of decisions || []) if (d && d.root && d.bar && Array.isArray(d.reads) && d.reads.length && !m.has(`${d.root}|${d.bar}`)) m.set(`${d.root}|${d.bar}`, d.reads);
  return m;
}

/** The account and the sizing both sides are scored with: one rulebook for both, so a tree whose sizing differs is blocked. */
function defaultSides({ cfg, root, candidateRoot, env }) {
  const { accountNamed } = require('../trading/accounts');
  const { loadStrategies } = require('../trading/strategies');
  const { policyFor } = require('../prop/model-score');
  const of = tree => {
    const account = accountNamed(tree, cfg.account, env);
    const policy = policyFor(loadStrategies(tree, env).strategies, account.name);
    const { file: _f, body: _b, description: _d, ...rules } = account;
    return { account, policy, sizing: JSON.stringify([rules, policy ? [policy.sizing || null, policy.contracts || null, policy.exit || null] : null]) };
  };
  const a = of(root);
  const b = candidateRoot ? of(candidateRoot) : a;
  return { account: a.account, policy: a.policy, differ: a.sizing !== b.sizing };
}

const defaultDeps = {
  sides: defaultSides,
  pair: (dirA, dirB, opts) => require('../prop/model-score').pairRuns(dirA, dirB, opts),
  reads: readsByKey,
  scoreOne: (dir, opts) => require('../prop/model-score').scoreRun(dir, { ...opts, riskActions: false, attribution: false }),
};

/**
 * The verifier. pairs: [{ label, champion: { runDir, decisions }, candidate: { runDir, decisions } }], one per window,
 * both runs of the same window and seed. root: the champion's tree; candidateRoot: the challenger's. Never throws: a
 * score that fails is `blocked`, never a pass.
 */
function verify({ cfg, pairs, seed, root, candidateRoot = null, env = process.env, heldOut = false, rule = DECISION_RULE, deps = {} }) {
  if (!cfg) return { available: false, verdict: 'blocked', reasons: ['no modelScore in the loop config: the model-scoring verifier is not run'] };
  const d = { ...defaultDeps, ...deps };
  try {
    const sides = d.sides({ cfg, root, candidateRoot, env });
    if (sides.differ) return { available: true, verdict: 'blocked', reasons: ['the challenger changes the account or the policy\'s sizing: the paired Monte Carlo scores both runs with one rulebook, so it can\'t judge this change'], windows: [] };
    const opts = { root, env, account: sides.account, policy: sides.policy, seed, paths: cfg.paths, reps: cfg.reps, faults: cfg.faults };
    const windows = pairs.map(p => {
      const mc = d.pair(p.champion.runDir, p.candidate.runDir, opts);
      let r = null;
      let readsWhy = null;
      try { r = reads(d.reads(p.champion.runDir, { root, env }), d.reads(p.candidate.runDir, { root: candidateRoot || root, env })); } catch (err) { readsWhy = err.message; }
      return { label: p.label, mc, adherence: adherence(p.champion.decisions, p.candidate.decisions), reads: r, readsWhy };
    });
    const v = decide(windows, { rule, heldOut });
    const out = { available: true, ...v, windows: windows.map(w => ({ label: w.label, blows: w.mc.blows, diff: w.mc.diff.resampled, champion: w.mc.a.resampled, challenger: w.mc.b.resampled, score: w.mc.b.score, adherence: w.adherence, reads: w.reads, readsWhy: w.readsWhy })) };
    if (heldOut) {
      // The final gate, frozen (prop/promotion.js through scoreStream): reported, never replaced; a kept change is not a promotion.
      out.promotion = pairs.map(p => {
        try { const s = d.scoreOne(p.candidate.runDir, { ...opts, root: candidateRoot || root }); return { label: p.label, passes: s.promotion.passes, failures: s.promotion.failures }; } catch (err) { return { label: p.label, passes: false, failures: [err.message] }; }
      });
    }
    return out;
  } catch (err) {
    return { available: true, verdict: 'blocked', reasons: [`the model-scoring verifier could not score the runs: ${err.message}`], windows: [] };
  }
}

/**
 * The loop's verdict with the model-scoring verifier on: the keep rule decides; every other verifier can only reject
 * (R26: all required): the panel's blows and harms (paired.js), and the mechanical evaluator's blows and failures.
 */
function combine({ panel, model, evaluator = null, rule = DECISION_RULE }) {
  if (!model || !model.available || model.verdict === 'blocked') return { verdict: 'blocked', reasons: (model && model.reasons) || ['the model-scoring verifier is unavailable'] };
  const out = [];
  const t = panel && panel.tests;
  if (!t) out.push('the panel\'s paired test has no result');
  else {
    if (t.blows) out.push(`panel: ${t.blows} blow(s) on the candidate's side: zero blows, no exception`);
    out.push(...harmReasons(t, rule).map(r => `panel: ${r}`));
  }
  if (evaluator && evaluator.available) {
    if ((evaluator.blows || 0) > 0) out.push(`evaluator: ${evaluator.blows} blow(s)`);
    out.push(...(evaluator.failures || []).map(f => `evaluator: ${f}`));
  }
  if (out.length || model.verdict === 'rejected') return { verdict: 'rejected', reasons: [...out, ...(model.verdict === 'rejected' ? model.reasons : [])] };
  return { verdict: model.verdict, reasons: model.reasons };
}

module.exports = { KEEP_RULE, HELD_BACK, resolveModelScore, windowErrors, adherence, reads, decide, verify, combine };
