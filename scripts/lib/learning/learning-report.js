'use strict';

/**
 * The learning measures of a run (the composed-entry design, section 4.8), for the replay report: whether the model
 * composes from its skills, keeps its reads true, spreads over combinations instead of collapsing onto one, passes
 * well, uses its record, and follows it; and how each of those moves day by day over practice.
 *
 * Read from the run home: the experience log (experience-log.js), every trade_lifecycle record the run wrote,
 * verified or not (lifecycle-record.js), the experience_lookup calls the cycle logs kept (`experienceLookups`), and
 * the run's pinned index (experience-index.js), the record the model was shown.
 *
 * Measures:
 *   decisions        composed (an ok record: entered, passed, refused) and plain passes (none)
 *   steps            the trader-process steps a composed decision's reads cover: mean, and how many cover all six
 *   skillsPerTrade   distinct skills per entered trade, mean
 *   reads            every read of every record: how many, verified (check true), the rate; records ok of all
 *   diversity        distinct skill signatures of composed decisions, normalized entropy (0 one, 1 even), the top
 *                    one's share; `collapsed` when the top share is at least COLLAPSE_SHARE over at least MIN_COLLAPSE
 *   passes           good passes (the counterfactual lost), missed wins, neutral; good of graded
 *   lookups          calls, composed decisions with a lookup on their bar, the rate
 *   record           each composed decision against its cell in the pinned index (this context, else any context,
 *                    the first with enough samples): followed (entered above zero, passed below), against, neutral
 *                    (the interval spans zero), no evidence; overall and for the decisions that looked it up
 *   curve            per practice day: decisions, taken, their mean R and win rate, the same over the last
 *                    ROLLING_DAYS days, pass quality (good of graded passes), lookups, followed and against
 *
 *   learningMeasures({ decisions, records, lookups, index })   the measures
 *   readLearning(home)                { decisions, records, lookups, index } from a run home (null without a log)
 *   learningMarkdown(m), learningText(m)
 */

const fs = require('fs');
const path = require('path');
const { readDecisions, logFile } = require('./experience-log');
const { readRecords, STEPS } = require('./lifecycle-record');
const { loadPinned, cellKey, contextKey } = require('./experience-index');

const ROLLING_DAYS = 5;
const COLLAPSE_SHARE = 0.8;
const MIN_COLLAPSE = 10;

const r4 = x => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (k, n) => (n ? r4(k / n) : null);
const hasR = d => d.outcome && Number.isFinite(d.outcome.R);

/** followed | against | neutral | no-evidence for one composed decision against the index. */
function followOf(d, index) {
  if (!index || !d.signatures || !d.signatures.skill) return 'no-evidence';
  const cells = [cellKey('skill', d.signatures.skill, contextKey(d.context)), cellKey('skill', d.signatures.skill)].map(k => index.cells[k]);
  const c = cells.find(x => x && x.enough);
  if (!c) return 'no-evidence';
  const took = d.decision === 'entered';
  if (c.meanR.lo > 0) return took ? 'followed' : 'against';
  if (c.meanR.hi < 0) return took ? 'against' : 'followed';
  return 'neutral';
}

function follows(list, index) {
  const out = { followed: 0, against: 0, neutral: 0, 'no-evidence': 0 };
  for (const d of list) out[followOf(d, index)] += 1;
  return out;
}

function learningMeasures({ decisions = [], records = [], lookups = [], index = null } = {}) {
  const composed = decisions.filter(d => d.decision !== 'none');
  const entered = composed.filter(d => d.decision === 'entered');
  const stepsOf = d => new Set((d.reads || []).map(r => r.step).filter(s => STEPS.includes(s))).size;
  const reads = records.flatMap(r => r.reads || []);
  const sigs = new Map();
  for (const d of composed) sigs.set(d.signatures.skill, (sigs.get(d.signatures.skill) || 0) + 1);
  const top = [...sigs].sort((a, b) => b[1] - a[1])[0] || null;
  const entropy = sigs.size > 1 ? -[...sigs.values()].reduce((a, k) => a + (k / composed.length) * Math.log(k / composed.length), 0) / Math.log(sigs.size) : sigs.size ? 0 : null;
  const graded = composed.filter(d => d.decision !== 'entered' && hasR(d));
  const good = graded.filter(d => d.grade === 'good-pass').length;
  const missed = graded.filter(d => d.grade === 'missed-win').length;
  const looked = new Set(lookups.map(l => `${l.root}|${l.bar}`));
  const withLookup = composed.filter(d => looked.has(`${d.root}|${d.bar}`));
  const topShare = top ? rate(top[1], composed.length) : null;
  return {
    decisions: { total: decisions.length, composed: composed.length, entered: entered.length, passed: composed.filter(d => d.decision === 'passed').length, refused: composed.filter(d => d.decision === 'refused').length, none: decisions.length - composed.length },
    steps: { mean: r4(mean(composed.map(stepsOf))), allSix: composed.filter(d => stepsOf(d) === STEPS.length).length },
    skillsPerTrade: r4(mean(entered.map(d => new Set((d.reads || []).map(r => r.skill)).size))),
    reads: { reads: reads.length, verified: reads.filter(r => r.check === 'true').length, rate: rate(reads.filter(r => r.check === 'true').length, reads.length), records: records.length, recordsOk: records.filter(r => r.ok).length },
    diversity: { signatures: sigs.size, entropy: r4(entropy), top: top ? top[0] : null, topShare, collapsed: composed.length >= MIN_COLLAPSE && topShare >= COLLAPSE_SHARE },
    passes: { good, missed, neutral: composed.filter(d => d.grade === 'neutral-pass').length, goodRate: rate(good, good + missed) },
    lookups: { calls: lookups.length, decisions: withLookup.length, rate: rate(withLookup.length, composed.length) },
    record: { index: index ? index.hash.slice(0, 16) : null, all: follows(composed, index), withLookup: follows(withLookup, index) },
    curve: curve(decisions, lookups, index),
  };
}

