'use strict';

/**
 * No web in a replay. On a replayed date the web holds what the market did next, so a replay step (FTH_REPLAY_NOW,
 * every learning run's) denies web search and web fetch to every agent and the launch of every role whose tools reach
 * the web (opencode.js webRoles: the news analyst), whatever the harness; a live run keeps them. Where each harness
 * gets it: opencode the per-run config (opencode.js runConfig, merged last over the project's), Claude Code the
 * allowlist, its deny rules (autotrader.js claudeTools, claudeDenied: a role by its plain and plugin-scoped name) and
 * only the harness's MCP servers (--strict-mcp-config), Qwen Code the workspace settings the runner writes
 * (install.js qwenWorkspaceSettings), Codex the sandbox's network off and web search disabled (CODEX_REPLAY_NO_WEB).
 * This module reads back what a replay step's effective permissions allow, for the training preflight's
 * no-web-in-replay check, with the user's own configuration each harness inherits (userConfig): a shell or a
 * fetch-like MCP tool it allows, or an MCP server of its own (only `broker` and `harness` are the harness's), is a
 * finding; a user config file that can't be parsed is one too.
 *
 *   webFindings({ harness, env, argv, projectConfig, qwenSettings, webRoles, root, user })   what the step lets an
 *       agent reach on the web, one line each ([]: nothing); a harness whose permissions can't be read back here (a
 *       custom command) is one finding: it can't be shown off
 *   allows(rules, key, pattern)      opencode's decision on ordered rules (the last match wins): whether `key` may run
 *   userConfig(harness, { home, workdir, env })   the user's own config files the harness inherits, read
 *   replayStep(run, { root, env, home })   the step a replay runs at its start, as the driver runs it (its replay clock,
 *       as replay/config.js replayEnv sets it; autotrader.js childEnv for a premarket, buildCommand): { harness, env,
 *       argv, projectConfig, qwenSettings, webRoles, root, user }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB_KEYS = Object.freeze(['websearch', 'webfetch']);
/** The harness's own MCP servers: the broker gateway and the harness tools. Any other may reach the web. */
const OWN_SERVERS = Object.freeze([require('../broker/config').SERVER_NAME, require('../harness-tools/registry').SERVER_NAME]);
/** A tool name that fetches, browses or searches: an MCP tool by it (not the harness's own) reaches the web. */
const FETCH_LIKE = /fetch|curl|wget|https?|browse|browser|web|url|search|scrape|crawl|download/i;

/** opencode's wildcards in a rule's permission and pattern: * any text, ? one character. */
const wildcard = (text, pattern) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's').test(String(text));

/** A permission map as opencode's ordered rules ({ "*": action } for a plain action). */
const rulesOf = map => Object.entries(map && typeof map === 'object' ? map : {})
  .flatMap(([permission, v]) => Object.entries(typeof v === 'string' ? { '*': v } : v && typeof v === 'object' ? v : {}).map(([pattern, action]) => ({ permission, pattern, action })));

/**
 * Whether opencode's ordered rules (the last match wins) let `key` run: with `pattern`, on that input (a role's name
 * for task); else on any input, so a rule after the last "*" one that allows some pattern counts. No rule at all counts
 * as allowed (a check never passes on what it can't see).
 */
function allows(rules, key, pattern = null) {
  const mine = rules.filter(r => wildcard(key, r.permission));
  if (pattern !== null) {
    const hit = mine.filter(r => wildcard(pattern, r.pattern)).pop();
    return !hit || hit.action !== 'deny';
  }
  const all = mine.filter(r => r.pattern === '*').pop();
  const after = all ? mine.slice(mine.lastIndexOf(all) + 1) : mine;
  return !all || all.action !== 'deny' || after.some(r => r.action !== 'deny');
}

