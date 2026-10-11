'use strict';

/**
 * The opencode (opencode.ai, 1.x) adapter, generated from the canonical tree
 * like the others (harness-sync.js), and what the runner adds per run.
 *
 *   workspace/opencode.json   the project config opencode loads when it runs in
 *                             workspace/: the `broker` (gateway) and `harness`
 *                             MCP servers, the skills folder, every role as a
 *                             subagent with its own permissions, opencode's
 *                             built-in agents disabled, and the main session's
 *                             permissions. No provider or model: those are the
 *                             user's (their global opencode config).
 *
 * Paths come from FTH_ROOT ({env:FTH_ROOT}, which opencode substitutes and the
 * runner always sets), so the file is the same on every machine and in a
 * replay's copied workspace; without FTH_ROOT the servers don't start (fails
 * closed). The roles live in this one file, not in `.opencode/agents/`:
 * opencode installs npm packages (running that folder's package.json) into
 * every `.opencode/` folder it loads, which a run could plant and the
 * workspace guard couldn't tell from opencode's own writes; with no such
 * folder, the guard fingerprints `.opencode/` as absent (harness-run.js).
 *
 * Permissions (opencode: the last matching rule wins, anything not allowed is
 * refused in a headless run): everything denied first, then what the other
 * adapters allow an autonomous session (autotrader.js claudeTools): the broker
 * and harness tools (orders go through the gateway's gate), skills, the
 * harness's roles as subagents, reading (never a .env), and web search. No
 * shell, no edits, and no web fetch (opencode can't limit it to the calendar
 * sites, so it is off). Each role starts from everything denied and gets its
 * own tools only, so only trade-executor holds order tools. Reading outside
 * the project is denied in the file; the runner allows the harness root, the
 * bar directory, the runner's logs and the bars scratch directory per run
 * (OPENCODE_CONFIG_CONTENT, runConfig), as Claude's allowlist does, and sets
 * the session's permissions there again, so a run never depends on finding
 * the project file. It names the directory (--dir, and PWD): opencode reads
 * its project from PWD, not the process's working directory.
 *
 *   permissionKeys(tools)        a role's Claude tool names as opencode permission keys
 *   agentConfig(agent)           a role as an opencode agent entry
 *   workspaceConfig(agents)      workspace/opencode.json's object
 *   runConfig({ ... })           the per-run config (OPENCODE_CONFIG_CONTENT)
 *   runEnv(base, { ... })        the run's environment for opencode
 *   denyTools(env, keys, roles)  the run's environment with tools denied everywhere (the headless probe)
 */

const { SERVER_NAME: BROKER_SERVER } = require('./broker/config');
const { SERVER_NAME: HARNESS_SERVER } = require('./harness-tools/registry');
const { scratchDir } = require('./bars-fetch');

