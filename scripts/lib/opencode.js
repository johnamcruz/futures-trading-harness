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
 * In index mode (role-skills.js, the default) a role that holds skill_lookup
 * is denied opencode's skill tool: its skills are in its prompt (the core) or
 * read with skill_lookup (which reads any skill), and while an agent may use
 * the tool opencode puts every skill's name and description in its system
 * prompt (about 26 KB a call). A role without skill_lookup keeps the tool (its
 * way to a skill its embedded ones name), as does full mode. In index mode the
 * head trader gets a prompt of its own too (head-prompt.js: its per-cycle skills
 * embedded, any other read with skill_lookup) and is denied the skill tool; in
 * full mode it has no prompt of its own and loads its skills with the tool.
 *
 *   permissionKeys(tools)        a role's Claude tool names as opencode permission keys
 *   deniesSkillTool(tools, mode) whether a role is denied the skill tool (index mode, holds skill_lookup)
 *   agentPrompt(agent)           a role's prompt: in index mode, the default (skillPlan: role-skills.js), its
 *                                body, its core skills and an index of the rest (skill_lookup); in full mode
 *                                (FTH_ROLE_SKILLS=full, or no skillPlan) its body and every skill in full
 *   agentPermission(tools, mode) a role's permissions (the skill tool denied where deniesSkillTool says)
 *   agentConfig(agent)           a role as an opencode agent entry (its mode: skillPlan's)
 *   workspaceConfig(agents, head) workspace/opencode.json's object; `head`: the head trader's embedded skills (index mode,
 *                                head-prompt.js headPlan), or null (full mode: no prompt of its own, the skill tool)
 *   sessionPermission(roles, denied, mode)  the session's and the head trader's permissions (index: skill_lookup, no skill tool)
 *   runConfig({ ... })           the per-run config (OPENCODE_CONFIG_CONTENT); `deniedRoles`: roles a kind of cycle may
 *                                not launch (its task permission); `mode`: the run's role-skills mode (FTH_ROLE_SKILLS);
 *                                the runner's plugin, which refuses FTH_DENIED_ROLES; `replay`: no web for any agent and
 *                                no role that reaches it (webRoles)
 *   runEnv(base, { ... })        the run's environment for opencode; `refusedRoles`: this cycle's other denied roles
 *                                (FTH_DENIED_ROLES, with `deniedRoles`), refused by the plugin
 *   deniedTaskRefusal(tool, args, env)   the plugin's refusal of a task call naming a denied role, or null
 *   dropInventedTaskId(tool, args)  the plugin's repair of a task call: a task_id that names no session is dropped
 *   stepCap(agent)               a role's step cap ({ steps }, config/runner.json limits.roleSteps), {} for an order role
 *   denyTools(env, keys)         the run's environment with tools denied everywhere (the headless probe)
 *   badExtraArgs(args)           runner extraArgs opencode runs may not take
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { SERVER_NAME: BROKER_SERVER } = require('./broker/config');
const { SERVER_NAME: HARNESS_SERVER } = require('./harness-tools/registry');
const { scratchDir } = require('./bars-fetch');
const { describeTrigger } = require('./trading/skills-loaded');
const { HEAD_AGENT, headPrompt } = require('./head-prompt');

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
 * Whether a role is denied opencode's skill tool: in index mode (`mode`, role-skills.js), when it holds skill_lookup,
 * which reads any skill. opencode lists every skill in the system prompt of an agent that may use the tool; a role
 * without skill_lookup keeps it, its only way to a skill its prompt names but doesn't embed.
 */
const deniesSkillTool = (tools, mode) => mode === 'index' && permissionKeys(tools).includes(`${HARNESS_SERVER}_skill_lookup`);

/**
 * A role's permissions: everything denied, then each broker and harness tool by name (its own allowed,
 * the rest denied, so a user's rule for the role can't grant one), then its other tools; the skill tool
 * denied where deniesSkillTool says.
 */
function agentPermission(tools, mode = null) {
  const own = permissionKeys(tools);
  const permission = { '*': 'deny', ...Object.fromEntries(ROLE_DENIED.map(k => [k, 'deny'])) };
  for (const k of MCP_KEYS()) permission[k] = own.includes(k) ? 'allow' : 'deny';
  for (const k of own) if (!(k in permission)) permission[k] = k === 'read' ? { ...READ } : 'allow';
  if (deniesSkillTool(tools, mode)) permission.skill = 'deny';
  return permission;
}

/** The body's "Load the skill(s) `a`, ... and `b`." sentence (the one `role-skills` and `role-index` together repeat). */
const LOAD_SENTENCE = /Load the\s+skills?\s+(`[a-z-]+`(?:,?\s+(?:and\s+)?`[a-z-]+`)*)(\s+first)?\./;
/** `a`, `b`, and `c`, as the body lists skills. */
const skillList = names => {
  const q = names.map(n => `\`${n}\``);
  return q.length < 3 ? q.join(' and ') : `${q.slice(0, -1).join(', ')}, and ${q[q.length - 1]}`;
};

/** Not loading the embedded skills again: with the skill tool, or at all for a role denied it (deniesSkillTool). */
const notAgain = (agent, plan) => (plan && deniesSkillTool(agent.tools || [], plan.mode)
  ? "Read them here; don't load them again." : "Read them here; don't load them again with the skill tool.");

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
    `The skills this role uses (${docs.map(d => d.name).join(', ')}) are below in full: they are loaded. ${plan && deniesSkillTool(agent.tools || [], plan.mode) ? NO_INDEX_LOOKUP : notAgain(agent, plan)}`,
    '',
    ...docs.flatMap(d => [`<skill name="${d.name}">`, d.body, '</skill>', '']),
  ].join('\n');
}

