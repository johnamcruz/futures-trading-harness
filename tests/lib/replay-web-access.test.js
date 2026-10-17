'use strict';

// No web in a replay (scripts/lib/replay/web-access.js): a replay step's effective permissions, per harness, let no
// agent search or fetch the web, nor launch a role whose tools reach it; a live run keeps them. The training
// preflight's no-web-in-replay check reads them back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../../scripts/lib/replay/web-access');
const oc = require('../../scripts/lib/opencode');
const at = require('../../scripts/lib/autotrader');
const { loadAgents, expectedFiles } = require('../../scripts/lib/harness-sync');
const { qwenWorkspaceSettings } = require('../../scripts/lib/install');

const ROOT = path.resolve(__dirname, '..', '..');
const agents = loadAgents(ROOT);
const WEB = oc.webRoles(agents);
const PROJECT = JSON.parse(expectedFiles(ROOT)['workspace/opencode.json']);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fth-web-'));
const REPLAY = { FTH_HOME: '/srv/fth', FTH_REPLAY_NOW: '2022-03-01T13:05:00Z' };

test('the roles that reach the web are the agents whose tools hold WebSearch or WebFetch (today the news analyst)', () => {
  assert.ok(WEB.length >= 1);
  for (const a of agents) assert.strictEqual(WEB.includes(a.name), a.tools.some(t => t === 'WebSearch' || t === 'WebFetch'), a.name);
  assert.ok(!WEB.includes('trade-executor'));
});

test('opencode: a replay\'s run config denies the web to the session, the head trader and every role, and the web roles\' launch; live keeps them', () => {
  const step = env => ({ harness: 'opencode', env: at.childEnv(at.validateConfig({ harness: 'opencode' }), ROOT, env, { action: 'premarket' }), projectConfig: PROJECT, webRoles: WEB });
  assert.deepStrictEqual(W.webFindings(step(REPLAY)), []);
  const live = W.webFindings(step({ FTH_HOME: '/srv/fth' }));
  assert.ok(live.includes('opencode: the session may use websearch'), live.join('\n'));
  assert.ok(live.includes(`opencode: ${oc.HEAD_AGENT} may launch ${WEB[0]}, whose tools reach the web`), live.join('\n'));
  assert.ok(live.includes(`opencode: ${WEB[0]} may use websearch`), live.join('\n'));
  // The replay's plugin refuses the web roles too (FTH_DENIED_ROLES): the task tool's refusal, not only its permission.
  const env = step(REPLAY).env;
  const { deniedRolesOf } = require('../../scripts/lib/toolcall/rules');
  const refusal = e => require('../../scripts/lib/toolcall/pipeline').createPipeline({ log: require('../../scripts/lib/toolcall/call-log').createCallLog(), env: e }).before({ tool: 'task', name: 'task', args: { subagent_type: WEB[0] }, session: 's' }).refuse;
  for (const r of WEB) assert.ok(deniedRolesOf(env).includes(r), r);
  assert.match(refusal(env), /reaches the web, which a replay never does/);
  assert.strictEqual(refusal(step({ FTH_HOME: '/srv/fth' }).env), null, 'live: launched');
  // No per-run config: the check can't see the web denied.
  assert.match(W.webFindings({ harness: 'opencode', env: {}, projectConfig: PROJECT, webRoles: WEB })[0], /no per-run config/);
});

test('opencode: read with opencode\'s rule order: a later allow (a pattern, a wildcard key) is found; a role\'s own deny after the session\'s allow holds', () => {
  const R = map => W.rulesOf(map);
  assert.strictEqual(W.allows(R({ '*': 'deny', websearch: 'deny' }), 'websearch'), false);
  assert.strictEqual(W.allows(R({ '*': 'deny', websearch: 'allow' }), 'websearch'), true);
  assert.strictEqual(W.allows(R({ '*': 'deny', websearch: { '*': 'deny', 'news*': 'allow' } }), 'websearch'), true, 'a pattern allowed after the deny');
  assert.strictEqual(W.allows(R({ '*': 'deny', 'web*': 'allow' }), 'webfetch'), true, 'a wildcard permission');
  assert.strictEqual(W.allows(R({ websearch: 'allow', '*': 'deny' }), 'websearch'), false, 'the last match wins');
  assert.strictEqual(W.allows([], 'websearch'), true, 'no rule: not shown off');
  assert.strictEqual(W.allows(R({ task: { '*': 'deny', a: 'allow' } }), 'task', 'a'), true);
  assert.strictEqual(W.allows(R({ task: { '*': 'deny', a: 'allow' } }), 'task', 'b'), false);
  // A user config granting the web under the run's config: the run's rules, merged last, still deny it.
  const user = { permission: { websearch: 'allow', webfetch: 'allow' }, agent: { [WEB[0]]: { permission: { websearch: 'allow' } } } };
  const env = at.childEnv(at.validateConfig({ harness: 'opencode' }), ROOT, REPLAY, { action: 'trade' });
  assert.deepStrictEqual(W.webFindings({ harness: 'opencode', env, projectConfig: W.merge(user, PROJECT), webRoles: WEB }), []);
  // A run config that left the web out of one role: found.
  const run = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  delete run.agent[WEB[0]].permission.websearch;
  const leaky = W.webFindings({ harness: 'opencode', env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(run) }, projectConfig: PROJECT, webRoles: WEB });
  assert.deepStrictEqual(leaky, [`opencode: ${WEB[0]} may use websearch`]);
});

