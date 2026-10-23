'use strict';

// Which skills a role the runner ran had (role-skills-record.js), in the cycle log's desk and entry records: detection
// only, on every harness, the roleSkillsInPrompt key on or off; a role's loads are its own run's, never another's.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = require('../../scripts/lib/role-skills-record');
const { runRole, runCycle } = require('../../scripts/lib/cycle-run');
const { validateConfig } = require('../../scripts/lib/autotrader');
const roleSkills = require('../../scripts/lib/role-skills');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const SKILLS = role => roleSkills.loadRoles(ROOT).find(a => a.name === role).skills;
const TREND = 'trend-momentum-analyst';

const use = (id, name, input, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id, text, extra = {}) => JSON.stringify({ type: 'user', ...extra, message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const init = session => JSON.stringify({ type: 'system', subtype: 'init', session_id: session, tools: ['Skill'] });
const done = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Data: bar_briefing\nBias: long' });
/** A Claude Code role run's stream: its own Skill loads (`skills`), its own skill_lookup reads (`looked`). */
const stream = ({ session = 's-role', skills = [], looked = [] } = {}) => [
  init(session),
  ...skills.flatMap((s, i) => [use(`k${i}`, 'Skill', { skill: s }), res(`k${i}`, 'loaded')]),
  ...looked.flatMap((s, i) => [use(`l${i}`, 'mcp__harness__skill_lookup', { skill: s, role: TREND }), res(`l${i}`, `<skill name="${s}">\nbody\n</skill>`)]),
  done,
].join('\n');

test('a role\'s transcript with no loads, the key off: every role-skill missing', () => {
  const r = R.roleSkills({ root: ROOT, role: TREND, output: stream() });
  assert.deepStrictEqual(r.expected, SKILLS(TREND));
  assert.deepStrictEqual([r.embedded, r.loaded, r.had], [[], [], []]);
  assert.deepStrictEqual(r.missing, SKILLS(TREND));
  assert.deepStrictEqual(R.skillsMissing([{ role: TREND, skills: r }]), { [TREND]: SKILLS(TREND) });
  assert.strictEqual(R.missingLine(R.skillsMissing([{ role: TREND, skills: r }])), `desk: roles ran without their skills: ${TREND} [${SKILLS(TREND).join(', ')}]`);
});

test('a role with all its loads (Skill calls, skill_lookup reads, its own session\'s tool-call log): none missing', () => {
  const all = SKILLS(TREND);
  const half = Math.floor(all.length / 2);
  assert.deepStrictEqual(R.roleSkills({ root: ROOT, role: TREND, output: stream({ skills: all }) }).missing, []);
  assert.deepStrictEqual(R.roleSkills({ root: ROOT, role: TREND, output: stream({ skills: all.slice(0, half), looked: all.slice(half) }) }).missing, []);
  // A skill_lookup whose reply isn't the skill (a refusal) read nothing.
  const refused = [init('s'), use('l0', 'mcp__harness__skill_lookup', { skill: all[0] }), res('l0', 'no such skill'), done].join('\n');
  assert.deepStrictEqual(R.roleSkills({ root: ROOT, role: TREND, output: refused }).loaded, []);
  // The tool-call log of the run's own session (logs/toolcall/<session>.jsonl): a completed call is a load.
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'toolcall'), { recursive: true });
  const post = (session, name, skill) => JSON.stringify({ event: 'post', call: { tool: name, name, args: { skill }, session }, result: { text: 'sha256:x' } });
  fs.writeFileSync(path.join(home, 'logs', 'toolcall', 's-role.jsonl'), [...all.map(s => post('s-role', 'Skill', s)), JSON.stringify({ event: 'pre', call: { name: 'Skill', args: { skill: 'x' }, session: 's-role' } })].join('\n'));
  const r = R.roleSkills({ root: ROOT, role: TREND, output: stream({ session: 's-role' }), home });
  assert.deepStrictEqual([r.loaded, r.missing], [[...all].sort(), []]);
  // A pre event alone (the call not completed) is no load.
  assert.ok(!r.loaded.includes('x'));
});

test('the key on: the embedded skills count, so none is missing', () => {
  const r = R.roleSkills({ root: ROOT, role: TREND, output: stream(), embedded: SKILLS(TREND) });
  assert.deepStrictEqual([r.embedded, r.loaded, r.missing], [[...SKILLS(TREND)].sort(), [], []]);
  assert.deepStrictEqual(R.withSkillsMissing([{ role: TREND, skills: r }]), {});
});

