'use strict';

/**
 * The probe screen (Propose-Probe-Compose, docs/TRAINING.md): a cheap, permissive filter of one skill edit, by code.
 * The champion and the edit's tree replay the same curated practice-train moments with the same seed (stage 1); each
 * side's run is reduced here (sideOf) and the two are paired decision by decision (root and bar):
 *
 *   reads     the correct-read rate per decision: every read verified true, or not (exact one-sided McNemar)
 *   process   process adherence: the scorecard's category right, or not (McNemar; the champion's unchecked left out)
 *   r         R per decision (an entry's R, a pass 0): the paired bootstrap interval of probe minus champion
 *   target    the finding the edit addresses (McNemar), reading better, never claiming more:
 *             - a misread: only the decisions where the champion claimed the skill: its reads all verified (right),
 *               or not (a read refused, or none claimed: dropping the skill is never a fix);
 *             - a miss: only the decisions where the skill was relevant at the bar on the champion's side (a TRUE read
 *               of it pointed the side's way: the skill-usage report's per-point relevance, learning/skill-usage.js),
 *               right when its reads were claimed and all verified. A read cited where it was not relevant fixes
 *               nothing;
 *             - a wrong-reason refusal: a decision the champion refused for a false reason now right, against one it
 *               got right now not.
 *             A fix counts only when the decision's scorecard pair got no worse (right before, not right after);
 *             - an exit decision (exit-findings.js: the open trade's read, its management, its profit-taking): the trades
 *               both sides opened (exitTargetTest), the R banked better or worse by at least exitScreen.epsR, too few
 *               pairs (under minPairs) never a gain; a cut on more of the champion's runners (MFE at least
 *               exitScreen.runnerMfeR) than it un-cut is a harm whatever the mean
 *   skill     the target skill's used, correct and missed counts on each side (the skill-usage report): descriptive
 *   blows     decisions the probe's scorecard records at or past the account's floor
 *
 * SCREEN holds every threshold, in one place. The screen only filters noise: it is looser than the keep rule
 * (train/paired.js DECISION_RULE, train/model-verifier.js KEEP_RULE) on a gain, and at least as quick to call a harm. A
 * gain also needs a minimum effect: fixed minus broken at least minEffect of the target's paired decisions. A passing
 * edit is never kept on the screen: it is composed and goes through the full keep rule. Nothing here calls a model.
 *
 * The overfit guard: the curated moments split by session date, by a seeded hash (halfOf), into a probe half and a
 * confirm half, both inside the probe windows (practice-train). Each edit is screened on the probe half only; the
 * combined change on the confirm half only, which no edit was chosen on.
 *
 *   helped     a significant gain on the target and no significant harm on any measure (it passes)
 *   hurt       a significant harm on any measure (the target included), or a blow
 *   no effect  neither
 *
 *   SCREEN, VERDICTS, HALVES
 *   sideOf({ decisions, scorecard, usage, points })   a side reduced: { decisions: [{ key, day, R, entered, side?, reads, relevant }],
 *                                                      exitPlans, scorecard: [{ key, at, day, category, blow }], usage }
 *                                                      (measure refuses two sides whose exit plans differ)
 *   halfOf(day, seed)                            'probe' or 'confirm': a session date's half, by a seeded hash
 *   half(side, which, seed)                      the side's decisions and scorecard of one half (usage as given)
 *   measure(champion, probe, { skill, kind, exits })   { reads, process, r, target, skill, blows } (exits: the trend
 *                                                set's scored exits, { champion, probe, stepMs }, for an exit finding)
 *   exitTargetTest(champion, probe, exits)       { measure, pairs, b, c, n, pBetter, pWorse, meanDiff, enough, unmatched,
 *                                                classes, runners }: the trades both sides opened, paired
 *   screen(m)                                    { verdict, pass, harms, gain }
 *   composedScreen(champion, probe, parts)       the combined change against every part's target: { verdict, pass, harms, targets }
 */

const crypto = require('crypto');
const { tally, pairUp, mcnemar } = require('./paired');
const { decisionsByKey, pairedInterval } = require('./ab-compare');
const { skillOfRead } = require('../learning/curated-moments');
const { familyRoot } = require('../trading/contracts');
const { tradingDayKey } = require('../trading/clock');

