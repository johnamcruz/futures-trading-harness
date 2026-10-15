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
 *             A fix counts only when the decision's scorecard pair got no worse (right before, not right after)
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
 *   sideOf({ decisions, scorecard, usage, points })   a side reduced: { decisions: [{ key, day, R, reads, relevant }],
 *                                                      exitPlans, scorecard: [{ key, at, day, category, blow }], usage }
 *                                                      (measure refuses two sides whose exit plans differ)
 *   halfOf(day, seed)                            'probe' or 'confirm': a session date's half, by a seeded hash
 *   half(side, which, seed)                      the side's decisions and scorecard of one half (usage as given)
 *   measure(champion, probe, { skill, kind })    { reads, process, r, target, skill, blows }
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
 * minEffect 0.15: a gain must fix, net, at least about one in seven of the target's paired decisions. McNemar alone
 * passes 3 fixed / 0 broken (p 0.125) whatever the pairs; on 30 pairs that is 0.1 of them, an effect the keep rule's
 * pooled full-day windows (where the target skill is one read among many) cannot tell from noise, so probing it
 * further only spends model time. 3 of up to 20 pairs, or 5 of 30, still passes.
 */
const SCREEN = Object.freeze({ gainAlpha: 0.2, harmAlpha: 0.2, minDiscordant: 3, minPairs: 10, minEffect: 0.15 });
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
  const out = [];
  for (const x of decisionsByKey(decisions).values()) {
    if (!x.composed) continue;
    const [root, bar] = [x.key.slice(0, x.key.indexOf('|')), x.key.slice(x.key.indexOf('|') + 1)];
    const key = momentKey(root, bar);
    if (!key) continue;
    out.push({
      key, day: dayOf(key), R: isR(x.R) ? x.R : null, relevant: [...(relevant.get(key) || [])].sort(),
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

function measure(champion, probe, { skill = null, kind = null } = {}) {
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
    target: targetTest(champion, probe, { skill, kind }),
    skill: skill ? { skill, champion: use(champion), probe: use(probe) } : null,
    blows: probe.scorecard.filter(d => d.blow).length,
  };
}

const harmful = t => t && t.n >= SCREEN.minDiscordant && t.c > t.b && t.pWorse <= SCREEN.harmAlpha;
const gained = t => t && t.n >= SCREEN.minDiscordant && t.b > t.c && t.pBetter <= SCREEN.gainAlpha && t.pairs > 0 && (t.b - t.c) / t.pairs >= SCREEN.minEffect;

function harmsOf(m) {
  const out = [];
  if (m.blows > 0) out.push(`${m.blows} blow(s) on the probe's side`);
  for (const k of ['reads', 'process', 'target']) if (harmful(m[k])) out.push(`${k}: worse (broken ${m[k].c}, fixed ${m[k].b}, p ${m[k].pWorse})`);
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
function composedScreen(champion, probe, parts) {
  const ms = parts.map(p => ({ id: p.id, m: measure(champion, probe, { skill: p.tag.skill, kind: p.finding.kind }) }));
  const harms = ms.length ? harmsOf(ms[0].m) : [];
  for (const x of ms) if (harmful(x.m.target)) harms.push(`${x.id}'s target: worse (broken ${x.m.target.c}, fixed ${x.m.target.b})`);
  const lost = ms.filter(x => !gained(x.m.target)).map(x => x.id);
  const verdict = harms.length ? 'hurt' : lost.length ? 'no effect' : 'helped';
  return { verdict, pass: verdict === 'helped', harms, cancelled: lost, targets: ms.map(x => ({ id: x.id, target: x.m.target })), measures: ms.length ? ms[0].m : null };
}

module.exports = { SCREEN, VERDICTS, HALVES, sideOf, halfOf, half, momentKey, measure, screen, composedScreen, skillState };
