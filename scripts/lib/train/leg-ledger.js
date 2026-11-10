'use strict';

/**
 * The leg ledger (docs/TRAINING.md, "The leg ledger"): what the model's refusals cost on the trend legs. The round report
 * shows the trades taken; this joins, per trend leg of the champion's trend runs, what the model read over the leg's
 * window and what the leg then did, so a refusal's class can be weighed by the legs that ran after it. Information only:
 * a report the operator reads; nothing that decides (the gate, compose_check, sizing, the stop, the trail, the exits, the
 * briefing, a skill, a prompt) reads it. priorOnly is the view a later change may show the model: days strictly before.
 *
 * Built only from what the loop already records (no fact re-derived here):
 *   the leg          the champion's probe docs (probe.js, probes/trend/pc-<day>-<hash>.json): its trend-capture report
 *                    (replay/trend-capture.js), each leg's day, side, start, end, availableR (that module's own basis: the
 *                    move from the first bar an entry could be on, in the leg's trade's held stop, else the planned stop,
 *                    else the run's: `estimated`), caught or not, its ride (replay/trend-ride.js) and its blocker
 *   the reads        the capture's cycles over the leg's first catchShare (classifyCycle: each cycle's code, as recorded
 *                    at the cycle from its cycle log, compose records and gate log), each with
 *                      class    its code's class (codeClass; CLASSES)
 *                      stated   the reason the model stated for the leg's own side (statedClass on its CYCLE RESULT text:
 *                               the scorecard row's full text, else the capture's clipped message), for a no-plan or a
 *                               head-pass cycle only (the codes that hold the model's own reason); null when none matches
 *                      reason   stated, else class
 *                      scorecard  the scorecard's own verdict on that decision (loop.js scorecardDecisions: the decision
 *                               the priority order expects, its category, and the counterfactual R of a skip where the row
 *                               carries one), joined by bar (its barT one timeframe before the cycle's close); null when no
 *                               row joins (counted: `unjoined`)
 *   the outcome      later data, labelled outcome: a caught leg's entry lag (share of the leg), peak R, banked R and
 *                    giveback R (its ride); a missed leg's R available and its blocker (the capture's: the cycle that came
 *                    closest to an entry), with that cycle's class and stated reason. `unfilled` is an outcome too: the
 *                    capture sets it from the fills after the order went (at the cycle it read "order placed").
 * No look-ahead in what a read says: its code and stated reason are what the cycle recorded at its bar. The leg itself,
 * its R, its ride and the scorecard's category are what happened after: outcomes, never inputs to a read.
 *
 * Aggregates (aggregate), by class (the blocker's class) and by reason (the stated one), each figure with its n:
 *   blocked     the missed legs whose blocker is of the class, their R available (n known, sum, mean, median, unknown,
 *               estimated)
 *   refusedIn   the legs a flat read of the class refused before any entry on them (legs that ran after that refusal:
 *               caught later or missed), the cycles, and those legs' R available
 *   scorecard   those refusals' scorecard rows: joined, unjoined, how many it expected a take on, its categories, and the
 *               counterfactual R where recorded (n, sum). Leg R is NOT tradeable (a leg's whole move from its first entry
 *               bar, which no entry gets); the counterfactual is the scorecard's own simulated trade: different things
 * Unknown is unknown (trade-feedback.js's rule): an R not known is counted `unknown`, never summed as 0, and a mean or a
 * median over none is null.
 *
 *   CLASSES                                   [{ key, says }], frozen
 *   codeClass({ code, by, step })             a capture cycle code's class
 *   statedClass(text, side)                   the reason a CYCLE RESULT text states for that side, or null
 *   buildLedger(runs)                         { v, rows, totals, byClass, byReason, byHalf }; runs [{ capture, decisions,
 *                                             minutes, half, include }] (include: the leg ids kept; none: all)
 *   aggregate(rows)                           { totals, byClass, byReason }
 *   priorOnly(ledger, day)                    aggregate of the rows of days strictly before day (YYYY-MM-DD), { before }
 *   readRound(home, { iteration, runs, minutes, prefix })   { runs, missingDays, unfinished }: a training home's round
 *                                             (iter-<n>/probe-report.json halves, the champion's probe docs and decisions;
 *                                             a run's timeframe from <runs>/<runId>/replay/<runId>/autotrader.json, else
 *                                             minutes)
 *   ledgerLines(ledger)                       the report's text lines
 */

