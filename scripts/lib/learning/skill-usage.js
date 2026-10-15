'use strict';

/**
 * The skill-usage report: whether the model uses each of its skills, and uses it correctly, on its own decisions in
 * a run. An operator report, for the replay report and the CLI (scripts/skill-usage.js): never in a prompt, a tool's
 * reply or anything a cycle reads (no harness tool requires this module).
 *
 * Read from what the run recorded, nothing else: the compose_check records (<run home>/trade-lifecycle, the single
 * file per family or its day shards, readComposeRecords), the cycle log's summary lines (logs/cycles-<day>.jsonl),
 * the run's own bars (its bars files, or the data it replayed, as the experience log reads them), and the experience
 * log (experience/decisions.jsonl) for the outcomes the run itself filled. The briefing at a decision bar is rebuilt
 * from the bars closed by that bar's close (briefing.js buildBriefing, the runner's history window), never a later bar.
 *
 * A decision point is a bar and side the model composed on (a compose_check record for that root, bar and side; the
 * sides it considered). Each read the model stated is the skill's the crosswalk gives its form (available-reads.js
 * READ_SKILL; a form with none, the skill it named), once per point (a read stated again on the bar counts once).
 * Per skill:
 *   used       the points where the model claimed one of its reads, of the points where a read of it was TRUE at
 *              the bar (available: available-reads.js, the checker's own check of every read the briefing can state)
 *   correct    claimed reads the checker verified (TRUE and agreeing with the side)
 *   wrong      claimed reads refused (FALSE, unverifiable, against the side, or refused by the checker's rules), with
 *              the top reasons
 *   missed     the points where a read of it was TRUE and agreed with the side the model traded or considered, and the
 *              model claimed none of its reads, with the reads it missed most
 *   mislabeled claimed reads the model filed under another skill (the checker records the label, never checks it)
 * pullback-vs-reversal (the shape skill) is claimed when the model names it, and available when the true agreeing
 * reads show the shape (available-reads.js shapeOf). The size and management skills have no read (NO_READ_SKILLS):
 * listed, not measured.
 *
 * Outcome (the experience log's composed decisions, the run's own fills and counterfactuals): R and win rate by skill
 * (a decision counts for each skill with a verified read in it) and by skill combination (its skill signature, the
 * experience index's cell), for the trades taken and for every decision (passes at their counterfactual), each with n,
 * its days and the experience index's sample-size label (experience-index.js cellStats: under MIN_N decisions or
 * MIN_DAYS days, `too few samples (n, days)`). A run whose look hides its outcomes (a reasoning-fix look) shows none.
 *
 * The ledger's rules: a run's learning decision (learning-run.json, learning/run-gate.js) is the run's look; a run
 * with records on a held-back day (practice-validate, test or final) and no learning decision is refused, since a
 * held-back window is seen only through its look.
 *
 *   skillUsage({ records, briefingAt, decisions, cycles, hideOutcomes, tick })   the report
 *   readComposeRecords(home)            every compose record under a home, oldest first (both layouts)
 *   readSkillUsage(runDir, { barsFiles })   the report of a replay run (its run dir, as `replay.js report` takes it)
 *   skillUsageMarkdown(u), skillUsageText(u)
 */

const fs = require('fs');
const path = require('path');
const { parseRead } = require('../trading/composed-reads');
const { tradingDayKey } = require('../trading/clock');
const { availableSkills, skillOfRead, READ_SKILL, SHAPE_SKILL, NO_READ_SKILLS } = require('./available-reads');
const { cellStats, knownDay } = require('./experience-index');

const DIR = 'trade-lifecycle';
const MAX_BYTES = 64 * 1024 * 1024;
const TOP = 3;
const ORDER = [...new Set([...Object.values(READ_SKILL).flatMap(k => Object.values(k)), SHAPE_SKILL])];

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const r4 = x => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const checkOf = r => (r.check === true || r.check === 'true' ? true : r.check === false || r.check === 'false' ? false : 'unchecked');
const formOf = r => { const p = parseRead(r.read); return p.form || String(r.read || '').toLowerCase(); };
const noNumbers = form => String(form).split(' ').filter(w => !/^-?\d+(\.\d+)?$/.test(w)).join(' ');

