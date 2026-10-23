'use strict';

// A Claude Code role's prompt addition (role-prompt.js, the runner config's roleSkillsInPrompt): its role-skills embedded
// as a load returns them, its role-index one line each, read with skill_lookup, from opencode's index-mode selection.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RP = require('../../scripts/lib/role-prompt');
const HP = require('../../scripts/lib/head-prompt');
const roleSkills = require('../../scripts/lib/role-skills');
const { RUNNER_RUN_ROLES } = require('../../scripts/lib/opencode');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const roles = roleSkills.loadRoles(ROOT);
const agentOf = name => roles.find(a => a.name === name);
const LOOKUP = 'mcp__harness__skill_lookup';

test('every role the runner runs: its file embeds exactly its role-skills (the text a load returns) and indexes exactly its role-index', () => {
  for (const role of RUNNER_RUN_ROLES()) {
    const a = agentOf(role);
    const text = RP.claudeRoleText(ROOT, role);
    assert.deepStrictEqual(HP.embeddedSkills(text, ROOT).sort(), [...a.skills].sort(), `${role}: embedded`);
    assert.deepStrictEqual(RP.indexedIn(text).sort(), [...a.index].sort(), `${role}: indexed`);
    for (const s of a.skills) assert.ok(text.includes(HP.block(s, HP.skillBody(ROOT, s))), `${role}: ${s} whole`);
    for (const s of a.index) assert.ok(!text.includes(`<skill name="${s}">`), `${role}: ${s} not embedded`);
    // The one sentence: already loaded, don't load them again.
    assert.match(text, /are below, already loaded \(Your skills\): read them here; don't load them again with the Skill tool/, role);
    if (a.index.length) {
      assert.ok(a.tools.includes(LOOKUP), `${role}: a role with an index holds skill_lookup`);
      assert.ok(text.includes(`\`${LOOKUP} {"skill": "<name>", "role": "${role}"}\``), `${role}: the lookup names its role`);
    }
    // No cycle data: the same text every call, and nothing of a bar, an account or a time in it.
    assert.strictEqual(RP.claudeRoleText(ROOT, role), text);
    assert.doesNotMatch(text.split('## Your skills (already loaded)')[0], /\d{4}-\d{2}-\d{2}T/);
    // Sizes (the report's): a file per role, bounded by its skills.
    const bodies = [...a.skills].reduce((n, s) => n + HP.skillBody(ROOT, s).length, 0);
    assert.ok(text.length > bodies && text.length < bodies + 8000, `${role}: ${text.length} chars for ${bodies} of skills`);
  }
});

test('the selection is opencode\'s index mode (role-skills.js skillPlan): the same docs embedded, the same indexed', () => {
  const sync = require('../../scripts/lib/harness-sync');
  for (const role of RUNNER_RUN_ROLES()) {
    const a = sync.loadAgents(ROOT).find(x => x.name === role);
    const plan = roleSkills.skillPlan(a, sync.agentSkills(ROOT, a), 'index');
    const text = RP.claudeRoleText(ROOT, role);
    for (const d of plan.docs) assert.ok(text.includes(HP.block(d.name, d.body)), `${role} ${d.name}`);
    assert.deepStrictEqual(RP.indexedIn(text), plan.indexed.map(d => d.name), role);
    // opencode's generated role prompt embeds the same blocks.
    const oc = JSON.parse(fs.readFileSync(path.join(ROOT, 'workspace', 'opencode.json'), 'utf8')).agent[role].prompt;
    assert.deepStrictEqual(HP.embeddedSkills(oc, ROOT).sort(), HP.embeddedSkills(text, ROOT).sort(), `${role}: opencode's and Claude's agree`);
  }
});

test('rolePlan refuses a role that isn\'t one, and a role-index without skill_lookup', () => {
  assert.throws(() => RP.claudeRoleText(ROOT, 'nobody'), /no role "nobody"/);
  assert.throws(() => RP.claudeRoleText(ROOT, '../x'), /no role/);
  const root = tmpDir();
  fs.mkdirSync(path.join(root, 'agents'));
  fs.mkdirSync(path.join(root, 'skills', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'a', 'SKILL.md'), '---\nname: a\ndescription: A.\n---\nbody a\n');
  fs.writeFileSync(path.join(root, 'skills', 'b', 'SKILL.md'), '---\nname: b\ndescription: B.\n---\nbody b\n');
  fs.writeFileSync(path.join(root, 'agents', 'r.md'), '---\nname: r\ndescription: R.\ntools: Read\nrole-skills:\n  - a\nrole-index:\n  - b\n---\nLoad the skills `a` and `b`.\n');
  assert.throws(() => RP.claudeRoleText(root, 'r'), /has a role-index but not the tool mcp__harness__skill_lookup/);
  fs.writeFileSync(path.join(root, 'agents', 'r.md'), `---\nname: r\ndescription: R.\ntools: Read, ${LOOKUP}\nrole-skills:\n  - a\nrole-index:\n  - b\n---\nLoad the skills \`a\` and \`b\`.\n`);
  const text = RP.claudeRoleText(root, 'r');
  assert.deepStrictEqual([HP.embeddedSkills(text, root), RP.indexedIn(text)], [['a'], ['b']]);
  assert.match(text, /- b: B\./);
});

test('writeClaudeRole: <home>/role-prompt/claude-<role>-<sha256>.md, written when missing or different; the role\'s older ones pruned (its newest kept), another role\'s never', () => {
  const home = tmpDir();
  const { file, text } = RP.writeClaudeRole(home, ROOT, 'risk-manager');
  assert.strictEqual(file, path.join(home, 'role-prompt', `claude-risk-manager-${HP.sha256(text)}.md`));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  assert.strictEqual(RP.claudeRoleFile(home, 'risk-manager', text), file);
  const dir = path.dirname(file);
  const stale = n => { const f = path.join(dir, `claude-risk-manager-${String(n).repeat(64)}.md`); fs.writeFileSync(f, 'old'); fs.utimesSync(f, new Date(1000 * n), new Date(1000 * n)); return f; };
  const other = path.join(dir, `claude-trade-executor-${'9'.repeat(64)}.md`);
  fs.writeFileSync(other, 'other role');
  const head = path.join(dir, `claude-head-${'8'.repeat(64)}.md`);
  fs.writeFileSync(head, 'not a role file');
  const [a, b] = [stale(1), stale(2)];
  // Unchanged: nothing written, nothing pruned.
  RP.writeClaudeRole(home, ROOT, 'risk-manager');
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  // Changed (a different file at the role's name): written again, the role's older ones pruned but the newest.
  fs.writeFileSync(file, 'tampered');
  RP.writeClaudeRole(home, ROOT, 'risk-manager');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  assert.deepStrictEqual([fs.existsSync(a), fs.existsSync(b), fs.existsSync(other), fs.existsSync(head)], [false, true, true, true]);
});