const fs = require('fs');
const path = require('path');
const { FLOW_STEPS } = require('../trading/composed-reads');
const TUN = require('../tunables').replay().trendCapture; // config/replay.json (the capture's own message length)

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const num = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const r2 = x => (num(x) === null ? null : Math.round(x * 100) / 100);
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Compose refusals other than location and entry are filed by their step.
const STEP_CLASS = { location: 'location', entry: 'entry-reaction' };
const CLASSES = Object.freeze([
  ['trend-rule', 'the model said the trend rule refused the leg\'s own side (stated reason)'],
  ['htf-choch-against', 'the model said a 1h or 4h CHoCH ran against the leg\'s side (stated reason)'],
  ['location', 'compose_check refused the location read (not at the level it named)'],
  ['entry-reaction', 'compose_check refused the entry read, or the model said the reaction was plain or conflicting'],
  ...FLOW_STEPS.filter(s => !STEP_CLASS[s]).map(s => [`compose-${s}`, `compose_check refused the ${s} step`]),
  ['compose-refused', 'compose_check refused the record with no step named'],
  ['room-rr', 'the model said the plan had no room (R:R under the minimum, no level at the target) (stated reason)'],
  ['size-floor', 'no size fits: the floor of contracts at that stop (phase 2, the gate, or the model said so)'],
  ['risk-veto', 'risk-manager phase 2 vetoed (or its verdict read as one)'],
  ['late-entry-chase', 'the plan\'s entry was missed or chased (the runner\'s late entry, or the model said it was stale)'],
  ['executor-blocked', 'the executor or the gate blocked the entry order (an abort, a block)'],
  ['gate-refused', 'the order gate refused the entry with another check'],
  ['unfilled', 'the order went and never filled (an outcome: the capture reads it from the later fills)'],
  ['head-pass', 'the head trader passed on an OK compose record'],
  ['no-plan', 'no compose call the leg\'s way and no stated reason matched'],
  ['position-open', 'a position was already open (not a refusal: the window ran while it was held)'],
  ['opening-print', 'the opening print refused entries (a rule)'],
  ['news', 'a news blackout (a rule)'], ['loss-streak', 'a loss streak cooldown (a rule)'], ['daily-stop', 'the soft daily stop (a rule)'],
  ['window', 'outside the entry window (a rule)'],
  ['outside-session', 'no trade cycle on that bar'],
  ['entered', 'an entry the leg\'s way that filled'],
  ['unknown', 'a code this ledger does not know'],
].map(([key, says]) => Object.freeze({ key, says })));
const KNOWN = new Set(CLASSES.map(c => c.key));
const STATED_RULES = [
  ['loss-streak', /\bloss[- ]streak\b|\bconsecutive loss|\bcooldown\b/i], ['daily-stop', /\bdaily (?:loss )?stop\b|\bsoft (?:daily )?stop\b|\bstopped for the day\b/i],
  ['news', /\bnews blackout\b|\bin blackout\b/i], ['opening-print', /\bopening[- ]print\b/i],
];
const RULE_CODES = new Set(['opening-print', 'news', 'loss-streak', 'daily-stop', 'window', 'outside-session']);

/** A capture cycle code's class (see CLASSES). */
function codeClass({ code, by, step } = {}) {
  const c = String(code || '');
  if (by === 'compose_check') return step ? STEP_CLASS[step] || `compose-${step}` : 'compose-refused';
  if (RULE_CODES.has(c)) return c;
  const direct = {
    'position-open': 'position-open', 'head-pass': 'head-pass', 'no-plan': 'no-plan', entered: 'entered', unfilled: 'unfilled',
    blocked: 'executor-blocked', 'executor-abort': 'executor-blocked', 'late-entry': 'late-entry-chase', veto: 'risk-veto',
    'verdict-unread': 'risk-veto', 'min-contracts': 'size-floor',
  }[c];
  if (direct) return direct;
  if (by === 'gate') return 'gate-refused';
  return 'unknown';
}