/** A JSON-lines file's objects (an unreadable line skipped); over MAX_BYTES throws. */
function readLines(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error(`${file}: over ${MAX_BYTES} bytes`);
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { const x = JSON.parse(l); return isObj(x) ? [x] : []; } catch (_err) { return []; } });
}

/**
 * Every compose record under the home, oldest first: each family's single file (<home>/trade-lifecycle/<ROOT>.jsonl)
 * and its day shards (<home>/trade-lifecycle/<ROOT>/<day>.jsonl), whichever the run wrote; a record in both, once.
 */
function readComposeRecords(home) {
  const dir = path.join(home, DIR);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const files = [];
  for (const e of entries) {
    if (e.isFile() && /^[A-Z0-9]{1,8}\.jsonl$/.test(e.name)) files.push(path.join(dir, e.name));
    if (e.isDirectory() && /^[A-Z0-9]{1,8}$/.test(e.name)) {
      for (const n of fs.readdirSync(path.join(dir, e.name)).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) files.push(path.join(dir, e.name, n));
    }
  }
  const seen = new Set();
  const out = [];
  for (const f of files.sort()) {
    for (const r of readLines(f)) {
      const key = r.id ? String(r.id) : JSON.stringify(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

/** Why a claimed read was refused, as a reason to count: the kind of refusal and the read without its prices. */
function refusalOf(r, side) {
  const c = checkOf(r);
  if (c === true && r.agrees === false) return `against the ${side}: ${noNumbers(formOf(r))}`;
  if (c === 'unchecked') return `unverifiable: ${noNumbers(formOf(r))}`;
  // A read the checker's rules refused before any check (its step, its skill, said twice, a negation) names no field.
  if (!r.field && r.fact) return `refused: ${String(r.fact).slice(0, 80)}`;
  return `false: ${noNumbers(formOf(r))}`;
}

const top = (map, n = TOP) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([what, count]) => ({ what, count }));

function blank(skill) {
  return { skill, steps: new Set(), claimed: 0, reads: 0, correct: 0, wrong: 0, mislabeled: 0, available: 0, used: 0, relevant: 0, missed: 0, reasons: new Map(), missedReads: new Map() };
}

/** The decision points: root|bar|side -> { root, bar, side, reads: Map(step|form -> read) } (a read stated again, once: the latest). */
function pointsOf(records) {
  const points = new Map();
  for (const rec of records) {
    if (!isObj(rec) || !['long', 'short'].includes(rec.side) || !rec.bar) continue;
    const key = `${rec.root}|${rec.bar}|${rec.side}`;
    if (!points.has(key)) points.set(key, { root: rec.root, bar: rec.bar, side: rec.side, reads: new Map() });
    for (const r of Array.isArray(rec.reads) ? rec.reads : []) if (isObj(r) && typeof r.read === 'string') points.get(key).reads.set(`${r.step}|${formOf(r)}`, r);
  }
  return [...points.values()];
}

/** The usage per skill (see the head); briefingAt(root, bar) -> the briefing at the bar, or null. */
function usageOf(points, briefingAt, tick) {
  const stats = new Map();
  const at = skill => { if (!stats.has(skill)) stats.set(skill, blank(skill)); return stats.get(skill); };
  let withBriefing = 0;
  for (const p of points) {
    const claimed = new Set();
    for (const r of p.reads.values()) {
      const own = skillOfRead(r.step, r.read);
      const skills = [own || r.skill || 'unknown', ...(r.skill === SHAPE_SKILL && own !== SHAPE_SKILL ? [SHAPE_SKILL] : [])];
      const ok = checkOf(r) === true && r.agrees === true;
      for (const skill of skills) {
        const s = at(skill);
        s.steps.add(r.step);
        s.reads += 1;
        if (ok) s.correct += 1;
        else { s.wrong += 1; const why = refusalOf(r, p.side); s.reasons.set(why, (s.reasons.get(why) || 0) + 1); }
        // Filed under another skill (the shape skill names a read of another's on purpose: never a mislabel).
        if (skill === own && r.skill && r.skill !== own && r.skill !== SHAPE_SKILL) s.mislabeled += 1;
        claimed.add(skill);
      }
    }
    for (const skill of claimed) at(skill).claimed += 1;
    let b;
    try { b = briefingAt ? briefingAt(p.root, p.bar) : null; } catch (_err) { b = null; }
    if (!b) continue;
    withBriefing += 1;
    const avail = availableSkills(b, p.side, { tick });
    for (const [skill, a] of avail) {
      const s = at(skill);
      if (a.reads.length) { s.available += 1; if (claimed.has(skill)) s.used += 1; }
      if (a.agreeing.length && !claimed.has(skill)) {
        s.missed += 1;
        for (const x of a.agreeing) { const f = noNumbers(x.form); s.missedReads.set(f, (s.missedReads.get(f) || 0) + 1); }
      }
      if (a.agreeing.length) s.relevant += 1;
    }
  }
  const rank = s => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  const skills = [...stats.values()].sort((a, b) => rank(a.skill) - rank(b.skill) || a.skill.localeCompare(b.skill)).map(s => ({
    skill: s.skill, steps: [...s.steps].sort(), claimed: s.claimed, available: s.available, used: s.used, usedRate: s.available ? r4(s.used / s.available) : null,
    reads: s.reads, correct: s.correct, wrong: s.wrong, correctRate: s.reads ? r4(s.correct / s.reads) : null, topRefusals: top(s.reasons),
    relevant: s.relevant, missed: s.missed, topMissed: top(s.missedReads), mislabeled: s.mislabeled,
  }));
  return { withBriefing, skills };
}

/** n, days, raw mean R and win rate, and the experience index's label (its interval when it has enough). */
function cell(rows, key) {
  const c = cellStats(rows, { key, reps: 500 });
  const withR = rows.filter(r => Number.isFinite(r[1]));
  return {
    n: c.n, days: c.days, unfilled: c.unfilled, meanR: r4(mean(withR.map(r => r[1]))), winRate: c.n ? r4(c.wins / c.n) : null,
    enough: c.enough, label: c.enough ? `enough (n=${c.n}, ${c.days} days; mean R ${c.meanR.lo} to ${c.meanR.hi})` : c.note,
  };
}

/** The outcome by skill and by skill combination (see the head), from the experience log's composed decisions. */
function outcomeOf(decisions) {
  const composed = (decisions || []).filter(d => isObj(d) && d.decision && d.decision !== 'none' && !d.hidden);
  const bySkill = new Map();
  const byCombo = new Map();
  for (const d of composed) {
    const row = [knownDay(d), d.outcome && Number.isFinite(d.outcome.R) ? d.outcome.R : null, d.decision === 'entered' ? 1 : 0, (d.context && d.context.regime) || '-'];
    const skills = new Set();
    for (const r of Array.isArray(d.reads) ? d.reads : []) {
      if (!isObj(r) || checkOf(r) !== true || r.agrees === false) continue;
      skills.add(skillOfRead(r.step, r.read) || r.skill || 'unknown');
      if (r.skill === SHAPE_SKILL) skills.add(SHAPE_SKILL);
    }
    for (const s of skills) { if (!bySkill.has(s)) bySkill.set(s, []); bySkill.get(s).push(row); }
    const combo = d.signatures && d.signatures.skill ? d.signatures.skill : null;
    if (combo) { if (!byCombo.has(combo)) byCombo.set(combo, []); byCombo.get(combo).push(row); }
  }
  const both = (rows, key) => ({ taken: cell(rows.filter(r => r[2] === 1), `${key}|taken`), all: cell(rows, key) });
  const rank = s => (ORDER.includes(s) ? ORDER.indexOf(s) : ORDER.length);
  return {
    decisions: composed.length,
    bySkill: [...bySkill].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([skill, rows]) => ({ skill, ...both(rows, skill) })),
    byCombo: [...byCombo].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([combo, rows]) => ({ combo, ...both(rows, combo) })),
  };
}

/** The cycles the run's cycle log holds (trade cycles, those with a compose_check call), from its summary lines. */
function cyclesOf(lines) {
  const trade = (lines || []).filter(l => isObj(l) && l.action === 'trade');
  return { trade: trade.length, composed: trade.filter(l => isObj(l.composed) && l.composed.calls > 0).length, calls: trade.reduce((n, l) => n + (isObj(l.composed) ? Number(l.composed.calls) || 0 : 0), 0) };
}

function skillUsage({ records = [], briefingAt = null, decisions = null, cycles = null, hideOutcomes = false, tick = 0.25 } = {}) {
  const points = pointsOf(records);
  const u = usageOf(points, briefingAt, tick);
  return {
    records: records.length, recordsOk: records.filter(r => isObj(r) && r.ok === true).length, points: points.length, briefings: u.withBriefing,
    cycles: cycles ? cyclesOf(cycles) : null, skills: u.skills,
    noRead: Object.entries(NO_READ_SKILLS).map(([step, skills]) => ({ step, skills: [...skills] })),
    outcome: hideOutcomes ? { hidden: true } : decisions ? outcomeOf(decisions) : null,
  };
}

/** The cycle log's summary lines under a home (logs/cycles-<day>.jsonl). */
function readCycleLines(home) {
  const dir = path.join(home, 'logs');
  let names;
  try { names = fs.readdirSync(dir).filter(n => /^cycles-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch (_err) { return []; }
  return names.flatMap(n => readLines(path.join(dir, n)));
}

/**
 * The briefing at a bar, rebuilt from `bars` (the run's, oldest first) closed by that bar's close: the bar and the
 * `count` before it, never a later bar. null when the bar isn't in them.
 */
function briefingFrom(bars, { root, minutes, count }) {
  const { buildBriefing } = require('../trading/briefing');
  const index = new Map(bars.map((b, i) => [Date.parse(b.t), i]));
  return (r, bar) => {
    if (r !== root) return null;
    const i = index.get(Date.parse(bar));
    if (i === undefined) return null;
    const slice = bars.slice(Math.max(0, i + 1 - count), i + 1).map(({ t, o, h, l, c, v }) => ({ t, o, h, l, c, v }));
    return buildBriefing({ symbol: root, bars: slice, minutes, now: new Date(Date.parse(bars[i].t) + minutes * 60000) });
  };
}

/** Refused when the records reach a held-back day and the run has no learning decision (see the head). */
function checkLedger(records, gate) {
  if (gate) return;
  const { roleOf } = require('./splits');
  const held = [...new Set(records.map(r => (Number.isFinite(Date.parse(r.bar)) ? tradingDayKey(new Date(Date.parse(r.bar))) : null)).filter(Boolean))]
    .filter(d => { try { return roleOf(d) !== 'practice-train'; } catch (_err) { return false; } });
  if (held.length) throw new Error(`skill usage refused: this run has records on held-back days (${held[0]}${held.length > 1 ? ` and ${held.length - 1} more` : ''}) and no learning decision (learning-run.json): a held-back window is seen only through its look (learning/run-gate.js)`);
}

/** The report of a replay run: its run dir (<run home>/replay/<id>); barsFiles { SYMBOL: file } the data it replayed. */
function readSkillUsage(runDir, { barsFiles = {} } = {}) {
  const labels = require('../replay/labels');
  const { readLearningRun } = require('./run-gate');
  const { historyBars } = require('../autotrader');
  const { readDecisions, logFile } = require('./experience-log');
  const dir = labels.realDir(runDir);
  const home = path.resolve(dir, '..', '..');
  const records = readComposeRecords(home);
  const gate = readLearningRun(dir) || readLearningRun(home);
  checkLedger(records, gate);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dir, 'autotrader.json'), 'utf8')) || {}; } catch (_err) { cfg = {}; }
  const minutes = Number(cfg.timeframe) || null;
  const count = Number(cfg.bars) > 0 ? Number(cfg.bars) : minutes ? historyBars(minutes) : 0;
  const outcomeBars = minutes && Object.keys(barsFiles).length ? labels.outcomeBarsFor(dir, barsFiles) : null;
  const builders = new Map();
  const briefingAt = minutes ? (root, bar) => {
    if (!builders.has(root)) {
      const bars = (labels.outcomeFor(outcomeBars, root, minutes) || labels.loadBars(home, root, minutes)).slice().sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      builders.set(root, bars.length ? briefingFrom(bars, { root, minutes, count }) : () => null);
    }
    return builders.get(root)(root, bar);
  } : null;
  const hideOutcomes = Boolean(gate && gate.hideOutcomes);
  const decisions = !hideOutcomes && fs.existsSync(logFile(home)) ? readDecisions(logFile(home)) : null;
  return skillUsage({ records, briefingAt, decisions, cycles: readCycleLines(home), hideOutcomes });
}

