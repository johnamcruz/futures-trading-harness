'use strict';

/**
 * The skills a cycle's situation needs, in that cycle's prompt (the owner: "All our skills should be used as context,
 * like CISD or compression"; every skill loaded when needed, so no setup is skipped, and the exit playbook while a trade
 * is open). One table (TABLE) maps each fact the account or the cycle's bar briefing shows to the skills that own it;
 * the skills come from the crosswalk (learning/curated-moments.js READ_SKILL: the skill of each read kind), so the
 * read a fact supports and the skill embedded for it can't disagree. Each entry has its decision stage; the budget fills
 * in STAGES order, the stage being decided now first:
 *
 *   management  a position or a working entry is open: manage-position, pullback-vs-reversal, take-profit; an entry
 *               working: entry-outcome; flat with working orders: leftover-orders
 *   setup       flat, the window allowing entries, each setup the Setups-to-check line lists (setup-moments.js checkLine,
 *               setupChecks): a level rejected (rejection), broken (breakout, breakout-vs-fakeout), a compression break
 *               (compression), a live CISD (cisd, fib-retracement: its OTE is a fib zone), an FVG retested
 *               (fair-value-gaps)
 *   entry       a setup listed: candle-reading, momentum-and-volume (the entry read), top-down-entry
 *   risk        a setup listed: invalidation, take-profit, position-sizing; in a prop attempt prop-challenge-pacing
 *   location    price at a key level (a reaction, a compression box at one): levels-and-reactions; a liquidity sweep
 *               (breakout-vs-fakeout); VWAP and value (vwap-volume-profile)
 *   bias        the trend rule's filter (mtf-bias-filter, the standard plan's bias skill), the day's bias (daily-bias), the last structure break (bos-vs-choch), a window refusing entries
 *               (session-timing: the opening print, lunch), and the "Trend declared?" line (trend-vs-range's
 *               "Declared yet?" part only, SECTIONS: read from the skill file at run time, never a load, so never
 *               credited)
 *
 * The skills already in the prompt (the load list, the head prompt CORE: `loaded`) are never embedded twice. Each body
 * is read from its SKILL.md at run time. A byte budget (config/runner.json prompt.situationalSkillBytes) caps the
 * embedded text, filled in stage order; a skill past it is never dropped silently: the prompt names it on an "Also
 * relevant now" line (read it with your skill tool) and the cycle record lists it (`over`). A cycle in no situation gets
 * nothing: its prompt is as before, byte for byte.
 *
 * The order gate counts the embedded skills as loaded only on the runner's attestation (FTH_CYCLE_SKILLS,
 * cycle-skills-attest.js), as it counts the head trader's embedded skills (head-prompt.js): the run's environment
 * (autotrader.js childEnv, from context.cycleSkills, the chosen skills) writes the section to the harness home and
 * attests it for its cycle; anything off, the transcript decides.
 *
 *   TABLE, STAGES, SECTIONS, SKILLS (every skill the table can embed), ATTEST_ENV ('FTH_CYCLE_SKILLS')
 *   openOf(state)                      an open position or a working entry in the account state
 *   factsOf({ state, briefings })      the table's entries that apply: [{ id, stage, facts, skills | section, why }]
 *   choose(root, facts, { budget, loaded })   { skills, sections, over, why, stages, bytes }: in stage order, in budget
 *   situationText(root, chosen)        the prompt's section ('' for none; starts with a space)
 *   sectionOf(root, section)           a skill part's text, read from the skill (null when it has no such part)
 *   writeSituation(home, root, chosen) { file, text } or null (written atomically when missing or different)
 *   attestation, parseAttestation, attested   cycle-skills-attest.js's
 */