test('claude: a replay\'s allowlist holds no web tool and its deny rules hold the web and each web role; live as before', () => {
  const argv = env => at.buildCommand(at.validateConfig({ harness: 'claude' }), 'p', ROOT, env);
  assert.deepStrictEqual(W.webFindings({ harness: 'claude', argv: argv(REPLAY), webRoles: WEB, root: ROOT }), []);
  const live = W.webFindings({ harness: 'claude', argv: argv({ FTH_HOME: '/srv/fth' }), webRoles: WEB, root: ROOT });
  assert.ok(live.includes('claude: the allowlist holds WebSearch') && live.includes('claude: WebFetch is not denied'), live.join('\n'));
  assert.deepStrictEqual(at.claudeTools(ROOT, { replay: false }).filter(t => /^Web/.test(t)).length, 1 + at.NEWS_DOMAINS.length, 'live: search and the calendar sites');
  assert.deepStrictEqual(at.claudeTools(ROOT, { replay: true }).filter(t => /^Web/.test(t)), []);
  // A role by its plain name and by the plugin-scoped name Claude Code gives a plugin's roles (<plugin>:<role>).
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  assert.deepStrictEqual(at.claudeDenied(ROOT, { replay: true }).filter(t => /^Web|^Agent/.test(t)), ['WebSearch', 'WebFetch', ...WEB.flatMap(r => [`Agent(${r})`, `Agent(${plugin}:${r})`])]);
  const scoped = argv(REPLAY).map(a => a.replace(`,Agent(${plugin}:${WEB[0]})`, ''));
  assert.deepStrictEqual(W.webFindings({ harness: 'claude', argv: scoped, webRoles: WEB, root: ROOT }), [`claude: Agent(${plugin}:${WEB[0]}) is not denied`]);
  assert.deepStrictEqual(at.claudeDenied(ROOT, {}).filter(t => /^Web|^Agent/.test(t)), []);
});

test('qwen: a replay\'s workspace settings allow no web and no web role, and deny them; live as before; codex: no network in a replay', () => {
  const home = tmp();
  const replay = qwenWorkspaceSettings(ROOT, home, { replay: true });
  assert.deepStrictEqual(W.webFindings({ harness: 'qwen', qwenSettings: replay, webRoles: WEB }), []);
  const live = qwenWorkspaceSettings(ROOT, home, {});
  assert.ok(live.permissions.allow.includes('web_search') && live.permissions.allow.includes(`Agent(${WEB[0]})`));
  assert.ok(W.webFindings({ harness: 'qwen', qwenSettings: live, webRoles: WEB }).includes('qwen: the allowlist holds web_search'));
  const codex = env => at.buildCommand(at.validateConfig({ harness: 'codex' }), 'p', ROOT, env);
  // Codex: the sandbox's network off and web search disabled (its `web_search` mode, and the older tools toggle).
  for (const o of ['sandbox_workspace_write.network_access=false', 'web_search="disabled"', 'tools.web_search=false']) {
    assert.ok(codex(REPLAY).includes(o), o);
    assert.ok(!codex({ FTH_HOME: '/srv/fth' }).includes(o), `live: ${o}`);
  }
  assert.deepStrictEqual(W.webFindings({ harness: 'codex', argv: codex(REPLAY) }), []);
  assert.deepStrictEqual(W.webFindings({ harness: 'codex', argv: codex({ FTH_HOME: '/srv/fth' }) }).length, 3);
  const noSearch = codex(REPLAY).map(a => (a === 'web_search="disabled"' ? 'web_search="live"' : a));
  assert.deepStrictEqual(W.webFindings({ harness: 'codex', argv: noSearch }), ['codex: the run doesn\'t set web_search="disabled"']);
  // A harness whose permissions can't be read back here: never shown off.
  assert.match(W.webFindings({ harness: 'custom' })[0], /can't be read back/);
});

test('replayStep: a resolved replay\'s first step as the driver runs it (opencode) shows no web; the preflight check passes on it and fails on live permissions', () => {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const P = require('../../scripts/lib/learning/preflight');
  const dir = tmp();
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true } } }));
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json') };
  const raw = { runId: 'w1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-02T00:00:00Z', learning: false,
    autotrader: { harness: 'opencode', symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' } };
  const run = resolveReplay(raw, { baseDir: dir, env, home: dir, root: ROOT });
  const step = W.replayStep(run, { root: ROOT, env });
  assert.ok(step.env.FTH_REPLAY_NOW, 'the replay clock');
  // Every step the driver runs has its replay clock (replayEnv), the one fact the permissions follow.
  require('../../scripts/lib/replay/driver').seedRunHome(run, { root: ROOT, userEnv: env });
  assert.strictEqual(require('../../scripts/lib/replay/config').replayEnv(env, run, { at: run.start }).FTH_REPLAY_NOW, run.start.toISOString());
  assert.deepStrictEqual(W.webFindings(step), []);
  const ok = P.noWebInReplay({ run, read: { replayStep: r => W.replayStep(r, { root: ROOT, env }) } });
  assert.strictEqual(ok.status, P.PASS, ok.detail);
  assert.match(ok.detail, new RegExp(`no agent may search or fetch the web, and ${WEB[0]} is not launched`));
  // The same step with a live run's permissions (no replay clock in its run config): refused.
  const liveStep = { ...step, env: at.childEnv(run.cfg, ROOT, { FTH_HOME: live }, { action: 'premarket' }) };
  const bad = P.noWebInReplay({ run, read: { replayStep: () => liveStep } });
  assert.strictEqual(bad.status, P.FAIL);
  assert.match(bad.detail, /the replay could reach the web: opencode: the session may use websearch/);
  // Codex without its no-web overrides: refused.
  assert.strictEqual(P.noWebInReplay({ run, read: { replayStep: () => ({ harness: 'codex', argv: [], webRoles: WEB }) } }).status, P.FAIL);
});

