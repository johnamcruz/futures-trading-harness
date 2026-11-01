'use strict';

// compose_check's early warning (scripts/lib/trading/reaction-lookup.js): the head-required skills a record's reads
// trigger (skills-loaded.js SITUATIONAL), and which of them this cycle's head hasn't read; table-driven over every
// SITUATIONAL entry and each way a skill reaches the head (looked up, embedded and attested, neither), held to the gate's
// own check (checkSkillsLoaded) so the warning names exactly what the gate would refuse.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RL = require('../../scripts/lib/trading/reaction-lookup');
const SL = require('../../scripts/lib/trading/skills-loaded');
const ES = require('../../scripts/lib/situational-skills');
const { cycleId } = require('../../scripts/lib/trading/check-order');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const oc = (tool, input, output) => JSON.stringify({ type: 'tool_use', timestamp: 1, sessionID: 's', part: { type: 'tool', tool, state: { status: 'completed', input, output } } });
/** An autonomous index-mode head's env: its opencode cycle transcript with these skill lookups, and an optional attested section. */
function envOf({ looked = [], embedded = [], headPrompt = false } = {}) {
  const dir = tmpDir();
  const transcript = path.join(dir, 'logs', 'cycle-transcript-5-ab.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, [JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }), ...looked.map(s => oc('harness_skill_lookup', { skill: s }, `<skill name="${s}">...`))].join('\n'));
  const env = { FTH_AUTONOMOUS: '1', FTH_CYCLE_TRANSCRIPT: transcript };
  if (embedded.length) {
    const { file, text } = ES.writeSituation(dir, ROOT, { skills: embedded, sections: [], over: [], why: ['a test'] });
    env.FTH_CYCLE_SKILLS = JSON.stringify(ES.attestation({ file, text, root: ROOT, cycle: cycleId(env) }));
  }
  // The head prompt (opencode's, index mode) on its attestation: the skills it embeds (CORE, the composed reads).
  if (headPrompt) {
    const file = path.join(dir, 'workspace', 'opencode.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, require('../../scripts/lib/harness-sync').expectedFiles(ROOT)['workspace/opencode.json']);
    env.FTH_HEAD_PROMPT = JSON.stringify(require('../../scripts/lib/head-prompt').attestation(file, ROOT));
  }
  return env;
}
// A read that fires each composed trigger (the trigger vocabulary: skills-loaded.js TRIGGERS).
const READ_FOR = {
  composed: '3m close top',
  'composed.relation=rejected': '15m rejected prior vah up',
  'composed.relation=broke': '15m broke prior vah up',
  'composed.kind=swept': 'swept prior rth high',
};

test('requiredBy: the head-required skills each composed read triggers (the gate\'s table), none of a role\'s', () => {
  assert.deepStrictEqual(RL.requiredBy(['15m rejected prior vah up']).sort(), ['candle-reading', 'confluence-counting', 'invalidation', 'rejection']);
  assert.deepStrictEqual(RL.requiredBy(['15m broke prior vah up']).sort(), ['breakout', 'candle-reading', 'confluence-counting', 'invalidation']);
  assert.deepStrictEqual(RL.requiredBy(['swept prior rth high']).sort(), ['candle-reading', 'confluence-counting', 'invalidation']);
  assert.deepStrictEqual(RL.requiredBy(['15m cisd up']).sort(), ['confluence-counting', 'invalidation']);
  assert.deepStrictEqual(RL.requiredBy(['15m touched prior vah']).sort(), ['confluence-counting', 'invalidation'], 'a touch needs no reaction read');
});

test('enforced only where the gate requires the situational skills: autonomous, index mode or Claude Code\'s attested head', () => {
  assert.strictEqual(RL.enforced({}), false);
  assert.strictEqual(RL.enforced({ FTH_AUTONOMOUS: '1' }), true);
  assert.strictEqual(RL.enforced({ FTH_AUTONOMOUS: '1', FTH_ROLE_SKILLS: 'full' }), false);
  assert.strictEqual(RL.warningFor(['15m rejected prior vah up'], { env: { FTH_ROLE_SKILLS: 'index' }, root: ROOT }), null, 'not autonomous: no warning');
});

test('every SITUATIONAL entry x delivery: looked up or embedded and attested is read; neither is warned at compose_check and refused at the gate', () => {
  const headComposed = SL.SITUATIONAL.filter(e => e.head && e.when.startsWith('composed'));
  // A new head entry with a composed trigger needs its read here (a trigger not covered fails).
  for (const e of headComposed) assert.ok(READ_FOR[e.when], `no read fires ${e.when}`);
  for (const e of headComposed) {
    const reads = [READ_FOR[e.when]];
    assert.ok(RL.requiredBy(reads).includes(e.skill), `${e.when}: ${e.skill} required`);
    // Embedded where the harness embeds it: a taught one in the head prompt, any other in the cycle's situational section.
    const cases = [
      ['neither', envOf(), true],
      ['looked up', envOf({ looked: [e.skill] }), false],
      ['embedded and attested', e.taughtIn ? envOf({ headPrompt: true }) : envOf({ embedded: [e.skill] }), false],
    ];
    for (const [mode, env, missing] of cases) {
      const unread = RL.unread(reads, { env, root: ROOT });
      assert.strictEqual(unread.includes(e.skill), missing, `${e.skill} (${e.when}), ${mode}`);
      const line = RL.warningFor(reads, { env, root: ROOT });
      assert.strictEqual(Boolean(line && line.includes(`"skill": "${e.skill}"`)), missing, `${e.skill}, ${mode}: the warning`);
      // The gate's own check, with what it counts for the same session: refused exactly for the unread ones.
      const counted = [...RL.readThisCycle(env, ROOT)];
      const gate = SL.checkSkillsLoaded(env.FTH_CYCLE_TRANSCRIPT, RL.requiredBy(reads), counted);
      assert.strictEqual(Boolean(gate && new RegExp(`\\b${e.skill}\\b`).test(gate)), missing, `${e.skill}, ${mode}: the gate`);
    }
  }
  // A role's entries (the candidate triggers) never reach the head's warning: the desk's own lookups cover them.
  for (const e of SL.SITUATIONAL.filter(x => !x.head)) assert.ok(!e.when.startsWith('composed'), `${e.when}: a role's entry, never a composed trigger`);
});

test('warningFor: one line naming each unread skill with its skill_lookup call, then compose again; nothing once all are read', () => {
  const reads = ['15m rejected prior vah up'];
  const line = RL.warningFor(reads, { env: envOf(), root: ROOT });
  assert.match(line, /^- READ FIRST: this record's reads need [^\n]*candle-reading[^\n]*then compose again \(the order gate requires them for this entry\)\.$/);
  for (const s of RL.requiredBy(reads)) assert.ok(line.includes(`\`skill_lookup {"skill": "${s}"}\``), s);
  assert.strictEqual(RL.warningFor(reads, { env: envOf({ looked: RL.requiredBy(reads) }), root: ROOT }), null);
  // An unreadable transcript (or none): nothing counts as read, so the warning shows (fails toward it).
  assert.ok(RL.warningFor(reads, { env: { FTH_AUTONOMOUS: '1', FTH_CYCLE_TRANSCRIPT: '/nonexistent/cycle-transcript-1-a.jsonl' }, root: ROOT }));
  assert.ok(RL.warningFor(reads, { env: { FTH_AUTONOMOUS: '1' }, root: ROOT }));
  // Attested for another cycle: not read.
  const env = envOf({ embedded: ['candle-reading'] });
  const att = JSON.parse(env.FTH_CYCLE_SKILLS);
  assert.ok(RL.unread(reads, { env: { ...env, FTH_CYCLE_SKILLS: JSON.stringify({ ...att, cycle: 'f'.repeat(16) }) }, root: ROOT }).includes('candle-reading'));
});
