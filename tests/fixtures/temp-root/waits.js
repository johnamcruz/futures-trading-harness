'use strict';
// A test file for tests/plugin/temp-root.test.js: makes a temp dir, says so on stdout, and waits to be killed.
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('waits', async () => {
  fs.mkdtempSync(path.join(os.tmpdir(), 'fth-test-'));
  fs.writeFileSync(process.env.TEMP_ROOT_OUT, os.tmpdir());
  await new Promise(res => setTimeout(res, 30000));
});
