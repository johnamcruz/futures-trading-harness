'use strict';

/**
 * Which of the tool-call layer's events the canonical hooks declare (hooks/hooks.json): the rules run on an event only
 * where hooks.json has its entry, whose command runs the dispatcher (scripts/hooks/toolcall.js). Each harness's adapter
 * reads this: Claude Code runs the entries itself; the opencode plugin runs the same rules in-process for them.
 *
 *   EVENTS                     { pre: 'PreToolUse', post: 'PostToolUse' }
 *   DISPATCHER                 the dispatcher script's path, as an entry's command names it
 *   declaredEvents(root)       a Set of 'pre' / 'post'; empty when hooks.json can't be read (no rules run)
 */

const fs = require('fs');
const path = require('path');

const EVENTS = Object.freeze({ pre: 'PreToolUse', post: 'PostToolUse' });
const DISPATCHER = 'scripts/hooks/toolcall.js';

function declaredEvents(root) {
  let hooks;
  try {
    hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks || {};
  } catch (_err) {
    return new Set();
  }
  const out = new Set();
  for (const [event, name] of Object.entries(EVENTS)) {
    const entries = Array.isArray(hooks[name]) ? hooks[name] : [];
    if (entries.some(e => (e.hooks || []).some(h => typeof h.command === 'string' && h.command.includes(DISPATCHER)))) out.add(event);
  }
  return out;
}

module.exports = { EVENTS, DISPATCHER, declaredEvents };