/**
 * A role with no index denied the skill tool (deniesSkillTool: it holds skill_lookup): its skills are below, and another
 * one they name is a skill_lookup away, so opencode's listing of every skill stays out of its prompt (shorter than
 * notAgain's sentence it replaces).
 */
const NO_INDEX_LOOKUP = 'Read them here; others they name: skill_lookup.';

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
      `The skills this role uses every call (${plan.docs.map(d => d.name).join(', ')}) are below in full: they are loaded. ${notAgain(agent, plan)}`,
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

/**
 * A role's step cap (opencode's `steps`: the most model steps before it must answer in text), from config/runner.json
 * limits.roleSteps: a role stuck repeating a call (the PPC run of 2026-10-16: 386 steps of one refused market_snapshot,
 * the cycle lost to its timeout) answers with what it has. Measured on 555 role sessions: median 2 to 4, none
 * legitimate above 27; 40 leaves room for index mode's lookups (each a step), and a cut-short role's answer fails
 * closed (no approval, the gate's lookups). A role holding an order tool (broker interface role `order`: the trade-executor) is never
 * capped, so a protecting stop or an exit is never cut short; {} for it.
 */
function stepCap(agent) {
  const { TOOLS } = require('./broker/interface');
  const orders = (agent.tools || []).some(t => {
    const m = /^mcp__([a-z0-9-]+)__([a-z0-9_]+)$/.exec(t);
    return m && m[1] === BROKER_SERVER && TOOLS[m[2]] && TOOLS[m[2]].role === 'order';
  });
  return orders ? {} : { steps: require('./tunables').runner().limits.roleSteps };
}

function agentConfig(agent) {
  return {
    description: agent.description,
    mode: 'subagent',
    prompt: agentPrompt(agent),
    permission: agentPermission(agent.tools, agent.skillPlan ? agent.skillPlan.mode : null),
    ...stepCap(agent),
  };
}

/**
 * The main session's permissions (claudeTools' equivalent), with the roles it may delegate to (none of `denied`). In
 * index mode (`mode`, role-skills.js) the head trader's prompt embeds its skills (head-prompt.js): it reads any other
 * one with skill_lookup, and is denied the skill tool, whose listing of every skill opencode would put in its prompt.
 */
function sessionPermission(roles, denied = [], mode = null, replay = false) {
  const index = mode === 'index';
  return {
    '*': 'deny',
    ...Object.fromEntries(DENIED.map(k => [k, 'deny'])),
    read: { ...READ }, glob: 'allow', grep: 'allow', list: 'allow',
    // A replay: no web search (what the market did on a replayed date is on the web).
    skill: index ? 'deny' : 'allow', todowrite: 'allow', websearch: replay ? 'deny' : 'allow',
    // Every role by name, allowed or denied: a run config that only left a role out would keep the project's
    // `allow` for it when opencode merges the two (key by key).
    task: { '*': 'deny', ...Object.fromEntries(roles.map(r => [r, denied.includes(r) ? 'deny' : 'allow'])) },
    // Orders go through the gateway, which enforces the order gate on every call. An entry is the trade-executor's
    // alone (it holds place_order; the head trader delegates the approved plan to it); the head trader keeps the
    // reads and the risk-reducing calls (close, partial close, cancel, a stop tightened). Each broker tool by name,
    // no wildcard: a merged config naming one can't reorder a wildcard after it.
    ...Object.fromEntries(Object.keys(require('./broker/interface').TOOLS).map(t => [`${BROKER_SERVER}_${t}`, t === 'place_order' ? 'deny' : 'allow'])),
    [`${HARNESS_SERVER}_*`]: 'allow',
    // Full mode: skill_lookup is the roles' (a lookup counts for the role it names: trading/skill-lookups.js); the
    // head trader loads its skills with the skill tool. Index mode: its way to a skill its prompt doesn't embed.
    [`${HARNESS_SERVER}_skill_lookup`]: index ? 'allow' : 'deny',
  };
}