const path = require('path');
const HP = require('./head-prompt');
const { READ_SKILL } = require('./learning/curated-moments');
// The standard plan's step skills (setup-library.js SKILL): its bias read's skill.
const setupSkill = require('./learning/setup-library').SKILL;

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = x => Array.isArray(x) && Boolean(x.length);
const m3Of = b => (isObj(b) && isObj(b.sections) && isObj(b.sections.m3) && isObj(b.sections.m3.data) ? b.sections.m3.data : null);
const entriesAllowed = m3 => isObj(m3) && m3.windowEntries === 'allowed';
const S = READ_SKILL;

/** The setup moment's reactions on the briefing's setup candle (setup-moments.js setupMoment), or []. */
function reactionsOf(b) {
  const m3 = m3Of(b);
  if (!m3 || !isObj(m3.bar) || !Number.isFinite(Date.parse(m3.bar.t))) return [];
  const { setupMoment } = require('./learning/setup-moments');
  const m = setupMoment(m3.candles, { barClose: Date.parse(m3.bar.t) + (Number(b.minutes) || 0) * 60000 });
  return m.moment ? m.reactions.filter(r => r.dir === 'up' || r.dir === 'down') : [];
}
const checksOf = b => require('./learning/setup-moments').setupChecks(m3Of(b));
const anyFvgRetest = m3 => Object.values(isObj(m3.fvgs) ? m3.fvgs : {}).some(list => Array.isArray(list) && list.some(g => isObj(g) && g.retest));

// The decision stages (trader-process's flow, condensed), in the budget's priority order: the stage being decided now
// first (management while a trade is open; the setup, its entry, then its risk and target when a setup is listed),
// then location, then bias and day context.
const STAGES = Object.freeze(['management', 'setup', 'entry', 'risk', 'location', 'bias']);
const listed = b => nonEmpty(reactionsOf(b)) || nonEmpty(checksOf(b)) || nonEmpty(m3Of(b).candidates);
/**
 * The table: each fact (`when`, on { open, state, briefings, flat }), the briefing fields it reads (`facts`: m3 keys, or
 * 'account'), its stage, and the skills that own it (from the crosswalk where it names one).
 */