const f2 = x => (x === null || x === undefined ? '-' : Number(x).toFixed(2));
const list = xs => (xs.length ? xs.map(x => `${x.what} (${x.count})`).join('; ') : '-');
const cellText = c => `${c.n}, ${f2(c.meanR)}, ${f2(c.winRate)}, ${c.label}`;

function skillUsageText(u) {
  const used = u.skills.filter(s => s.claimed > 0).length;
  const wrong = u.skills.reduce((n, s) => n + s.wrong, 0);
  const reads = u.skills.reduce((n, s) => n + s.reads, 0);
  const missed = u.skills.filter(s => s.missed > 0).map(s => s.skill);
  return `skill usage: ${u.points} decision points (${u.records} compose records, ${u.recordsOk} ok); ${used} skills claimed; reads wrong ${wrong} of ${reads}; missed: ${missed.join(', ') || 'none'}\n`;
}

function skillUsageMarkdown(u) {
  const c = u.cycles;
  const o = u.outcome;
  const outcome = !o ? ['Outcomes: no experience log for this run (written when a learning run finishes).']
    : o.hidden ? ['Outcomes: hidden (this run is a reasoning-fix look).']
      : [
        `Outcomes, from the experience log's ${o.decisions} composed decisions (n, mean R, win rate, the experience index's label):`, '',
        '| Skill | Taken | All (passes at their counterfactual) |', '|---|---|---|',
        ...o.bySkill.map(s => `| ${s.skill} | ${cellText(s.taken)} | ${cellText(s.all)} |`), '',
        '| Skill combination | Taken | All |', '|---|---|---|',
        ...o.byCombo.slice(0, 15).map(s => `| ${s.combo} | ${cellText(s.taken)} | ${cellText(s.all)} |`),
      ];
  return [
    '## Skill usage', '',
    '- An operator report: never shown to the model.',
    `- ${u.points} decision points (a bar and side composed on) from ${u.records} compose records (${u.recordsOk} ok); briefings rebuilt from the run's bars for ${u.briefings}${c ? `; cycle log: ${c.trade} trade cycles, ${c.composed} with compose_check (${c.calls} calls)` : ''}.`,
    `- No read form, not measured here: ${u.noRead.map(x => `${x.step} (${x.skills.join(', ')})`).join('; ')}.`, '',
    '| Skill | Steps | Used (of available) | Claimed reads | Correct | Wrong | Top refusals | Missed (of relevant) | Top missed | Mislabeled |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...u.skills.map(s => `| ${s.skill} | ${s.steps.join(', ') || '-'} | ${s.used} of ${s.available} (${f2(s.usedRate)}); claimed ${s.claimed} | ${s.reads} | ${s.correct} | ${s.wrong} | ${list(s.topRefusals)} | ${s.missed} of ${s.relevant} | ${list(s.topMissed)} | ${s.mislabeled} |`),
    '', ...outcome, '',
  ].join('\n');
}

module.exports = { skillUsage, readComposeRecords, readSkillUsage, readCycleLines, briefingFrom, checkLedger, skillUsageMarkdown, skillUsageText };
