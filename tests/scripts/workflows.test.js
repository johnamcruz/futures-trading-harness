'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('../helpers');
const { run } = require('../../scripts/workflows');

test('workflows.js: validate says each workflow is OK (exit 0) or why not (exit 1); list shows the phases; a bad op is usage (2)', () => {
  let out = '';
  assert.strictEqual(run(['validate'], { out: s => { out += s; } }), 0);
  assert.match(out, /^OK {3}desk$/m);
  out = '';
  assert.strictEqual(run(['list'], { out: s => { out += s; } }), 0);
  assert.match(out, /desk: desk \[market-structure-analyst, trend-momentum-analyst, volume-liquidity-analyst, risk-manager\]/);
  const r = tmpDir();
  fs.mkdirSync(path.join(r, 'workflows', 'x'), { recursive: true });
  fs.writeFileSync(path.join(r, 'workflows', 'x', 'WORKFLOW.md'), '---\nname: y\n---\n');
  out = '';
  assert.strictEqual(run(['validate'], { root: r, out: s => { out += s; } }), 1);
  assert.match(out, /^FAIL x: /m);
  assert.strictEqual(run(['nope'], { out: () => {} }), 2);
});
