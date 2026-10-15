'use strict';

/**
 * No web in a replay. On a replayed date the web holds what the market did next, so a replay step (FTH_REPLAY_NOW,
 * every learning run's) denies web search and web fetch to every agent and the launch of every role whose tools reach
 * the web (opencode.js webRoles: the news analyst), whatever the harness; a live run keeps them. Where each harness
 * gets it: opencode the per-run config (opencode.js runConfig, merged last over the project's), Claude Code the
 * allowlist and its deny rules (autotrader.js claudeTools, claudeDenied), Qwen Code the workspace settings the runner
 * writes (install.js qwenWorkspaceSettings), Codex the sandbox's network off. This module reads back what a replay
 * step's effective permissions allow, for the training preflight's no-web-in-replay check.
 *
 *   webFindings({ harness, env, argv, projectConfig, qwenSettings, webRoles })   what the step lets an agent reach on
 *       the web, one line each ([]: nothing); a harness whose permissions can't be read back here (Codex, a custom
 *       command) is one finding: it can't be shown off
 *   allows(rules, key, pattern)      opencode's decision on ordered rules (the last match wins): whether `key` may run
 *   replayStep(run, { root, env })   the step a replay runs at its start, as the driver runs it (its replay clock, as
 *       replay/config.js replayEnv sets it; autotrader.js childEnv for a premarket, buildCommand): { harness, env, argv,
 *       projectConfig, qwenSettings, webRoles }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB_KEYS = Object.freeze(['websearch', 'webfetch']);

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

function opencodeFindings({ env, projectConfig, webRoles }) {
  let run;
  try {
    run = JSON.parse((env || {}).OPENCODE_CONFIG_CONTENT || '');
  } catch (_err) {
    run = null;
  }
  if (!run || typeof run !== 'object') return ['opencode: the run has no per-run config (OPENCODE_CONFIG_CONTENT) to deny the web'];
  const config = merge(projectConfig && typeof projectConfig === 'object' ? projectConfig : {}, run);
  const top = rulesOf(config.permission);
  // The session, then each agent it may run: the top-level rules, then the agent's own (opencode's order).
  const scopes = [['the session', top]];
  for (const name of Object.keys(config.agent || {}).sort()) {
    const a = config.agent[name];
    if (!a || a.disable === true) continue;
    scopes.push([name, [...top, ...rulesOf(a.permission)]]);
  }
  const out = [];
  for (const [scope, rules] of scopes) {
    for (const k of WEB_KEYS) if (allows(rules, k)) out.push(`opencode: ${scope} may use ${k}`);
    for (const role of webRoles) if (allows(rules, 'task', role)) out.push(`opencode: ${scope} may launch ${role}, whose tools reach the web`);
  }
  return out;
}

/** The comma-separated value after `flag` in argv. */
const listAfter = (argv, flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1].split(',').map(x => x.trim()).filter(Boolean) : [];
};

function claudeFindings({ argv, webRoles }) {
  const allowed = listAfter(argv, '--allowedTools');
  const denied = listAfter(argv, '--disallowedTools');
  const out = [];
  for (const t of allowed) if (/^Web(Search|Fetch)\b/.test(t)) out.push(`claude: the allowlist holds ${t}`);
  // Deny rules too, so no allow in the user's own settings reaches the web.
  for (const t of ['WebSearch', 'WebFetch', ...webRoles.map(r => `Agent(${r})`)]) if (!denied.includes(t)) out.push(`claude: ${t} is not denied`);
  return out;
}

function qwenFindings({ qwenSettings, webRoles }) {
  const p = (qwenSettings && qwenSettings.permissions) || {};
  const allow = Array.isArray(p.allow) ? p.allow : [];
  const deny = Array.isArray(p.deny) ? p.deny : [];
  const out = [];
  for (const t of allow) if (/^(web_search|web_fetch|WebSearch|WebFetch)\b/.test(t) || webRoles.some(r => t === `Agent(${r})`)) out.push(`qwen: the allowlist holds ${t}`);
  for (const t of ['web_search', 'WebFetch', ...webRoles.map(r => `Agent(${r})`)]) if (!deny.includes(t)) out.push(`qwen: ${t} is not denied`);
  return out;
}

function webFindings({ harness, env = {}, argv = [], projectConfig = null, qwenSettings = null, webRoles = [] }) {
  if (harness === 'opencode') return opencodeFindings({ env, projectConfig, webRoles });
  if (harness === 'claude') return claudeFindings({ argv, webRoles });
  if (harness === 'qwen') return qwenFindings({ qwenSettings, webRoles });
  return [`${harness}: its web access can't be read back from its permissions here (opencode, claude and qwen can be)`];
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_err) { return null; } };

function replayStep(run, { root, env = process.env }) {
  const autotrader = require('../autotrader');
  const cfg = autotrader.validateConfig(run.cfg);
  // A replay step's clock (replay/config.js replayEnv sets FTH_REPLAY_NOW on every step) in its run home; the rest of
  // replayEnv points at the run home's copies, which aren't seeded before the preflight, and decides no permission.
  const base = { ...env, ...(run.paths && run.paths.runHome ? { FTH_HOME: run.paths.runHome } : {}), FTH_REPLAY_NOW: new Date(run.start).toISOString() };
  const stepEnv = autotrader.childEnv(cfg, root, base, { action: 'premarket' });
  const argv = autotrader.buildCommand(cfg, '<prompt>', root, stepEnv);
  const workdir = cfg.workdir ? path.resolve(root, cfg.workdir) : path.join(root, 'workspace');
  // The run's copy of the workspace once seeded, else the one it is copied from.
  const projectConfig = readJson(path.join(workdir, 'opencode.json')) || readJson(path.join(root, 'workspace', 'opencode.json'));
  const qwenSettings = cfg.harness === 'qwen'
    ? require('../install').qwenWorkspaceSettings(root, os.homedir(), { dataDir: autotrader.resolveDataDir(cfg, os.homedir(), stepEnv), stateDir: require('../paths').harnessHome(stepEnv), replay: autotrader.isReplay(stepEnv) })
    : null;
  const webRoles = require('../opencode').webRoles(require('../harness-sync').loadAgents(root));
  return { harness: cfg.harness, env: stepEnv, argv, projectConfig, qwenSettings, webRoles };
}

module.exports = { WEB_KEYS, allows, rulesOf, merge, webFindings, replayStep };
