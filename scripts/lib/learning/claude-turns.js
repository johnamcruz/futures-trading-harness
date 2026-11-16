'use strict';

/**
 * The head trader's turn from a Claude Code run record (`-p --output-format stream-json`, the transcript the runner
 * records in each cycle file), as the same model-agnostic chat messages decision-examples.js headMessages reads from
 * opencode's: each model step one assistant message ({ content, tool_calls: [{ id, type 'function', function { name,
 * arguments } }] }), each call's result a tool message ({ tool_call_id, content }), ending in the final assistant text.
 * Texts are byte for byte; `arguments` is JSON.stringify of the call's recorded input (faithful to the parsed call).
 *
 * Faithful or nothing (null, never guessed):
 *   - only the session's own events (a subagent's, parent_tool_use_id, are not the head trader's turn);
 *   - a model step is one API message (its message id); its text blocks joined with a blank line, its thinking blocks
 *     left out (as opencode's reasoning events are); a text after a call within one message starts the next assistant
 *     message (the order is kept);
 *   - a call's result: its text (a string, or text blocks only); an error result's text too;
 *   - a deferred tool's schema load (a result of tool_reference blocks only, no text: the CLI loading a tool's
 *     definition, nothing the model read as text) is left out with its call, and counted (`omitted`): a model with its
 *     tools listed up front never makes that call; a step left with no text and no call is dropped;
 *   - the CLI's own message mid-turn (a hook's feedback: a user event marked isSynthetic, text blocks only) is a user
 *     message, its text byte for byte;
 *   - null: an event, block or system subtype of a kind it doesn't know (SYSTEM_SUBTYPES: a compacted history is not
 *     one), any other user message that isn't only tool results, a call without its id, name, object input or result,
 *     a repeated call id, a result for no open call, a result with another block (an image), an assistant event the
 *     CLI wrote itself (an API error: isApiErrorMessage, an error, a synthetic message) or one cut off (max_tokens), a
 *     run that ended in an error result, without a result event or not at end_turn, an event after the result, or a
 *     turn that doesn't end in text.
 * A call's result is its text: an error result's text too (the chat format has no error flag; opencode's errors are
 * read the same way), text blocks joined with a newline (transcript.js resultText, as opencode's are).
 * A resumed or forked session (`--resume`, `--continue`, `--fork-session`, `--from-pr` in the record's argv, or a
 * SessionStart hook of a resume or fork in its stream) continues a history the cycle record doesn't hold: no turn
 * (resumedSession). The context the session's start hooks gave the model (sessionContext: each SessionStart hook's plain
 * text output, the account and lessons briefing) is a user message before the cycle prompt; a hook that failed, started
 * and never answered, or printed JSON (its context injected in a form not recorded), gives no turn.
 *
 *   isClaudeStream(events)                 a Claude Code stream-json run (its init event and session ids)
 *   resumedSession(doc, events)            why the turn continues a session the record doesn't hold, or null
 *   claudeHeadMessages(events)             { messages, omitted } of the head trader's turn after its prompt, or null
 *   sessionContext(events)                 { texts } of its SessionStart hooks' output, in order, or { error }
 *   appendedSystemPrompt(doc, home)        { prompt } of the file the run appended to the system prompt
 *                                          (--append-system-prompt-file, read from <home>/<its folder>/<its name>,
 *                                          its content checked against the sha256 its name carries), { none: true }
 *                                          when the run appended none, else { error }
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const isObj = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const EVENT_TYPES = new Set(['system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event']);
const RESUME_FLAGS = new Set(['--resume', '-r', '--continue', '-c', '--fork-session', '--from-pr']);
// The CLI's system events the turn may hold: the session's start, its hooks, progress and retries (none the model reads,
// the start hooks' output read by sessionContext). Any other (a compacted history) gives no turn.
const SYSTEM_SUBTYPES = new Set(['init', 'hook_started', 'hook_response', 'thinking_tokens', 'notification', 'task_started', 'task_progress', 'task_updated', 'task_notification', 'api_retry', 'permission_denied']);
const RESUME_HOOK = /^SessionStart:(resume|fork)\b/;

function isClaudeStream(events) {
  if (!Array.isArray(events) || !events.length) return false;
  const init = events.find(e => isObj(e) && e.type === 'system' && e.subtype === 'init');
  return Boolean(init) && typeof init.session_id === 'string' && events.every(e => isObj(e) && EVENT_TYPES.has(e.type));
}

function resumedSession(doc, events) {
  const argv = isObj(doc) && Array.isArray(doc.argv) ? doc.argv.map(String) : [];
  const flag = argv.find(a => RESUME_FLAGS.has(a) || /^--(resume|from-pr)=/.test(a));
  if (flag) return `the run resumed a session (${flag}): its history is not in the record`;
  const hook = (events || []).find(e => isObj(e) && e.type === 'system' && typeof e.hook_name === 'string' && RESUME_HOOK.test(e.hook_name));
  return hook ? `the run's stream shows a ${hook.hook_name} hook: its history is not in the record` : null;
}

/** A tool_result's content: { text } (a string, or text blocks only), { load: true } (tool_reference blocks only), else null. */
function resultContent(content) {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content) || !content.length) return null;
  if (content.every(b => isObj(b) && b.type === 'tool_reference')) return { load: true };
  if (content.every(b => isObj(b) && b.type === 'text' && typeof b.text === 'string')) return { text: content.map(b => b.text).join('\n') };
  return null;
}