/**
 * A gain needs both a practical size and significance. minEffect 0.10: net, at least a tenth of the target's paired
 * decisions fixed (8 fixed / 0 broken on 80 pairs is real, p about 0.004). gainAlpha 0.10 and minDiscordant 4: a
 * one-sided McNemar test on at least 4 changed decisions (4/0 on 30 passes, p 0.0625; 3/0 never does), so noise at
 * small n is the test's to catch, not the effect size's. 5 fixed / 1 broken on 40 has the size (0.10) but not the
 * significance (p about 0.22). The screen only filters; the keep rule is the real gate.
 */
const SCREEN = require('../tunables').training().screen; // config/training.json screen (tighten-only)
const EXIT = require('../tunables').training().exitScreen; // config/training.json exitScreen: epsR, runnerMfeR
const MATCH_BARS = require('../tunables').replay().exitScore.matchBars; // config/replay.json: an exit's bar tolerance
const EXIT_KIND = require('./exit-findings').KIND;
const VERDICTS = Object.freeze(['helped', 'no effect', 'hurt']);
const HALVES = Object.freeze(['probe', 'confirm']);

const isR = x => typeof x === 'number' && Number.isFinite(x);
const round4 = x => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);
const isTrue = c => c === true || c === 'true';

/** A moment's key: its root's family and its bar (ms), the same from the experience log, the scorecard and the compose records. */
function momentKey(root, bar) {
  const t = Date.parse(bar);
  return Number.isFinite(t) ? `${familyRoot(String(root || ''))}|${t}` : null;
}
const dayOf = key => {
  const t = Number(String(key).split('|')[1]);
  return Number.isFinite(t) ? tradingDayKey(new Date(t)) : null;
};

/** A session date's half: a seeded hash, the same for every side and every run. */
function halfOf(day, seed) {
  const h = crypto.createHash('sha256').update(`probe-split|${seed}|${day}`).digest();
  return HALVES[h[0] & 1];
}

/**
 * A run's decisions, scorecard and skill usage as the screen reads them (small enough to keep in a phase file).
 * points: the skill-usage report's per-point relevance ({ root, bar, relevant: [skill] }), joined to each decision.
 */
function sideOf({ decisions = [], scorecard = [], usage = [], points = [] } = {}) {
  const relevant = new Map();
  for (const p of points || []) {
    const k = p && momentKey(p.root, p.bar);
    if (!k) continue;
    const set = relevant.get(k) || new Set();
    for (const sk of p.relevant || []) set.add(sk);
    relevant.set(k, set);
  }
  // An entered moment's side (the exit screen pairs the same side only).
  const sides = new Map((decisions || []).filter(d => d && d.decision === 'entered' && (d.side === 'long' || d.side === 'short')).map(d => [`${d.root}|${d.bar}`, d.side]));
  const out = [];
  for (const x of decisionsByKey(decisions).values()) {
    if (!x.composed) continue;
    const [root, bar] = [x.key.slice(0, x.key.indexOf('|')), x.key.slice(x.key.indexOf('|') + 1)];
    const key = momentKey(root, bar);
    if (!key) continue;
    out.push({
      key, day: dayOf(key), R: isR(x.R) ? x.R : null, entered: x.entered === true, ...(sides.has(x.key) ? { side: sides.get(x.key) } : {}), relevant: [...(relevant.get(key) || [])].sort(),
      reads: (x.reads || []).map(r => ({ skill: skillOfRead(r.step, r.read) || r.skill || null, check: isTrue(r.check), ok: isTrue(r.check) && r.agrees !== false })),
    });
  }
  return {
    decisions: out,
    // The exit plans the run's decisions were scored under (experience-log.js exitPlan, from its manifest at seed time).
    exitPlans: [...new Set((decisions || []).filter(d => d && d.decision && d.decision !== 'none').map(d => d.exitPlan || null))].sort(),
    scorecard: (scorecard || []).filter(d => d && d.key && d.category).map(d => {
      // The scorecard's key is its cycle's time and symbol; `at` is its bar's moment (barT, else the cycle's time).
      const [t, symbol] = String(d.key).split('|');
      const at = momentKey(d.symbol || symbol, d.barT || t);
      return { key: d.key, at, day: at ? dayOf(at) : null, category: d.category, blow: d.blow === true };
    }),
    usage: (usage || []).map(s => ({ skill: s.skill, used: s.used, available: s.available, reads: s.reads, correct: s.correct, missed: s.missed, relevant: s.relevant })),
  };
}

/** One half of a side: its decisions and scorecard on the session dates of that half (a moment with no date: neither). */
function half(side, which, seed) {
  if (!HALVES.includes(which)) throw new Error(`half: one of ${HALVES.join(', ')}`);
  const mine = x => x.day && halfOf(x.day, seed) === which;
  return { ...side, decisions: side.decisions.filter(mine), scorecard: side.scorecard.filter(mine) };
}

