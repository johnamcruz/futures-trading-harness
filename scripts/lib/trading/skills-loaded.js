'use strict';

/**
 * Were the trading skills loaded before an entry? A harness loads a skill
 * only when the model calls its skill tool, and its hooks get the session's
 * transcript (transcript_path), so the order gate can check that the model
 * read how to trade before it trades: trade-session (the cycle),
 * multi-timeframe-analysis (the trend rule), strategy-library (applying the
 * strategy it names, and the priority order), strategy-scan (reading the scan)
 * and strategy-gate-checks (what the gate checks of a strategy entry): the last
 * three were one skill, strategy-library, before it was split, so an entry
 * needs what it needed before. Two transcript shapes are read:
 *
 *   - message.content[] items {type:'tool_use', name:'Skill', input:{skill}}
 *     (Claude Code), and slash commands of skills: the call counts.
 *   - message.parts[] items {functionCall:{id, name:'skill'|'Skill', args:{skill}}}
 *     in a role 'model' message (Qwen Code's chat file, chats/<session>.jsonl,
 *     which it passes as transcript_path): the call counts only once a role
 *     'user' {functionResponse:{id, name, response:{output}}} with no error
 *     answers it, since a skill that wasn't found or wasn't permitted was
 *     never read.
 *   - opencode `run --format json` events (the runner's cycle transcript,
 *     FTH_CYCLE_TRANSCRIPT): {type:'tool_use', part:{tool:'skill',
 *     state:{status:'completed', input:{name}}}}; an errored load doesn't count.
 *
 * A harness that passes no transcript (Codex) carries the skills in the
 * workspace instructions (AGENTS.md); for it the check doesn't apply.
 *
 * In index mode (the default, FTH_ROLE_SKILLS not full, opencode only) the situational skills
 * (SITUATIONAL) marked for the head trader that the bar briefing triggers are
 * required as well (the gate adds them to the list it checks), and a
 * skill_lookup in the session's transcript counts as a load.
 *
 * opencode's head trader in index mode has its per-cycle skills embedded in its prompt (head-prompt.js), never
 * loaded by a tool: the gate passes those as `embedded` (counted as loaded) only on the runner's attestation, checked
 * against the run's config file (head-prompt.js attestedSkills); without it, the transcript alone decides.
 *
 * A Claude subagent's transcript (…/<session>/subagents/agent-*.jsonl) is read
 * together with its session's main transcript (…/<session>.jsonl), where the
 * head trader loaded the skills before handing the order to the
 * trade-executor. Qwen Code passes a subagent's hooks the session's main
 * chat file (chats/<session>.jsonl), so it needs no pairing.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_FOR_ENTRY = ['trade-session', 'multi-timeframe-analysis', 'strategy-library', 'strategy-scan', 'strategy-gate-checks'];
/*
 * A trade_lifecycle (composed) entry's list in place of REQUIRED_FOR_ENTRY: no scan and no strategy fired for it, so
 * the strategy skills give way to trade-lifecycle (how to compose the trade with compose_check, and its refusals).
 */
const REQUIRED_FOR_COMPOSED = ['trade-session', 'multi-timeframe-analysis', 'trade-lifecycle'];
/*
 * Read before an entry, not every cycle (the runner's load list doesn't name them): how to judge the setup and how to
 * write its plan (trade-session steps 3 and 4). A check of its own (checkSkillsAtEntry), apart from REQUIRED_FOR_ENTRY,
 * which stays the cycle's load list.
 */
const REQUIRED_AT_ENTRY = ['setup-judgment', 'trade-plan'];

