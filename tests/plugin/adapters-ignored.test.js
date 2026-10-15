'use strict';

// adapters/ commits its documents only (adapters/README.md): weights, checkpoints, built datasets, manifests, training
// scripts and the local runner config that selects an adapter are gitignored, whatever their name or depth.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');

/** The paths git ignores among `paths` (git check-ignore, without the index: a path need not exist). */
function ignored(paths) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REPO, input: paths.join('\n'), encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, r.stderr);
  return r.stdout.split('\n').filter(Boolean);
}

test('adapter weights, checkpoints, datasets, manifests and the local runner config are ignored', () => {
  const local = [
    'adapters/base-folder/m1/adapters.safetensors',
    'adapters/base-folder/m1/step1/0000100_adapters.safetensors',
    'adapters/base-folder/m1/checkpoints/0001.npz',
    'adapters/base-folder/m1/adapter_config.json',
    'adapters/base-folder/m1/manifest.json',
    'adapters/manifest.json',
    'adapters/base-folder/train.sh',
    'adapters/base-folder/data/step1/train.jsonl',
    'adapters/datasets/ds1/dataset.json',
    'adapters/datasets/ds1/meta.jsonl',
    'adapters/base-folder/m1/weights.bin',
    'adapters/notes.md',
    'adapters/base-folder/README.md',
    'adapters/base-folder/x/train.example.sh',
    'autotrader.json',
    'autotrader.adapter.json',
    'replay.json',
    'replay-adapted.json',
  ];
  assert.deepStrictEqual(ignored(local).sort(), [...local].sort());
});

test('the adapters/ documents are not ignored', () => {
  const shared = ['adapters/README.md', 'adapters/spec.json', 'adapters/base-folder/train.example.sh', 'mcp-configs/replay.example.json', 'docs/TRAINING.md'];
  assert.deepStrictEqual(ignored(shared), []);
  // And the ones in the repository are tracked or listed (none hidden by the rules above).
  const listed = spawnSync('git', ['ls-files', '-co', '--exclude-standard', 'adapters'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(listed.includes('adapters/README.md') && listed.includes('adapters/spec.json'), listed.join(', '));
  assert.ok(listed.every(f => /^adapters\/(?:README\.md|spec\.json|[^/]+\/train\.example\.sh)$/.test(f)), `only the documents: ${listed.join(', ')}`);
});
