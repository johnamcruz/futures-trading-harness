'use strict';

// The harness tool skill_lookup (scripts/lib/harness-tools/skills.js): a whole skill by name, read-only, refusing
// anything that isn't a skill under skills/, and recording a role's lookup in a runner's cycle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const K = require('../../scripts/lib/harness-tools/skills');
const { BY_NAME } = require('../../scripts/lib/harness-tools/registry');
const { validate } = require('../../scripts/lib/harness-tools/validate');
const { readLookups } = require('../../scripts/lib/trading/skill-lookups');
const { parseFrontmatter } = require('../../scripts/lib/frontmatter');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('skill_lookup: the whole skill, wrapped with its name', () => {
  const { body } = parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', 'fair-value-gaps', 'SKILL.md'), 'utf8'));
  assert.strictEqual(K.skillLookup({ skill: 'fair-value-gaps' }, { env: {} }).text, `<skill name="fair-value-gaps">\n${body.trim()}\n</skill>\n`);
});

test('skill_lookup: unknown skills, paths, and a skill folder that leads outside skills/ are refused', () => {
  for (const skill of ['no-such-skill', '../agents', 'skills/x', '/etc/passwd', '.hidden', 'A', '']) {
    assert.throws(() => K.skillLookup({ skill }, { env: {} }), /--skill: a skill's name|no skill/, String(skill));
  }
  // A root whose skills/ holds a symlink out of it.
  const root = tmpDir();
  const outside = path.join(tmpDir(), 'evil');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: evil\n---\nsecret\n');
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'skills', 'evil'), 'dir');
  assert.throws(() => K.skillLookup({ skill: 'evil' }, { env: {}, root }), /is not a file under skills\/: refused/);
  assert.throws(() => K.skillLookup({ skill: 'fair-value-gaps', role: '../x' }, { env: {} }), /--role/);
  // The tool's schema refuses them first.
  const schema = BY_NAME.get('skill_lookup').inputSchema;
  assert.deepStrictEqual(validate(schema, { skill: 'fair-value-gaps', role: 'risk-manager' }), []);
  assert.match(validate(schema, { skill: '../x' }).join(';'), /must match/);
  assert.match(validate(schema, { skill: 'x', section: 'y' }).join(';'), /"section": unknown argument/);
  assert.deepStrictEqual(validate(schema, {}), [], 'no skill: the catalog');
  assert.deepStrictEqual(validate(schema, { query: 'vwap' }), []);
  assert.throws(() => K.skillLookup({ query: '' }, { env: {} }), /--query/, 'an empty query: the operation refuses it');
  assert.match(validate(schema, { query: 'x'.repeat(65) }).join(';'), /query/);
});

test('skill_lookup: a role\'s lookup in a runner\'s cycle is recorded; none outside one, none without a role, none refused', () => {
  const transcript = path.join(tmpDir(), 'cycle-transcript.jsonl');
  const env = { FTH_CYCLE_TRANSCRIPT: transcript };
  K.skillLookup({ skill: 'fair-value-gaps', role: 'volume-liquidity-analyst' }, { env, wallNow: () => 123 });
  K.skillLookup({ skill: 'fair-value-gaps' }, { env });
  assert.throws(() => K.skillLookup({ skill: 'nope', role: 'volume-liquidity-analyst' }, { env }));
  K.skillLookup({ skill: 'fair-value-gaps', role: 'volume-liquidity-analyst' }, { env: {} });
  assert.deepStrictEqual(readLookups(transcript), [{ at: 123, role: 'volume-liquidity-analyst', skill: 'fair-value-gaps' }]);
});

test('skill_lookup without skill: every skill under skills/, sorted, one line each with its description', () => {
  const names = fs.readdirSync(path.join(ROOT, 'skills')).filter(n => fs.existsSync(path.join(ROOT, 'skills', n, 'SKILL.md'))).sort();
  const cat = K.skillCatalog(ROOT);
  assert.deepStrictEqual(cat.map(k => k.name), names);
  for (const k of cat) {
    const { data } = parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', k.name, 'SKILL.md'), 'utf8'));
    assert.strictEqual(k.description, String(data.description).replace(/\s+/g, ' ').trim(), k.name);
    assert.ok(k.description, `${k.name}: a description`);
  }
  const text = K.skillLookup({}, { env: {} }).text;
  const lines = text.trimEnd().split('\n');
  assert.strictEqual(lines[0], `Every skill of the harness (${names.length}); skill_lookup with skill reads one whole:`);
  assert.deepStrictEqual(lines.slice(1), cat.map(k => `- ${k.name}: ${k.description}`));
  assert.strictEqual(K.skillLookup({ skill: null, role: 'risk-manager' }, { env: {} }).text, text, 'a role changes nothing');
});

