'use strict';

/**
 * The training loop's model-scoring verifier (docs/TRAINING.md, "The keep rule"): a champion and a challenger are
 * judged on the model's own trades. Both trees replay the same windows (the loop's replay config, its seed), and then:
 *
 *   - the paired 30-day Monte Carlo of the two runs of each window (prop/model-score.js pairRuns: the same start days,
 *     the same resampled day blocks, the same faults; A is the champion, B the challenger, every difference A minus B).
 *     Its real attempts (one per start day, a block bootstrap in blocks of the account's sessions S) are the evidence;
 *     its resampled paths redraw the window's own days, so their intervals shrink with `paths` whatever the effect:
 *     they are conditional on those days, and only (a) and (b) read them. Each side is scored as the model traded
 *     (scorePaired sized 'own'): every entry at its own filled share of the ceiling and, where it took itself out (an
 *     early exit, a tightened stop), at its own exit, so its stage-2 risk decisions count; the ceiling-sized result is
 *     reported beside it (`ceiling`), never judged. A curated run is refused (its moments are outcome-balanced and its
 *     rebuilt days drawn): the keep rule pairs full-day windows, at least (minBlocks + 1) x S session days each;
 *   - the paired decision measures (train/paired.js pairUp and tally): process adherence (the scorecard's category per
 *     decision, right or not) and the correct-read rate (a decision's reads all verified true or not), each by an exact
 *     one-sided McNemar test.
 *
 * KEEP_RULE and decide() are the one place the keep rule lives. The primary measure, declared before any run, is the
 * pass rate within the account's sessions on the real attempts; the median days to pass is secondary, only reported.
 *
 *   (a) zero blows on the challenger's side, in every real attempt and resampled path of every window: a hard rule;
 *   (b) no significantly worse blow rate on the resampled paths in any window (conditional on its days: the 90% paired
 *       interval of A minus B wholly below 0);
 *   (c) i.  one pooled paired interval over the real attempts of every window (the per-start-day differences stacked,
 *           window by window, a block bootstrap in blocks of S inside each window) wholly below 0 for the primary
 *           measure: the challenger passes more;
 *       ii. no window significantly worse on its real attempts: pass rate, blow rate or median days to pass;
 *       a window whose real attempts are fewer than KEEP_RULE.minBlocks blocks of S (about 3 x S days) shows nothing;
 *   (d) process adherence and the correct-read rate not significantly worse (McNemar, the loop's decision rule:
 *       at least minDiscordant discordant decisions and p <= alpha), in any window, on at least the rule's minPairs
 *       paired decisions, with the challenger's decisions keyed as the champion's (KEEP_RULE.minOverlap of its keys).
 *
 * Any of (a), (b), (c) ii or (d) rejects; a change that adds return but adds a blow is rejected. No pooled gain is not
 * kept (rejected: nothing shows the challenger better). A measure that can't be read (a run without its reads, a score
 * that fails, a window too short, too few decisions) is never a pass: the verdict is `blocked` or `inconclusive`.
 *
 * The two sides' rulebooks: the account (its firm rules: sessions, target, max loss, daily limit) must be the same on
 * both trees, or the change is blocked. The policy's sizing, exit and multipliers (the account's RULEBOOK.md)
 * (not its contracts: a difference there is blocked) may differ: each side is then scored under its own (pairRuns policyB), the challenger's as a candidate
 * rulebook (prop/evaluator.js checkModelWindow candidateRulebook: refused on test and final, judged on practice-train
 * and practice-validate only), labelled as such; a rulebook that loosens a limit the rulebook guard forbids
 * (train/rulebook-guard.js; the exit is the search's, judged here, never a limit) is rejected unscored.
 *
 * Splits and looks: tuning windows lie in practice-train (learning/splits.js) only; held-out windows each lie in one held-
 * back learning window (practice-validate, test, final), read through the learning ledger's looks the runs took before
 * their first cycle (learning/run-gate.js; pairRuns checks each run's look, prop/evaluator.js checkModelWindow);
 * lookErrors refuses a judging that would need more looks than a window's budget has left. A diagnostic score (a
 * setup-focused run) can keep a change on tuning, labelled diagnostic, but never on held-out months, and never
 * promotes; a curated run is never paired (pairRuns refuses it, and the loop's config refuses a curated list). The frozen promotion gate (prop/promotion.js) stays the final gate: held-out judging reports the
 * challenger's verdict from it (`promotion`), and a kept change is never a promotion.
 *
 * A kept change is a PR for the owner (train/loop.js promote): nothing here merges, pushes or edits a document.
 *
 *   KEEP_RULE
 *   resolveModelScore(raw)                 the loop config's `modelScore` ({ account, paths, reps, faults }) or null
 *   windowErrors(tuning, heldOut)          [error]: tuning outside practice-train, held-out outside one held-back window
 *   lookErrors(windows, ledger, { perWindow })   [error]: a sealed window's budget too small for the looks judging takes
 *   adherence(base, cand), reads(base, cand)   the paired decision measures (tally: b fixed, c broken, pWorse; decisions,
 *                                          overlap: the share of the champion's keys the challenger decided)
 *   pooledInterval(strata, { block, reps, level, rand })   the stratified block bootstrap of the stacked differences
 *   decide(windows, { rule, heldOut })     { verdict: kept | rejected | inconclusive, reasons, diagnostic, pooled }
 *   verify({ cfg, pairs, seed, root, candidateRoot, env, heldOut, rule, deps })   the verifier: { available, verdict, ... }
 *   combine({ panel, model, evaluator, rule })   the loop's verdict: the keep rule decides; the panel's harms, its blows
 *                                          and the mechanical evaluator's failures can only reject
 */

