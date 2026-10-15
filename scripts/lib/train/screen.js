'use strict';

/**
 * The probe screen (Propose-Probe-Compose, docs/TRAINING.md): a cheap, permissive filter of one skill edit, by code.
 * The champion and the edit's tree replay the same curated practice-train moments with the same seed (stage 1); each
 * side's run is reduced here (sideOf) and the two are paired decision by decision (root and bar):
 *
 *   reads     the correct-read rate per decision: every read verified true, or not (exact one-sided McNemar)
 *   process   process adherence: the scorecard's category right, or not (McNemar; the champion's unchecked left out)
 *   r         R per decision (an entry's R, a pass 0): the paired bootstrap interval of probe minus champion
 *   target    the finding the edit addresses (McNemar): for a misread or a miss, the decisions where either side claimed
 *             the skill: right (its reads all verified), missed (no read of it claimed) or misread; for a wrong-reason
 *             refusal, a decision the champion refused for a false reason now right, against one it got right now not
 *   skill     the target skill's used, correct and missed counts on each side (the skill-usage report): descriptive
 *   blows     decisions the probe's scorecard records at or past the account's floor
 *
 * SCREEN holds every threshold, in one place. The screen only filters noise: it is looser than the keep rule
 * (train/paired.js DECISION_RULE, train/model-verifier.js KEEP_RULE) on a gain, and at least as quick to call a harm. A
 * passing edit is never kept on the screen: it is composed and goes through the full keep rule. Nothing here calls a
 * model.
 *
 *   helped     a significant gain on the target and no significant harm on any measure (it passes)
 *   hurt       a significant harm on any measure (the target included), or a blow
 *   no effect  neither
 *
 *   SCREEN, VERDICTS
 *   sideOf({ decisions, scorecard, usage })      a side reduced: { decisions: [{ key, R, reads: [{ skill, check, ok }] }], scorecard, usage }
 *   measure(champion, probe, { skill, kind })    { reads, process, r, target, skill, blows }
 *   screen(m)                                    { verdict, pass, harms, gain }
 *   composedScreen(champion, probe, parts)       the combined change against every part's target: { verdict, pass, harms, targets }
 */

const { tally, pairUp, mcnemar } = require('./paired');
const { decisionsByKey, pairedInterval } = require('./ab-compare');
const { skillOfRead } = require('../learning/curated-moments');

const SCREEN = Object.freeze({ gainAlpha: 0.2, harmAlpha: 0.2, minDiscordant: 3, minPairs: 10 });
const VERDICTS = Object.freeze(['helped', 'no effect', 'hurt']);

const isR = x => typeof x === 'number' && Number.isFinite(x);
const round4 = x => (x === null || x === undefined ? null : Math.round(x * 10000) / 10000);

/** A run's decisions, scorecard and skill usage as the screen reads them (small enough to keep in a phase file). */
function sideOf({ decisions = [], scorecard = [], usage = [] } = {}) {
  const by = decisionsByKey(decisions);
  return {
    decisions: [...by.values()].filter(x => x.composed).map(x => ({
      key: x.key, R: isR(x.R) ? x.R : null,
      reads: (x.reads || []).map(r => ({ skill: skillOfRead(r.step, r.read) || r.skill || null, check: r.check === true || r.check === 'true', ok: (r.check === true || r.check === 'true') && r.agrees !== false })),
    })),
    scorecard: (scorecard || []).filter(d => d && d.key && d.category).map(d => ({ key: d.key, category: d.category, blow: d.blow === true })),
    usage: (usage || []).map(s => ({ skill: s.skill, used: s.used, available: s.available, reads: s.reads, correct: s.correct, missed: s.missed, relevant: s.relevant })),
  };
}

const right = c => ({ category: c });
const counts = t => ({ b: t.b, c: t.c, n: t.n, pBetter: t.pBetter, pWorse: t.pWorse });

/** The skill's state at a decision: right (all its reads verified), misread, or missed (none claimed). */
function skillState(d, skill) {
  const mine = (d.reads || []).filter(r => r.skill === skill);
  if (!mine.length) return 'missed';
  return mine.every(r => r.ok) ? 'right' : 'misread';
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
  const pairs = [];
  for (const d of probe.decisions) {
    const base = a.get(d.key);
    if (!base) continue;
    const s = [skillState(base, skill), skillState(d, skill)];
    if (s[0] === 'missed' && s[1] === 'missed') continue;
    pairs.push({ base: right(s[0]), cand: right(s[1]) });
  }
  return { measure: `${skill}: reads right per decision`, pairs: pairs.length, ...counts(tally(pairs, r => r.category !== 'right')) };
}

function measure(champion, probe, { skill = null, kind = null } = {}) {
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
const gained = t => t && t.n >= SCREEN.minDiscordant && t.b > t.c && t.pBetter <= SCREEN.gainAlpha;

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

module.exports = { SCREEN, VERDICTS, sideOf, measure, screen, composedScreen, skillState };
