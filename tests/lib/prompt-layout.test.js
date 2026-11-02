'use strict';

// The prompts' stable-first layout (autotrader.js TRADE_ORDER, the runner config's stableFirstPrompt: Claude Code's
// default): what holds across cycles comes first, byte for byte, so consecutive cycles' prompts share it as a prefix a
// prompt cache can reuse; the cycle's own data comes after it. The head trader's prompt and the role runs' system-prompt
// files (role-prompt.js, head-prompt.js) are checked across two cycles; the situational skills' attestation is checked
// on the reordered prompt.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validateConfig, prompts, childEnv, buildCommand, TRADE_ORDER } = require('../../scripts/lib/autotrader');
const { runRole } = require('../../scripts/lib/cycle-run');
const { REQUESTS } = require('../../scripts/lib/orchestrate/requests');
const SS = require('../../scripts/lib/situational-skills');
const CA = require('../../scripts/lib/cycle-skills-attest');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const T1 = new Date('2026-10-07T14:03:05Z');
const T2 = new Date('2026-10-07T14:06:05Z');

const sharedPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1; return i; };
const item = (t, c) => ({ symbol: 'MNQ', scan: [], verdicts: [], notEntries: [], bar: { t, c, file: '/bars/MNQ-3m.json', contractId: 'MNQ', trend: 'Trend rule: LONG allowed.', day: `Today: open ${c}`, recent: [{ t, o: c - 1, h: c + 1, l: c - 2, c, v: 100 }] } });
const account = (at, balance) => ({ id: '7', at: at.toISOString(), balance, positions: [], orders: [], workingOrders: 0 });
const cached = text => ({ roles: ['market-structure-analyst'], reports: [{ role: 'market-structure-analyst', text, at: T1.toISOString(), until: null, source: 'desk' }] });
// The situational section as the runner builds it (situational-skills.js), for a fixed choice.
const chosen = { skills: ['rejection', 'candle-reading'], sections: [], over: [], why: ['a level rejected', 'a candle rejected a level'], stages: ['setup', 'entry'], bytes: 0 };

function twoCycles(cfg, situation) {
  const text = situation ? SS.situationText(ROOT, situation) : '';
  const opts = (t, c, report) => ({ state: account(t, 50000 + c), cached: cached(report), cycleSkills: text });
  const P = (t, c, report) => prompts(cfg, t, ROOT).trade([item(new Date(t.getTime() - 185000).toISOString(), c)], opts(t, c, report));
  const parts = prompts(cfg, T1, ROOT).trade([item(new Date(T1.getTime() - 185000).toISOString(), 27400)], opts(T1, 27400, 'Bias: long'), { raw: true });
  return { a: P(T1, 27400, 'Bias: long'), b: P(T2, 27410.25, 'Bias: short'), parts };
}

test('the head trader\'s trade prompt, stable first: two cycles share the stable part, the instructions and the situation byte for byte, and differ only after them', () => {
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '' });
  const { a, b, parts } = twoCycles(cfg, chosen);
  const stable = parts.stable + parts.instructions + parts.situation;
  assert.ok(parts.situation.includes('<skill name="rejection">'), 'the section embeds its skills');
  assert.ok(a.startsWith(stable) && b.startsWith(stable), 'both start with the stable part');
  const shared = sharedPrefix(a, b);
  assert.ok(shared >= stable.length, `shared ${shared} < stable ${stable.length}`);
  assert.strictEqual(a.slice(0, stable.length), b.slice(0, stable.length));
  // The first byte that differs is in the cycle's own part: its time.
  assert.ok(a.slice(stable.length).startsWith(' The cycle\'s time: '), a.slice(stable.length, stable.length + 40));
  // The situation is most of the prompt: with the old order (the time second) the two shared only the stable head.
  const old = twoCycles(validateConfig({ harness: 'claude', account: '7', premarketAt: '', stableFirstPrompt: false }), chosen);
  assert.ok(sharedPrefix(old.a, old.b) < parts.stable.length + 40, 'the old order: the time comes right after the stable head');
  assert.strictEqual(old.a.length, a.length, 'the same text, reordered');
});

