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