const path = require('path');
const { DECISION_RULE, pairUp, tally, harmReasons } = require('./paired');
const { rolesBetween, SEALED } = require('../learning/splits');
const { decisionsByKey } = require('./ab-compare');
const stats = require('../prop/stats');

/**
 * maxChallengerBlows: (a). level: the paired intervals' two-sided level. primary: the measure (c) i judges, declared
 * before any run. minBlocks: the real attempts a window needs, in blocks of the account's sessions (2 x S start days,
 * so about 3 x S days), before it shows anything. minOverlap: the share of the champion's decisions (and reads) the
 * challenger must have decided on the same keys before the decision measures pair.
 */
const KEEP_RULE = Object.freeze({ maxChallengerBlows: 0, level: 0.9, primary: 'passRate', minBlocks: 2, minOverlap: 0.5 });
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

const rolesOf = w => { try { return rolesBetween(w.from, w.to); } catch (err) { return [`(${err.message})`]; } };

/** Tuning only on practice-train; each held-out window inside one held-back learning window (its looks are the ledger's). */
function windowErrors(tuning = [], heldOut = []) {
  const out = [];
  for (const w of tuning || []) {
    const r = rolesOf(w);
    if (!(r.length === 1 && r[0] === 'practice-train')) out.push(`tuningWindows ${w.from}..${w.to}: the model-scored loop tunes on practice-train only (this touches ${r.join(' + ')})`);
  }
  for (const w of heldOut || []) {
    const r = rolesOf(w);
    if (!(r.length === 1 && HELD_BACK.includes(r[0]))) out.push(`heldOutWindows ${w.from}..${w.to}: the model-scored loop judges held out inside one of ${HELD_BACK.join(', ')}, through its learning looks (this touches ${r.join(' + ')})`);
  }
  return out;
}

/**
 * Before any look is taken: each sealed window's role (test, final) must have budget left for every look judging
 * takes there (perWindow looks per window: the champion's run and the challenger's, each an evaluation of its own),
 * so a judging never spends looks and then blocks. ledger: the learning ledger's lines (learning/looks.js).
 */
