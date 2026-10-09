'use strict';

/**
 * Were the trading skills loaded before an entry? Claude Code loads a skill
 * only when the model calls the Skill tool, and its hooks get the session's
 * transcript (transcript_path), so the order gate can check that the model
 * read how to trade before it trades: trade-session (the cycle),
 * multi-timeframe-analysis (the trend rule), and strategy-library (the
 * strategy it names). Codex and Qwen Code carry the skills in the workspace
 * instructions (AGENTS.md / QWEN.md) and pass no Claude transcript, so for
 * them the check doesn't apply.
 *
 * A subagent's transcript (…/<session>/subagents/agent-*.jsonl) is read
 * together with its session's main transcript (…/<session>.jsonl), where the
 * head trader loaded the skills before handing the order to the
 * trade-executor.
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

/** Skill names loaded in a transcript's text (Skill tool calls, or slash commands of skills). */
function skillsInTranscript(text) {
  const out = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('Skill') && !line.includes('command-name')) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_err) { continue; }
    const content = ev && ev.message && ev.message.content;
    if (Array.isArray(content)) {
      for (const c of content) if (c && c.type === 'tool_use' && c.name === 'Skill') out.add(skillName(c.input && (c.input.skill || c.input.command)));
    }
    // A slash command the user typed (/trade-session): its skill text is in the session.
    const text2 = typeof content === 'string' ? content : '';
    for (const mm of text2.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) out.add(skillName(mm[1]));
  }
  out.delete(null);
  return out;
}

/**
 * The gate's check: a message naming the skills not loaded yet, or null. No
 * transcript (another harness, or none passed) -> null.
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
    ? `Load the trading skills before an entry; not loaded in this session: ${missing.join(', ')}. Call the Skill tool for each (they say how to read the trend, the trigger, and the strategy), then plan again.`
    : null;
}

module.exports = { REQUIRED_FOR_ENTRY, skillName, transcriptFiles, skillsInTranscript, checkSkillsLoaded };