test('skill_lookup query: name or description contains it (any case); none says so; bad queries refused', () => {
  const lines = K.skillLookup({ query: ' VWAP ' }, { env: {} }).text.trimEnd().split('\n');
  const want = K.skillCatalog(ROOT).filter(k => k.name.includes('vwap') || k.description.toLowerCase().includes('vwap'));
  assert.ok(want.length >= 2);
  assert.match(lines[0], new RegExp(`^Skills matching "VWAP" \\(${want.length} of \\d+\\)`));
  assert.deepStrictEqual(lines.slice(1).map(l => l.split(':')[0]), want.map(k => `- ${k.name}`));
  assert.match(K.skillLookup({ query: 'fair-value-gaps' }, { env: {} }).text, /^- fair-value-gaps: /m, 'by name');
  assert.match(K.skillLookup({ query: 'zzzz-no-such' }, { env: {} }).text, /\(0 of \d+\)\. None: call skill_lookup without query/);
  for (const query of ['', '   ', 'x'.repeat(65), 7]) assert.throws(() => K.skillLookup({ query }, { env: {} }), /--query/, String(query));
  assert.throws(() => K.skillLookup({ skill: 'fair-value-gaps', query: 'x' }, { env: {} }), /give one of them/);
});

test('skill_lookup catalog: a skill that leads outside skills/ (a symlink) is not listed; nor folders without SKILL.md, a bad name or bad frontmatter', () => {
  const root = tmpDir();
  const outside = path.join(tmpDir(), 'evil');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: evil\ndescription: secret\n---\nsecret\n');
  fs.mkdirSync(path.join(root, 'skills', 'good'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: "two \\n  lines"\n---\nbody\n');
  fs.mkdirSync(path.join(root, 'skills', 'empty'));
  fs.mkdirSync(path.join(root, 'skills', 'Bad_Name'));
  fs.writeFileSync(path.join(root, 'skills', 'Bad_Name', 'SKILL.md'), '---\nname: x\n---\n');
  fs.mkdirSync(path.join(root, 'skills', 'broken'));
  fs.writeFileSync(path.join(root, 'skills', 'broken', 'SKILL.md'), '---\ndescription: >-\n  x\n---\n');
  fs.symlinkSync(outside, path.join(root, 'skills', 'evil'), 'dir');
  assert.deepStrictEqual(K.skillCatalog(root), [{ name: 'good', description: 'two lines' }]);
  assert.doesNotMatch(K.skillLookup({}, { env: {}, root }).text, /evil|secret/);
  assert.doesNotMatch(K.skillLookup({ query: 'secret' }, { env: {}, root }).text, /evil/);
});

test('skill_lookup catalog: a listing is not a lookup, nothing recorded, with a role or a query naming a skill', () => {
  const transcript = path.join(tmpDir(), 'cycle-transcript.jsonl');
  const env = { FTH_CYCLE_TRANSCRIPT: transcript };
  K.skillLookup({ role: 'volume-liquidity-analyst' }, { env, wallNow: () => 1 });
  K.skillLookup({ query: 'fair-value-gaps', role: 'volume-liquidity-analyst' }, { env, wallNow: () => 2 });
  assert.deepStrictEqual(readLookups(transcript), []);
  assert.strictEqual(fs.existsSync(`${transcript}.lookups.jsonl`), false);
});

test('skill-lookup.js: the CLI prints the skill; a bad argument fails', () => {
  assert.deepStrictEqual(K.parseArgv(['--skill', 'a', '--role=b']), { skill: 'a', role: 'b', query: null });
  assert.deepStrictEqual(K.parseArgv(['--query=vwap']), { skill: null, role: null, query: 'vwap' });
  // A flag without its value is refused: never read as left out (which would list every skill).
  assert.throws(() => K.parseArgv(['--skill']), /--skill: give its value/);
  assert.throws(() => K.parseArgv(['--query']), /--query: give its value/);
  assert.throws(() => K.parseArgv(['--skill', '--role', 'r']), /--skill: give its value/);
  assert.throws(() => K.parseArgv(['--role', 'r', '--query']), /--query: give its value/);
  assert.throws(() => K.parseArgv(['--role']), /--role: give its value/);
  for (const flag of ['--skill', '--query']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-lookup.js'), flag], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, flag);
    assert.strictEqual(r.stdout, '', flag);
    assert.match(r.stderr, new RegExp(`^\\[skill-lookup\\] ${flag}: give its value`), flag);
  }
  const list = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-lookup.js'), '--query', 'gap'], { encoding: 'utf8' });
  assert.strictEqual(list.status, 0);
  assert.match(list.stdout, /^Skills matching "gap"/);
  assert.match(list.stdout, /^- fair-value-gaps: /m);
  assert.throws(() => K.parseArgv(['--section', 'x']), /unknown argument/);
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-lookup.js'), '--skill', 'fair-value-gaps'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /^<skill name="fair-value-gaps">/);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-lookup.js'), '--skill', 'nope'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /^\[skill-lookup\] no skill "nope"/);
});