/**
 * The main session's own agent. opencode evaluates an agent's own rules after the top-level ones, so a
 * session run as `build` (or a user's default agent) would follow whatever the user's config gives that
 * agent; the harness runs its own, named so no user config means it, with the session's permissions. In
 * index mode (`head`: head-prompt.js headPlan) its prompt embeds its per-cycle skills, in place of opencode's.
 */
const headAgent = (roles, head = null) => ({
  description: 'The head trader of the futures trading harness (workspace/AGENTS.md).',
  mode: 'primary',
  ...(head ? { prompt: headPrompt(head) } : {}),
  permission: sessionPermission(roles, [], head ? 'index' : null),
});

/** opencode's own agents, not run: the roles replace general and explore, the head trader build. */
const DISABLED_AGENTS = [...BUILTIN_AGENTS, 'build'];

const server = script => ({ type: 'local', command: ['node', `{env:FTH_ROOT}/scripts/${script}`], enabled: true, timeout: 60000 });

function workspaceConfig(agents, head = null) {
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
      [HEAD_AGENT]: headAgent(roles, head),
      ...Object.fromEntries(agents.map(a => [a.name, agentConfig(a)])),
    },
    permission: sessionPermission(roles, [], head ? 'index' : null),
  };
}

/** Directories outside the project a run may read, as opencode's external_directory rules. */
function externalDirs({ root, dataDir, stateDir }) {
  const dirs = [root, dataDir, `${stateDir}/logs`, scratchDir({ FTH_HOME: stateDir })];
  return { '*': 'deny', ...Object.fromEntries(dirs.map(d => [`${String(d).replace(/\/+$/, '')}/*`, 'allow'])) };
}

/**
 * The runner's opencode plugin (scripts/opencode-plugin.js, loaded by every run's config): it refuses a task call
 * naming a role the run lists in FTH_DENIED_ROLES (deniedTaskRefusal). A role denied in the task permission drops out
 * of the task tool's description, which opencode puts in the head trader's prompt ahead of everything else, so a
 * permission that changed from cycle to cycle (the roles served from the report cache) broke the model server's
 * prompt cache every such cycle; the plugin refuses them with that description the same every cycle. The permission
 * keeps what a whole kind of cycle denies (autotrader.js deniedRoles: off the desk).
 */
const PLUGIN_FILE = ['scripts', 'opencode-plugin.js'];
const DENIED_ROLES_ENV = 'FTH_DENIED_ROLES';

/** The roles a run may not launch (FTH_DENIED_ROLES, comma-separated): a list. */
const deniedRolesOf = env => String((env && env[DENIED_ROLES_ENV]) || '').split(',').map(r => r.trim()).filter(Boolean);

/**
 * The plugin's check of one tool call: the refusal for a task call whose subagent_type is a role the run denies, else
 * null. Any other tool, or no role named, is not this check's (opencode's own checks apply).
 */
function deniedTaskRefusal(tool, args, env) {
  if (tool !== 'task' || !args || typeof args !== 'object') return null;
  const role = String(args.subagent_type || '').trim();
  if (!role || !deniedRolesOf(env).includes(role)) return null;
  return `[denied-role] ${role} is not launched this cycle (the cycle prompt gives its cached report, the role is off the desk, or it reaches the web, which a replay never does): don't call it again; go on with the reports you have.`;
}

