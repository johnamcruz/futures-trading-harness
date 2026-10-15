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
  for (const r of WEB) assert.ok(oc.deniedRolesOf(env).includes(r), r);
  assert.match(oc.deniedTaskRefusal('task', { subagent_type: WEB[0] }, env), /reaches the web, which a replay never does/);
  assert.strictEqual(oc.deniedTaskRefusal('task', { subagent_type: WEB[0] }, step({ FTH_HOME: '/srv/fth' }).env), null, 'live: launched');
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
  assert.deepStrictEqual(W.webFindings({ harness: 'claude', argv: argv(REPLAY), webRoles: WEB }), []);
  const live = W.webFindings({ harness: 'claude', argv: argv({ FTH_HOME: '/srv/fth' }), webRoles: WEB });
  assert.ok(live.includes('claude: the allowlist holds WebSearch') && live.includes('claude: WebFetch is not denied'), live.join('\n'));
  assert.deepStrictEqual(at.claudeTools(ROOT, { replay: false }).filter(t => /^Web/.test(t)).length, 1 + at.NEWS_DOMAINS.length, 'live: search and the calendar sites');
  assert.deepStrictEqual(at.claudeTools(ROOT, { replay: true }).filter(t => /^Web/.test(t)), []);
  assert.deepStrictEqual(at.claudeDenied(ROOT, { replay: true }).filter(t => /^Web|^Agent/.test(t)), ['WebSearch', 'WebFetch', ...WEB.map(r => `Agent(${r})`)]);
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
  assert.ok(codex(REPLAY).includes('sandbox_workspace_write.network_access=false'));
  assert.ok(!codex({ FTH_HOME: '/srv/fth' }).includes('sandbox_workspace_write.network_access=false'));
  // A harness whose permissions can't be read back here: never shown off.
  assert.match(W.webFindings({ harness: 'codex' })[0], /can't be read back/);
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
  // Codex: its web search can't be shown off from here: refused. A custom command (the user's own argv): a warning.
  assert.strictEqual(P.noWebInReplay({ run, read: { replayStep: () => ({ harness: 'codex', webRoles: WEB }) } }).status, P.FAIL);
  const custom = P.noWebInReplay({ run: { ...run, cfg: { ...run.cfg, harness: 'custom' } }, read: { replayStep: () => ({ harness: 'opencode', env: {}, webRoles: WEB }) } });
  assert.deepStrictEqual([custom.status, /its web access is its own/.test(custom.detail)], [P.WARN, true]);
});
