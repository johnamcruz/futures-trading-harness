'use strict';

/**
 * Tool names as the tool-call layer's rules match them (docs/TOOL-CALLS-AND-ORCHESTRATION.md): one canonical name per
 * tool, whatever the harness calls it. A harness or broker tool is `<server>.<tool>` (`harness.compose_check`,
 * `broker.place_order`); a harness's own tool is its lowercase name (`task`, `invalid`, `read`). Each adapter turns its
 * harness's names into canonical ones, and back for a route a refusal names.
 *
 *   fromOpencode(name)      opencode names a server's tool `<server>_<tool>` (opencode.js permissionKeys)
 *   toOpencode(canonical)   the name the model calls there
 *   fromClaude(name)        Claude Code names it `mcp__<server>__<tool>`; its role launch is `Task` or `Agent`
 *   toClaude(canonical)
 */

const { SERVER_NAME: BROKER_SERVER } = require('../broker/config');
const { SERVER_NAME: HARNESS_SERVER } = require('../harness-tools/registry');

const SERVERS = Object.freeze([HARNESS_SERVER, BROKER_SERVER]);

function fromOpencode(name) {
  const n = String(name || '');
  for (const s of SERVERS) if (n.startsWith(`${s}_`)) return `${s}.${n.slice(s.length + 1)}`;
  return n.toLowerCase();
}

function toOpencode(canonical) {
  const [s, ...rest] = String(canonical || '').split('.');
  return rest.length && SERVERS.includes(s) ? `${s}_${rest.join('.')}` : String(canonical || '');
}

function fromClaude(name) {
  const n = String(name || '');
  const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(n);
  if (m) return `${m[1]}.${m[2]}`;
  if (n === 'Task' || n === 'Agent') return 'task';
  return n.toLowerCase();
}

function toClaude(canonical) {
  const [s, ...rest] = String(canonical || '').split('.');
  return rest.length && SERVERS.includes(s) ? `mcp__${s}__${rest.join('.')}` : String(canonical || '');
}

module.exports = { SERVERS, BROKER_SERVER, HARNESS_SERVER, fromOpencode, toOpencode, fromClaude, toClaude };