/**
 * The plugin's repair of a task call's arguments, in place: a `task_id` that is not an opencode session id (SESSION_ID)
 * is dropped, so the role starts a fresh session, as a first launch does. opencode reads task_id as a session to
 * resume and fails the whole call on one that names none; a model inventing a label for its call ("msa", "rm1") lost
 * the role that cycle (the PPC run of 2026-10-16: 4 of 4 analysts in one cycle). A real session id (a resume) is left
 * as it is. True when it dropped one.
 */
const SESSION_ID = /^ses/;
function dropInventedTaskId(tool, args) {
  if (tool !== 'task' || !args || typeof args !== 'object' || !('task_id' in args)) return false;
  if (typeof args.task_id === 'string' && SESSION_ID.test(args.task_id)) return false;
  delete args.task_id;
  return true;
}

/** The web's permission keys: a replay denies both to every agent (WEB_KEYS), and launching a role that holds one. */
const WEB_KEYS = Object.freeze(['websearch', 'webfetch']);
/** The roles whose tools reach the web (WebSearch, WebFetch): a replay never launches them. */
const webRoles = agents => agents.filter(a => (a.tools || []).some(t => t === 'WebSearch' || t === 'WebFetch')).map(a => a.name);
/** A permission set with the web denied (a replay's), else as it is. */
const noWeb = (permission, replay) => (replay ? { ...permission, ...Object.fromEntries(WEB_KEYS.map(k => [k, 'deny'])) } : permission);

/**
 * The per-run config: every permission again, the session's, the head trader's and each role's (so a
 * run whose directory has no opencode.json, or another one, is still locked down: merged last, they
 * replace the project's in place), reading the runner's directories for all of them, and the runner's plugin
 * (PLUGIN_FILE under the harness root) that refuses the roles the run's FTH_DENIED_ROLES names. A replay (`replay`)
 * denies web search and web fetch to every agent and the launch of every role whose tools reach the web (webRoles): on
 * a replayed date the web holds what the market did next. A live run is as before.
 */
function runConfig({ root, dataDir, stateDir, agents, deniedRoles = [], mode = null, replay = false }) {
  const external = externalDirs({ root, dataDir, stateDir });
  const roles = agents.map(a => a.name);
  const denied = replay ? [...new Set([...deniedRoles, ...webRoles(agents)])] : deniedRoles;
  return {
    plugin: [pathToFileURL(path.join(root, ...PLUGIN_FILE)).href],
    default_agent: HEAD_AGENT,
    permission: { ...sessionPermission(roles, denied, mode, replay), external_directory: external },
    agent: {
      ...Object.fromEntries(DISABLED_AGENTS.map(a => [a, { disable: true }])),
      [HEAD_AGENT]: { mode: 'primary', permission: { ...sessionPermission(roles, denied, mode, replay), external_directory: { ...external } } },
      ...Object.fromEntries(agents.map(a => [a.name, { mode: 'subagent', ...stepCap(a), permission: { ...noWeb(agentPermission(a.tools, mode), replay), external_directory: { ...external } } }])),
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
function runEnv(base, { root, dataDir, stateDir, agents, dir, deniedRoles = [], refusedRoles = [], mode = null, replay = false }) {
  const env = { ...base };
  for (const k of UNSAFE_ENV) delete env[k];
  // `deniedRoles`: denied by permission (the same for every cycle of a kind); with `refusedRoles` (this cycle's: the
  // roles served from the report cache), refused by the plugin. Never inherited: only the run's own list.
  delete env[DENIED_ROLES_ENV];
  const refused = [...new Set([...deniedRoles, ...refusedRoles, ...(replay ? webRoles(agents) : [])])];
  return {
    ...env,
    ...(refused.length ? { [DENIED_ROLES_ENV]: refused.join(',') } : {}),
    PWD: dir,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    // Only the harness's skills and instructions: none from ~/.claude or ~/.agents.
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(runConfig({ root, dataDir, stateDir, agents, deniedRoles, mode, replay })),
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

module.exports = { WEB_KEYS, webRoles, LOAD_SENTENCE, SCHEMA, BUILTIN_AGENTS, DISABLED_AGENTS, HEAD_AGENT, READ, DENIED, ROLE_DENIED, TOOL_KEYS, UNSAFE_ENV, EXTRA_ARGS, permissionKeys, deniesSkillTool, agentPermission, agentPrompt, agentConfig, sessionPermission, headAgent, workspaceConfig, externalDirs, runConfig, runEnv, denyTools, badExtraArgs, PLUGIN_FILE, DENIED_ROLES_ENV, deniedRolesOf, deniedTaskRefusal, dropInventedTaskId, stepCap };
