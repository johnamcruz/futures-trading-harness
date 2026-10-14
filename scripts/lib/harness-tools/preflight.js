'use strict';

/**
 * The runner's start check of the harness-tools server (scripts/autotrader.js,
 * live and --once): start this checkout's server (scripts/harness-tools-mcp.js)
 * with the cycles' environment and compare its tools/list with the registry
 * (registry.js). It catches a server that doesn't start or answer (a broken
 * checkout, a module that fails to load, a Node too old) and one that offers
 * other tools. It does not read which server each harness's own settings
 * register as `harness` (the installer writes those; check-headless.js probes
 * them for real).
 *
 * On a failure (startPreflight): a manual trade or premarket run is refused; a
 * manual end of day only warns (flattening needs only the broker); the live
 * loop turns trading off with the kill switch and keeps running, so end of day,
 * the catch-up of a missed one, and housekeeping still flatten and cancel.
 *
 *   compareTools(got, want)                     -> [problem]
 *   roleSkillsMismatch(root, env, harness)      an opencode run's opencode.json not generated for its FTH_ROLE_SKILLS, or null
 *   checkToolsServer({ root, env, harness, timeoutMs })  resolves, or rejects with what is wrong
 *   startPreflight({ root, env, harness, once, killSwitchFile, warn, check })
 */

const fs = require('fs');

const path = require('path');
const { createMcpClient } = require('../broker/mcp-client');
const { listTools } = require('./registry');

/** What differs between a server's tools/list and the registry's tools: [problem], empty when they match. */
function compareTools(got, want = listTools()) {
  const problems = [];
  const byName = new Map((Array.isArray(got) ? got : []).map(t => [t && t.name, t]));
  for (const t of want) {
    const g = byName.get(t.name);
    if (!g) problems.push(`missing ${t.name}`);
    else if (JSON.stringify(g.inputSchema) !== JSON.stringify(t.inputSchema)) problems.push(`${t.name}: a different argument schema`);
    else if (g.description !== t.description) problems.push(`${t.name}: a different description`);
  }
  const known = new Set(want.map(t => t.name));
  for (const name of byName.keys()) if (!known.has(name)) problems.push(`unexpected tool ${String(name).slice(0, 64)}`);
  return problems;
}

/**
 * An opencode run (`harness`, the runner config's; FTH_ROLE_SKILLS set by the runner, PWD its directory): its
 * opencode.json must be the one generated for that mode (role-skills.js), else the role prompts and the gate's lookup
 * check disagree. null when it is, or when the run is another harness's (the runner sets full for those).
 */
const INDEX_MARK = '## Your skill index'; // opencode.js indexPrompt's heading: a role prompt in index mode
function roleSkillsMismatch(root, env = {}, harness = null) {
  if (harness !== 'opencode' || env.FTH_ROLE_SKILLS === undefined || !env.PWD) return null;
  const mode = require('../role-skills').modeOf(env);
  const generated = m => require('../harness-sync').expectedFiles(root, { mode: m })['workspace/opencode.json'];
  let got = null;
  try { got = fs.readFileSync(path.join(env.PWD, 'opencode.json'), 'utf8'); } catch (_err) { /* missing */ }
  // Full (on request): only a workspace with index-mode role prompts is refused (its roles would skip lookups the gate
  // doesn't check), whatever checkout generated it. Index (the default): exactly the index-mode file.
  const bad = mode === 'full' ? got !== null && got.includes(INDEX_MARK) : got !== generated('index');
  return bad ? `${path.join(env.PWD, 'opencode.json')} is not the one generated for FTH_ROLE_SKILLS=${mode}: run FTH_ROLE_SKILLS=${mode} node scripts/sync-harness.js (the committed file is index)` : null;
}

async function checkToolsServer({ root, env = process.env, harness = null, timeoutMs = 15000, command = process.execPath, args = null } = {}) {
  const script = path.join(root, 'scripts', 'harness-tools-mcp.js');
  const client = createMcpClient({ command, args: args || [script], env, timeoutMs, clientName: 'fth-runner-preflight' });
  let tools;
  try {
    tools = await client.listTools();
  } catch (err) {
    throw new Error(`the harness tools server (${script}) did not answer tools/list: ${err.message}`, { cause: err });
  } finally {
    client.close();
  }
  const mismatch = roleSkillsMismatch(root, env, harness);
  if (mismatch) throw new Error(mismatch);
  const problems = compareTools(tools);
  if (problems.length) {
    throw new Error(`the harness tools server (${script}) does not offer the harness's tools (${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}); update the checkout and re-run the installer`);
  }
  return tools.length;
}

async function startPreflight({ root, env, harness = null, once = null, killSwitchFile, warn = s => process.stderr.write(s), check = checkToolsServer }) {
  try {
    await check({ root, env, harness });
    return 'ok';
  } catch (err) {
    if (once && once !== 'eod') throw err;
    if (once === 'eod') {
      warn(`[autotrader] warning: ${err.message}\n`);
      return 'warned';
    }
    // Appended, as the workspace guard does: a kill switch already on keeps its other reasons.
    // If even that fails, the start fails (trading can't be turned off, so it doesn't start).
    fs.mkdirSync(path.dirname(killSwitchFile), { recursive: true });
    fs.appendFileSync(killSwitchFile, `${err.message}. Fix it, then remove this file to resume trading.\n`);
    warn(`[autotrader] ${err.message}: trading is off (kill switch ${killSwitchFile}); end of day and housekeeping still run\n`);
    return 'kill-switch';
  }
}

module.exports = { compareTools, roleSkillsMismatch, checkToolsServer, startPreflight };
