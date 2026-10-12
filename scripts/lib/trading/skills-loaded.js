'use strict';

/**
 * Were the trading skills loaded before an entry? A harness loads a skill
 * only when the model calls its skill tool, and its hooks get the session's
 * transcript (transcript_path), so the order gate can check that the model
 * read how to trade before it trades: trade-session (the cycle),
 * multi-timeframe-analysis (the trend rule), and strategy-library (the
 * strategy it names). Two transcript shapes are read:
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
 * A Claude subagent's transcript (…/<session>/subagents/agent-*.jsonl) is read
 * together with its session's main transcript (…/<session>.jsonl), where the
 * head trader loaded the skills before handing the order to the
 * trade-executor. Qwen Code passes a subagent's hooks the session's main
 * chat file (chats/<session>.jsonl), so it needs no pairing.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_FOR_ENTRY = ['trade-session', 'multi-timeframe-analysis', 'strategy-library'];
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
    if (!line.includes('Skill') && !line.includes('command-name') && !line.includes('"function') && !line.includes('"skill"')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    if (!ev || typeof ev !== 'object') continue;
    // opencode: one event per finished tool call.
    const part = ev.part && typeof ev.part === 'object' ? ev.part : null;
    if (ev.type === 'tool_use' && part && part.tool === 'skill' && part.state && part.state.status === 'completed'
      && part.state.input && typeof part.state.input.name === 'string') out.add(skillName(part.state.input.name));
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

/**
 * The gate's check: a message naming the skills not loaded yet, or null. No
 * transcript (a harness that passes none) -> null.
 */
function checkSkillsLoaded(transcriptPath, required = REQUIRED_FOR_ENTRY) {
  if (!transcriptPath) return null;
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
  if (!readAny) return null;
  const missing = required.filter(s => !loaded.has(s));
  return missing.length
    ? `Load the trading skills before an entry; not loaded in this session: ${missing.join(', ')}. Load each with the skill tool (they say how to read the trend, the trigger, and the strategy), then plan again.`
    : null;
}

module.exports = { REQUIRED_FOR_ENTRY, skillName, transcriptFiles, skillsInTranscript, checkSkillsLoaded };
