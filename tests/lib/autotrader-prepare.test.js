'use strict';

// Prepare ahead, shadow mode (PR B1) in the runner's command and environment (scripts/lib/autotrader.js): the
// prepareAhead key, its delivery (never pooled), the prepare and shadow-confirm argv (the head trader's argv with a
// narrower --allowedTools, and the confirm's --resume <session> --fork-session), and the env they get (and no other run).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const A = require('../../scripts/lib/autotrader');
const PA = require('../../scripts/lib/prepare-ahead');
const { TOOLS: BROKER_TOOLS } = require('../../scripts/lib/broker/interface');
const { TOOLS: HARNESS_TOOLS } = require('../../scripts/lib/harness-tools/registry');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const { validateConfig, buildCommand, childEnv, claudeTools } = A;
const flag = (argv, f) => argv[argv.indexOf(f) + 1];
const ORDERS = ['place_order', 'modify_order', 'cancel_order', 'close_position', 'partial_close_position'];

test('prepareAhead (the runner config): off, shadow or on for Claude Code; "off" is no key at all', () => {
  assert.strictEqual(validateConfig({ harness: 'claude', prepareAhead: 'shadow' }).prepareAhead, 'shadow');
  assert.strictEqual(validateConfig({ harness: 'claude', prepareAhead: 'on' }).prepareAhead, 'on');
  assert.ok(!('prepareAhead' in validateConfig({ harness: 'claude', prepareAhead: 'off' })), '"off" is as absent');
  assert.ok(!('prepareAhead' in validateConfig({ harness: 'claude' })));
  for (const v of [true, 'yes', 1, null]) assert.throws(() => validateConfig({ harness: 'claude', prepareAhead: v }), /prepareAhead: "off", "shadow" or "on"/, String(v));
  for (const harness of ['opencode', 'codex', 'qwen']) for (const m of ['shadow', 'on']) assert.throws(() => validateConfig({ harness, prepareAhead: m }), /prepareAhead: for harness "claude" only/, harness);
  assert.ok(!('prepareAhead' in validateConfig({ harness: 'opencode', prepareAhead: 'off' })));
});

test('prepareAhead is a head trader delivery key: a shadow run is never pooled with one without it; "off" is the same delivery as no key', () => {
  assert.ok(A.HEAD_DELIVERY_KEYS.includes('prepareAhead'));
  const base = A.headDeliveryOf(null, validateConfig({ harness: 'claude' }));
  assert.strictEqual(A.headDeliveryOf(null, validateConfig({ harness: 'claude', prepareAhead: 'off' })), base);
  assert.strictEqual(A.headDeliveryOf(null, { harness: 'claude', stableFirstPrompt: true, prepareAhead: 'off' }), base, 'a raw "off" too');
  assert.strictEqual(A.headDeliveryOf({ config: { 'cfg.prepareAhead': '"off"', 'cfg.stableFirstPrompt': 'true' } }, null), base, 'a setup record\'s "off"');
  assert.strictEqual(A.headDeliveryOf(null, validateConfig({ harness: 'claude', prepareAhead: 'shadow' })), 'stableFirstPrompt,prepareAhead=shadow');
  assert.strictEqual(A.headDeliveryOf({ config: { 'cfg.prepareAhead': '"shadow"' } }, null), 'prepareAhead=shadow');
  // Each key's "on" value, and the token it is named by.
  assert.strictEqual(A.deliveryOnValue('prepareAhead'), 'shadow');
  assert.strictEqual(A.deliveryOnValue('headSkillsInPrompt'), true);
  assert.strictEqual(A.deliveryToken('prepareAhead', 'shadow'), 'prepareAhead=shadow');
  assert.strictEqual(A.deliveryToken('prepareAhead', 'off'), null);
  assert.strictEqual(A.deliveryToken('cycleDataInPrompt', true), 'cycleDataInPrompt');
  assert.strictEqual(A.deliveryToken('cycleDataInPrompt', false), null);
  assert.strictEqual(A.deliveryProblem('prepareAhead', 'shadow', 'claude'), null);
  assert.strictEqual(A.deliveryProblem('prepareAhead', 'on', 'claude'), null);
  assert.match(A.deliveryProblem('prepareAhead', 'on', 'opencode'), /for harness "claude" only/);
  // "on" is its own delivery: never pooled with shadow's, nor with none.
  assert.strictEqual(A.headDeliveryOf(null, validateConfig({ harness: 'claude', prepareAhead: 'on' })), 'stableFirstPrompt,prepareAhead=on');
  assert.strictEqual(A.deliveryToken('prepareAhead', 'on'), 'prepareAhead=on');
  assert.match(A.deliveryProblem('headSkillsInPrompt', 'yes', 'claude'), /true or false/);
});