const right = c => ({ category: c });
const counts = t => ({ b: t.b, c: t.c, n: t.n, pBetter: t.pBetter, pWorse: t.pWorse });

/** The skill's state at a decision: right (all its reads verified), misread, or missed (none claimed). */
function skillState(d, skill) {
  const mine = (d.reads || []).filter(r => r.skill === skill);
  if (!mine.length) return 'missed';
  return mine.every(r => r.ok) ? 'right' : 'misread';
}

/** The decisions whose scorecard pair got worse: right on the champion's side, not right on the probe's. */
function worseAt(champion, probe) {
  const cat = side => {
    const m = new Map();
    for (const d of side.scorecard) {
      if (!d.at) continue;
      const fails = (m.get(d.at) || false) || d.category !== 'right';
      m.set(d.at, fails);
    }
    return m;
  };
  const a = cat(champion);
  const b = cat(probe);
  return new Set([...a].filter(([k, fails]) => !fails && b.get(k) === true).map(([k]) => k));
}

function targetTest(champion, probe, { skill, kind }) {
  if (kind === 'wrong-reason refusal') {
    const pairs = pairUp(champion.scorecard.map(d => ({ ...d, repeat: 0 })), probe.scorecard.map(d => ({ ...d, repeat: 0 }))).filter(p => !p.base.implicit && p.base.category !== 'unchecked');
    let b = 0;
    let c = 0;
    for (const p of pairs) {
      if (p.base.category === 'wrong stated reason' && p.cand.category === 'right') b += 1;
      else if (p.base.category === 'right' && p.cand.category !== 'right') c += 1;
    }
    return { measure: 'wrong-reason refusals fixed', pairs: pairs.length, b, c, n: b + c, pBetter: round4(mcnemar(b, c)), pWorse: round4(mcnemar(c, b)) };
  }
  const a = new Map(champion.decisions.map(d => [d.key, d]));
  const worse = worseAt(champion, probe);
  // A misread: the decisions where the champion claimed the skill. A miss: where the skill was relevant at the bar.
  const inScope = kind === 'missed' ? base => base.relevant.includes(skill) : base => skillState(base, skill) !== 'missed';
  let b = 0;
  let c = 0;
  let pairs = 0;
  for (const d of probe.decisions) {
    const base = a.get(d.key);
    if (!base || !inScope(base)) continue;
    pairs += 1;
    const [was, now] = [skillState(base, skill) === 'right', skillState(d, skill) === 'right'];
    // A fix counts only when the decision itself got no worse.
    if (!was && now && !worse.has(d.key)) b += 1;
    else if (was && !now) c += 1;
  }
  const label = kind === 'missed' ? 'reads right where relevant' : 'reads right where the champion claimed it';
  return { measure: `${skill}: ${label}`, pairs, b, c, n: b + c, pBetter: round4(mcnemar(b, c)), pWorse: round4(mcnemar(c, b)) };
}

/**
 * An exit edit's target: the trades both sides opened, paired. The curated set: a moment both entered (its key), the same
 * side (when both name one), each with its R. The trend set's scored exits (exit-scorecard.js decisions): the same root
 * and side, the entries at most matchBars bars apart (the nearest first, each trade once). A pair is better or worse when
 * its banked R moved by at least epsR (the probe's minus the champion's); the exact one-sided McNemar test on those, as
 * the read target's. Too few pairs (under minPairs): never a gain. Each trend pair's class change (cut, right, late, as
 * scored), tagged by who exited on the probe's side; runners: the champion's trades with an MFE of at least runnerMfeR,
 * newly cut by the probe or no longer cut. Trades on one side only: counted as unmatched, never paired. exits.done: the
 * units both sides finished (only their trades pair); exits.unknown: a side's scored exits unknown, never a gain.
 */