function curve(decisions, lookups, index) {
  const days = [...new Set(decisions.map(d => d.day))].sort();
  const takenOn = day => decisions.filter(d => d.day === day && d.decision === 'entered' && hasR(d));
  return days.map((day, i) => {
    const today = decisions.filter(d => d.day === day);
    const taken = takenOn(day);
    const window = days.slice(Math.max(0, i - ROLLING_DAYS + 1), i + 1).flatMap(takenOn);
    const passes = today.filter(d => d.decision !== 'entered' && d.decision !== 'none' && hasR(d));
    const f = follows(today.filter(d => d.decision !== 'none'), index);
    return {
      day, role: today[0].role || null, decisions: today.length, taken: taken.length,
      meanR: r4(mean(taken.map(d => d.outcome.R))), winRate: rate(taken.filter(d => d.outcome.R > 0).length, taken.length),
      rollingMeanR: r4(mean(window.map(d => d.outcome.R))), rollingWinRate: rate(window.filter(d => d.outcome.R > 0).length, window.length),
      passQuality: rate(passes.filter(d => d.grade === 'good-pass').length, passes.length),
      lookups: lookups.filter(l => today.some(d => d.root === l.root && d.bar === l.bar)).length, followed: f.followed, against: f.against,
    };
  });
}

/** The experience_lookup calls the run's cycle logs kept (cycles-<day>.jsonl, `experienceLookups`). */
function cycleLookups(home) {
  const dir = path.join(home, 'logs');
  let names;
  try { names = fs.readdirSync(dir).filter(n => /^cycles-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch (_err) { return []; }
  const out = [];
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      try {
        const c = JSON.parse(line);
        if (c && Array.isArray(c.experienceLookups)) out.push(...c.experienceLookups);
      } catch (_err) { /* not a line */ }
    }
  }
  return out;
}

/** What the measures read from a run home; null when the run has no experience log. */
function readLearning(home) {
  const file = logFile(home);
  if (!fs.existsSync(file)) return null;
  let index = null;
  let indexError = null;
  try { index = loadPinned(home); } catch (err) { indexError = err.message; }
  return { decisions: readDecisions(file), records: readRecords(home), lookups: cycleLookups(home), index, indexError };
}

const f2 = x => (x === null || x === undefined ? '-' : Number(x).toFixed(2));

function learningText(m) {
  const d = m.decisions;
  return `learning: ${d.composed} composed (${d.entered} entered, ${d.passed} passed, ${d.refused} refused), ${d.none} plain passes; steps ${f2(m.steps.mean)} (${m.steps.allSix} all six); `
    + `reads verified ${f2(m.reads.rate)} of ${m.reads.reads}; ${m.diversity.signatures} combinations, entropy ${f2(m.diversity.entropy)}, top share ${f2(m.diversity.topShare)}${m.diversity.collapsed ? ' (collapsed)' : ''}; `
    + `good passes ${m.passes.good} of ${m.passes.good + m.passes.missed}; lookups ${m.lookups.calls} (${f2(m.lookups.rate)} of composed); record followed ${m.record.all.followed}, against ${m.record.all.against}\n`;
}

function learningMarkdown(m) {
  const d = m.decisions;
  const rows = m.curve.map(c => `| ${c.day} | ${c.role || '-'} | ${c.decisions} | ${c.taken} | ${f2(c.meanR)} | ${f2(c.winRate)} | ${f2(c.rollingMeanR)} | ${f2(c.rollingWinRate)} | ${f2(c.passQuality)} | ${c.lookups} | ${c.followed} / ${c.against} |`);
  return [
    '## Learning', '',
    `- Decisions: ${d.total} (${d.composed} composed: ${d.entered} entered, ${d.passed} passed, ${d.refused} refused; ${d.none} plain passes)`,
    `- Steps covered per composed decision: ${f2(m.steps.mean)} (${m.steps.allSix} cover all six); distinct skills per trade: ${f2(m.skillsPerTrade)}`,
    `- Reads verified: ${m.reads.verified} of ${m.reads.reads} (${f2(m.reads.rate)}); records ok: ${m.reads.recordsOk} of ${m.reads.records}`,
    `- Combinations: ${m.diversity.signatures}, entropy ${f2(m.diversity.entropy)}, top share ${f2(m.diversity.topShare)}${m.diversity.collapsed ? ' (collapsed onto one)' : ''}`,
    `- Passes: ${m.passes.good} good, ${m.passes.missed} missed wins, ${m.passes.neutral} neutral (good rate ${f2(m.passes.goodRate)})`,
    `- experience_lookup: ${m.lookups.calls} calls, ${m.lookups.decisions} composed decisions looked up (${f2(m.lookups.rate)})`,
    `- Against the record (index ${m.record.index || 'none pinned'}): followed ${m.record.all.followed}, against ${m.record.all.against}, neutral ${m.record.all.neutral}, no evidence ${m.record.all['no-evidence']}; after a lookup: followed ${m.record.withLookup.followed}, against ${m.record.withLookup.against}`,
    '', `Per day (rolling over ${ROLLING_DAYS} days):`, '',
    '| Day | Role | Decisions | Taken | Mean R | Win rate | Rolling mean R | Rolling win rate | Pass quality | Lookups | Followed / against |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows, '',
  ].join('\n');
}

module.exports = { ROLLING_DAYS, COLLAPSE_SHARE, MIN_COLLAPSE, learningMeasures, followOf, readLearning, cycleLookups, learningMarkdown, learningText };