test('a changed situation keeps the stable part and the instructions shared; a cycle in no situation shares them too', () => {
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '' });
  const one = twoCycles(cfg, chosen);
  const other = twoCycles(cfg, { ...chosen, skills: ['breakout'], why: ['a level broken'] });
  const none = twoCycles(cfg, null);
  const base = one.parts.stable + one.parts.instructions;
  for (const p of [other.a, none.a]) assert.ok(sharedPrefix(one.a, p) >= base.length);
  assert.strictEqual(none.parts.situation, '');
  assert.ok(none.a.startsWith(`${base} The cycle's time: `));
  assert.deepStrictEqual(TRADE_ORDER.slice(0, 3), ['stable', 'instructions', 'situation']);
});

test('the situational skills\' attestation is unaffected by the order: the run\'s environment attests the section the reordered prompt holds, and the gate counts it', () => {
  const home = tmpDir();
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '', dataDir: path.join(home, 'bars') });
  const { a, parts } = twoCycles(cfg, chosen);
  const env = childEnv(cfg, ROOT, { FTH_HOME: home, HOME: home }, { action: 'trade', cycleSkills: chosen, symbols: [] });
  const att = CA.parseAttestation(env[CA.ATTEST_ENV]);
  assert.ok(att, 'attested');
  const text = fs.readFileSync(att.config, 'utf8');
  assert.strictEqual(text, parts.situation, 'the attested file is the section in the prompt');
  assert.ok(a.includes(text));
  const stream = path.join(home, 'stream.jsonl');
  fs.writeFileSync(stream, JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }));
  assert.deepStrictEqual(CA.attested(att, ROOT, { stream, cycle: att.cycle }).sort(), ['candle-reading', 'rejection']);
});

test('a role\'s run: its stable part is its system prompt (its agent and, with roleSkillsInPrompt, its skills file), the same bytes every cycle; the request is the cycle\'s', async () => {
  const home = tmpDir();
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '', roleSkillsInPrompt: true, dataDir: path.join(home, 'bars') });
  const ctx = at => ({ symbol: 'MNQ', contractId: 'MNQ', at, timeframe: 3, bars: '/bars/MNQ-3m.json' });
  for (const role of ['market-structure-analyst', 'risk-manager', 'trade-executor']) {
    const seen = [];
    const run = async argv => { seen.push(argv); return { ok: true, timedOut: false, code: 0, output: '', stdout: '' }; };
    const request = at => (role === 'trade-executor' ? REQUESTS.execute(role, { ...ctx(at), args: { size: 3 }, verdict: 'VERDICT: APPROVE - size 3' }) : REQUESTS.desk(role, ctx(at)));
    for (const at of [T1.toISOString(), T2.toISOString()]) await runRole(cfg, role, request(at), { timeoutMs: 1000, context: { action: 'trade', symbols: [] } }, { root: ROOT, env: { FTH_HOME: home, HOME: home }, run });
    const [x, y] = seen;
    const file = argv => argv[argv.indexOf('--append-system-prompt-file') + 1];
    assert.ok(x.includes('--append-system-prompt-file'), role);
    assert.strictEqual(file(x), file(y), `${role}: the same file (its text's hash) both cycles`);
    assert.strictEqual(fs.readFileSync(file(x), 'utf8'), require('../../scripts/lib/role-prompt').claudeRoleText(ROOT, role));
    assert.ok(!fs.readFileSync(file(x), 'utf8').includes(T1.toISOString()), `${role}: no cycle data in the file`);
    // Everything but the request is the same both cycles; the requests differ.
    const at = x.indexOf(request(T1.toISOString()));
    assert.ok(at > 0, role);
    assert.deepStrictEqual([...x.slice(0, at), ...x.slice(at + 1)], [...y.slice(0, at), ...y.slice(at + 1)], role);
    assert.notStrictEqual(x[at], y[at]);
  }
});

test('the head trader with headSkillsInPrompt: its skills file holds no cycle data, the same bytes every cycle', () => {
  const home = tmpDir();
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '', headSkillsInPrompt: true, dataDir: path.join(home, 'bars') });
  const env = { FTH_HOME: home, HOME: home };
  const [x, y] = [twoCycles(cfg, chosen).a, twoCycles(cfg, chosen).b].map(p => buildCommand(cfg, p, ROOT, env));
  const file = argv => argv[argv.indexOf('--append-system-prompt-file') + 1];
  assert.strictEqual(file(x), file(y));
  assert.deepStrictEqual(x.filter(v => v !== x[2]), y.filter(v => v !== y[2]), 'the argv but the prompt');
});