/*
 * Situational skills (index mode only, the default, FTH_ROLE_SKILLS not full: role-skills.js): when the cycle's bar briefing shows
 * the situation, the skill is read before an entry by each role whose `role-index` lists it (skill_lookup naming its
 * role during one of its calls this cycle: skill-lookups.js; a subagent's own tool calls, skill loads included, are
 * not in the session's transcript, so the harness tool records them), and, for an entry marked `head`, by the head
 * trader too (a skill load or a skill_lookup in the session's transcript). With no trigger firing, nothing more is
 * required. The triggers read the briefing's `m3` part (trading/briefing.js), a small vocabulary:
 *
 *   candidate                      a setup fired: m3.candidates is not empty
 *   candidate.trendRule=<v>        a candidate whose trendRule is v (reversal | against | allows)
 *   candidate.name=<strategy>      a candidate of that strategy
 *   candidate.blocked              a candidate blocked now (a no-entry window, a news blackout)
 *   news.inBlackout                a news blackout in force (m3.news.inBlackout)
 *   composed                       the head trader composed a trade on the bar: a compose record for the bar (m3.composed,
 *                                  added by skill-lookups.js cycleFacts from the records; never in the briefing itself)
 *   composed.relation=<rel>        a composed read of a candle's relation to a level (rejected | broke | touched)
 *
 * An entry with `taughtIn: <skill>` is the head trader's alone and is taught in that skill (which it reads before a
 * composed entry): no role's index requires it (role-skills.js requiredOf) and the head prompt doesn't list it
 * (head-prompt.js), so the requirement adds nothing to a prompt.
 */
const SITUATIONAL = [
  // A setup fired: what counts as confluence (trader-process step 5) and what proves it wrong (steps 7 and 9).
  { when: 'candidate', skill: 'confluence-counting' },
  { when: 'candidate', skill: 'invalidation' },
  // A fade at a level (a strategy with mtf: reversal): the rejection setup, and pullback or reversal (step 4).
  { when: 'candidate.trendRule=reversal', skill: 'rejection' },
  { when: 'candidate.trendRule=reversal', skill: 'pullback-vs-reversal' },
  // A with-trend setup: the breakout setup, and accepted or a fakeout (step 3).
  { when: 'candidate.trendRule=allows', skill: 'breakout' },
  { when: 'candidate.trendRule=allows', skill: 'breakout-vs-fakeout' },
  // A composed trade (trade_lifecycle) on the bar: the same reading, keyed on the head trader's own reads.
  { when: 'composed', skill: 'confluence-counting', head: true, taughtIn: 'trade-lifecycle' },
  { when: 'composed', skill: 'invalidation', head: true, taughtIn: 'trade-lifecycle' },
  { when: 'composed.relation=rejected', skill: 'rejection', head: true, taughtIn: 'trade-lifecycle' },
  { when: 'composed.relation=broke', skill: 'breakout', head: true, taughtIn: 'trade-lifecycle' },
];

const TREND_RULES = ['reversal', 'against', 'allows'];
const RELATIONS = ['rejected', 'broke', 'touched'];
const composedOf = m3 => (m3 && Array.isArray(m3.composed) ? m3.composed.filter(c => c && typeof c === 'object') : []);
const cands = m3 => (m3 && Array.isArray(m3.candidates) ? m3.candidates.filter(c => c && typeof c === 'object') : []);
const TRIGGERS = {
  candidate: { value: false, test: m3 => cands(m3).length > 0, text: () => 'a setup fired (the briefing lists a candidate)' },
  'candidate.trendRule': { value: v => TREND_RULES.includes(v), test: (m3, v) => cands(m3).some(c => c.trendRule === v), text: v => `a candidate's trendRule is ${v}` },
  'candidate.name': { value: v => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v), test: (m3, v) => cands(m3).some(c => c.name === v), text: v => `a ${v} candidate fired` },
  'candidate.blocked': { value: false, test: m3 => cands(m3).some(c => Boolean(c.blocked)), text: () => 'a candidate is blocked now (a no-entry window or a news blackout)' },
  'news.inBlackout': { value: false, test: m3 => Boolean(m3 && m3.news && m3.news.inBlackout === true), text: () => 'a news blackout is in force' },
  composed: { value: false, test: m3 => composedOf(m3).length > 0, text: () => 'you composed a trade on the bar (a compose record)' },
  'composed.relation': { value: v => RELATIONS.includes(v), test: (m3, v) => composedOf(m3).some(c => Array.isArray(c.relations) && c.relations.includes(v)), text: v => `a composed read says a candle ${v} a level` },
};