const TABLE = Object.freeze([
  { id: 'open', stage: 'management', facts: ['account'], skills: ['manage-position', 'pullback-vs-reversal', S.target.target], why: 'a position or a working entry is open', when: c => c.open },
  { id: 'working', stage: 'management', facts: ['account'], skills: ['entry-outcome'], why: 'an entry is working', when: c => isObj(c.state) && nonEmpty(c.state.entryLines) },
  { id: 'leftover', stage: 'management', facts: ['account'], skills: ['leftover-orders'], why: 'flat with working orders', when: c => !c.open && isObj(c.state) && Array.isArray(c.state.positions) && Boolean(Number(c.state.workingOrders)) },
  { id: 'rejected', stage: 'setup', facts: ['candles'], skills: [S.setup.rejected], why: 'a level rejected on the Setups to check', when: c => c.flat.some(b => reactionsOf(b).some(r => r.rel === 'rejected')) },
  { id: 'broke', stage: 'setup', facts: ['candles'], skills: [S.setup.broke, S.setup.swept], why: 'a level broken on the Setups to check', when: c => c.flat.some(b => reactionsOf(b).some(r => r.rel === 'broke')) },
  { id: 'compression', stage: 'setup', facts: ['compression'], skills: [S.setup.compression], why: 'a compression break on the Setups to check', when: c => c.flat.some(b => checksOf(b).some(x => x.kind === 'compression')) },
  { id: 'cisd', stage: 'setup', facts: ['cisd'], skills: [S.setup.cisd, 'fib-retracement'], why: 'a live CISD on the Setups to check', when: c => c.flat.some(b => checksOf(b).some(x => x.kind === 'cisd')) },
  { id: 'fvg', stage: 'setup', facts: ['fvgs'], skills: [S.setup.fvg], why: 'an FVG retested', when: c => c.flat.some(b => anyFvgRetest(m3Of(b))) },
  { id: 'entry', stage: 'entry', facts: ['candles', 'candidates'], skills: [S.entry.close, S.entry.momentum, 'top-down-entry'], why: 'a setup listed: its entry read', when: c => c.flat.some(listed) },
  { id: 'risk', stage: 'risk', facts: ['candles', 'candidates'], skills: [S.stop.stop, S.target.target, 'position-sizing'], why: 'a setup listed: its stop, target and size', when: c => c.flat.some(listed) },
  { id: 'attempt', stage: 'risk', facts: ['account'], skills: ['prop-challenge-pacing'], why: 'a prop attempt sizes it', when: c => c.flat.some(listed) && isObj(c.state) && nonEmpty(c.state.attempts) },
  { id: 'level', stage: 'location', facts: ['candles', 'compression'], skills: [S.location.at], why: 'price at a key level', when: c => c.flat.some(b => nonEmpty(reactionsOf(b)) || checksOf(b).some(x => x.level)) },
  { id: 'sweep', stage: 'location', facts: ['sweeps'], skills: [S.setup.swept], why: 'a liquidity sweep', when: c => c.flat.some(b => nonEmpty(m3Of(b).sweeps)) },
  { id: 'vwap', stage: 'location', facts: ['vwap'], skills: [S.location.vwap], why: 'VWAP and value', when: c => c.flat.some(b => isObj(m3Of(b).vwap)) },
  { id: 'declared', stage: 'bias', facts: ['declared'], section: 'declared', why: 'the Trend declared? line', when: c => c.briefings.some(b => require('./trading/trend-declared').declaredLine(m3Of(b).declared)) },
  { id: 'trend', stage: 'bias', facts: ['trendRule'], skills: [setupSkill.bias], why: 'the trend rule', when: c => nonEmpty(c.flat) },
  { id: 'day', stage: 'bias', facts: ['today', 'overnight'], skills: [S.bias.priorRth], why: 'the day\'s bias', when: c => nonEmpty(c.briefings) },
  { id: 'structure', stage: 'bias', facts: ['lastBreak'], skills: [S.bias.break], why: 'the last structure break', when: c => c.briefings.some(b => isObj(m3Of(b).lastBreak) && isObj(m3Of(b).lastBreak.last)) },
  { id: 'window', stage: 'bias', facts: ['windowEntries'], skills: ['session-timing'], why: 'the window refuses entries', when: c => c.briefings.some(b => m3Of(b).windowEntries && m3Of(b).windowEntries !== 'allowed') },
].map(e => Object.freeze({ ...e, facts: Object.freeze(e.facts), ...(e.skills ? { skills: Object.freeze(e.skills) } : {}) })));
const SECTIONS = Object.freeze({ declared: Object.freeze({ skill: S.bias.regime, heading: '**Declared yet?**', intro: 'For the Trend declared? line, from your `trend-vs-range` skill' }) });
const SKILLS = Object.freeze([...new Set(TABLE.flatMap(e => e.skills || []))]);
const CA = require('./cycle-skills-attest');
const BUDGET = () => require('./tunables').runner().prompt.situationalSkillBytes; // config/runner.json

/** An open position, or a working entry with its bracket, in the account state the prompt is built from. */
function openOf(state) {
  if (!isObj(state) || state.error) return false;
  return nonEmpty(state.positions) || nonEmpty(state.entryLines);
}

/** The table's entries that apply this cycle (briefings: the cycle's symbols' bar briefings). */
function factsOf({ state = null, briefings = [] } = {}) {
  const list = (briefings || []).filter(b => m3Of(b));
  const open = openOf(state);
  const c = { open, state, briefings: list, flat: open ? [] : list.filter(b => entriesAllowed(m3Of(b))) };
  return TABLE.filter(e => { try { return e.when(c); } catch (_err) { return false; } });
}

const blockOf = (root, name) => HP.block(name, HP.skillBody(root, name));

