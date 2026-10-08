'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { resolveDest, installRules } = require('../../scripts/install-rules');
const { tmpDir } = require('../helpers');

test('resolveDest picks user, project, or explicit destinations', () => {
  assert.strictEqual(resolveDest([], { cwd: '/w', home: '/h' }), path.join('/h', '.claude', 'rules', 'trading'));
  assert.strictEqual(resolveDest(['--project'], { cwd: '/w', home: '/h' }), path.join('/w', '.claude', 'rules', 'trading'));
  assert.strictEqual(resolveDest(['--dest', 'x'], { cwd: '/w', home: '/h' }), path.join('/w', 'x'));
  assert.throws(() => resolveDest(['--dest']));
});

test('installRules copies every trading rule', () => {
  const dest = path.join(tmpDir(), 'rules');
  const files = installRules(dest);
  assert.ok(files.includes('risk-management.md'));
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), files);
});