const SCHEMA = 'https://opencode.ai/config.json';
/** opencode's built-in agents; the harness's roles replace them. */
const BUILTIN_AGENTS = ['general', 'explore', 'plan'];
/** Reading anything but a .env (credentials). */
const READ = { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny' };
/** Permissions denied by name too, so no rule in the user's global config placed after a shared "*" re-allows them. */
const DENIED = ['bash', 'edit', 'webfetch', 'external_directory', 'question', 'lsp', 'codesearch', 'plan_enter', 'plan_exit'];

/**
 * Claude tool names as opencode permission keys. MCP tools are `<server>_<tool>`. Bash, Write, Edit
 * and WebFetch map to nothing: no autonomous allowlist gives a session or a role a shell or edits,
 * and opencode can't limit web fetches to the calendar sites.
 */
const TOOL_KEYS = {
  Read: ['read', 'list'], Grep: ['grep'], Glob: ['glob'], Skill: ['skill'], WebSearch: ['websearch'],
  Bash: [], Write: [], Edit: [], WebFetch: [],
};

function permissionKeys(tools) {
  const keys = [];
  for (const t of tools) {
    const m = /^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.exec(t);
    if (m && [BROKER_SERVER, HARNESS_SERVER].includes(m[1])) keys.push(`${m[1]}_${m[2]}`);
    else if (TOOL_KEYS[t]) keys.push(...TOOL_KEYS[t]);
    else throw new Error(`no opencode permission for the tool "${t}": map it in scripts/lib/opencode.js`);
  }
  return [...new Set(keys)];
}

/** A role's permissions: everything denied, then its own tools. */
function agentPermission(tools) {
  const permission = { '*': 'deny' };
  for (const k of permissionKeys(tools)) permission[k] = k === 'read' ? { ...READ } : 'allow';
  return permission;
}

function agentConfig(agent, generated = '') {
  return {
    description: agent.description,
    mode: 'subagent',
    prompt: `${generated ? `${generated}\n\n` : ''}${agent.body}\n`,
    permission: agentPermission(agent.tools),
  };
}

/** The main session's permissions (claudeTools' equivalent), with the roles it may delegate to. */
function sessionPermission(roles) {
  return {
    '*': 'deny',
    ...Object.fromEntries(DENIED.map(k => [k, 'deny'])),
    read: { ...READ }, glob: 'allow', grep: 'allow', list: 'allow',
    skill: 'allow', todowrite: 'allow', websearch: 'allow',
    task: { '*': 'deny', ...Object.fromEntries(roles.map(r => [r, 'allow'])) },
    // Orders go through the gateway, which enforces the order gate on every call.
    [`${BROKER_SERVER}_*`]: 'allow',
    [`${HARNESS_SERVER}_*`]: 'allow',
  };
}

const server = script => ({ type: 'local', command: ['node', `{env:FTH_ROOT}/scripts/${script}`], enabled: true, timeout: 60000 });

function workspaceConfig(agents, generated = '') {
  return {
    $schema: SCHEMA,
    autoupdate: false,
    share: 'disabled',
    mcp: {
      // The gateway starts the broker MCP server named in the broker config and enforces the order gate.
      [BROKER_SERVER]: server('mcp-gateway.js'),
      // The harness's own operations as tools (no order tools).
      [HARNESS_SERVER]: server('harness-tools-mcp.js'),
    },
    skills: { paths: ['{env:FTH_ROOT}/skills'] },
    agent: {
      ...Object.fromEntries(BUILTIN_AGENTS.map(a => [a, { disable: true }])),
      ...Object.fromEntries(agents.map(a => [a.name, agentConfig(a, generated)])),
    },
    permission: sessionPermission(agents.map(a => a.name)),
  };
}

/** Directories outside the project a run may read, as opencode's external_directory rules. */
function externalDirs({ root, dataDir, stateDir }) {
  const dirs = [root, dataDir, `${stateDir}/logs`, scratchDir({ FTH_HOME: stateDir })];
  return { '*': 'deny', ...Object.fromEntries(dirs.map(d => [`${String(d).replace(/\/+$/, '')}/*`, 'allow'])) };
}

/**
 * The per-run config: the session's permissions again (so a run whose directory has no opencode.json,
 * or another one, is still locked down: merged last, they replace the project's in place), reading
 * the runner's directories for the session and every role.
 */
function runConfig({ root, dataDir, stateDir, roles }) {
  const external = externalDirs({ root, dataDir, stateDir });
  return {
    permission: { ...sessionPermission(roles), external_directory: external },
    agent: Object.fromEntries(roles.map(r => [r, { permission: { external_directory: { ...external } } }])),
  };
}

/**
 * Variables opencode reads that would change what a run may do: an inline permission set merged last,
 * or skipping the project config (and with it every permission here). The runner's own config replaces
 * any OPENCODE_CONFIG_CONTENT.
 */
const UNSAFE_ENV = ['OPENCODE_PERMISSION', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_CONFIG_CONTENT'];

/**
 * The run's environment: no update check, no sharing, no Claude Code or external skills, and the
 * per-run config. PWD is the run's directory: opencode takes its project directory from PWD before
 * its working directory, and a PWD inherited from the runner would load another project's config.
 */
function runEnv(base, { root, dataDir, stateDir, roles, dir }) {
  const env = { ...base };
  for (const k of UNSAFE_ENV) delete env[k];
  return {
    ...env,
    PWD: dir,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    // Only the harness's skills and instructions: none from ~/.claude or ~/.agents.
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(runConfig({ root, dataDir, stateDir, roles })),
  };
}

/** The environment with these permission keys denied for the session and every role (merged last, so they win). */
function denyTools(env, keys, roles) {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
  const deny = Object.fromEntries(keys.map(k => [k, 'deny']));
  config.permission = { ...(config.permission || {}), ...deny };
  config.agent = config.agent || {};
  for (const r of roles) config.agent[r] = { ...(config.agent[r] || {}), permission: { ...((config.agent[r] || {}).permission || {}), ...deny } };
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

module.exports = { SCHEMA, BUILTIN_AGENTS, READ, DENIED, TOOL_KEYS, UNSAFE_ENV, permissionKeys, agentPermission, agentConfig, sessionPermission, workspaceConfig, externalDirs, runConfig, runEnv, denyTools };