/** "candidate.trendRule=reversal" -> { key, value }; throws on anything outside the vocabulary. */
function parseTrigger(text) {
  const [key, ...rest] = String(text || '').trim().split('=');
  const value = rest.length ? rest.join('=').trim() : null;
  const t = Object.prototype.hasOwnProperty.call(TRIGGERS, key.trim()) ? TRIGGERS[key.trim()] : null;
  if (!t) throw new Error(`unknown trigger "${text}" (${Object.keys(TRIGGERS).join(', ')})`);
  if (t.value === false && value !== null) throw new Error(`trigger "${key}" takes no value`);
  if (t.value && (value === null || !t.value(value))) throw new Error(`trigger "${key}" needs a valid value (${key}=<value>)`);
  return { key: key.trim(), value };
}

const fires = (trigger, m3) => TRIGGERS[trigger.key].test(m3 || {}, trigger.value);
const describeTrigger = trigger => TRIGGERS[trigger.key].text(trigger.value);
/** Every situational skill marked for the head trader: what an entry needs when the cycle's facts can't be read. */
// By default the ones the head prompt lists (a `taughtIn` entry is a composed entry's: the gate passes the whole table then).
const headSituationalSkills = (table = SITUATIONAL.filter(e => !e.taughtIn)) => [...new Set(table.filter(e => e.head === true).map(e => e.skill))];
/** The situational skills the head trader reads whose trigger fires on m3 (entries marked `head`; no facts: none). */
const situationalSkills = (m3, table = SITUATIONAL) => [...new Set(table.filter(e => e.head === true && fires(parseTrigger(e.when), m3)).map(e => e.skill))];
const MAX_BYTES = 50 * 1024 * 1024;

/** "futures-trading-harness:trade-session" or "/trade-session" -> "trade-session". */
function skillName(raw) {
  const s = String(raw || '').trim().replace(/^\//, '');
  return s ? s.split(':').pop().split(/\s/)[0] : null;
}

/** The transcripts to read for this hook call: the given one, and its session's main one for a subagent. */
function transcriptFiles(transcriptPath) {
  const files = [transcriptPath];
  const m = /^(.*)\/([^/]+)\/subagents\/[^/]+\.jsonl$/.exec(String(transcriptPath || ''));
  if (m) files.push(path.join(m[1], `${m[2]}.jsonl`));
  return files;
}

const SKILL_TOOLS = new Set(['skill', 'Skill']);
const isId = v => typeof v === 'string' && v.length > 0;

/** A functionResponse that answers its call as loaded: an output, no error, and a successful toolCallResult when one is given. */
function loadedResponse(ev, fr) {
  const r = fr.response;
  if (!r || typeof r !== 'object' || Object.prototype.hasOwnProperty.call(r, 'error')) return false;
  if (typeof r.output !== 'string' || !r.output) return false;
  const tcr = ev.toolCallResult;
  return !(tcr && typeof tcr === 'object' && tcr.callId === fr.id && tcr.status !== 'success');
}

/** Skill names loaded in a transcript's text (skill tool calls, or slash commands of skills). */
function skillsInTranscript(text) {
  const out = new Set();
  const calls = new Map(); // parts format: unanswered functionCall id -> skill name
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('Skill') && !line.includes('command-name') && !line.includes('"function') && !line.includes('"skill"') && !line.includes('skill_lookup')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!ev || typeof ev !== 'object') continue;
    // opencode: one event per finished tool call.
    const part = ev.part && typeof ev.part === 'object' ? ev.part : null;
    if (ev.type === 'tool_use' && part && part.tool === 'skill' && part.state && part.state.status === 'completed'
      && part.state.input && typeof part.state.input.name === 'string') out.add(skillName(part.state.input.name));
    // A whole skill read with the harness tool skill_lookup (index mode): read as a load. Only a reply that is the
    // skill (its <skill name=...> text): a refusal or a catalog listing (no skill) read nothing.
    if (ev.type === 'tool_use' && part && /(^|_)skill_lookup$/.test(String(part.tool || '')) && part.state && part.state.status === 'completed'
      && part.state.input && typeof part.state.input.skill === 'string'
      && typeof part.state.output === 'string' && part.state.output.trimStart().startsWith('<skill name=')) out.add(skillName(part.state.input.skill));
    const msg = ev.message && typeof ev.message === 'object' ? ev.message : {};
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const c of content) if (c && c.type === 'tool_use' && c.name === 'Skill') out.add(skillName(c.input && (c.input.skill || c.input.command)));
    }
    // A slash command the user typed (/trade-session): its skill text is in the session.
    const text2 = typeof content === 'string' ? content : '';
    for (const mm of text2.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) out.add(skillName(mm[1]));
    // Parts format: the model's skill call, and the tool's answer to it.
    for (const p of Array.isArray(msg.parts) ? msg.parts : []) {
      const fc = p && typeof p === 'object' ? p.functionCall : null;
      const fr = p && typeof p === 'object' ? p.functionResponse : null;
      if (msg.role === 'model' && fc && typeof fc === 'object' && SKILL_TOOLS.has(fc.name) && isId(fc.id)
        && fc.args && typeof fc.args === 'object' && typeof fc.args.skill === 'string') calls.set(fc.id, skillName(fc.args.skill));
      // Resolved when answered: a provider may reuse an id on a later turn (call_0), so an answer belongs to the call before it.
      if (msg.role === 'user' && fr && typeof fr === 'object' && SKILL_TOOLS.has(fr.name) && isId(fr.id) && calls.has(fr.id)) {
        if (loadedResponse(ev, fr)) out.add(calls.get(fr.id));
        calls.delete(fr.id);
      }
    }
  }
  out.delete(null);
  return out;
}

