'use strict';

/**
 * The harness-tools MCP server's protocol (scripts/harness-tools-mcp.js):
 * JSON-RPC 2.0 over newline-delimited stdio, the MCP stdio transport, for any
 * MCP client. Methods: initialize, notifications/initialized, ping,
 * tools/list, tools/call; anything else is -32601. Batches (JSON arrays) are
 * refused, and so is a line over 1 MB. Notifications get no reply, and a
 * tools/call sent as a notification is not run (nobody would see its result).
 *
 * A tool call runs its operation (index.js OPERATIONS) with the server's
 * launch environment (bars_fetch also loads the user's .env into a copy, as
 * scripts/bars.js does) and the harness clock (harnessNow, read per call), after
 * its arguments, with numbers and booleans sent as strings repaired (repair.js),
 * pass the tool's schema (registry.js, validate.js) and its bars
 * files pass paths.js. The result is the CLI's output: the text it prints on
 * stdout with the operation's stderr notes appended; a failure is isError
 * with the stdout printed before it and `[<script>] <message>`, as the CLI
 * prints it. Invalid arguments are an isError result too, not a protocol
 * error. Over 256 KB the result is refused (isError, saying how to narrow
 * it), never truncated. Tool calls run one at a time, in order.
 *
 * createServer({ env, root, write, call }) -> { handleLine(line), oversize(), idle() }   (call: callTool, replaceable in tests)
 * callTool(name, input, { env, root }) -> MCP tool result
 * boundedLines(onLine, onOversize, max) -> { push(chunk), flush() }
 */

const { lineSplitter } = require('../trading/mcp-gateway');
const { harnessNow } = require('../trading/harness-now');
const { OPERATIONS } = require('./index');
const { OpError, ROOT } = require('./cli');
const { SERVER_NAME, BY_NAME, listTools } = require('./registry');
const { validate } = require('./validate');
const { repair } = require('./repair');
const { barsFile } = require('./paths');
const { loadEnvFiles } = require('../env-file');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const VERSION = '1';
const MAX_ERRORS = 10; // an invalid call's reply names the first few problems, never thousands

const result = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

/** Run one tool; never throws (a failure is an isError result). */
async function callTool(name, input, { env = process.env, root = ROOT } = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) return result(`[harness] unknown tool: ${String(name).slice(0, 64)}`, true);
  // A number or boolean sent as a string ("3", "true") becomes what the schema declares, then is validated as usual (repair.js).
  const given = repair(tool.inputSchema, input === undefined ? {} : input);
  const errors = validate(tool.inputSchema, given);
  if (errors.length) {
    const more = errors.length > MAX_ERRORS ? `; and ${errors.length - MAX_ERRORS} more` : '';
    return result(`[harness] invalid arguments for ${tool.name}: ${errors.slice(0, MAX_ERRORS).join('; ')}${more}\n`, true);
  }
  // The .env credentials only where the CLI loads them (bars.js: the broker's settings), on a copy.
  let notes = '';
  const barsEnv = env; // the bars directories: the server's own environment, never one a .env file filled in
  if (tool.envFile) {
    env = { ...env };
    notes = loadEnvFiles({ env }).warnings.map(w => `[${tool.script}] warning: ${w}\n`).join('');
  }
  const checked = { ...given };
  for (const k of tool.bars || []) {
    if (given[k] === undefined) continue;
    const r = barsFile(given[k], { env: barsEnv });
    if (r.error) return result(`[harness] ${k}: ${r.error}\n`, true);
    checked[k] = r.file;
  }
  let text;
  let isError;
  try {
    if (tool.clockFirst) harnessNow(env); // as the CLI does: a refused replay clock refuses the call
    const r = await OPERATIONS[tool.op](tool.args(checked), { env, barsEnv, root, tool: true, now: () => harnessNow(env) });
    text = `${r.text || ''}${r.stderr || ''}${notes}`;
    isError = Boolean(r.code);
  } catch (err) {
    text = `${(err instanceof OpError && err.text) || ''}${notes}[${tool.script}] ${(err && err.message) || String(err)}\n`;
    isError = true;
  }
  // Measured as it goes out: JSON-encoded in the reply (quotes, newlines and control characters grow).
  const bytes = Buffer.byteLength(JSON.stringify(text));
  if (bytes > MAX_OUTPUT_BYTES) {
    return result(`[harness] ${tool.name}: the output is ${Math.ceil(bytes / 1024)} KB, over the ${MAX_OUTPUT_BYTES / 1024} KB a reply may carry, so none of it is returned (anything the call records was recorded). Narrow it: ${tool.narrow}.\n`, true);
  }
  return result(text, isError);
}