function lookErrors(windows, ledger, { perWindow = 2, budgets = null } = {}) {
  const looks = require('../learning/looks');
  const usage = looks.lookUsage(Array.isArray(ledger) ? ledger : []);
  const need = new Map();
  for (const w of windows || []) {
    const r = rolesOf(w);
    if (r.length === 1 && SEALED.includes(r[0])) need.set(r[0], (need.get(r[0]) || 0) + perWindow);
  }
  const out = [];
  for (const [role, n] of need) {
    const budget = (budgets || looks.LOOK_BUDGETS)[role];
    const left = Math.max(0, budget - ((usage[role] && usage[role].evaluations) || 0));
    if (n > left) out.push(`${role}: judging these windows takes ${n} look(s) (${perWindow} per window: the champion's run and the challenger's), and ${left} of its ${budget} are left: refused before any look is spent`);
  }
  return out;
}

/**
 * Before any replay or look: a challenger whose rulebook differs is scored as a candidate rulebook, which a sealed
 * window (test, final) refuses (prop/evaluator.js checkModelWindow). So a proposal that edits a rulebook is refused
 * up front when any held-out window is sealed, rather than after both replays have spent their looks.
 */
function candidateErrors(windows, proposal) {
  const edits = proposal && Array.isArray(proposal.edits) ? proposal.edits : [];
  if (!edits.some(e => require('./proposal').kindOf(e.file) === 'rulebook')) return [];
  return (windows || []).filter(w => { const r = rolesOf(w); return r.length === 1 && SEALED.includes(r[0]); })
    .map(w => `${w.from}..${w.to}: the proposal edits a rulebook, a candidate rulebook never scored on a sealed window (tune it on practice-train, choose it on practice-validate): refused before any look is spent`);
}

const records = list => (list || []).filter(d => d && d.key && d.category).map(d => ({ key: d.key, repeat: 0, category: d.category, blow: d.blow === true }));
const shareOf = (keys, other) => (keys.length ? keys.filter(k => other.has(k)).length / keys.length : 0);
const round = x => Math.round(x * 10000) / 10000;

/**
 * Process adherence: each decision right or not, paired (a decision only the challenger made counts against it; one
 * only the champion made is the challenger's `no decision`, a failure). overlap: the share of the champion's judged
 * decisions the challenger decided on the same key.
 */
function adherence(base, cand) {
  const judged = pairUp(records(base), records(cand)).filter(p => p.base.category !== 'unchecked');
  const baseKeys = [...new Set(records(base).filter(r => r.category !== 'unchecked' && r.category !== 'no decision').map(r => r.key))];
  return { ...tally(judged, r => r.category !== 'right'), decisions: judged.length, overlap: round(shareOf(baseKeys, new Set(records(cand).map(r => r.key)))) };
}

/**
 * The correct-read rate: each decision's reads all true or not. base, cand: Map key -> reads. A read the champion made
 * and the challenger didn't is a failure on its side (it stopped reading); one only the challenger made pairs with a
 * right champion. overlap: the share of the champion's read decisions the challenger read on the same key.
 */
function reads(base, cand) {
  const ok = rs => rs.every(r => r && (r.check === true || r.check === 'true'));
  const read = m => [...m.keys()].filter(k => (m.get(k) || []).length);
  const side = m => read(m).map(k => ({ key: k, repeat: 0, category: ok(m.get(k)) ? 'right' : 'false read' }));
  const pairs = pairUp(side(base), side(cand));
  return { ...tally(pairs, r => r.category !== 'right'), decisions: pairs.length, overlap: round(shareOf(read(base), new Set(read(cand)))) };
}

/**
 * One pooled paired interval: the mean of every stratum's differences together, its interval a circular block
 * bootstrap inside each stratum (a window's start days, blocks of `block`), so no block runs across two windows.
 * Degenerate (no information: the whole range) when any stratum holds fewer than two blocks.
 */