function exitTargetTest(champion, probe, exits = null, { epsR = EXIT.epsR, runnerMfeR = EXIT.runnerMfeR, minPairs = SCREEN.minPairs } = {}) {
  const diffs = [];
  const unmatched = { champion: 0, probe: 0 };
  // The curated set's moments: entered on both sides, each R known.
  const entered = s => (s && Array.isArray(s.decisions) ? s.decisions : []).filter(d => d.entered === true && isR(d.R));
  const a = new Map(entered(champion).map(d => [d.key, d]));
  const seen = new Set();
  for (const d of entered(probe)) {
    const base = a.get(d.key);
    if (!base || (base.side && d.side && base.side !== d.side)) { unmatched.probe += 1; continue; }
    seen.add(d.key);
    diffs.push(d.R - base.R);
  }
  unmatched.champion += [...a.keys()].filter(k => !seen.has(k)).length;
  // The trend set's trades.
  const classes = {};
  const runners = { pairs: 0, newCuts: 0, fixedCuts: 0 };
  const label = x => (x.late ? 'late' : x.cls);
  // Only the units (stepped windows) both sides finished, when the caller names them (done), as the trend screen pairs.
  const done = exits && Array.isArray(exits.done) ? new Set(exits.done) : null;
  const tradeOf = x => (x && x.root && x.side && Number.isFinite(Date.parse(x.entryAt)) && isR(x.r) ? { ...x, ms: Date.parse(x.entryAt) } : null);
  const unknown = Boolean(exits && exits.unknown);
  // A trade in a unit the other side (or this one) left unfinished: counted apart, never paired.
  const unfinished = { champion: 0, probe: 0 };
  const listOf = who => {
    const all = exits && !unknown && Array.isArray(exits[who]) ? exits[who].map(tradeOf).filter(Boolean) : [];
    const kept = done ? all.filter(x => done.has(x.unit)) : all;
    unfinished[who] = all.length - kept.length;
    return kept;
  };
  const mine = listOf('champion');
  const theirs = listOf('probe');
  const near = MATCH_BARS * (exits && exits.stepMs > 0 ? exits.stepMs : 0);
  const free = new Set(theirs.keys());
  let trendPairs = 0;
  for (const base of mine) {
    const i = [...free].filter(j => theirs[j].root === base.root && theirs[j].side === base.side && Math.abs(theirs[j].ms - base.ms) <= near)
      .sort((x, y) => Math.abs(theirs[x].ms - base.ms) - Math.abs(theirs[y].ms - base.ms))[0];
    if (i === undefined) { unmatched.champion += 1; continue; }
    free.delete(i);
    trendPairs += 1;
    const d = theirs[i];
    diffs.push(d.r - base.r);
    if (label(base) !== label(d)) { const k = `${label(base)}->${label(d)} (${d.exitBy})`; classes[k] = (classes[k] || 0) + 1; }
    // A runner: the champion's trade, its MFE at least runnerMfeR and its exit resolved (cut or right). Only a cut
    // turned right offsets a right turned cut (an unclear or unresolved class offsets nothing).
    if (isR(base.peakR) && base.peakR >= runnerMfeR && (base.cls === 'cut' || base.cls === 'right')) {
      runners.pairs += 1;
      if (base.cls === 'right' && d.cls === 'cut') runners.newCuts += 1;
      if (base.cls === 'cut' && d.cls === 'right') runners.fixedCuts += 1;
    }
  }
  unmatched.probe += free.size;
  // A trend set given but nothing of it to pair: no window both sides finished, or none of the champion's trades
  // matched by the edit's. Never a gain, said why (as unknown exits are).
  const empty = exits && !unknown ? (done && !done.size && (unfinished.champion || unfinished.probe) ? 'no window both sides stepped to its end' : mine.length && !trendPairs ? 'the edit opened none of the champion\'s trend trades' : null) : null;
  const b = diffs.filter(x => x >= epsR).length;
  const c = diffs.filter(x => x <= -epsR).length;
  const meanDiff = diffs.length ? round4(diffs.reduce((s, x) => s + x, 0) / diffs.length) : null;
  return { measure: 'exit: R banked on the trades both sides opened', pairs: diffs.length, b, c, n: b + c, pBetter: round4(mcnemar(b, c)), pWorse: round4(mcnemar(c, b)), meanDiff, enough: !unknown && !empty && diffs.length >= minPairs, ...(unknown ? { why: 'the trend set\'s scored exits are unknown (a capture from before they named their trades)' } : empty ? { why: empty } : {}), unmatched, unfinished, classes, runners };
}

/** The runner guard's harm: an exit edit that cut more of the champion's runners than it stopped cutting. */
const runnerHarm = t => (t && t.runners && t.runners.newCuts > t.runners.fixedCuts ? `cut ${t.runners.newCuts} runner(s) the champion rode (un-cut ${t.runners.fixedCuts}; MFE at least ${EXIT.runnerMfeR}R)` : null);