/**
 * The skills and sections to embed: the facts in stage order, each skill once, none the cycle loads anyway (`loaded`),
 * within `budget` bytes of embedded text; a skill or section past it goes to `over` (named in the prompt, recorded).
 */
function choose(root, facts, { budget = BUDGET(), loaded = [] } = {}) {
  const out = { skills: [], sections: [], over: [], why: [], stages: [], bytes: 0 };
  const seen = new Set(loaded);
  // Strictly in order: once one doesn't fit, every later one is named, never a smaller later one in its place.
  let full = false;
  const ordered = [...facts].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
  for (const f of ordered) {
    let used = false;
    if (f.section) {
      const text = sectionOf(root, SECTIONS[f.section]);
      if (!text || out.sections.includes(f.section)) continue;
      const n = Buffer.byteLength(text);
      if (!full && out.bytes + n <= budget) { out.sections.push(f.section); out.bytes += n; used = true; } else { full = true; out.over.push(SECTIONS[f.section].skill); }
    }
    for (const name of f.skills || []) {
      if (seen.has(name)) continue;
      seen.add(name);
      let n;
      try { n = Buffer.byteLength(blockOf(root, name)); } catch (_err) { continue; }
      if (!full && out.bytes + n <= budget) { out.skills.push(name); out.bytes += n; used = true; } else { full = true; out.over.push(name); }
    }
    if (used) { out.why.push(f.why); if (!out.stages.includes(f.stage)) out.stages.push(f.stage); }
  }
  out.over = [...new Set(out.over)].filter(s => !out.skills.includes(s));
  return out;
}

/** A skill part's text: from its heading line to the next heading (or bold heading, or the file's end), or null. */
function sectionOf(root, section) {
  if (!section) return null;
  let body;
  try { body = HP.skillBody(root, section.skill).split('\n'); } catch (_err) { return null; }
  const at = body.findIndex(l => l.startsWith(section.heading));
  if (at < 0) return null;
  const end = body.findIndex((l, i) => i > at && (/^#{1,6} /.test(l) || /^\*\*[^*]+\*\*/.test(l)));
  return body.slice(at, end < 0 ? body.length : end).join('\n').trim();
}

function situationText(root, chosen) {
  const c = isObj(chosen) ? chosen : {};
  const skills = (Array.isArray(c.skills) ? c.skills : []).filter(s => SKILLS.includes(s));
  const sections = (Array.isArray(c.sections) ? c.sections : []).filter(s => SECTIONS[s]);
  const over = (Array.isArray(c.over) ? c.over : []).filter(s => typeof s === 'string' && /^[a-z0-9-]+$/.test(s));
  const why = (Array.isArray(c.why) ? c.why : []).filter(s => typeof s === 'string');
  const parts = [];
  if (skills.length) parts.push(` This cycle's situation (${why.join('; ')}) needs your skills ${HP.andList(skills)}: they are below, already loaded (don't load them again).\n\n${skills.map(s => blockOf(root, s)).join('\n\n')}\n`);
  for (const id of sections) {
    const text = sectionOf(root, SECTIONS[id]);
    if (text) parts.push(` ${SECTIONS[id].intro}:\n\n${text}\n`);
  }
  if (over.length) parts.push(` Also relevant now, read with your skill tool: ${HP.andList(over)}.`);
  return parts.join('');
}

function writeSituation(home, root, chosen) {
  const text = situationText(root, chosen);
  if (!text) return null;
  const file = CA.fileOf(home, text);
  if (HP.writeAtomic(file, text)) HP.pruneOlder(path.dirname(file), file, CA.FILE);
  return { file, text };
}

// The attestation, as the gate checks it (cycle-skills-attest.js: light, so the gate loads whatever the config holds).
module.exports = { TABLE, STAGES, SECTIONS, SKILLS, ATTEST_ENV: CA.ATTEST_ENV, openOf, factsOf, choose, sectionOf, situationText, writeSituation, attestation: CA.attestation, parseAttestation: CA.parseAttestation, attested: CA.attested };
