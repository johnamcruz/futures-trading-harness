'use strict';

/**
 * Tool names as the tool-call layer's rules match them (docs/TOOL-CALLS-AND-ORCHESTRATION.md): one canonical name per
 * tool, whatever the harness calls it. A harness or broker tool is `<server>.<tool>` (`harness.compose_check`,
 * `broker.place_order`); a harness's own tool is its lowercase name (`task`, `invalid`, `read`). Each adapter turns its
 * harness's names into canonical ones, and back for a route a refusal names.
 *
 *   fromOpencode(name)      opencode names a server's tool `<server>_<tool>` (opencode.js permissionKeys)
 *   toOpencode(canonical)   the name the model calls there
 *   fromClaude(name)        Claude Code names it `mcp__<server>__<tool>` (a plugin's `mcp__plugin_<p>_<server>__<tool>`);
 *                           its role launch is `Task` or `Agent`
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
  // `mcp__<server>__<tool>`, or a plugin's `mcp__plugin_<plugin>_<server>__<tool>` (the order gate's matcher takes both).
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (m) {
    // Only the server itself, or a plugin's `plugin_<p>_<server>`: another server merely ending in `_harness` isn't ours.
    const server = SERVERS.find(s => m[1] === s || new RegExp(`^plugin_[a-z0-9-]+_${s}$`).test(m[1])) || m[1];
    return `${server}.${m[2]}`;
  }
  if (n === 'Task' || n === 'Agent') return 'task';
  return n.toLowerCase();
}

function toClaude(canonical) {
  const [s, ...rest] = String(canonical || '').split('.');
  return rest.length && SERVERS.includes(s) ? `mcp__${s}__${rest.join('.')}` : String(canonical || '');
}

module.exports = { SERVERS, BROKER_SERVER, HARNESS_SERVER, fromOpencode, toOpencode, fromClaude, toClaude };