/** Merging configs as opencode does: objects key by key (a known key keeps its place), anything else replaced. */
function merge(a, b) {
  if (b === undefined) return a;
  if (!a || typeof a !== 'object' || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
  return out;
}

/** Opencode's MCP tool keys are `<server>_<tool>`: the harness's own servers' tools. */
const ownKey = key => OWN_SERVERS.some(s => String(key).startsWith(`${s}_`));

function opencodeFindings({ env, projectConfig, webRoles, user = {} }) {
  let run;
  try {
    run = JSON.parse((env || {}).OPENCODE_CONFIG_CONTENT || '');
  } catch (_err) {
    run = null;
  }
  if (!run || typeof run !== 'object') return ['opencode: the run has no per-run config (OPENCODE_CONFIG_CONTENT) to deny the web'];
  // opencode's order: the user's global config (and OPENCODE_CONFIG's file), then the project's, then the run's.
  const inherited = (user.opencode || []).filter(c => c && c.json && typeof c.json === 'object');
  const config = [...inherited.map(c => c.json), projectConfig && typeof projectConfig === 'object' ? projectConfig : {}, run].reduce((a, b) => merge(a, b), {});
  const out = [];
  // A server of the user's (its tools keep any per-tool key of the user's config): refused, not guessed at.
  for (const c of inherited) {
    for (const [name, server] of Object.entries((c.json.mcp && typeof c.json.mcp === 'object') ? c.json.mcp : {})) {
      if (!OWN_SERVERS.includes(name) && !(server && server.enabled === false)) out.push(`opencode: ${c.source} configures the MCP server ${name} (a replay loads only ${OWN_SERVERS.join(' and ')}: remove it or set enabled false)`);
    }
  }
  const top = rulesOf(config.permission);
  // The session, then each agent it may run: the top-level rules, then the agent's own (opencode's order).
  const scopes = [['the session', top, config.permission]];
  for (const name of Object.keys(config.agent || {}).sort()) {
    const a = config.agent[name];
    if (!a || a.disable === true) continue;
    scopes.push([name, [...top, ...rulesOf(a.permission)], a.permission]);
  }
  for (const [scope, rules, own] of scopes) {
    for (const k of WEB_KEYS) if (allows(rules, k)) out.push(`opencode: ${scope} may use ${k}`);
    if (allows(rules, 'bash')) out.push(`opencode: ${scope} may use bash`);
    // Any fetch-like tool key (an MCP server's) a config allows, but the harness's own.
    const keys = new Set([...Object.keys(config.permission || {}), ...Object.keys(own && typeof own === 'object' ? own : {})]);
    for (const k of [...keys].sort()) if (!WEB_KEYS.includes(k) && !ownKey(k) && FETCH_LIKE.test(k) && allows(rules, k)) out.push(`opencode: ${scope} may use ${k}`);
    for (const role of webRoles) if (allows(rules, 'task', role)) out.push(`opencode: ${scope} may launch ${role}, whose tools reach the web`);
  }
  return out;
}

/** Every comma-separated value after each `flag` in argv. */
const listAfter = (argv, flag) => argv.flatMap((a, i) => (a === flag && typeof argv[i + 1] === 'string' ? argv[i + 1].split(',').map(x => x.trim()).filter(Boolean) : []));
/** Every value after each `flag` in argv. */
const valuesAfter = (argv, flag) => argv.flatMap((a, i) => (a === flag && typeof argv[i + 1] === 'string' ? [argv[i + 1]] : []));

/** A Claude or Qwen rule's MCP server (`mcp__<server>` or `mcp__<server>__<tool>`), or null. */
const mcpServerOf = rule => (/^mcp__/.test(rule) ? String(rule).split('(')[0].split('__')[1] || null : null);
/** A user allow rule that reaches the web: a shell (Bash, any form), or a fetch-like or whole foreign MCP server's tool. */
function webAllow(rule, shells) {
  const name = String(rule).split('(')[0];
  if (shells.includes(name)) return true;
  const server = mcpServerOf(rule);
  if (!server || OWN_SERVERS.includes(server)) return false;
  const tool = String(rule).split('(')[0].split('__').slice(2).join('__');
  return !tool || tool === '*' || FETCH_LIKE.test(tool);
}

/** The servers of an --mcp-config value (inline JSON, else a JSON file), or null when it can't be read. */
function mcpConfigServers(value) {
  let doc;
  try { doc = JSON.parse(value); } catch (_err) { doc = readJson(value); }
  return doc && typeof doc === 'object' ? Object.keys(doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}) : null;
}