function pooledInterval(strata, { block, reps, level, rand }) {
  const list = Array.isArray(strata) ? strata : [];
  const n = list.reduce((t, x) => t + (Array.isArray(x) ? x.length : 0), 0);
  const total = list.reduce((t, x) => t + (Array.isArray(x) ? x.reduce((a, v) => a + v, 0) : 0), 0);
  const diff = n ? stats.round4(total / n) : null;
  if (!n || list.some(x => !Array.isArray(x) || x.length < 2 * block)) return { diff, lo: -1, hi: 1, level, n, block, degenerate: true };
  const means = new Array(reps);
  for (let r = 0; r < reps; r += 1) {
    let sum = 0;
    for (const x of list) {
      let taken = 0;
      for (let k = 0; k < Math.ceil(x.length / block); k += 1) {
        const start = stats.pick(rand, x.length);
        for (let j = 0; j < block && taken < x.length; j += 1, taken += 1) sum += x[(start + j) % x.length];
      }
    }
    means[r] = sum / n;
  }
  means.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return { diff, lo: stats.round4(stats.quantile(means, tail)), hi: stats.round4(stats.quantile(means, 1 - tail)), level, n, block };
}

const worse = (m, rule) => Boolean(m) && m.n >= rule.minDiscordant && m.pWorse <= rule.alpha;
const span = i => (i && i.lo !== null && i.lo !== undefined ? `${i.diff} [${i.lo}, ${i.hi}]` : 'none');
const informative = i => Boolean(i) && !i.degenerate && i.lo !== null && i.lo !== undefined && i.hi !== null && i.hi !== undefined;
const passed = st => (st === 'passed' ? 1 : 0);

/** (d) for one measure: worse rejects; unmeasured, too few decisions or decisions keyed apart is never a pass. */
function decisionChecks(label, name, m, why, rule, rejected, open) {
  if (!m) { open.push(`${label}: ${name} not measured${why ? ` (${why})` : ''}`); return; }
  if (worse(m, rule)) rejected.push(`(d) ${label}: ${name} significantly worse (${m.c} decision(s) broken, ${m.b} fixed, p ${m.pWorse})`);
  else if (!(m.decisions >= rule.minPairs)) open.push(`${label}: ${name}: ${m.decisions || 0} paired decision(s), under the rule's minimum of ${rule.minPairs}: not measured`);
  else if (!(m.overlap >= KEEP_RULE.minOverlap)) open.push(`${label}: ${name}: the challenger decided on ${Math.round((m.overlap || 0) * 100)}% of the champion's keys (at least ${KEEP_RULE.minOverlap * 100}%): its decisions don't pair (changed keys, or it stopped emitting them)`);
}

/**
 * The keep rule (the module head). windows: [{ label, mc (pairRuns' result), adherence, reads, readsWhy? }].
 * heldOut: a diagnostic score never judges there.
 */
