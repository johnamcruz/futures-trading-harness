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
 * The session runs as the harness's own primary agent (HEAD_AGENT, --agent and
 * default_agent; opencode's build, general, explore and plan are disabled), so a
 * user's config for opencode's agents never applies to it.
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
 *   agentPrompt(agent)           a role's prompt: in index mode, the default (skillPlan: role-skills.js), its
 *                                body, its core skills and an index of the rest (skill_lookup); in full mode
 *                                (FTH_ROLE_SKILLS=full, or no skillPlan) its body and every skill in full
 *   agentConfig(agent)           a role as an opencode agent entry
 *   workspaceConfig(agents)      workspace/opencode.json's object
 *   runConfig({ ... })           the per-run config (OPENCODE_CONFIG_CONTENT); `deniedRoles`: roles this run may not launch
 *   runEnv(base, { ... })        the run's environment for opencode
 *   denyTools(env, keys)         the run's environment with tools denied everywhere (the headless probe)
 *   badExtraArgs(args)           runner extraArgs opencode runs may not take
 */

const { SERVER_NAME: BROKER_SERVER } = require('./broker/config');
const { SERVER_NAME: HARNESS_SERVER } = require('./harness-tools/registry');
const { scratchDir } = require('./bars-fetch');
const { describeTrigger } = require('./trading/skills-loaded');

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

/** Permissions a role is never granted, denied by name after its "*" (the session's, and delegating). */
const ROLE_DENIED = [...DENIED.filter(k => k !== 'external_directory'), 'task'];

/** Every broker and harness tool by its opencode key. */
const MCP_KEYS = () => [
  ...Object.keys(require('./broker/interface').TOOLS).map(t => `${BROKER_SERVER}_${t}`),
  ...[...require('./harness-tools/registry').BY_NAME.keys()].map(t => `${HARNESS_SERVER}_${t}`),
];

/**
 * A role's permissions: everything denied, then each broker and harness tool by name (its own allowed,
 * the rest denied, so a user's rule for the role can't grant one), then its other tools.
 */
function agentPermission(tools) {
  const own = permissionKeys(tools);
  const permission = { '*': 'deny', ...Object.fromEntries(ROLE_DENIED.map(k => [k, 'deny'])) };
  for (const k of MCP_KEYS()) permission[k] = own.includes(k) ? 'allow' : 'deny';
  for (const k of own) if (!(k in permission)) permission[k] = k === 'read' ? { ...READ } : 'allow';
  return permission;
}

/** The body's "Load the skill(s) `a`, ... and `b`." sentence (the one `role-skills` and `role-index` together repeat). */
const LOAD_SENTENCE = /Load the\s+skills?\s+(`[a-z-]+`(?:,?\s+(?:and\s+)?`[a-z-]+`)*)(\s+first)?\./;
/** `a`, `b`, and `c`, as the body lists skills. */
const skillList = names => {
  const q = names.map(n => `\`${n}\``);
  return q.length < 3 ? q.join(' and ') : `${q.slice(0, -1).join(', ')}, and ${q[q.length - 1]}`;
};

/**
 * A role's prompt: its body, with its "Load the skills" sentence saying they are below, then its skills in full
 * (frontmatter `role-skills`, skillDocs), so the role has them every call without spending a turn per skill load
 * or relying on the model to load them; they are part of the role's fixed prompt prefix, which a local model
 * server caches across calls.
 */
function agentPrompt(agent) {
  const plan = agent.skillPlan || null;
  if (plan && plan.indexed.length) return indexPrompt(agent, plan);
  const docs = plan ? plan.docs : (agent.skillDocs || []);
  if (!docs.length) return `${agent.body}\n`;
  return [
    agent.body.replace(LOAD_SENTENCE, (_m, list) => `Your skills ${list} are below, already loaded (Your skills, at the end).`),
    '',
    '## Your skills (already loaded)',
    '',
    `The skills this role uses (${docs.map(d => d.name).join(', ')}) are below in full: they are loaded. Read them here; don't load them again with the skill tool.`,
    '',
    ...docs.flatMap(d => [`<skill name="${d.name}">`, d.body, '</skill>', '']),
  ].join('\n');
}

/** The skill_lookup call a role makes, with its own name (the order gate counts a lookup by it). */
const lookupCall = role => `\`skill_lookup {"skill": "<skill>", "role": "${role}"}\``;

/** Index mode's one line for the skills outside a role's lists: the catalog is on demand, never in the prompt. */
const OTHER_SKILLS = 'Other skills: `skill_lookup {}` lists them all.';

/**
 * A role's prompt in index mode (role-skills.js skillPlan): its body, its core skills in full, then its index, one
 * line per skill (name and description), which it reads whole with the harness tool skill_lookup when the cycle
 * needs one, and the situations in which a lookup is required (skills-loaded.js SITUATIONAL).
 */