function claudeFindings({ argv, webRoles, root = null, user = {} }) {
  const allowed = listAfter(argv, '--allowedTools');
  const denied = listAfter(argv, '--disallowedTools');
  const out = [];
  for (const t of allowed) if (/^Web(Search|Fetch)\b/.test(t)) out.push(`claude: the allowlist holds ${t}`);
  // The runner's own shell rules are its scripts (node <root>/scripts/...); any other shell rule reaches the web.
  for (const t of allowed) if (/^Bash\b/.test(t) && !(root && t.startsWith(`Bash(node ${root}/scripts/`))) out.push(`claude: the allowlist holds ${t}`);
  for (const t of allowed) if (webAllow(t, [])) out.push(`claude: the allowlist holds ${t}`);
  // Deny rules too, so no allow in the user's own settings reaches the web: a role by its plain and plugin-scoped name.
  const plugin = (() => { try { return require('../autotrader').pluginName(); } catch (_err) { return null; } })();
  for (const t of ['WebSearch', 'WebFetch', ...webRoles.flatMap(r => [`Agent(${r})`, ...(plugin ? [`Agent(${plugin}:${r})`] : [])])]) if (!denied.includes(t)) out.push(`claude: ${t} is not denied`);
  // The user's settings (dontAsk runs what they allow): a shell or a fetch-like MCP tool reaches the web.
  for (const { source, json } of user.claudeSettings || []) {
    const allow = json && json.permissions && Array.isArray(json.permissions.allow) ? json.permissions.allow : [];
    for (const t of allow) if (webAllow(t, ['Bash'])) out.push(`claude: ${source} allows ${t}`);
  }
  // MCP servers: only --mcp-config's, and only the harness's own (--strict-mcp-config); else every user server loads.
  if (!argv.includes('--strict-mcp-config')) {
    out.push('claude: the run loads the user\'s MCP servers (no --strict-mcp-config)');
    for (const { source, servers } of user.claudeMcp || []) for (const name of servers) if (!OWN_SERVERS.includes(name)) out.push(`claude: ${source} configures the MCP server ${name}`);
  }
  for (const v of valuesAfter(argv, '--mcp-config')) {
    const servers = mcpConfigServers(v);
    if (servers === null) out.push(`claude: an --mcp-config the check can't read (${v.length} characters, not shown)`);
    else for (const name of servers) if (!OWN_SERVERS.includes(name)) out.push(`claude: --mcp-config adds the MCP server ${name}`);
  }
  return out;
}

/** Qwen's names for its shell tool (its aliases resolve each to run_shell_command). */
const QWEN_SHELLS = ['Bash', 'Shell', 'ShellTool', 'run_shell_command'];

function qwenFindings({ qwenSettings, webRoles, user = {} }) {
  const p = (qwenSettings && qwenSettings.permissions) || {};
  const allow = Array.isArray(p.allow) ? p.allow : [];
  const deny = Array.isArray(p.deny) ? p.deny : [];
  const out = [];
  for (const t of allow) if (/^(web_search|web_fetch|WebSearch|WebFetch)\b/.test(t) || webRoles.some(r => t === `Agent(${r})`)) out.push(`qwen: the allowlist holds ${t}`);
  // Qwen's tool aliases: web_search (WebSearch) and WebFetch (web_fetch) name one tool each.
  for (const t of ['web_search', 'WebFetch', ...webRoles.map(r => `Agent(${r})`)]) if (!deny.includes(t)) out.push(`qwen: ${t} is not denied`);
  // The user's settings: a shell or a fetch-like MCP tool allowed, an MCP server of their own.
  const u = user.qwen && user.qwen.json && typeof user.qwen.json === 'object' ? user.qwen.json : null;
  if (u) {
    const uAllow = u.permissions && Array.isArray(u.permissions.allow) ? u.permissions.allow : [];
    for (const t of uAllow) if (webAllow(t, QWEN_SHELLS)) out.push(`qwen: ${user.qwen.source} allows ${t}`);
    for (const name of Object.keys(u.mcpServers && typeof u.mcpServers === 'object' ? u.mcpServers : {})) if (!OWN_SERVERS.includes(name)) out.push(`qwen: ${user.qwen.source} configures the MCP server ${name}`);
  }
  return out;
}