function claudeHeadMessages(events) {
  const msgs = [];
  const seen = new Set();
  const open = new Map(); // call id -> the step's call record, until its result
  let omitted = 0;
  let cur = null; // { mid, parts: [{ texts, calls }] }
  let ended = false;
  const flush = () => {
    if (!cur) return true;
    for (const part of cur.parts) {
      if (part.calls.some(c => !c.done)) return false; // a call never answered
      const calls = part.calls.filter(c => !c.load);
      omitted += part.calls.length - calls.length;
      if (!part.texts.length && !calls.length) continue;
      const m = { role: 'assistant', content: part.texts.join('\n\n') };
      if (calls.length) m.tool_calls = calls.map(c => c.call);
      msgs.push(m, ...calls.map(c => ({ role: 'tool', tool_call_id: c.call.id, content: c.text })));
    }
    cur = null;
    return true;
  };
  for (const e of events) {
    if (!isObj(e) || e.parent_tool_use_id) continue;
    if (e.type === 'system') { if (!SYSTEM_SUBTYPES.has(e.subtype)) return null; continue; }
    if (e.type === 'rate_limit_event' || e.type === 'stream_event') continue;
    if (ended) return null; // an event after the run's result
    if (e.type === 'result') {
      if (e.is_error === true || e.subtype !== 'success' || e.stop_reason !== 'end_turn' || !flush()) return null;
      ended = true;
      continue;
    }
    const message = e.message;
    // A message whose content isn't blocks (a user's plain string: an injected message) can't be read as the turn.
    if (!isObj(message) || !Array.isArray(message.content)) return null;
    if (e.type === 'assistant') {
      const mid = typeof message.id === 'string' && message.id ? message.id : null;
      // An event the CLI wrote itself (an API error shown as text) or a message cut off is not the model's turn.
      if (!mid || e.error || e.isApiErrorMessage || message.model === '<synthetic>' || message.stop_reason === 'max_tokens') return null;
      if (cur && cur.mid !== mid && !flush()) return null;
      cur = cur || { mid, parts: [{ texts: [], calls: [] }] };
      for (const b of message.content) {
        const part = cur.parts[cur.parts.length - 1];
        if (!isObj(b)) return null;
        if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
        if (b.type === 'text' && typeof b.text === 'string') {
          if (part.calls.length) cur.parts.push({ texts: [b.text], calls: [] });
          else part.texts.push(b.text);
        } else if (b.type === 'tool_use') {
          const id = typeof b.id === 'string' && b.id ? b.id : null;
          if (!id || typeof b.name !== 'string' || !b.name || !isObj(b.input) || seen.has(id)) return null;
          seen.add(id);
          const c = { call: { id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }, done: false };
          part.calls.push(c);
          open.set(id, c);
        } else return null;
      }
    } else if (e.type === 'user') {
      if (!message.content.length) return null;
      // The CLI's own message to the model mid-turn (a hook's feedback: isSynthetic, text blocks only): a user message,
      // its text byte for byte, after the step before it.
      if (e.isSynthetic === true && message.content.every(b => isObj(b) && b.type === 'text' && typeof b.text === 'string')) {
        if (open.size || !flush()) return null;
        msgs.push({ role: 'user', content: message.content.map(b => b.text).join('\n') });
        continue;
      }
      for (const b of message.content) {
        if (!isObj(b) || b.type !== 'tool_result' || !open.has(b.tool_use_id)) return null;
        const c = open.get(b.tool_use_id);
        open.delete(b.tool_use_id);
        const r = resultContent(b.content === undefined ? '' : b.content);
        if (!r) return null;
        if (r.load) c.load = true;
        else c.text = r.text;
        c.done = true;
      }
    } else return null;
  }
  if (!ended || open.size) return null;
  const last = msgs[msgs.length - 1];
  return last && last.role === 'assistant' && !last.tool_calls && last.content ? { messages: msgs, omitted } : null;
}

