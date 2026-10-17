'use strict';

/**
 * The tool-call pipeline (docs/TOOL-CALLS-AND-ORCHESTRATION.md, "The pipeline"): every rule that matches a call, in
 * the registry's order (rules.js), before it runs and after it returned. Before: repairs change the arguments, the
 * first refusal is final (no later rule turns it into an allowance), a rule that throws refuses only when it declares
 * failClosed (else it is passed over). After: every matching rule runs; its notes are joined.
 *
 *   createPipeline({ rules, log, env, now, native })
 *     before(call) -> { refuse: text | null }    call: { tool, name, args, session, id }; args may be repaired in place
 *     after(call, result) -> { note: text | null }   result: { text }
 *   log: call-log.js; native(canonical): the name the model calls (names.js toOpencode / toClaude)
 */

const { RULES } = require('./rules');

function createPipeline({ rules = RULES, log, env = process.env, now = () => Date.now(), native = n => n } = {}) {
  if (!log || typeof log.state !== 'function') throw new TypeError('toolcall: a call log is required');
  const ctx = (rule, call, result) => ({ state: log.state(rule.state || rule.id, call.session), env, now, native, result });
  const runs = (event, call) => rules.filter(r => r.event === event && typeof call.tool === 'string' && r.match(call));
  return {
    before(call) {
      try {
        for (const rule of runs('pre', call)) {
          let out;
          try {
            out = rule.check(call, ctx(rule, call, null));
          } catch (err) {
            if (rule.failClosed) return { refuse: `[${rule.id}] the check failed (${err && err.message ? err.message : err}): refused (it fails closed).` };
            continue;
          }
          if (out && typeof out.refuse === 'string') return { refuse: out.refuse };
        }
        return { refuse: null };
      } finally {
        log.save();
      }
    },
    after(call, result = {}) {
      const notes = [];
      try {
        for (const rule of runs('post', call)) {
          try {
            const out = rule.check(call, ctx(rule, call, result));
            if (out && typeof out.note === 'string') notes.push(out.note);
          } catch (_err) { /* a post rule that throws adds nothing */ }
        }
      } finally {
        log.save();
      }
      return { note: notes.length ? notes.join('\n') : null };
    },
  };
}

module.exports = { createPipeline };