function decide(windows, { rule = DECISION_RULE, heldOut = false } = {}) {
  if (!Array.isArray(windows) || !windows.length) return { verdict: 'inconclusive', reasons: ['no window was scored'], diagnostic: false, pooled: null };
  const rejected = [];
  const open = [];
  const blows = windows.reduce((s, w) => s + Number((w.mc && w.mc.blows && w.mc.blows.b) || 0), 0);
  const diagnostic = windows.some(w => /^diagnostic/.test(String(w.mc && w.mc.a && w.mc.a.score)) || /^diagnostic/.test(String(w.mc && w.mc.b && w.mc.b.score)));
  // (a) zero blows for the challenger: a hard rule, whatever else it gains.
  if (!(blows <= KEEP_RULE.maxChallengerBlows)) rejected.push(`(a) ${blows} blow(s) on the challenger's side over the windows' attempts and paths: zero blows is a hard rule`);
  const sessions = new Set();
  for (const w of windows) {
    const diff = w.mc && w.mc.diff;
    const real = diff && diff.real;
    const rs = diff && diff.resampled;
    const inputs = (w.mc && w.mc.inputs) || {};
    if (!real || !real.passRate || !real.blowRate || !rs || !rs.blowRate || !Array.isArray(w.mc.starts)) { open.push(`${w.label}: no paired Monte Carlo`); continue; }
    if (!(Number(inputs.level) >= KEEP_RULE.level)) open.push(`${w.label}: the paired intervals are under ${KEEP_RULE.level}`);
    // (b) on the resampled paths, conditional on the window's days: wholly below 0 is the challenger blowing more.
    if (rs.blowRate.hi < 0) rejected.push(`(b) ${w.label}: blow rate significantly worse on the resampled paths (conditional on these days; champion minus challenger ${span(rs.blowRate)})`);
    // (c) ii on the real attempts; a window under two blocks of S start days shows nothing.
    const S = Number(inputs.sessions);
    sessions.add(S);
    if (!(S >= 1 && informative(real.passRate) && informative(real.blowRate) && w.mc.starts.length >= KEEP_RULE.minBlocks * S)) {
      open.push(`${w.label}: ${w.mc.starts.length} real attempt(s) over ${inputs.days} day(s), under ${KEEP_RULE.minBlocks} independent blocks of ${S} start days (about ${(KEEP_RULE.minBlocks + 1) * S} days): it shows nothing`);
    } else {
      const days = real.medianDaysToPass || {};
      if (real.passRate.lo > 0) rejected.push(`(c) ${w.label}: pass rate significantly worse on the real attempts (champion minus challenger ${span(real.passRate)})`);
      if (real.blowRate.hi < 0) rejected.push(`(c) ${w.label}: blow rate significantly worse on the real attempts (champion minus challenger ${span(real.blowRate)})`);
      if (days.hi !== null && days.hi !== undefined && days.hi < 0) rejected.push(`(c) ${w.label}: median days to pass significantly more on the real attempts (champion minus challenger ${span(days)})`);
    }
    // (d) the decision measures, not significantly worse, on enough paired decisions.
    decisionChecks(w.label, 'process adherence', w.adherence, null, rule, rejected, open);
    decisionChecks(w.label, 'correct-read rate', w.reads, w.readsWhy, rule, rejected, open);
  }
  if (rejected.length) return { verdict: 'rejected', reasons: rejected, diagnostic, pooled: null };
  if (heldOut && diagnostic) open.push('a diagnostic score (setup-focused) never judges held-out months and never promotes: only full-day runs');
  if (sessions.size > 1) open.push('the windows were scored with different sessions: no pooled interval');
  if (open.length) return { verdict: 'inconclusive', reasons: open, diagnostic, pooled: null };
  // (c) i: one pooled interval on the primary measure over every window's real start days, stacked window by window.
  const first = windows[0].mc.inputs;
  const pooled = pooledInterval(windows.map(w => w.mc.starts.map(x => passed(x.a) - passed(x.b))), { block: [...sessions][0], reps: Number(first.reps) || 2000, level: KEEP_RULE.level, rand: stats.streamFor(first.seed, 'keep-rule:pooled:passRate') });
  const table = windows.map(w => `${w.label}: pass rate ${span(w.mc.diff.real.passRate)}, median days ${span(w.mc.diff.real.medianDaysToPass)}`).join('; ');
  if (!(pooled.hi < 0)) return { verdict: 'rejected', reasons: [`(c) no significant gain: the pooled pass rate on ${pooled.n} real attempts, champion minus challenger ${span(pooled)}, is not wholly below 0 (${table}): nothing shows the challenger better`], diagnostic, pooled };
  return { verdict: 'kept', reasons: [`zero challenger blows; the pooled pass rate on ${pooled.n} real attempts better for the challenger (champion minus challenger ${span(pooled)}); no window significantly worse (${table}); adherence and reads not worse${diagnostic ? '; a diagnostic score: never a promotion' : ''}`], diagnostic, pooled };
}

/** The run's decisions' reads by key (root|bar), as the A/B comparison keys them (ab-compare.js decisionsByKey). */
function readsByKey(runDir, { root }) {
  const { decisions } = require('../learning/run-experience').runDecisions(runDir, { root });
  return new Map([...decisionsByKey(decisions)].filter(([, x]) => x.reads).map(([k, x]) => [k, x.reads]));
}

