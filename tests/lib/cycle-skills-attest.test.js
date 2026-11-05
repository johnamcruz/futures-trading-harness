'use strict';

// The cycle-skills attestation (scripts/lib/cycle-skills-attest.js), as the order gate checks it: one cycle, the runner's
// file, its hash, each named skill's current text whole, and the run's own transcript; anything off, none counts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const CA = require('../../scripts/lib/cycle-skills-attest');
const HP = require('../../scripts/lib/head-prompt');
const { tmpDir } = require('../helpers');

const ROOT = path.resolve(__dirname, '..', '..');

test('attested: counted only for its cycle, its file unchanged, the skills embedded whole, on the run\'s own Claude or opencode transcript', () => {
  const dir = tmpDir();
  const text = ` A section.\n\n${HP.block('compression', HP.skillBody(ROOT, 'compression'))}\n`;
  const file = CA.fileOf(dir, text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const stream = path.join(dir, 'stream.jsonl');
  fs.writeFileSync(stream, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }));
  const att = CA.attestation({ file, text, root: ROOT, cycle: '0123456789abcdef' });
  assert.deepStrictEqual([att.kind, att.skills], ['cycle-skills', ['compression']]);
  assert.deepStrictEqual(CA.parseAttestation(JSON.stringify(att)), att);
  const ok = (a, o = {}) => CA.attested(a, ROOT, { stream, cycle: att.cycle, ...o });
  assert.deepStrictEqual(ok(att), ['compression']);
  assert.deepStrictEqual(ok(att, { hook: path.join(dir, 'projects', 'sess-1.jsonl') }), ['compression'], 'a hook of the run\'s session');
  for (const [label, a, o] of [['another cycle', att, { cycle: 'f'.repeat(16) }], ['another session\'s hook', att, { hook: path.join(dir, 'other.jsonl') }], ['no stream', att, { stream: null }],
    ['another file', { ...att, config: path.join(dir, 'other.md') }, {}], ['a forged hash', { ...att, sha256: '0'.repeat(64) }, {}], ['a skill not embedded', { ...att, skills: ['cisd'] }, {}]]) {
    assert.deepStrictEqual(ok(a, o), [], label);
  }
  // An opencode stream counts, never with a hook.
  const oc = path.join(dir, 'oc.jsonl');
  fs.writeFileSync(oc, JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 's', part: { type: 'step-start' } }));
  assert.deepStrictEqual(ok(att, { stream: oc }), ['compression']);
  assert.deepStrictEqual(ok(att, { stream: oc, hook: path.join(dir, 'x.jsonl') }), []);
  // The file edited after the runner hashed it: none.
  fs.writeFileSync(file, `${text} `);
  assert.deepStrictEqual(ok(att), []);
  for (const bad of ['', '{', JSON.stringify({ ...att, kind: 'x' }), JSON.stringify({ ...att, skills: ['../x'] }), JSON.stringify({ ...att, cycle: 'x' })]) assert.strictEqual(CA.parseAttestation(bad), null, bad);
});

// The runner's entry judges the run's transcript as captured (`text`), after the run. A real Claude Code stream opens with
// SessionStart hook events (hook_started, hook_response) before its init event; the live-file check already reads past them
// (head-prompt.js claudeStreamSession), so the captured-text check must too. Found in a replay: every refused entry had
// its skill embedded in the cycle section and attested, yet the gate said it was not loaded, because the text check
// stopped at the first system event that was not init.
test('attested: the captured transcript counts when SessionStart hook events come before init, as the live file does', () => {
  const dir = tmpDir();
  const text = ` A section.\n\n${HP.block('compression', HP.skillBody(ROOT, 'compression'))}\n`;
  const file = CA.fileOf(dir, text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const att = CA.attestation({ file, text, root: ROOT, cycle: '0123456789abcdef' });
  const ev = o => JSON.stringify(o);
  const hookStarted = ev({ type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: 'sess-1' });
  const hookResponse = ev({ type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', outcome: 'success', session_id: 'sess-1' });
  const init = ev({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  const assistant = ev({ type: 'assistant', session_id: 'sess-1', message: { content: [] } });
  const judged = lines => CA.attested(att, ROOT, { text: lines.join('\n'), cycle: att.cycle });
  assert.deepStrictEqual(judged([init, assistant]), ['compression'], 'init first (as before)');
  assert.deepStrictEqual(judged([hookStarted, hookResponse, init, assistant]), ['compression'], 'hook events, then init');
  assert.deepStrictEqual(judged([hookStarted, init]), ['compression'], 'one hook event, then init');
  // Still the run\'s own stream: no init, an init without a session, or anything else before init, and none counts.
  assert.deepStrictEqual(judged([hookStarted, hookResponse]), [], 'hook events and no init');
  assert.deepStrictEqual(judged([hookStarted, ev({ type: 'system', subtype: 'init' })]), [], 'init without a session id');
  assert.deepStrictEqual(judged([hookStarted, assistant, init]), [], 'a non-system event before init');
  assert.deepStrictEqual(judged(['not json', hookStarted, init]), ['compression'], 'unparseable lines are skipped, as the live-file check skips them');
  assert.deepStrictEqual(judged([]), [], 'empty');
  // Only the stream's first 64 KiB is read (as for the live file): an init past it is not found, and none counts (fails closed).
  const bulky = ev({ type: 'system', subtype: 'hook_response', output: 'x'.repeat(70 * 1024) });
  assert.deepStrictEqual(judged([hookStarted, bulky, init]), [], 'init past the head cut');
});