test('preflight: an opencode run\'s opencode.json must be the one generated for its mode', () => {
  const { roleSkillsMismatch } = require('../../scripts/lib/harness-tools/preflight');
  const { expectedFiles } = require('../../scripts/lib/harness-sync');
  const dir = tmpDir();
  const oc = { PWD: dir };
  assert.strictEqual(roleSkillsMismatch(ROOT, { PWD: dir }, 'opencode'), null, 'no FTH_ROLE_SKILLS');
  // Another harness's run (the runner sets full for it): its workspace's opencode.json isn't its, whatever the
  // environment holds (an OPENCODE_CONFIG_CONTENT inherited from the user's shell included). The runner config decides.
  fs.writeFileSync(path.join(dir, 'opencode.json'), expectedFiles(ROOT)['workspace/opencode.json']);
  for (const harness of ['claude', 'codex', 'qwen', null]) {
    assert.strictEqual(roleSkillsMismatch(ROOT, { PWD: dir, FTH_ROLE_SKILLS: 'full', OPENCODE_CONFIG_CONTENT: '{}' }, harness), null, `not an opencode run: ${harness}`);
  }
  assert.match(roleSkillsMismatch(ROOT, { PWD: dir, FTH_ROLE_SKILLS: 'full' }, 'opencode'), /not the one generated for FTH_ROLE_SKILLS=full/, 'opencode, without its run config in the env: still checked');
  fs.unlinkSync(path.join(dir, 'opencode.json'));
  // Full (on request): whatever the file (a missing or hand-edited one included), but an index-mode one.
  assert.strictEqual(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'full' }, 'opencode'), null);
  // The committed file is the default, index: an index run takes it as is; a full run refuses it.
  fs.writeFileSync(path.join(dir, 'opencode.json'), expectedFiles(ROOT)['workspace/opencode.json']);
  assert.strictEqual(expectedFiles(ROOT)['workspace/opencode.json'], expectedFiles(ROOT, { mode: 'index' })['workspace/opencode.json']);
  assert.strictEqual(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'index' }, 'opencode'), null);
  assert.match(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'full' }, 'opencode'), /not the one generated for FTH_ROLE_SKILLS=full/);
  // A full-mode file: a full run takes it; an index run refuses it.
  fs.writeFileSync(path.join(dir, 'opencode.json'), expectedFiles(ROOT, { mode: 'full' })['workspace/opencode.json']);
  assert.strictEqual(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'full' }, 'opencode'), null);
  assert.match(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'index' }, 'opencode'), /run FTH_ROLE_SKILLS=index node scripts\/sync-harness\.js/);
  // An index-mode file from another checkout (not byte for byte this one's) is refused in either mode.
  fs.writeFileSync(path.join(dir, 'opencode.json'), expectedFiles(ROOT, { mode: 'index' })['workspace/opencode.json'].replace('"autoupdate": false', '"autoupdate": false '));
  assert.match(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'full' }, 'opencode'), /not the one generated for FTH_ROLE_SKILLS=full/);
  assert.match(roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'index' }, 'opencode'), /not the one generated for FTH_ROLE_SKILLS=index/);
  assert.throws(() => roleSkillsMismatch(ROOT, { ...oc, FTH_ROLE_SKILLS: 'bogus' }, 'opencode'), /one of full, index/);
});

test('the runner: an opencode run carries its FTH_ROLE_SKILLS (index by default); every other harness\'s run carries full', () => {
  const { childEnv, validateConfig } = require('../../scripts/lib/autotrader');
  const { loadConfig } = require('../../scripts/lib/trading/config');
  const oc = childEnv(validateConfig({ harness: 'opencode' }), ROOT, { FTH_HOME: tmpDir(), FTH_ROLE_SKILLS: 'full' });
  assert.strictEqual(oc.FTH_ROLE_SKILLS, 'full');
  const dflt = childEnv(validateConfig({ harness: 'opencode' }), ROOT, { FTH_HOME: tmpDir() });
  assert.strictEqual(dflt.FTH_ROLE_SKILLS, 'index');
  assert.strictEqual(loadConfig(dflt).roleSkills, 'index', 'the gate in an opencode run enforces the lookups');
  assert.throws(() => childEnv(validateConfig({ harness: 'opencode' }), ROOT, { FTH_HOME: tmpDir(), FTH_ROLE_SKILLS: 'bogus' }), /one of full, index/);
  // The other harnesses' roles load every skill as their body says (no skill_lookup): full, whatever the user set,
  // so the gate never waits on lookups those roles don't make.
  for (const harness of ['claude', 'codex', 'qwen']) {
    for (const set of [{}, { FTH_ROLE_SKILLS: 'index' }]) {
      const env = childEnv(validateConfig({ harness }), ROOT, { FTH_HOME: tmpDir(), ...set });
      assert.strictEqual(env.FTH_ROLE_SKILLS, 'full', harness);
      assert.strictEqual(loadConfig(env).roleSkills, 'full', harness);
    }
  }
});

test('the gate reads FTH_ROLE_SKILLS: index unless full is set (unset, blank and unknown values are index, the strictest)', () => {
  const { loadConfig } = require('../../scripts/lib/trading/config');
  for (const v of [undefined, '', ' ', 'index', 'bogus', 'FULL']) assert.strictEqual(loadConfig(v === undefined ? {} : { FTH_ROLE_SKILLS: v }).roleSkills, 'index', String(v));
  for (const v of ['full', ' full ']) assert.strictEqual(loadConfig({ FTH_ROLE_SKILLS: v }).roleSkills, 'full', v);
});
