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
  const { body } = parseFrontmatter(fs.readFileSync(path.join(ROOT, 'skills', 'liquidity-concepts', 'SKILL.md'), 'utf8'));
  assert.strictEqual(K.skillLookup({ skill: 'liquidity-concepts' }, { env: {} }).text, `<skill name="liquidity-concepts">\n${body.trim()}\n</skill>\n`);
});

test('skill_lookup: unknown skills, paths, and a skill folder that leads outside skills/ are refused', () => {
  for (const skill of ['no-such-skill', '../agents', 'skills/x', '/etc/passwd', '.hidden', 'A', '', null]) {
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
  assert.throws(() => K.skillLookup({ skill: 'liquidity-concepts', role: '../x' }, { env: {} }), /--role/);
  // The tool's schema refuses them first.
  const schema = BY_NAME.get('skill_lookup').inputSchema;
  assert.deepStrictEqual(validate(schema, { skill: 'liquidity-concepts', role: 'risk-manager' }), []);
  assert.match(validate(schema, { skill: '../x' }).join(';'), /must match/);
  assert.match(validate(schema, { skill: 'x', section: 'y' }).join(';'), /"section": unknown argument/);
  assert.match(validate(schema, {}).join(';'), /skill/);
});

test('skill_lookup: a role\'s lookup in a runner\'s cycle is recorded; none outside one, none without a role, none refused', () => {
  const transcript = path.join(tmpDir(), 'cycle-transcript.jsonl');
  const env = { FTH_CYCLE_TRANSCRIPT: transcript };
  K.skillLookup({ skill: 'liquidity-concepts', role: 'volume-liquidity-analyst' }, { env, wallNow: () => 123 });
  K.skillLookup({ skill: 'liquidity-concepts' }, { env });
  assert.throws(() => K.skillLookup({ skill: 'nope', role: 'volume-liquidity-analyst' }, { env }));
  K.skillLookup({ skill: 'liquidity-concepts', role: 'volume-liquidity-analyst' }, { env: {} });
  assert.deepStrictEqual(readLookups(transcript), [{ at: 123, role: 'volume-liquidity-analyst', skill: 'liquidity-concepts' }]);
});

test('skill-lookup.js: the CLI prints the skill; a bad argument fails', () => {
  assert.deepStrictEqual(K.parseArgv(['--skill', 'a', '--role=b']), { skill: 'a', role: 'b' });
  assert.throws(() => K.parseArgv(['--section', 'x']), /unknown argument/);
  const ok = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-lookup.js'), '--skill', 'liquidity-concepts'], { encoding: 'utf8' });
  assert.strictEqual(ok.status, 0);
  assert.match(ok.stdout, /^<skill name="liquidity-concepts">/);
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