/**
 * The guard's findings without its exit-change ones (the exit is judged here, not refused). Matches the guard's own
 * message, `<file>: policies.<name>.exit: changed (`, at its start, so a free-text value that merely contains
 * ".exit: changed" is never dropped.
 */
const withoutExitChanges = errors => errors.filter(e => !/^[^ ]+: policies\.[a-z0-9_-]+\.exit: changed \(/.test(e));

/**
 * Each side's account and policy. The account's firm rules (its ACCOUNT.md: sessions, target, max loss, daily limit,
 * contracts, fees) must be the same on both trees, and so must the policy's contracts (a difference is blocked, not
 * scored: no guard covers it); the rulebook's numbers (the soft stop, the loss streak stop, the
 * policy's sizing, exit and multipliers) may differ, and a rulebook that loosens a limit
 * is refused by the rulebook guard (train/rulebook-guard.js; its exit check aside: the exit is judged here).
 */
function defaultSides({ cfg, root, candidateRoot, env }) {
  const fs = require('fs');
  const { accountNamed } = require('../trading/accounts');
  const { loadStrategies } = require('../trading/strategies');
  const { policyFor } = require('../prop/model-score');
  const rb = require('../trading/rulebook');
  const of = tree => {
    const account = accountNamed(tree, cfg.account, env);
    const policy = policyFor(loadStrategies(tree, env).strategies, account.name);
    const { file: _f, body: _b, description: _d, valid: _v, errors: _e, daily_loss_soft: soft, loss_streak_stop: streak, ...firm } = account;
    const bookFile = path.join(path.dirname(account.file), rb.FILE);
    return {
      account, policy, firm: JSON.stringify(firm), bookText: fs.existsSync(bookFile) ? fs.readFileSync(bookFile, 'utf8') : '',
      book: JSON.stringify([soft, streak, policy ? [policy.name, policy.sizing || null, policy.multipliers || null] : null]),
      contracts: JSON.stringify(policy ? policy.contracts || null : null),
      exit: JSON.stringify(policy ? policy.exit || null : null),
    };
  };
  const a = of(root);
  const b = candidateRoot ? of(candidateRoot) : a;
  const where = `accounts/${a.account.name}/${rb.FILE}`;
  const loosenings = a.bookText !== b.bookText ? withoutExitChanges(require('./rulebook-guard').rulebookErrors(where, a.bookText, b.bookText)) : [];
  const exitDiffers = a.exit !== b.exit;
  const candidateB = a.book !== b.book || exitDiffers;
  return {
    account: a.account, policy: a.policy, accountB: b.account, policyB: b.policy, firmDiffers: a.firm !== b.firm, policyMissing: Boolean(a.policy) !== Boolean(b.policy),
    candidateB, exitDiffers, contractsDiffers: a.contracts !== b.contracts, loosenings,
    pairing: exitDiffers ? 'different trade streams under different sizing/exit' : candidateB ? 'different sizing (the same exit)' : 'one rulebook',
  };
}

const defaultDeps = {
  sides: defaultSides,
  pair: (dirA, dirB, opts) => require('../prop/model-score').pairRuns(dirA, dirB, opts),
  reads: readsByKey,
  scoreOne: (dir, opts) => require('../prop/model-score').scoreRun(dir, { ...opts, riskActions: false, attribution: false }),
};

const ivOf = i => (i ? { diff: i.diff, lo: i.lo, hi: i.hi, ...(i.degenerate ? { degenerate: true } : {}) } : null);
const RESAMPLED = 'conditional on this window\'s days (Monte Carlo precision, not evidence): read by (a) and (b) only';

/** A window's figures for the archive and the PR body: the real attempts' evidence; the resampled paths labelled conditional. */
function windowOut(w) {
  const m = w.mc;
  const real = m.diff.real || {};
  const rs = m.diff.resampled || {};
  return {
    label: w.label, blows: m.blows, attempts: Array.isArray(m.starts) ? m.starts.length : 0, days: m.inputs ? m.inputs.days : null,
    diff: { passRate: ivOf(real.passRate), blowRate: ivOf(real.blowRate), medianDaysToPass: ivOf(real.medianDaysToPass) },
    resampled: { conditional: RESAMPLED, passRate: ivOf(rs.passRate), blowRate: ivOf(rs.blowRate), medianDaysToPass: ivOf(rs.medianDaysToPass) },
    champion: m.a && m.a.real, challenger: m.b && m.b.real, score: m.b && m.b.score, adherence: w.adherence, reads: w.reads, readsWhy: w.readsWhy,
    sizedAs: m.sizedAs || 'ceiling',
    // Beside the judged result: every entry at the code's ceiling under the policy exit, labelled, never judged.
    ...(m.ceiling ? { ceiling: { label: m.ceiling.label, blows: m.ceiling.blows, verdict: m.ceiling.verdict, passRate: ivOf(m.ceiling.diff.real.passRate), blowRate: ivOf(m.ceiling.diff.real.blowRate) } } : {}),
  };
}

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
    if (sides.firmDiffers) return { available: true, verdict: 'blocked', reasons: ['the challenger changes the account\'s firm rules (its ACCOUNT.md): both sides attempt one account, so this change can\'t be judged here'], windows: [] };
    if (sides.policyMissing) return { available: true, verdict: 'blocked', reasons: ['the challenger adds or removes the policy that trades the account: the two sides\' sizing can\'t be paired'], windows: [] };
    if (sides.contractsDiffers) return { available: true, verdict: 'blocked', reasons: ['the challenger changes the policy\'s contracts: no guard covers it and the two sides\' sizing would differ in kind, so this change can\'t be judged here'], windows: [] };
    if ((sides.loosenings || []).length) return { available: true, verdict: 'rejected', reasons: sides.loosenings.map(e => `the rulebook guard: ${e}`), windows: [] };
    const opts = { root, env, account: sides.account, policy: sides.policy, seed, paths: cfg.paths, reps: cfg.reps, faults: cfg.faults };
    const two = { accountB: sides.accountB || sides.account, policyB: sides.policyB === undefined ? sides.policy : sides.policyB, candidateB: sides.candidateB === true };
    const windows = pairs.map(p => {
      const mc = d.pair(p.champion.runDir, p.candidate.runDir, { ...opts, ...two, rootB: candidateRoot || root });
      let r = null;
      let readsWhy = null;
      try { r = reads(d.reads(p.champion.runDir, { root, env }), d.reads(p.candidate.runDir, { root: candidateRoot || root, env })); } catch (err) { readsWhy = err.message; }
      return { label: p.label, mc, adherence: adherence(p.champion.decisions, p.candidate.decisions), reads: r, readsWhy };
    });
    const v = decide(windows, { rule, heldOut });
    const out = { available: true, ...v, pairing: sides.pairing || 'one rulebook', windows: windows.map(w => (w.mc && w.mc.diff ? windowOut(w) : { label: w.label })) };
    if (heldOut) {
      // The final gate, frozen (prop/promotion.js through scoreStream): reported, never replaced; a kept change is not a promotion.
      out.promotion = pairs.map(p => {
        if (two.candidateB) return { label: p.label, passes: false, failures: ['a candidate rulebook: the promotion gate judges the account\'s adopted rulebook, never a candidate'] };
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
  if (out.length) return { verdict: 'rejected', reasons: [...out, ...(model.verdict === 'rejected' ? model.reasons : [])] };
  return { verdict: model.verdict, reasons: model.reasons };
}

module.exports = { KEEP_RULE, HELD_BACK, resolveModelScore, windowErrors, lookErrors, candidateErrors, adherence, reads, pooledInterval, decide, verify, combine, withoutExitChanges };