function indexPrompt(agent, plan) {
  // Without its load sentence the body would still name the indexed skills to load: never generated silently.
  if (!LOAD_SENTENCE.test(agent.body)) throw new Error(`agents/${agent.file || agent.name}: no "Load the skills ..." sentence to split into its core and its index`);
  const out = [
    // Its load sentence names core and index alike (the other adapters load them all, as before): here, two sentences.
    agent.body.replace(LOAD_SENTENCE, () => `${plan.docs.length ? `Your skills ${skillList(plan.docs.map(d => d.name))} are below, already loaded (Your skills, at the end). ` : ''}Look up as needed: ${skillList(plan.indexed.map(d => d.name))}, listed in Your skill index (at the end); read one with skill_lookup only when this cycle needs it.`),
    '',
  ];
  if (plan.docs.length) {
    out.push('## Your skills (already loaded)', '',
      `The skills this role uses every call (${plan.docs.map(d => d.name).join(', ')}) are below in full: they are loaded. Read them here; don't load them again with the skill tool.`,
      '', ...plan.docs.flatMap(d => [`<skill name="${d.name}">`, d.body, '</skill>', '']));
  }
  out.push('## Your skill index', '',
    `Your other skills, not loaded. Read one only when this cycle's situation needs it: ${lookupCall(agent.name)} returns the whole skill. Don't look up what the cycle doesn't need.`,
    '', ...plan.indexed.map(d => `- ${d.name}: ${d.description}`), '', OTHER_SKILLS, '');
  if (plan.required.length) {
    out.push('Required by the situation: when this bar\'s briefing shows it, or a setup the caller names as fired on another lane\'s bar this cycle shows it (that setup counts as one of the briefing\'s candidates, with the trend rule the caller gives), look the skill up in this call, before your report; otherwise the order gate doesn\'t count your report for an entry.', '',
      ...plan.required.map(r => `- ${r.when.map(describeTrigger).join(', or ')}: \`${r.skill}\``), '');
  }
  return out.join('\n');
}

function agentConfig(agent) {
  return {
    description: agent.description,
    mode: 'subagent',
    prompt: agentPrompt(agent),
    permission: agentPermission(agent.tools),
  };
}

/** The main session's permissions (claudeTools' equivalent), with the roles it may delegate to (none of `denied`). */
function sessionPermission(roles, denied = []) {
  return {
    '*': 'deny',
    ...Object.fromEntries(DENIED.map(k => [k, 'deny'])),
    read: { ...READ }, glob: 'allow', grep: 'allow', list: 'allow',
    skill: 'allow', todowrite: 'allow', websearch: 'allow',
    // Every role by name, allowed or denied: a run config that only left a role out would keep the project's
    // `allow` for it when opencode merges the two (key by key).
    task: { '*': 'deny', ...Object.fromEntries(roles.map(r => [r, denied.includes(r) ? 'deny' : 'allow'])) },
    // Orders go through the gateway, which enforces the order gate on every call. An entry is the trade-executor's
    // alone (it holds place_order; the head trader delegates the approved plan to it); the head trader keeps the
    // reads and the risk-reducing calls (close, partial close, cancel, a stop tightened). Each broker tool by name,
    // no wildcard: a merged config naming one can't reorder a wildcard after it.
    ...Object.fromEntries(Object.keys(require('./broker/interface').TOOLS).map(t => [`${BROKER_SERVER}_${t}`, t === 'place_order' ? 'deny' : 'allow'])),
    [`${HARNESS_SERVER}_*`]: 'allow',
    // skill_lookup is the roles' (a lookup counts for the role it names: trading/skill-lookups.js); the head trader
    // loads its skills with the skill tool.
    [`${HARNESS_SERVER}_skill_lookup`]: 'deny',
  };
}

/**
 * The main session's own agent. opencode evaluates an agent's own rules after the top-level ones, so a
 * session run as `build` (or a user's default agent) would follow whatever the user's config gives that
 * agent; the harness runs its own, named so no user config means it, with the session's permissions.
 */
const HEAD_AGENT = 'fth-head-trader';
const headAgent = roles => ({
  description: 'The head trader of the futures trading harness (workspace/AGENTS.md).',
  mode: 'primary',
  permission: sessionPermission(roles),
});

/** opencode's own agents, not run: the roles replace general and explore, the head trader build. */
const DISABLED_AGENTS = [...BUILTIN_AGENTS, 'build'];

const server = script => ({ type: 'local', command: ['node', `{env:FTH_ROOT}/scripts/${script}`], enabled: true, timeout: 60000 });