function sessionContext(events) {
  const texts = [];
  // A start hook that began and never answered (timed out, killed, its event lost): what it gave is unknown.
  const started = (events || []).filter(e => isObj(e) && e.type === 'system' && e.subtype === 'hook_started' && e.hook_event === 'SessionStart');
  const answered = new Set((events || []).filter(e => isObj(e) && e.type === 'system' && e.subtype === 'hook_response').map(e => e.hook_id));
  const lost = started.find(e => !answered.has(e.hook_id));
  if (lost) return { error: `the ${lost.hook_name} hook started and never answered: the context it gave is unknown` };
  for (const e of events || []) {
    if (!isObj(e) || e.type !== 'system' || e.subtype !== 'hook_response' || e.hook_event !== 'SessionStart') continue;
    if (e.exit_code !== 0 || e.outcome !== 'success' || typeof e.stdout !== 'string') return { error: `the ${e.hook_name} hook failed or printed nothing readable: the context it gave is unknown` };
    if (/^\s*[{[]/.test(e.stdout)) return { error: `the ${e.hook_name} hook printed JSON: the context it injected is not recorded as text` };
    if (e.stdout) texts.push(e.stdout);
  }
  return { texts };
}

const NAMED_SHA = /-([0-9a-f]{64})\.[a-z]+$/;
function appendedSystemPrompt(doc, home) {
  if (!(isObj(doc) && Array.isArray(doc.argv) && doc.argv.length)) return { error: 'the record has no argv: its system prompt is unknown' };
  const argv = doc.argv.map(String);
  const i = argv.indexOf('--append-system-prompt-file');
  if (argv.some(a => /^--(append-system-prompt|system-prompt|system-prompt-file)(=|$)/.test(a) || a.startsWith('--append-system-prompt-file='))) return { error: 'the run set its system prompt another way: not recorded whole' };
  if (i < 0) return { none: true };
  const named = argv[i + 1] || '';
  // Read inside the run home, by the file's folder and name (the record's absolute path is the machine's at run time).
  const file = path.join(home, path.basename(path.dirname(named)), path.basename(named));
  const m = NAMED_SHA.exec(path.basename(named));
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_err) { return { error: `the appended system prompt ${path.basename(named)} is not in the run home` }; }
  if (!m || crypto.createHash('sha256').update(text).digest('hex') !== m[1]) return { error: `the appended system prompt ${path.basename(named)} doesn't match the sha256 its name carries` };
  return { prompt: text };
}

module.exports = { SYSTEM_SUBTYPES, isClaudeStream, resumedSession, claudeHeadMessages, sessionContext, appendedSystemPrompt, resultContent };