test('the prepare\'s tools: the head trader\'s, less the subagent tool, compose_check, the order tools, the journal\'s writes, the data fetches and the scripts that write', () => {
  const opts = { home: '/h', dataDir: '/h/bars', stateDir: '/h/.fth', replay: true };
  const head = claudeTools('/fth', opts);
  const prep = A.claudePrepareTools('/fth', opts);
  // Never wider than the head trader's: every rule is one of its rules, or a tool of a server it allows whole.
  for (const t of prep) assert.ok(head.includes(t) || /^mcp__(broker|harness)__/.test(t), t);
  assert.ok(!prep.includes('Agent') && !prep.includes('mcp__broker') && !prep.includes('mcp__harness'), 'no subagent, no whole server');
  for (const t of ORDERS) assert.ok(!prep.includes(`mcp__broker__${t}`), t);
  for (const t of ['compose_check', 'bars_fetch', 'blackouts_add', 'reconcile']) assert.ok(!prep.includes(`mcp__harness__${t}`), t);
  for (const t of ['get_bars', 'get_quote', 'journal_add']) assert.ok(!prep.includes(`mcp__broker__${t}`), t);
  // From the interface and the registry, never a list of its own: every other read the head trader has.
  const reads = Object.entries(BROKER_TOOLS).filter(([n, d]) => (d.role === 'read' || n === 'journal_read') && !['get_bars', 'get_quote'].includes(n)).map(([n]) => `mcp__broker__${n}`);
  for (const t of reads) assert.ok(prep.includes(t), t);
  for (const t of HARNESS_TOOLS.map(x => x.name).filter(n => !['compose_check', 'bars_fetch', 'blackouts_add', 'reconcile'].includes(n))) assert.ok(prep.includes(`mcp__harness__${t}`), t);
  // The scripts: the reads only (no bars fetch, no blackouts or lessons write, no reconcile).
  const bash = prep.filter(t => t.startsWith('Bash('));
  assert.deepStrictEqual(bash.map(t => /scripts\/(\S+?)(?: status)?:\*/.exec(t)[1]).sort(), ['combine.js', 'market-snapshot.js', 'mtf.js', 'strategies.js']);
  // Reads, the skill tool and (live) the calendar sites, as the head trader has them.
  assert.ok(prep.includes('Skill'));
  assert.deepStrictEqual(prep.filter(t => t.startsWith('Read(')), head.filter(t => t.startsWith('Read(')));
  assert.deepStrictEqual(A.claudePrepareTools('/fth', { ...opts, replay: false }).filter(t => /^Web/.test(t)), claudeTools('/fth', { ...opts, replay: false }).filter(t => /^Web/.test(t)));
});