function workspaceConfig(agents) {
  const roles = agents.map(a => a.name);
  return {
    $schema: SCHEMA,
    autoupdate: false,
    share: 'disabled',
    // No language servers, formatters, or git snapshot of the project per step: nothing a trading run needs.
    lsp: false,
    formatter: false,
    snapshot: false,
    mcp: {
      // The gateway starts the broker MCP server named in the broker config and enforces the order gate.
      [BROKER_SERVER]: server('mcp-gateway.js'),
      // The harness's own operations as tools (no order tools).
      [HARNESS_SERVER]: server('harness-tools-mcp.js'),
    },
    skills: { paths: ['{env:FTH_ROOT}/skills'] },
    default_agent: HEAD_AGENT,
    agent: {
      ...Object.fromEntries(DISABLED_AGENTS.map(a => [a, { disable: true }])),
      [HEAD_AGENT]: headAgent(roles),
      ...Object.fromEntries(agents.map(a => [a.name, agentConfig(a)])),
    },
    permission: sessionPermission(roles),
  };
}

/** Directories outside the project a run may read, as opencode's external_directory rules. */
function externalDirs({ root, dataDir, stateDir }) {
  const dirs = [root, dataDir, `${stateDir}/logs`, scratchDir({ FTH_HOME: stateDir })];
  return { '*': 'deny', ...Object.fromEntries(dirs.map(d => [`${String(d).replace(/\/+$/, '')}/*`, 'allow'])) };
}

/**
 * The per-run config: every permission again, the session's, the head trader's and each role's (so a
 * run whose directory has no opencode.json, or another one, is still locked down: merged last, they
 * replace the project's in place), and reading the runner's directories for all of them.
 */
function runConfig({ root, dataDir, stateDir, agents, deniedRoles = [] }) {
  const external = externalDirs({ root, dataDir, stateDir });
  const roles = agents.map(a => a.name);
  return {
    default_agent: HEAD_AGENT,
    permission: { ...sessionPermission(roles, deniedRoles), external_directory: external },
    agent: {
      ...Object.fromEntries(DISABLED_AGENTS.map(a => [a, { disable: true }])),
      [HEAD_AGENT]: { mode: 'primary', permission: { ...sessionPermission(roles, deniedRoles), external_directory: { ...external } } },
      ...Object.fromEntries(agents.map(a => [a.name, { mode: 'subagent', permission: { ...agentPermission(a.tools), external_directory: { ...external } } }])),
    },
  };
}

/**
 * Variables opencode reads that would change what a run may do: an inline permission set merged last,
 * skipping the project config, or another config folder (agents, plugins, permissions) loaded after
 * it. The runner's own config replaces any OPENCODE_CONFIG_CONTENT. OPENCODE_CONFIG (a file loaded
 * before the project's, where a provider may be) stays.
 */
const UNSAFE_ENV = ['OPENCODE_PERMISSION', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR',
  // Background subagents return before their report: a role must report in the foreground (roles-ran.js).
  'OPENCODE_EXPERIMENTAL', 'OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS'];

/**
 * The run's environment: no update check, no sharing, no Claude Code or external skills, no language
 * server downloads, and the per-run config. PWD is the run's directory: opencode takes its project
 * directory from PWD before its working directory, and a PWD inherited from the runner would load
 * another project's config.
 */
function runEnv(base, { root, dataDir, stateDir, agents, dir, deniedRoles = [] }) {
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
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(runConfig({ root, dataDir, stateDir, agents, deniedRoles })),
  };
}

/** The environment with these permission keys denied for the session and every agent it runs (merged last, so they win). */
function denyTools(env, keys) {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}');
  const deny = Object.fromEntries(keys.map(k => [k, 'deny']));
  config.permission = { ...(config.permission || {}), ...deny };
  for (const [name, a] of Object.entries(config.agent || {})) if (!a.disable) config.agent[name] = { ...a, permission: { ...(a.permission || {}), ...deny } };
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
}

/**
 * Arguments a runner config may add to `opencode run`: the model's variant and logging. Anything
 * else (--auto and its aliases, --attach, --dir, --agent, a session to continue, sharing) could run
 * the cycle somewhere else, as another agent, or with approvals the runner didn't set up.
 */
const EXTRA_ARGS = { '--variant': 1, '--thinking': 0, '--print-logs': 0, '--log-level': 1 };

/** The extra arguments that are not allowed, [] when all are. */
function badExtraArgs(args) {
  const bad = [];
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = String(args[i]).split(/=(.*)/s);
    const takes = EXTRA_ARGS[flag];
    if (takes === undefined || (takes === 0 && inline !== undefined)) bad.push(String(args[i]));
    else if (takes === 1 && inline === undefined) {
      if (args[i + 1] === undefined || String(args[i + 1]).startsWith('-')) bad.push(String(args[i]));
      i += 1;
    }
  }
  return bad;
}

module.exports = { LOAD_SENTENCE, SCHEMA, BUILTIN_AGENTS, DISABLED_AGENTS, HEAD_AGENT, READ, DENIED, ROLE_DENIED, TOOL_KEYS, UNSAFE_ENV, EXTRA_ARGS, permissionKeys, agentPermission, agentPrompt, agentConfig, sessionPermission, headAgent, workspaceConfig, externalDirs, runConfig, runEnv, denyTools, badExtraArgs };