/** Complete lines to onLine; a line over `max` bytes (its line ending not counted) is dropped whole and reported with onOversize(). */
function boundedLines(onLine, onOversize, max = MAX_LINE_BYTES) {
  const lines = lineSplitter(onLine);
  let parts = [];
  let size = 0;
  let dropping = false;
  const end = () => {
    const line = parts.join('');
    if (dropping || Buffer.byteLength(line.replace(/\r?\n$|\r$/, '')) > max) onOversize();
    else lines.push(line.endsWith('\n') ? line : `${line}\n`);
    parts = [];
    size = 0;
    dropping = false;
  };
  return {
    push(chunk) {
      let rest = String(chunk);
      while (rest.length) {
        const i = rest.indexOf('\n');
        const seg = i === -1 ? rest : rest.slice(0, i + 1);
        rest = i === -1 ? '' : rest.slice(i + 1);
        if (!dropping) {
          size += Buffer.byteLength(seg);
          // Memory stays bounded: past the limit plus a line ending, stop keeping it.
          if (size > max + 2) { dropping = true; parts = []; } else parts.push(seg);
        }
        if (i !== -1) end();
      }
    },
    flush() {
      if (dropping || parts.length) end();
    },
  };
}

const validId = id => (typeof id === 'string' && id.length <= 256) || (typeof id === 'number' && Number.isFinite(id));

function createServer({ env = process.env, root = ROOT, write, call = callTool }) {
  let queue = Promise.resolve();
  const error = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });
  const reply = (id, res) => write({ jsonrpc: '2.0', id, result: res });

  function handle(msg) {
    if (msg === null || typeof msg !== 'object') return error(null, -32600, 'invalid request: not a JSON-RPC object');
    if (Array.isArray(msg)) return error(null, -32600, 'invalid request: batches are not supported; send one request per line');
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    if (hasId && !validId(msg.id)) return error(null, -32600, 'invalid request: id must be a string (at most 256 characters) or a number');
    if (typeof msg.method !== 'string') {
      // A response to nothing (the server sends no requests): ignore it.
      if (!hasId || (msg.jsonrpc === '2.0' && ('result' in msg || 'error' in msg))) return undefined;
      return error(msg.id, -32600, 'invalid request: no method');
    }
    if (msg.jsonrpc !== '2.0') return hasId ? error(msg.id, -32600, 'invalid request: jsonrpc must be "2.0"') : undefined;
    if (!hasId) return undefined; // a notification: notifications/initialized and the rest need no reply
    const { id, method } = msg;
    const params = msg.params === undefined ? {} : msg.params;
    if (params === null || typeof params !== 'object' || Array.isArray(params)) return error(id, -32602, 'invalid params: an object');
    if (method === 'initialize') {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
        instructions: 'The futures trading harness\'s own operations (strategies, bars, market snapshot, multi-timeframe read, blackouts, prop challenge status, lessons, reconcile). None places or changes an order.',
      });
    }
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: listTools() });
    if (method === 'tools/call') {
      if (typeof params.name !== 'string' || !BY_NAME.has(params.name)) return error(id, -32602, `unknown tool: ${String(params.name).slice(0, 64)}`);
      const run = () => call(params.name, params.arguments, { env, root })
        .catch(err => result(`[harness] ${err && err.message}\n`, true))
        .then(res => reply(id, res));
      queue = queue.then(run, run);
      return queue;
    }
    return error(id, -32601, `method not found: ${method.slice(0, 64)}`);
  }

  return {
    handleLine(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_err) {
        return error(null, -32700, 'parse error: not JSON');
      }
      return handle(msg);
    },
    oversize: () => error(null, -32600, `invalid request: a line over ${MAX_LINE_BYTES / 1024 / 1024} MB is refused`),
    idle: () => queue,
  };
}

module.exports = { PROTOCOL_VERSIONS, MAX_LINE_BYTES, MAX_OUTPUT_BYTES, callTool, boundedLines, createServer };