/** The MCP server names a Codex TOML config defines ([mcp_servers.<name>], a dotted key, a key under [mcp_servers]). */
function codexServers(text) {
  const names = new Set();
  const unq = n => n.replace(/^["']|["']$/g, '');
  let inServers = false;
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/#.*$/, '').trim();
    let m;
    if (l.startsWith('[')) {
      inServers = /^\[\s*["']?mcp_servers["']?\s*\]/.test(l);
      if ((m = /^\[\s*["']?mcp_servers["']?\s*\.\s*("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)/.exec(l))) names.add(unq(m[1]));
      continue;
    }
    if ((m = /^["']?mcp_servers["']?\s*\.\s*("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)/.exec(l))) names.add(unq(m[1]));
    else if ((m = /^["']?mcp_servers["']?\s*=\s*\{(.*)/.exec(l))) for (const k of m[1].matchAll(/(?:^|[{,])\s*("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*=/g)) names.add(unq(k[1]));
    else if (inServers && (m = /^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*[.=]/.exec(l))) names.add(unq(m[1]));
  }
  return [...names];
}

function codexFindings({ argv, user = {} }) {
  const overrides = valuesAfter(argv, '-c').map(v => v.replace(/\s+/g, ''));
  const out = [];
  for (const o of require('../autotrader').CODEX_REPLAY_NO_WEB) if (!overrides.includes(o.replace(/\s+/g, ''))) out.push(`codex: the run doesn't set ${o}`);
  for (const { source, text } of user.codex || []) for (const name of codexServers(text)) if (!OWN_SERVERS.includes(name)) out.push(`codex: ${source} configures the MCP server ${name}`);
  return out;
}

function webFindings({ harness, env = {}, argv = [], projectConfig = null, qwenSettings = null, webRoles = [], root = null, user = {} }) {
  if (harness === 'opencode') return [...unreadable(user), ...opencodeFindings({ env, projectConfig, webRoles, user })];
  if (harness === 'claude') return [...unreadable(user), ...claudeFindings({ argv, webRoles, root, user })];
  if (harness === 'qwen') return [...unreadable(user), ...qwenFindings({ qwenSettings, webRoles, user })];
  if (harness === 'codex') return codexFindings({ argv, user });
  return [`${harness}: its web access can't be read back from its permissions here (opencode, claude, qwen and codex can be)`];
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch (_err) { return null; } };

/** JSON with comments and trailing commas (opencode.jsonc), outside strings. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const j = text.indexOf('*/', i + 2);
      i = j < 0 ? text.length : j + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A config file's JSON (JSONC for opencode's), or null when there is none; one that can't be parsed is said so. */
function readConfig(file, { jsonc = false } = {}) {
  const text = readText(file);
  if (text === null) return null;
  try { return { source: file, json: jsonc ? parseJsonc(text) : JSON.parse(text) }; } catch (_err) { return { source: file, json: null, unreadable: true }; }
}

/**
 * The user's own configuration each harness inherits on this machine (`home`; the step's env): what the run's
 * permissions merge with or load. Claude: its settings files (the ones checkClaudeSettings reads) and its MCP servers
 * (~/.claude.json, the project's, .mcp.json); opencode: its global config and OPENCODE_CONFIG's file; Qwen: its user
 * settings; Codex: its config.toml (CODEX_HOME) and the project's.
 */
function userConfig(harness, { home, workdir, env = {} }) {
  if (harness === 'claude') {
    const settings = [path.join(home, '.claude', 'settings.json'), path.join(workdir, '.claude', 'settings.json'), path.join(workdir, '.claude', 'settings.local.json')].map(f => readConfig(f)).filter(Boolean);
    const mcp = [];
    const main = readJson(path.join(home, '.claude.json'));
    if (main && main.mcpServers) mcp.push({ source: path.join(home, '.claude.json'), servers: Object.keys(main.mcpServers) });
    const proj = main && main.projects && main.projects[workdir];
    if (proj && proj.mcpServers) mcp.push({ source: `${path.join(home, '.claude.json')} (${workdir})`, servers: Object.keys(proj.mcpServers) });
    const local = readJson(path.join(workdir, '.mcp.json'));
    if (local && local.mcpServers) mcp.push({ source: path.join(workdir, '.mcp.json'), servers: Object.keys(local.mcpServers) });
    return { claudeSettings: settings, claudeMcp: mcp };
  }
  if (harness === 'opencode') {
    const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
    const files = ['config.json', 'opencode.json', 'opencode.jsonc'].map(f => path.join(dir, f));
    if (env.OPENCODE_CONFIG) files.push(env.OPENCODE_CONFIG);
    return { opencode: files.map(f => readConfig(f, { jsonc: true })).filter(Boolean) };
  }
  if (harness === 'qwen') return { qwen: readConfig(path.join(home, '.qwen', 'settings.json')) };
  if (harness === 'codex') {
    const files = [path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), path.join(workdir, '.codex', 'config.toml')];
    return { codex: files.map(f => ({ source: f, text: readText(f) })).filter(c => c.text !== null) };
  }
  return {};
}

/** A user config file that can't be parsed: its permissions and servers can't be read back, so never shown off. */
function unreadable(user) {
  const all = [...(user.claudeSettings || []), ...(user.opencode || []), ...(user.qwen ? [user.qwen] : [])];
  return all.filter(c => c.unreadable).map(c => `${c.source} can't be parsed: its permissions and servers can't be read back`);
}

function replayStep(run, { root, env = process.env, home = (env && env.HOME) || os.homedir() }) {
  const autotrader = require('../autotrader');
  // run.cfg is already the validated runner config (replay/config.js resolve): validating its normalized output again
  // would refuse a data lane's normalized `strategies: null`.
  const cfg = run.cfg;
  // A replay step's clock (replay/config.js replayEnv sets FTH_REPLAY_NOW on every step) in its run home; the rest of
  // replayEnv points at the run home's copies, which aren't seeded before the preflight, and decides no permission.
  const base = { ...env, ...(run.paths && run.paths.runHome ? { FTH_HOME: run.paths.runHome } : {}), FTH_REPLAY_NOW: new Date(run.start).toISOString() };
  // A probe: the step's env and argv as a run would build them, but nothing written (autotrader.js claudeHeadAttestation).
  const stepEnv = autotrader.childEnv(cfg, root, base, { action: 'premarket', probe: true });
  const argv = autotrader.buildCommand(cfg, '<prompt>', root, stepEnv);
  const workdir = cfg.workdir ? path.resolve(root, cfg.workdir) : path.join(root, 'workspace');
  // The run's copy of the workspace once seeded, else the one it is copied from.
  const projectConfig = readJson(path.join(workdir, 'opencode.json')) || readJson(path.join(root, 'workspace', 'opencode.json'));
  const qwenSettings = cfg.harness === 'qwen'
    ? require('../install').qwenWorkspaceSettings(root, home, { dataDir: autotrader.resolveDataDir(cfg, home, stepEnv), stateDir: require('../paths').harnessHome(stepEnv), replay: autotrader.isReplay(stepEnv) })
    : null;
  const webRoles = require('../opencode').webRoles(require('../harness-sync').loadAgents(root));
  return { harness: cfg.harness, env: stepEnv, argv, projectConfig, qwenSettings, webRoles, root, user: userConfig(cfg.harness, { home, workdir, env: stepEnv }) };
}

module.exports = { WEB_KEYS, OWN_SERVERS, FETCH_LIKE, allows, rulesOf, merge, webFindings, replayStep, userConfig, codexServers, parseJsonc, unreadable };