/** A resolved replay of `harness` in a fresh home (`files`: the user's config files under it, by path). */
function userRun(harness, files = {}, extraEnv = {}) {
  const { resolveReplay } = require('../../scripts/lib/replay/config');
  const dir = fs.realpathSync(tmp());
  const live = path.join(dir, 'live');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, 'brokers.json'), JSON.stringify({ brokers: { sim: { command: [process.execPath, '/opt/sim/server.js'], replay: true } } }));
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const env = { PATH: process.env.PATH, HOME: dir, FTH_HOME: live, FTH_BROKERS_FILE: path.join(live, 'brokers.json'), ...Object.fromEntries(Object.entries(extraEnv).map(([k, v]) => [k, v.replace('<home>', dir)])) };
  const raw = { runId: 'u1', workDir: path.join(dir, 'replays'), broker: 'sim', start: '2022-03-01T00:00:00Z', end: '2022-03-02T00:00:00Z', learning: false,
    autotrader: { harness, symbols: ['MNQ'], account: '7', timeframe: 3, sessions: ['09:30-15:50@America/New_York'], eodAt: '15:50@America/New_York' } };
  const run = resolveReplay(raw, { baseDir: dir, env, home: dir, root: ROOT });
  return W.webFindings(W.replayStep(run, { root: ROOT, env, home: dir }));
}