function measure(champion, probe, { skill = null, kind = null, exits = null } = {}) {
  // R and the counterfactuals pair only under one exit plan: an edit's run managed by another exit is not comparable.
  const plans = x => JSON.stringify(x.exitPlans || []);
  if (plans(champion) !== plans(probe)) throw new Error(`the probe's exit plan (${plans(probe)}) is not the champion's (${plans(champion)}): the two runs don't pair`);
  const a = new Map(champion.decisions.map(d => [d.key, d]));
  const both = probe.decisions.filter(d => a.has(d.key));
  const read = both.filter(d => d.reads.length && a.get(d.key).reads.length);
  const all = d => (d.reads.every(r => r.check) ? 'right' : 'false read');
  const reads = { pairs: read.length, ...counts(tally(read.map(d => ({ base: right(all(a.get(d.key))), cand: right(all(d)) })), r => r.category !== 'right')) };
  const sc = pairUp(champion.scorecard.map(d => ({ ...d, repeat: 0 })), probe.scorecard.map(d => ({ ...d, repeat: 0 }))).filter(p => !p.base.implicit && p.base.category !== 'unchecked');
  const process = { pairs: sc.length, ...counts(tally(sc, r => r.category !== 'right')) };
  const withR = both.filter(d => isR(d.R) && isR(a.get(d.key).R));
  const iv = pairedInterval(withR.map(d => d.R - a.get(d.key).R), 'screen:r');
  const r = { pairs: withR.length, diff: iv.diff, lo: iv.lo, hi: iv.hi };
  const use = side => side.usage.find(s => s.skill === skill) || null;
  return {
    reads, process, r,
    target: kind === EXIT_KIND ? exitTargetTest(champion, probe, exits) : targetTest(champion, probe, { skill, kind }),
    skill: skill ? { skill, champion: use(champion), probe: use(probe) } : null,
    blows: probe.scorecard.filter(d => d.blow).length,
  };
}

const harmful = t => t && t.n >= SCREEN.minDiscordant && t.c > t.b && t.pWorse <= SCREEN.harmAlpha;
const gained = t => t && t.enough !== false && t.n >= SCREEN.minDiscordant && t.b > t.c && t.pBetter <= SCREEN.gainAlpha && t.pairs > 0 && (t.b - t.c) / t.pairs >= SCREEN.minEffect;

function harmsOf(m) {
  const out = [];
  if (m.blows > 0) out.push(`${m.blows} blow(s) on the probe's side`);
  for (const k of ['reads', 'process', 'target']) if (harmful(m[k])) out.push(`${k}: worse (broken ${m[k].c}, fixed ${m[k].b}, p ${m[k].pWorse})`);
  if (runnerHarm(m.target)) out.push(`target: ${runnerHarm(m.target)}`);
  if (m.r.pairs >= SCREEN.minPairs && m.r.hi !== null && m.r.hi < 0) out.push(`R per decision: worse (${m.r.diff} [${m.r.lo}, ${m.r.hi}])`);
  return out;
}

function screen(m) {
  const harms = harmsOf(m);
  const gain = gained(m.target);
  const verdict = harms.length ? 'hurt' : gain ? 'helped' : 'no effect';
  return { verdict, pass: verdict === 'helped', harms, gain };
}

/** The combined change: no harm on any measure, and every part's target still a gain (its parts don't cancel). */
function composedScreen(champion, probe, parts, { exits = null } = {}) {
  const ms = parts.map(p => ({ id: p.id, m: measure(champion, probe, { skill: p.tag.skill, kind: p.finding.kind, exits }) }));
  const harms = ms.length ? harmsOf(ms[0].m) : [];
  for (const x of ms) if (harmful(x.m.target)) harms.push(`${x.id}'s target: worse (broken ${x.m.target.c}, fixed ${x.m.target.b})`);
  for (const x of ms.slice(1)) if (runnerHarm(x.m.target)) harms.push(`${x.id}'s target: ${runnerHarm(x.m.target)}`);
  const lost = ms.filter(x => !gained(x.m.target)).map(x => x.id);
  const verdict = harms.length ? 'hurt' : lost.length ? 'no effect' : 'helped';
  return { verdict, pass: verdict === 'helped', harms, cancelled: lost, targets: ms.map(x => ({ id: x.id, target: x.m.target })), measures: ms.length ? ms[0].m : null };
}

module.exports = { SCREEN, VERDICTS, HALVES, sideOf, halfOf, half, momentKey, measure, exitTargetTest, screen, composedScreen, skillState };
