'use strict';

// A managed cycle's exit skills (scripts/lib/exit-skills.js): manage-position and pullback-vs-reversal in full in the
// cycle's prompt when a position or a working entry is open, attested by the run's environment; a flat cycle's prompt as
// before, byte for byte.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ES = require('../../scripts/lib/exit-skills');
const HP = require('../../scripts/lib/head-prompt');
const { validateConfig, prompts, childEnv } = require('../../scripts/lib/autotrader');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-04-23T14:03:00.000Z');
const ITEMS = [{ symbol: 'MNQ', bar: { t: '2026-04-23T14:00:00.000Z', c: 21500, file: '/tmp/bars.json', contractId: 'MNQ' } }];
const FLAT = { id: 7, at: NOW.toISOString(), balance: 50000, positions: [], workingOrders: 0 };
const OPEN = { ...FLAT, positions: [{ contractId: 'MNQ', type: 1, size: 1, averagePrice: 21500 }], workingOrders: 2, openTrades: ['Open trade MNQ long 1 @ 21500.'] };

test('openOf: an open position or a working entry; flat, unknown or an unreadable account is not', () => {
  assert.strictEqual(ES.openOf(OPEN), true);
  assert.strictEqual(ES.openOf({ ...FLAT, entryLines: ['entry MNQ buy 1 @ 21490 (stop 21480, target 21510)'] }), true);
  for (const s of [FLAT, null, undefined, { ...OPEN, error: 'HTTP 503' }, { id: 7 }]) assert.strictEqual(ES.openOf(s), false, JSON.stringify(s));
});

test('the section: both skills whole (their current text), said loaded; the embedded check reads them', () => {
  const text = ES.exitSkillsText(ROOT);
  assert.ok(text.startsWith(' A position or a working entry is open: your exit skills `manage-position` and `pullback-vs-reversal` are below, already loaded'));
  for (const s of ES.SKILLS) assert.ok(text.includes(HP.block(s, HP.skillBody(ROOT, s))), s);
  assert.deepStrictEqual(HP.embeddedSkills(text, ROOT), ES.SKILLS);
});

test('the cycle prompt: a managed cycle holds both skills before its result line; a flat one is byte-identical to the prompt without them', () => {
  const cfg = validateConfig({ harness: 'claude', account: '7', sessions: ['09:30-12:00@America/New_York'] });
  const P = prompts(cfg, NOW, ROOT);
  const flat = P.trade(ITEMS, { state: FLAT });
  assert.strictEqual(P.trade(ITEMS, { state: FLAT, exitSkills: '' }), flat, 'no section: the prompt as before, byte for byte');
  assert.doesNotMatch(flat, /<skill name=/);
  const text = ES.exitSkillsText(ROOT);
  const managed = P.trade(ITEMS, { state: OPEN, exitSkills: text });
  assert.ok(managed.includes(text) && /CYCLE RESULT: <[^>]+> - <reason>\.$/.test(managed), 'before the result line');
  assert.ok(managed.indexOf(text) > managed.indexOf('trade-session'));
  assert.deepStrictEqual(HP.embeddedSkills(managed, ROOT), ES.SKILLS);
  // The managed prompt's size: the flat one's plus the section, nothing else.
  assert.strictEqual(managed.length, P.trade(ITEMS, { state: OPEN }).length + text.length);
  const bytes = Buffer.byteLength(text);
  assert.ok(bytes > 4000 && bytes < 16000, `the section: ${bytes} bytes`);
});

test('childEnv: the run that has the section writes and attests it for its cycle; never a role run, a probe, an inherited value, or without the section', () => {
  const cfg = validateConfig({ harness: 'claude' });
  const home = tmpDir();
  const base = { FTH_HOME: home, FTH_EXIT_SKILLS: 'stale' };
  assert.ok(!('FTH_EXIT_SKILLS' in childEnv(cfg, ROOT, base, {})), 'flat: none, an inherited one dropped');
  const env = childEnv(cfg, ROOT, base, { exitSkills: true });
  const att = ES.parseExitAttestation(env.FTH_EXIT_SKILLS);
  assert.ok(att, env.FTH_EXIT_SKILLS);
  assert.deepStrictEqual(att.skills, ES.SKILLS);
  assert.strictEqual(att.cycle, require('../../scripts/lib/trading/check-order').cycleId(env));
  assert.strictEqual(path.dirname(att.config), path.join(home, 'head-prompt'));
  assert.strictEqual(fs.readFileSync(att.config, 'utf8'), ES.exitSkillsText(ROOT));
  assert.strictEqual(att.sha256, HP.sha256(ES.exitSkillsText(ROOT)));
  for (const context of [{ exitSkills: true, roleRun: 'trade-executor' }, { exitSkills: true, probe: true }, { exitSkills: 'yes' }]) {
    assert.ok(!('FTH_EXIT_SKILLS' in childEnv(cfg, ROOT, base, context)), JSON.stringify(context));
  }
  // opencode's run too (a streamed cycle transcript: its cycle id); a harness with none (Qwen Code, Codex) gets the
  // section in its prompt but no attestation: its gate reads its own transcript, as before (fail closed).
  assert.ok(ES.parseExitAttestation(childEnv(validateConfig({ harness: 'opencode' }), ROOT, base, { exitSkills: true }).FTH_EXIT_SKILLS));
  for (const harness of ['qwen', 'codex']) assert.ok(!('FTH_EXIT_SKILLS' in childEnv(validateConfig({ harness }), ROOT, base, { exitSkills: true })), harness);
});

test('the attestation: one cycle, the runner\'s file name, the two skills only; malformed values parse to null', () => {
  const home = tmpDir();
  const { file, text } = ES.writeExitSkills(home, ROOT);
  assert.match(path.basename(file), /^exit-skills-[0-9a-f]{64}\.md$/);
  assert.strictEqual(ES.writeExitSkills(home, ROOT).file, file, 'the same text: the same file');
  const att = ES.exitAttestation({ file, text, root: ROOT, cycle: '0123456789abcdef' });
  assert.deepStrictEqual(ES.parseExitAttestation(JSON.stringify(att)), att);
  assert.strictEqual(ES.exitAttestation({ file, text, root: ROOT, cycle: 'nope' }), null);
  assert.strictEqual(ES.exitAttestation({ file, text: 'no skills', root: ROOT, cycle: '0123456789abcdef' }), null);
  for (const bad of ['', '{', '[]', JSON.stringify({ ...att, kind: 'x' }), JSON.stringify({ ...att, skills: [] }), JSON.stringify({ ...att, skills: ['trade-session'] }), JSON.stringify({ ...att, cycle: 'x' }), JSON.stringify({ ...att, sha256: 'abc' })]) {
    assert.strictEqual(ES.parseExitAttestation(bad), null, bad);
  }
});