test('claude: the user\'s settings and MCP servers are read: a shell or fetch-like MCP allow, a foreign server, an extra --mcp-config', () => {
  assert.deepStrictEqual(userRun('claude'), []);
  // Only the harness's own MCP servers load in a replay (--strict-mcp-config): a user server is not loaded, not a finding.
  const servers = { '.claude.json': { mcpServers: { fetch: { command: 'x' }, broker: { command: 'node' } } } };
  assert.deepStrictEqual(userRun('claude', servers), []);
  const at2 = require('../../scripts/lib/autotrader');
  const argv = at2.buildCommand(at2.validateConfig({ harness: 'claude' }), 'p', ROOT, REPLAY);
  const i = argv.indexOf('--mcp-config');
  assert.deepStrictEqual(JSON.parse(argv[i + 1]).mcpServers ? Object.keys(JSON.parse(argv[i + 1]).mcpServers) : null, ['broker', 'harness']);
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.ok(!at2.buildCommand(at2.validateConfig({ harness: 'claude' }), 'p', ROOT, { FTH_HOME: '/srv/fth' }).includes('--strict-mcp-config'), 'live: unchanged');
  // Without --strict-mcp-config: every user server is a finding.
  const loose = argv.filter(a => a !== '--strict-mcp-config');
  const user = { claudeMcp: [{ source: '~/.claude.json', servers: ['fetch', 'broker'] }] };
  assert.deepStrictEqual(W.webFindings({ harness: 'claude', argv: loose, webRoles: WEB, root: ROOT, user }), ['claude: the run loads the user\'s MCP servers (no --strict-mcp-config)', 'claude: ~/.claude.json configures the MCP server fetch']);
  // An extra --mcp-config (extraArgs) adding a server: found.
  const extra = [...argv, '--mcp-config', JSON.stringify({ mcpServers: { browser: {} } })];
  assert.deepStrictEqual(W.webFindings({ harness: 'claude', argv: extra, webRoles: WEB, root: ROOT }), ['claude: --mcp-config adds the MCP server browser']);
  // The user's settings: a shell (any form), a fetch-like or whole foreign MCP server allowed; the harness's own aren't.
  const settings = { '.claude/settings.json': { permissions: { allow: ['Bash(curl *)', 'mcp__fetch__fetch', 'mcp__notes', 'mcp__notes__read', 'mcp__broker__get_bars', 'Read'] } } };
  assert.deepStrictEqual(userRun('claude', settings).map(f => f.replace(/^claude: .*?settings\.json allows /, '')), ['Bash(curl *)', 'mcp__fetch__fetch', 'mcp__notes']);
  // A settings file that can't be parsed: its rules can't be read back.
  assert.match(userRun('claude', { '.claude/settings.json': '{not json' })[0], /settings\.json can't be parsed/);
});

test('opencode: the global config is merged first: a foreign MCP server, a fetch-like tool key or a shell it allows are found', () => {
  assert.deepStrictEqual(userRun('opencode'), []);
  const g = '.config/opencode/opencode.json';
  const found = userRun('opencode', { [g]: { mcp: { fetch: { type: 'local', command: ['x'] }, off: { enabled: false } } } });
  assert.strictEqual(found.length, 1);
  assert.match(found[0], /opencode\.json configures the MCP server fetch/);
  // A per-tool key placed after the user's own "*" (its place kept when the project's "*" merges over it): allowed, found.
  const keyed = userRun('opencode', { '.config/opencode/opencode.jsonc': '{\n // mine\n "permission": { "*": "allow", "fetch_fetch": "allow", "bash": "allow", },\n}' });
  assert.ok(keyed.includes('opencode: the session may use fetch_fetch'), keyed.join('\n'));
  assert.ok(!keyed.some(f => /may use bash/.test(f)), 'bash: denied by name in the project and run configs');
  // A role's own key: before the run's "*" (appended after it), denied; after the user's own "*", allowed and found.
  assert.deepStrictEqual(userRun('opencode', { [g]: { agent: { 'risk-manager': { permission: { bash: 'allow', http_get: 'allow' } } } } }), []);
  const role = userRun('opencode', { [g]: { agent: { 'risk-manager': { permission: { '*': 'allow', http_get: 'allow' } } } } });
  assert.deepStrictEqual(role, ['opencode: risk-manager may use http_get']);
  // OPENCODE_CONFIG's file is read too; an unparseable one is a finding.
  assert.match(userRun('opencode', { [g]: '{oops' })[0], /can't be parsed/);
  assert.match(userRun('opencode', { 'mine.json': { mcp: { browse: {} } } }, { OPENCODE_CONFIG: '<home>/mine.json' })[0], /mine\.json configures the MCP server browse/);
  assert.deepStrictEqual(W.parseJsonc('{"a": "//x", /* c */ "b": [1,],}'), { a: '//x', b: [1] });
});

test('qwen and codex: the user\'s settings and config: a shell or fetch-like allow, a foreign MCP server', () => {
  assert.deepStrictEqual(userRun('qwen'), []);
  const q = userRun('qwen', { '.qwen/settings.json': { mcpServers: { broker: {}, harness: {}, fetch: {} }, permissions: { allow: ['run_shell_command(curl *)', 'Shell', 'mcp__fetch__fetch', 'mcp__harness__bars'] } } });
  assert.deepStrictEqual(q.map(f => f.replace(/^qwen: .*?settings\.json /, '')), ['allows run_shell_command(curl *)', 'allows Shell', 'allows mcp__fetch__fetch', 'configures the MCP server fetch']);
  assert.deepStrictEqual(userRun('codex'), []);
  const toml = '[mcp_servers.broker]\ncommand = "node"\n[mcp_servers."web-fetch"]\ncommand = "x"\n[mcp_servers]\nsearch = { command = "y" }\nmcp_servers.dotted.command = "z"\n';
  assert.deepStrictEqual(W.codexServers(toml).sort(), ['broker', 'dotted', 'search', 'web-fetch']);
  const c = userRun('codex', { '.codex/config.toml': toml });
  assert.deepStrictEqual(c.map(f => f.replace(/^codex: .*?config\.toml /, '')), ['configures the MCP server web-fetch', 'configures the MCP server search', 'configures the MCP server dotted']);
});