test('a role\'s run keeps its prompt-cache use (Claude Code\'s result event), and the engine\'s envelope carries it; another harness\'s none', async () => {
  const home = tmpDir();
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '', dataDir: path.join(home, 'bars') });
  const stream = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 2, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500, output_tokens: 9 }, content: [{ type: 'text', text: 'Data: x' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'Data: x', usage: { input_tokens: 2, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500, output_tokens: 9 } }),
  ].join('\n');
  const run = async () => ({ ok: true, timedOut: false, code: 0, output: stream, stdout: stream });
  const r = await runRole(cfg, 'market-structure-analyst', 'request', { timeoutMs: 1000, context: { action: 'trade', symbols: [] } }, { root: ROOT, env: { FTH_HOME: home, HOME: home }, run });
  assert.deepStrictEqual(r.usage, { total: { input: 2, cacheRead: 30000, cacheCreation: 500, output: 9 }, first: { input: 2, cacheRead: 30000, cacheCreation: 500, output: 9 }, turns: 1 });
  const { createRun } = require('../../scripts/lib/orchestrate/engine');
  const env = await createRun({ engine: { run: async () => r } }).agent('market-structure-analyst', 'request');
  assert.deepStrictEqual(env.usage, r.usage);
  const none = await createRun({ engine: { run: async () => ({ ok: true, text: 'x', tools: [] }) } }).agent('market-structure-analyst', 'request');
  assert.strictEqual(none.usage, undefined);
});

test('the cycle log keeps the head trader\'s prompt-cache use on Claude Code (its summary\'s usage); none on another harness or without a result event', () => {
  const { writeCycleLog } = require('../../scripts/lib/cycle-log');
  const out = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
    JSON.stringify({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 1, cache_read_input_tokens: 25310, cache_creation_input_tokens: 59000, output_tokens: 5 }, content: [{ type: 'text', text: 'CYCLE RESULT: no-trade - x' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'CYCLE RESULT: no-trade - x', usage: { input_tokens: 1, cache_read_input_tokens: 25310, cache_creation_input_tokens: 59000, output_tokens: 5 } }),
  ].join('\n');
  const at = new Date('2026-10-07T14:03:05Z');
  const w = (harness, output) => writeCycleLog(tmpDir(), { at, action: 'trade', harness, prompt: 'p', output, result: 'CYCLE RESULT: no-trade - x' }).summary;
  assert.deepStrictEqual(w('claude', out).usage.first, { input: 1, cacheRead: 25310, cacheCreation: 59000, output: 5 });
  assert.strictEqual(w('opencode', out).usage, undefined);
  assert.strictEqual(w('claude', 'CYCLE RESULT: no-trade - x').usage, undefined);
});

// --- Freshness: the cached prefix holds static text only (no market or account data), keyed by its content. ---

test('the stable prefix holds no per-cycle data: two cycles with other bars, briefing facts, desk reports, account and positions share it byte for byte, and none of that is in it', () => {
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '' });
  const text = SS.situationText(ROOT, chosen);
  const P = (t, c, report, positions) => prompts(cfg, t, ROOT).trade([item(new Date(t.getTime() - 185000).toISOString(), c)], { state: { ...account(t, 51234.5 + c), positions, workingOrders: positions.length }, cached: cached(report), cycleSkills: text });
  const pos = [{ contractId: 'MNQ', type: 1, size: 3, averagePrice: 27399.75 }];
  const a = P(T1, 27400, 'Bias: long MARKER-REPORT-A', []);
  const b = P(T2, 27410.25, 'Bias: short MARKER-REPORT-B', pos);
  const parts = prompts(cfg, T1, ROOT).trade([item(new Date(T1.getTime() - 185000).toISOString(), 27400)], { state: account(T1, 1), cycleSkills: text }, { raw: true });
  const prefix = parts.stable + parts.instructions + parts.situation;
  assert.strictEqual(a.slice(0, prefix.length), prefix);
  assert.strictEqual(b.slice(0, prefix.length), prefix);
  // Each cycle's own data: in its cycle part, never in the prefix.
  for (const datum of ['27400', '27410.25', '27399.75', 'MARKER-REPORT-A', 'MARKER-REPORT-B', 'Account 7 at', T1.toISOString(), T2.toISOString(), '/bars/MNQ-3m.json', 'Trend rule: LONG allowed', 'Today: open']) {
    assert.ok(!prefix.includes(datum), `the prefix holds "${datum}"`);
    assert.ok(a.slice(prefix.length).includes(datum) || b.slice(prefix.length).includes(datum), `the cycle part holds "${datum}"`);
  }
  assert.ok(b.slice(prefix.length).includes('MNQ long 3 @ 27399.75') || b.slice(prefix.length).includes('27399.75'), 'the position, in the cycle part');
});