/** The skills loaded in this hook call's transcripts (transcriptFiles), or null when none could be read. */
function loadedSkills(transcriptPath) {
  const loaded = new Set();
  let readAny = false;
  for (const file of transcriptFiles(transcriptPath)) {
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const len = Math.min(st.size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      fs.closeSync(fd);
      for (const s of skillsInTranscript(buf.toString('utf8'))) loaded.add(s);
      readAny = true;
    } catch (_err) {
      // missing or unreadable: the other file may still have them
    }
  }
  return readAny ? loaded : null;
}

/**
 * The gate's check: a message naming the skills not loaded yet, or null. No
 * transcript (a harness that passes none) -> null.
 */
function checkSkillsLoaded(transcriptPath, required = REQUIRED_FOR_ENTRY, embedded = []) {
  if (!transcriptPath) return null;
  const loaded = loadedSkills(transcriptPath);
  if (!loaded) return null;
  const missing = required.filter(s => !loaded.has(s) && !embedded.includes(s));
  return missing.length
    ? `Load the trading skills before an entry; not loaded in this session: ${missing.join(', ')}. Load each with the skill tool (or skill_lookup, without one; they say how to read the trend, the trigger, and the strategy), then plan again.`
    : null;
}

/**
 * The gate's entry check (REQUIRED_AT_ENTRY): a message naming the skills not read yet, or null. A load counts as for
 * REQUIRED_FOR_ENTRY (the skill tool, or a skill_lookup). No transcript (a harness that passes none) -> null, as
 * there; a transcript named but unreadable -> refused (fails closed).
 */
function checkSkillsAtEntry(transcriptPath, required = REQUIRED_AT_ENTRY, embedded = []) {
  if (!transcriptPath) return null;
  const loaded = loadedSkills(transcriptPath);
  if (!loaded) return `The session's transcript can't be read, so the gate can't see ${required.join(' and ')} read before this entry: no entry. Exits and stops still go.`;
  const missing = required.filter(s => !loaded.has(s) && !embedded.includes(s));
  return missing.length
    ? `Read how to judge the setup and write its plan before an entry; not read in this session: ${missing.join(', ')}. Load each (your skill tool, or skill_lookup), decide and plan by them, then plan again. Exits and stops still go.`
    : null;
}

module.exports = { REQUIRED_FOR_ENTRY, REQUIRED_FOR_COMPOSED, REQUIRED_AT_ENTRY, SITUATIONAL, TRIGGERS, parseTrigger, fires, describeTrigger, situationalSkills, headSituationalSkills, skillName, transcriptFiles, skillsInTranscript, loadedSkills, checkSkillsLoaded, checkSkillsAtEntry };