/**
 * The reason a CYCLE RESULT text states for the leg's side, or null. Clause by clause (split at ';'); the trend rule only
 * when the leg's side is named before the refusal with the other side not between (the other side's setups refused by
 * the trend rule say nothing about this leg); a CHoCH only on the 1h or 4h, the other way, not negated.
 */
function statedClass(text, side) {
  const t = String(text || '');
  if (!t.trim() || (side !== 'long' && side !== 'short')) return null;
  const other = side === 'long' ? 'short' : 'long';
  const against = side === 'long' ? 'down' : 'up';
  const clauses = t.split(';');
  const any = re => clauses.some(c => re.test(c));
  // A rule the model said blocked entries (the capture's rule codes miss some wordings: "loss-streak stop").
  const rule = STATED_RULES.find(([, re]) => any(re));
  if (rule) return rule[0];
  // "<side> ... against|refused by|counter to the <a few plain words> trend": the other side never between, and only
  // words (no punctuation) between the refusal and "trend" ("CHoCH up are against, and the trend is not declared" is not).
  const notOther = `(?:(?!\\b${other}s?\\b)[^;])*?`;
  const mine = new RegExp(`\\b${side}s?\\b${notOther}\\b(?:against|refused by|counter to)\\s+(?:[\\w/-]+\\s+)*?trend\\b`, 'i');
  const ruleOn = new RegExp(`\\btrend\\s+rule\\s+(?:refuses|blocks|forbids)\\b${notOther}\\b${side}s?\\b`, 'i');
  if (any(mine) || any(ruleOn)) return 'trend-rule';
  // A 1h or 4h CHoCH said to be against (its way, when named, the other way), not negated ("no 1h CHoCH down").
  const choch = /\b(?:1h|4h)\s+choch(?:\s+(up|down))?\b[^;.]*?\bagainst\b/gi;
  if (clauses.some(c => [...c.matchAll(choch)].some(m => (!m[1] || m[1].toLowerCase() === against) && !/\bno\s+$/i.test(c.slice(0, m.index))))) return 'htf-choch-against';
  if (any(/\bno size fits\b|\bmin_contracts\b|\bsize floor\b/i)) return 'size-floor';
  if (any(/\bR:R\s+[\d.]+\s+(?:under|below)\b|\bno level at \d+R\b|\bstandard plan refused\b/i)) return 'room-rr';
  if (any(/\bstale\b|\bchas(?:e|ed|ing)\b|\bmissed the plan's entry\b/i)) return 'late-entry-chase';
  if (any(/\bconflicting\b|\bplain\b|\bno (?:confirmed )?rejection\b|\bnot a confirmed rejection\b|\bINVALID\b/i)) return 'entry-reaction';
  return null;
}

/** The scorecard rows by the close of the bar they decided on (barT plus the timeframe), or none without one. */
function byClose(decisions, minutes) {
  const map = new Map();
  if (!(num(minutes) > 0)) return map;
  for (const d of Array.isArray(decisions) ? decisions : []) {
    const ms = isObj(d) ? Date.parse(d.barT) : NaN;
    if (Number.isFinite(ms) && !map.has(ms + minutes * 60000)) map.set(ms + minutes * 60000, d);
  }
  return map;
}

const verdictOf = d => {
  if (!d) return null;
  const cf = isObj(d.counterfactual) && d.counterfactual.simulated === true ? num(d.counterfactual.R) : null;
  return { expected: isObj(d.expected) ? d.expected.decision || null : null, category: d.category || null, counterfactualR: cf };
};

/** One leg's row (see the header). */
function legRow(l, { rows: scored, half }) {
  const cycles = Array.isArray(l.cycles) ? l.cycles : [];
  const firstEntry = cycles.findIndex(c => c.code === 'entered');
  const reads = cycles.map((c, i) => {
    const d = scored.get(Date.parse(c.bar)) || null;
    const cls = codeClass(c);
    const stated = cls === 'no-plan' || cls === 'head-pass' ? statedClass(d && d.stated ? d.stated : c.message, l.side) : null;
    const flat = cls !== 'position-open' && cls !== 'entered';
    return { bar: c.bar, code: c.code, class: cls, stated, reason: stated || cls, flat, beforeEntry: firstEntry < 0 || i < firstEntry, message: String(c.message || '').slice(0, TUN.messageChars), scorecard: verdictOf(d) };
  });
  const refusals = {};
  for (const x of reads) if (x.flat && x.beforeEntry) refusals[x.class] = (refusals[x.class] || 0) + 1;
  // The capture's blocker: the latest cycle with its code (the furthest stage, the latest among equals).
  const b = !l.captured && isObj(l.blocker) ? l.blocker : null;
  const bx = b ? [...reads].reverse().find(x => x.code === b.code) || null : null;
  const blocker = b ? { class: codeClass(b), reason: bx ? bx.reason : codeClass(b), code: b.code, bar: bx ? bx.bar : null, cycles: num(b.cycles) } : null;
  const ride = isObj(l.ride) ? l.ride : {};
  const availableR = num(l.availableR);
  const outcome = l.captured
    ? { kind: 'entered', entryLag: num(ride.entryLag), peakR: num(ride.peakR), bankedR: num(ride.r), givebackR: num(ride.givebackR), open: ride.open === true }
    : { kind: 'missed', availableR };
  return { id: l.id, day: l.day, side: l.side, start: l.start, end: l.end, half: half || null, points: isObj(l.move) ? num(l.move.points) : null, availableR, estimated: l.estimated === true, captured: l.captured === true, reads, refusals, blocker, outcome };
}

/** R stats of rows' availableR: n known, sum, mean, median, unknown, estimated (never an unknown summed as 0). */
function rStats(rows) {
  const known = rows.filter(r => r.availableR !== null);
  const s = known.map(r => r.availableR).sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const mid = Math.floor(s.length / 2);
  const median = !s.length ? null : s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { n: s.length, sum: r2(sum), mean: s.length ? r2(sum / s.length) : null, median: r2(median), unknown: rows.length - known.length, estimated: known.filter(r => r.estimated).length };
}

function classesOf(rows, key) {
  const out = new Map();
  const slot = k => {
    if (!out.has(k)) out.set(k, { blocked: [], refusedIn: new Set(), cycles: 0, refusals: [] });
    return out.get(k);
  };
  for (const r of rows) {
    if (r.blocker) slot(r.blocker[key]).blocked.push(r);
    for (const x of r.reads) {
      if (!x.flat || !x.beforeEntry) continue;
      const s = slot(x[key]);
      s.refusedIn.add(r);
      s.cycles += 1;
      s.refusals.push(x);
    }
  }
  return [...out.entries()].map(([k, s]) => {
    const legs = [...s.refusedIn];
    const joined = s.refusals.filter(x => x.scorecard);
    const categories = {};
    for (const x of joined) if (x.scorecard.category) categories[x.scorecard.category] = (categories[x.scorecard.category] || 0) + 1;
    const cf = joined.map(x => x.scorecard.counterfactualR).filter(v => v !== null);
    return {
      class: k,
      blocked: { legs: s.blocked.length, r: rStats(s.blocked) },
      refusedIn: { legs: legs.length, caught: legs.filter(r => r.captured).length, missed: legs.filter(r => !r.captured).length, cycles: s.cycles, r: rStats(legs) },
      scorecard: { joined: joined.length, unjoined: s.refusals.length - joined.length, expectedTake: joined.filter(x => x.scorecard.expected === 'take').length, categories, counterfactual: { n: cf.length, sum: r2(cf.reduce((a, b) => a + b, 0)) } },
    };
  }).sort((a, b) => b.blocked.legs - a.blocked.legs || b.refusedIn.legs - a.refusedIn.legs || (a.class < b.class ? -1 : 1));
}

/** The aggregates of rows (see the header). */
function aggregate(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const caught = list.filter(r => r.captured);
  const banked = caught.map(r => r.outcome.bankedR).filter(v => v !== null);
  const reads = list.flatMap(r => r.reads);
  return {
    totals: {
      legs: list.length, caught: caught.length, missed: list.length - caught.length,
      rAvailable: rStats(list), rMissed: rStats(list.filter(r => !r.captured)),
      rCaught: { n: banked.length, sum: r2(banked.reduce((a, b) => a + b, 0)), unknown: caught.length - banked.length },
      scorecard: { joined: reads.filter(x => x.scorecard).length, unjoined: reads.filter(x => !x.scorecard).length },
    },
    byClass: classesOf(list, 'class'),
    byReason: classesOf(list, 'reason'),
  };
}

/** The ledger of the runs (see the header). */
function buildLedger(runs) {
  const rows = [];
  for (const run of Array.isArray(runs) ? runs : []) {
    const keep = Array.isArray(run.include) ? new Set(run.include) : null;
    const scored = byClose(run.decisions, run.minutes);
    for (const l of isObj(run.capture) && Array.isArray(run.capture.legs) ? run.capture.legs : []) {
      if (isObj(l) && (!keep || keep.has(l.id))) rows.push(legRow(l, { rows: scored, half: run.half }));
    }
  }
  rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const halves = [...new Set(rows.map(r => r.half).filter(Boolean))].sort();
  // v: the ledger's format version.
  return { v: 1, rows, ...aggregate(rows), byHalf: Object.fromEntries(halves.map(h => [h, aggregate(rows.filter(r => r.half === h))])) };
}

/** The aggregates of the days strictly before `day` only (what a later change may show the model at that day). */
function priorOnly(ledger, day) {
  if (!DAY.test(String(day || ''))) throw new Error(`priorOnly: a day YYYY-MM-DD is needed, not ${day}`);
  const rows = (isObj(ledger) && Array.isArray(ledger.rows) ? ledger.rows : []).filter(r => DAY.test(String(r.day)) && r.day < day);
  return { before: day, ...aggregate(rows) };
}

/**
 * A training home's round: each half of iter-<n>/probe-report.json's trend (its days and legs), the champion's probe doc
 * of each day (probes/trend/<prefix>-<day>-<hash>.json, its capture), the legs listed in the half whose unit the run
 * stepped to its end (as the screens pair them: trend-screen.js), and the same run's scorecard decisions
 * (<prefix>-t<YYYYMMDD>.<hash>.-decisions.json). A listed day without a doc and a leg on an unfinished unit are reported.
 */
function readRound(home, { iteration = 1, runs = null, minutes = null, prefix = 'pc', halves = ['probe', 'confirm'] } = {}) {
  const file = path.join(home, `iter-${iteration}`, 'probe-report.json');
  const report = readJson(file);
  if (!isObj(report) || !isObj(report.trend)) throw new Error(`${file}: no probe-report with a trend part`);
  const dir = path.join(home, 'probes', 'trend');
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch (_err) { /* none */ }
  const re = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})-([0-9a-f]+)\\.json$`);
  const docs = names.map(n => re.exec(n)).filter(Boolean).map(m => ({ day: m[1], hash: m[2], file: path.join(dir, m[0]) }));
  const out = { runs: [], missingDays: [], unfinished: [] };
  for (const half of halves) {
    const h = report.trend[half];
    if (!isObj(h)) continue;
    const listed = new Set(Array.isArray(h.legs) ? h.legs : []);
    for (const day of Array.isArray(h.days) ? h.days : []) {
      const found = docs.filter(d => d.day === day);
      if (!found.length) { out.missingDays.push({ half, day }); continue; }
      for (const f of found) {
        const doc = readJson(f.file);
        if (!isObj(doc) || !isObj(doc.capture)) continue;
        const unitOf = new Map((Array.isArray(doc.legs) ? doc.legs : []).filter(e => Array.isArray(e) && isObj(e[1])).map(([id, x]) => [id, x.unit !== undefined ? x.unit : x.day]));
        const done = new Set((Array.isArray(doc.sessions) ? doc.sessions : []).filter(s => isObj(s) && s.complete).map(s => (s.unit !== undefined ? s.unit : s.day)));
        const include = [];
        for (const l of Array.isArray(doc.capture.legs) ? doc.capture.legs : []) {
          if (!listed.has(l.id)) continue;
          if (done.has(unitOf.get(l.id))) include.push(l.id); else out.unfinished.push({ half, id: l.id });
        }
        const runId = doc.capture.runId;
        const cfg = runs && runId ? readJson(path.join(runs, runId, 'replay', runId, 'autotrader.json')) : null;
        const tf = isObj(cfg) && num(Number(cfg.timeframe)) > 0 ? Number(cfg.timeframe) : num(minutes);
        const decisions = readJson(path.join(home, `${prefix}-t${day.replace(/-/g, '')}.${f.hash}.-decisions.json`));
        out.runs.push({ capture: doc.capture, decisions: Array.isArray(decisions) ? decisions : [], minutes: tf, half, include });
      }
    }
  }
  return out;
}

const fmtR = s => `n ${s.n} sum ${s.sum}R mean ${s.mean ?? '-'} median ${s.median ?? '-'}${s.unknown ? ` (+${s.unknown} unknown)` : ''}${s.estimated ? ` (${s.estimated} est.)` : ''}`;

function aggLines(a, label) {
  const t = a.totals;
  const lines = [`${label}: ${t.legs} leg(s), ${t.caught} caught, ${t.missed} missed; R available ${fmtR(t.rAvailable)}; missed ${fmtR(t.rMissed)}; caught banked n ${t.rCaught.n} sum ${t.rCaught.sum}R${t.rCaught.unknown ? ` (+${t.rCaught.unknown} unknown)` : ''} (outcome)`];
  const table = (list, what) => {
    lines.push(`  by ${what}: class | blocked legs (missed R) | legs refused then ran (caught/missed, cycles; their R) | scorecard on those refusals`);
    for (const x of list) {
      const sc = x.scorecard;
      const cats = Object.entries(sc.categories).map(([k, n]) => `${k} ${n}`).join(', ');
      lines.push(`    ${x.class} | ${x.blocked.legs} (${fmtR(x.blocked.r)}) | ${x.refusedIn.legs} (${x.refusedIn.caught}/${x.refusedIn.missed}, ${x.refusedIn.cycles} cyc; ${fmtR(x.refusedIn.r)}) | joined ${sc.joined}/${sc.joined + sc.unjoined}, expected take ${sc.expectedTake}${cats ? `, ${cats}` : ''}, counterfactual ${sc.counterfactual.n ? `n ${sc.counterfactual.n} sum ${sc.counterfactual.sum}R` : 'not recorded'}`);
    }
  };
  table(a.byClass, 'class (the blocker\'s code)');
  table(a.byReason, 'reason (the model\'s stated reason, else the code)');
  return lines;
}

/** The report's lines (see the header). */
function ledgerLines(ledger) {
  if (!isObj(ledger) || !Array.isArray(ledger.rows)) return [];
  const lines = [
    'Leg ledger (information only). Leg R is the leg\'s whole move from its first entry bar in the plan\'s stop: an outcome, not tradeable.',
    'The scorecard\'s columns are its own verdict on each refusal (the priority order\'s expected decision, its category, a skip\'s simulated R where recorded): different from leg R.',
    `scorecard rows joined to reads: ${ledger.totals.scorecard.joined}, unjoined (unknown): ${ledger.totals.scorecard.unjoined}`,
    ...aggLines(ledger, 'all'),
    ...Object.entries(ledger.byHalf || {}).flatMap(([h, a]) => aggLines(a, h)),
    'legs (outcome):',
  ];
  for (const r of ledger.rows) {
    const o = r.outcome;
    const said = Object.entries(r.refusals).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
    lines.push(`  ${r.half || '-'} ${r.day} ${r.side} ${r.availableR ?? 'unknown'}R${r.estimated ? ' est.' : ''}: ${o.kind === 'entered' ? `caught, lag ${o.entryLag ?? '?'} peak ${o.peakR ?? '?'}R banked ${o.bankedR ?? '?'}R giveback ${o.givebackR ?? '?'}R` : `missed: ${r.blocker ? `${r.blocker.class}${r.blocker.reason !== r.blocker.class ? ` (said: ${r.blocker.reason})` : ''}` : 'no blocker'}`}; refusals before any entry: ${said}`);
  }
  return lines;
}

module.exports = { CLASSES, KNOWN, codeClass, statedClass, buildLedger, aggregate, priorOnly, readRound, ledgerLines };