test('the cached prefix is keyed by its content: a skill\'s edit gives another situational section, another role file and another head file, never a stale one', () => {
  const root = tmpDir();
  for (const d of ['skills', 'agents', 'rules', 'strategies', 'accounts', 'commands', '.claude-plugin']) if (fs.existsSync(path.join(ROOT, d))) fs.cpSync(path.join(ROOT, d), path.join(root, d), { recursive: true });
  if (fs.existsSync(path.join(ROOT, 'package.json'))) fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  const RP = require('../../scripts/lib/role-prompt');
  const HP = require('../../scripts/lib/head-prompt');
  const home = tmpDir();
  const now = () => ({ section: SS.situationText(root, chosen), role: RP.claudeRoleFile(home, 'risk-manager', RP.claudeRoleText(root, 'risk-manager')), head: HP.claudeHeadFile(home, HP.claudeHeadText(root)) });
  const before = now();
  assert.deepStrictEqual(now(), before, 'unchanged documents: the same prefix');
  // Edit a skill each of them embeds (the section's and the head trader's rejection, the role's first role-skill).
  const roleSkill = RP.rolePlan(root, 'risk-manager').plan.docs[0].name;
  for (const s of new Set(['rejection', roleSkill])) {
    const f = path.join(root, 'skills', s, 'SKILL.md');
    fs.writeFileSync(f, `${fs.readFileSync(f, 'utf8').trimEnd()}\n\n- An edited line.\n`);
  }
  const after = now();
  assert.notStrictEqual(after.section, before.section);
  assert.ok(after.section.includes('An edited line.'));
  assert.notStrictEqual(after.role, before.role, 'the role file is named by its text\'s hash');
  assert.notStrictEqual(after.head, before.head, 'the head file is named by its text\'s hash');
});

test('no live field (price, positions, orders, account, the bar, the clock) is in a cached artefact: the role files, the head trader\'s skills file, the situational section the runs wrote', async () => {
  const home = tmpDir();
  const cfg = validateConfig({ harness: 'claude', account: '7', premarketAt: '', headSkillsInPrompt: true, roleSkillsInPrompt: true, dataDir: path.join(home, 'bars') });
  // A cycle with marked live data: its bar, its time, its account and position, a desk report.
  const BAR_T = '2031-02-03T04:05:00.000Z';
  const context = { action: 'trade', cycleSkills: chosen, symbols: [{ symbol: 'MNQ', bar: { t: BAR_T, contractId: 'MNQ', file: '/marked/MNQ-3m-77777.json' } }], cachedRoles: [] };
  const base = { FTH_HOME: home, HOME: home };
  const run = async () => ({ ok: true, timedOut: false, code: 0, output: '', stdout: '' });
  const request = REQUESTS.desk('risk-manager', { symbol: 'MNQ', contractId: 'MNQ', at: '2031-02-03T04:08:00.000Z', timeframe: 3, bars: '/marked/MNQ-3m-77777.json' }) + '\n--- account ---\nbalance 98765.43, MNQ long 3 @ 12345.75\n';
  for (const role of ['market-structure-analyst', 'risk-manager', 'trade-executor']) await runRole(cfg, role, request, { timeoutMs: 1000, context }, { root: ROOT, env: base, run });
  childEnv(cfg, ROOT, base, context);
  const files = ['role-prompt', 'head-prompt'].flatMap(d => fs.readdirSync(path.join(home, d)).map(f => path.join(home, d, f)));
  assert.ok(files.some(f => /claude-head-/.test(f)) && files.some(f => /cycle-skills-/.test(f)) && files.filter(f => /role-prompt/.test(f)).length === 3, files.join(', '));
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    for (const live of ['98765.43', '12345.75', '77777', BAR_T, '2031-02-03', 'balance 98765']) assert.ok(!t.includes(live), `${path.basename(f)} holds "${live}"`);
  }
});