test('the prepare and the shadow confirm run the head trader\'s argv: the same --disallowedTools, model, plugin dir, system-prompt file and MCP config; only --allowedTools narrower, and the confirm resumes a fork of the prepare session', () => {
  const home = tmpDir();
  const env = { FTH_HOME: home, HOME: home, FTH_REPLAY_NOW: '2026-04-28T14:00:00.000Z' };
  for (const c of [validateConfig({ harness: 'claude', model: 'm1', prepareAhead: 'shadow' }), validateConfig({ harness: 'claude', headSkillsInPrompt: true, prepareAhead: 'shadow', extraArgs: ['--x'] })]) {
    const head = buildCommand(c, 'P', ROOT, env);
    const prep = buildCommand(c, 'P', ROOT, env, { prepare: 'prepare' });
    const conf = buildCommand(c, 'P', ROOT, env, { prepare: 'confirm', resume: 'ses-123' });
    // Identical but the allowed tools' value (and the confirm's resume pair).
    const without = (argv, f) => argv.map((a, i) => (argv[i - 1] === f ? '<allowed>' : a));
    assert.deepStrictEqual(without(prep, '--allowedTools'), without(head, '--allowedTools'));
    const r = conf.indexOf('--resume');
    assert.deepStrictEqual(conf.slice(r, r + 3), ['--resume', 'ses-123', '--fork-session']);
    assert.deepStrictEqual(without([...conf.slice(0, r), ...conf.slice(r + 3)], '--allowedTools'), without(head, '--allowedTools'));
    for (const f of ['--disallowedTools', '--plugin-dir', '--permission-mode', '--mcp-config']) assert.strictEqual(flag(prep, f), flag(head, f), f);
    if (c.model) assert.strictEqual(flag(prep, '--model'), 'm1');
    if (c.headSkillsInPrompt) assert.strictEqual(flag(conf, '--append-system-prompt-file'), flag(head, '--append-system-prompt-file'));
    assert.strictEqual(flag(prep, '--allowedTools'), A.claudePrepareTools(ROOT, { dataDir: A.resolveDataDir(c, require('os').homedir(), env), stateDir: home, replay: true }).join(','));
    assert.strictEqual(flag(conf, '--allowedTools'), flag(prep, '--allowedTools'), 'the confirm\'s tools are the prepare\'s');
    assert.ok(!prep.includes('--effort') && !conf.includes('--effort'), 'the CLI\'s default effort (config/runner.json prepare.effort null)');
    assert.ok(!head.includes('--resume') && !prep.includes('--resume'));
  }
  // The effort, only when the tunable names one; never on the head trader's own run.
  const c = validateConfig({ harness: 'claude', prepareAhead: 'shadow' });
  const withEffort = buildCommand(c, 'P', ROOT, env, { prepare: 'confirm', resume: 's', effort: 'low' });
  assert.strictEqual(flag(withEffort, '--effort'), 'low');
  // Only Claude Code; a resume only for the confirm; a resume without a session is refused.
  assert.throws(() => buildCommand(validateConfig({ harness: 'opencode' }), 'P', ROOT, env, { prepare: 'prepare' }), /prepare ahead runs on Claude Code only/);
  assert.throws(() => buildCommand(c, 'P', ROOT, env, { prepare: 'confirm' }), /the confirm resumes the prepare's session/);
  assert.throws(() => buildCommand(c, 'P', ROOT, env, { prepare: 'prepare', resume: 's' }), /only the confirm resumes/);
  assert.throws(() => buildCommand(c, 'P', ROOT, env, { prepare: 'other' }), /prepare: "prepare" or "confirm"/);
  assert.throws(() => buildCommand(c, 'P', ROOT, env, { prepare: 'prepare', agent: 'risk-manager' }), /never a role's run/);
});

test('childEnv: a prepare run and a shadow confirm say so (FTH_PREPARE) with the session record\'s file; no other run has either, an inherited one is dropped', () => {
  const c = validateConfig({ harness: 'claude', prepareAhead: 'shadow' });
  const base = { FTH_HOME: tmpDir(), FTH_PREPARE: 'prepare', FTH_PREPARE_SESSION: '/x/s.json' };
  const prep = childEnv(c, ROOT, base, { action: 'trade', prepare: 'prepare', prepareSession: '/h/prepare/s1.json' });
  assert.strictEqual(prep.FTH_PREPARE, 'prepare');
  assert.strictEqual(prep.FTH_PREPARE_SESSION, '/h/prepare/s1.json');
  const conf = childEnv(c, ROOT, base, { action: 'trade', prepare: 'confirm', prepareSession: '/h/prepare/s2.json' });
  assert.strictEqual(conf.FTH_PREPARE, 'confirm');
  // Never the cycle's entry, roles, id, verdict stage or cached phase 1: a shadow run is no cycle's.
  for (const k of ['FTH_CYCLE_ID', 'FTH_CYCLE_ROLES', 'FTH_CYCLE_ENTRY', 'FTH_VERDICT_STAGE', 'FTH_CYCLE_PHASE1', 'FTH_ROLE_RUN']) assert.ok(!(k in prep) && !(k in conf), k);
  // Its own transcript file (its skill lookups apart from the head trader's).
  assert.ok(prep.FTH_CYCLE_TRANSCRIPT && prep.FTH_CYCLE_TRANSCRIPT !== conf.FTH_CYCLE_TRANSCRIPT);
  // Any other run: neither, inherited or not.
  for (const ctx of [null, { action: 'trade' }, { action: 'trade', roleRun: 'risk-manager' }, { action: 'trade', prepare: 'other' }]) {
    const env = childEnv(c, ROOT, base, ctx);
    assert.ok(!('FTH_PREPARE' in env) && !('FTH_PREPARE_SESSION' in env), JSON.stringify(ctx));
  }
  // A role's run never gets them even beside a prepare context.
  assert.ok(!('FTH_PREPARE' in childEnv(c, ROOT, base, { action: 'trade', roleRun: 'risk-manager', prepare: 'prepare' })));
  // The values only: one of the two kinds, an absolute session file.
  assert.ok(!('FTH_PREPARE_SESSION' in childEnv(c, ROOT, base, { action: 'trade', prepare: 'prepare', prepareSession: 'rel/s.json' })));
});

test('childEnv: a prepare and a shadow confirm write the gate\'s log to the shadow\'s own file (<home>/prepare/gate-log.jsonl), never the old path\'s; every other run keeps its own', () => {
  const c = validateConfig({ harness: 'claude', prepareAhead: 'shadow' });
  const home = tmpDir();
  const base = { FTH_HOME: home, FTH_GATE_LOG: '/old/gate.jsonl' };
  for (const kind of ['prepare', 'confirm']) {
    const env = childEnv(c, ROOT, base, { action: 'trade', prepare: kind });
    assert.strictEqual(env.FTH_GATE_LOG, path.join(home, 'prepare', 'gate-log.jsonl'), kind);
    assert.strictEqual(require('../../scripts/lib/trading/check-order').gateLogPath(env), path.join(home, 'prepare', 'gate-log.jsonl'));
  }
  assert.strictEqual(PA.shadowGateLog(home), path.join(home, 'prepare', 'gate-log.jsonl'));
  for (const ctx of [null, { action: 'trade' }, { action: 'trade', roleRun: 'trade-executor', prepare: 'prepare' }]) assert.strictEqual(childEnv(c, ROOT, base, ctx).FTH_GATE_LOG, '/old/gate.jsonl', JSON.stringify(ctx));
});

test('PA and autotrader agree on the prepare\'s denied tools (one home: prepare-ahead.js)', () => {
  assert.deepStrictEqual([...PA.PREPARE_DENIED.harness].sort(), ['bars_fetch', 'blackouts_add', 'compose_check', 'reconcile']);
  assert.deepStrictEqual([...PA.PREPARE_DENIED.broker].sort(), ['get_bars', 'get_quote']);
  assert.deepStrictEqual([...PA.PREPARE_SCRIPTS].sort(), ['market-snapshot.js', 'mtf.js', 'strategies.js']);
});

// --- prepareAhead "on" (PR B2): the confirm IS the head trader's run at the close, a fork of the prepare's session ------

test('"on": the confirm\'s argv is the head trader\'s own, whole (its full --allowedTools, the same --disallowedTools, model, plugin dir, system-prompt file, MCP config), plus --resume <prepare session> --fork-session; no --effort', () => {
  const home = tmpDir();
  const env = { FTH_HOME: home, HOME: home, FTH_REPLAY_NOW: '2026-04-28T14:00:00.000Z' };
  for (const c of [validateConfig({ harness: 'claude', model: 'm1', prepareAhead: 'on' }), validateConfig({ harness: 'claude', headSkillsInPrompt: true, prepareAhead: 'on', extraArgs: ['--x'] })]) {
    const head = buildCommand(c, 'P', ROOT, env);
    const conf = buildCommand(c, 'P', ROOT, env, { confirm: 'ses-123' });
    const r = conf.indexOf('--resume');
    assert.ok(r > 0);
    assert.deepStrictEqual(conf.slice(r, r + 3), ['--resume', 'ses-123', '--fork-session']);
    // Everything else exactly the head trader's: its tools whole (it composes through compose_check as the head does).
    assert.deepStrictEqual([...conf.slice(0, r), ...conf.slice(r + 3)], head);
    assert.ok(flag(conf, '--allowedTools').split(',').includes('mcp__harness'), 'compose_check with the harness tools');
    assert.ok(!conf.includes('--effort'), 'the confirm\'s effort is the head trader\'s (an open owner decision: none)');
  }
  const c = validateConfig({ harness: 'claude', prepareAhead: 'on' });
  assert.throws(() => buildCommand(validateConfig({ harness: 'opencode' }), 'P', ROOT, env, { confirm: 'ses-1' }), /prepare ahead runs on Claude Code only/);
  for (const bad of ['', 7, {}]) assert.throws(() => buildCommand(c, 'P', ROOT, env, { confirm: bad }), /the confirm resumes the prepare's session/, String(bad));
  assert.throws(() => buildCommand(c, 'P', ROOT, env, { confirm: 'ses-1', agent: 'risk-manager' }), /never a role's run/);
  assert.throws(() => buildCommand(c, 'P', ROOT, env, { confirm: 'ses-1', prepare: 'prepare' }), /a shadow run or the confirm, never both/);
});

test('childEnv "on": the confirm runs under the close\'s cycle env (its entry, roles; the normal gate log), with FTH_CONFIRM_BASE its plan record; never FTH_PREPARE; no other run has the base, an inherited one is dropped', () => {
  const c = validateConfig({ harness: 'claude', prepareAhead: 'on' });
  const home = tmpDir();
  const base = { FTH_HOME: home, FTH_GATE_LOG: '/old/gate.jsonl', FTH_CONFIRM_BASE: '/inherited.json', FTH_PREPARE: 'confirm' };
  const plan = path.join(home, 'prepare', 'MNQ-20260428T041200000Z.json');
  const ctx = { action: 'trade', entry: true, rolesFile: path.join(home, 'roles.jsonl'), confirmBase: plan };
  const conf = childEnv(c, ROOT, base, ctx);
  const head = childEnv(c, ROOT, base, { action: 'trade', entry: true, rolesFile: path.join(home, 'roles.jsonl') });
  assert.strictEqual(conf.FTH_CONFIRM_BASE, plan);
  assert.ok(!('FTH_PREPARE' in conf) && !('FTH_PREPARE_SESSION' in conf), 'the stop hook asks it for its CYCLE RESULT, as the head trader');
  assert.strictEqual(conf.FTH_GATE_LOG, '/old/gate.jsonl', 'the normal gate log: it is the close\'s real head run');
  // The head trader's env but the base and its own transcript (so its own cycle id).
  const { FTH_CONFIRM_BASE: _b, FTH_CYCLE_TRANSCRIPT: t1, ...restConf } = conf;
  const { FTH_CYCLE_TRANSCRIPT: t2, ...restHead } = head;
  assert.deepStrictEqual(restConf, restHead);
  assert.ok(t1 && t2 && t1 !== t2);
  // Any other run: no base, inherited or not; a base not in <home>/prepare/, or not absolute, is never given.
  for (const other of [null, { action: 'trade' }, { action: 'trade', roleRun: 'trade-executor', confirmBase: plan }, { action: 'trade', prepare: 'prepare', confirmBase: plan }, { action: 'trade', confirmBase: 'prepare/x.json' }, { action: 'trade', confirmBase: path.join(home, 'x.json') }]) {
    assert.ok(!('FTH_CONFIRM_BASE' in childEnv(c, ROOT, base, other)), JSON.stringify(other));
  }
});