test('another role\'s loads, and the head trader\'s, never count for a role', () => {
  const all = SKILLS(TREND);
  // Another session's tool-call log (another role's run, or the head trader's): not this run's.
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'logs', 'toolcall'), { recursive: true });
  const post = (session, skill) => JSON.stringify({ event: 'post', call: { name: 'Skill', args: { skill }, session }, result: { text: 'ok' } });
  fs.writeFileSync(path.join(home, 'logs', 'toolcall', 's-head.jsonl'), all.map(s => post('s-head', s)).join('\n'));
  fs.writeFileSync(path.join(home, 'logs', 'toolcall', 's-other.jsonl'), all.map(s => post('s-other', s)).join('\n'));
  // A line naming another session in this one's file is not this session's either.
  fs.writeFileSync(path.join(home, 'logs', 'toolcall', 's-role.jsonl'), all.map(s => post('s-head', s)).join('\n'));
  assert.deepStrictEqual(R.roleSkills({ root: ROOT, role: TREND, output: stream({ session: 's-role' }), home }).missing, all);
  // No session in the stream: no tool-call log is read.
  assert.deepStrictEqual(R.roleSkills({ root: ROOT, role: TREND, output: done, home }).loaded, []);
  // A skill another role loaded in its own run (its own output) is in that run's record only.
  const other = R.roleSkills({ root: ROOT, role: 'market-structure-analyst', output: stream({ session: 's-other', skills: all }) });
  const mine = R.roleSkills({ root: ROOT, role: TREND, output: stream({ session: 's-role' }) });
  assert.deepStrictEqual([other.loaded.length > 0, mine.missing], [true, all]);
});

test('runRole: each role run\'s record is its own run\'s (its stream, its session), the head trader\'s loads never in it; key on, empty through the file', async () => {
  const home = tmpDir();
  const env = { FTH_HOME: home, HOME: home, PATH: process.env.PATH };
  fs.mkdirSync(path.join(home, 'logs', 'toolcall'), { recursive: true });
  // The head trader's session loaded every skill: its log is beside the role's.
  fs.writeFileSync(path.join(home, 'logs', 'toolcall', 's-head.jsonl'), SKILLS(TREND).map(s => JSON.stringify({ event: 'post', call: { name: 'Skill', args: { skill: s }, session: 's-head' } })).join('\n'));
  const outputs = { [TREND]: stream({ session: 's-trend', skills: ['bar-briefing'] }), 'market-structure-analyst': stream({ session: 's-ms', skills: SKILLS(TREND) }) };
  const seen = [];
  const run = async (argv, o) => {
    const role = o.env.FTH_ROLE_RUN;
    seen.push({ argv, role });
    return { ok: true, timedOut: false, code: 0, output: outputs[role] || stream({ session: `s-${role}` }), stdout: outputs[role] || stream({ session: `s-${role}` }) };
  };
  const off = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'] });
  const t = await runRole(off, TREND, 'report', { timeoutMs: 5000 }, { root: ROOT, home, env, run });
  assert.deepStrictEqual([t.skills.loaded, t.skills.missing], [['bar-briefing'], SKILLS(TREND).filter(s => s !== 'bar-briefing')]);
  assert.ok(!seen[0].argv.includes('--append-system-prompt-file'), 'the key off: no prompt addition');
  // The key on: every runner role's run gets its file, and nothing it should have is missing.
  const on = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'], roleSkillsInPrompt: true });
  for (const role of require('../../scripts/lib/opencode').RUNNER_RUN_ROLES()) {
    const r = await runRole(on, role, 'report', { timeoutMs: 5000 }, { root: ROOT, home, env, run });
    const argv = seen.at(-1).argv;
    const file = argv[argv.indexOf('--append-system-prompt-file') + 1];
    assert.ok(argv.indexOf('--append-system-prompt-file') > argv.indexOf('--agent'), role);
    assert.strictEqual(file, require('../../scripts/lib/role-prompt').claudeRoleFile(home, role, fs.readFileSync(file, 'utf8')), `${role}: its file, written before its run`);
    assert.deepStrictEqual(r.skills.embedded, [...SKILLS(role)].sort(), role);
    // A non-empty `missing` with the key on is a bug.
    assert.deepStrictEqual(r.skills.missing, [], `${role}: the key on, nothing missing`);
  }
});

test('runCycle: one runner log line a cycle when the desk or the entry record names roles missing skills; the summary line says it; none when none', async () => {
  const lines = async context => {
    const home = tmpDir();
    const errs = [];
    const run = async () => ({ ok: true, timedOut: false, code: 0, output: 'CYCLE RESULT: no-trade - x\n', stdout: 'CYCLE RESULT: no-trade - x\n' });
    const cfg = validateConfig({ harness: 'claude', premarketAt: '', symbols: ['MNQ'] });
    await runCycle(cfg, 'trade', 'p', {}, { timeoutMs: 60000, context }, { root: ROOT, home, env: { FTH_HOME: home, HOME: home }, run, out: () => {}, err: t => errs.push(t), guard: () => true });
    const summary = JSON.parse(fs.readFileSync(path.join(home, 'logs', fs.readdirSync(path.join(home, 'logs')).find(f => /^cycles-.*\.jsonl$/.test(f))), 'utf8').trim());
    return { errs: errs.filter(e => /without their skills/.test(e)), summary };
  };
  const missing = { [TREND]: ['bos-vs-choch', 'bar-briefing'] };
  const a = await lines({ action: 'trade', desk: { results: [], missing: [], ms: 1, skillsMissing: missing } });
  assert.deepStrictEqual(a.errs, [`[autotrader] desk: roles ran without their skills: ${TREND} [bos-vs-choch, bar-briefing]\n`]);
  assert.deepStrictEqual(a.summary.roleSkillsMissing, { desk: missing });
  const b = await lines({ action: 'trade', desk: { results: [], missing: [], ms: 1 } });
  assert.deepStrictEqual([b.errs, b.summary.roleSkillsMissing], [[], undefined]);
});
