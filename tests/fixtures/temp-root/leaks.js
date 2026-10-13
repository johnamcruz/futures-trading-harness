'use strict';
// A test file for tests/plugin/temp-root.test.js: ignores the run's root and makes a dir straight in
// process.env.TEMP_ROOT_LEAK_PARENT, as a helper with a hard-coded temp path would.
const test = require('node:test');
const fs = require('fs');
const path = require('path');

test('leaks a temp dir outside the root', () => {
  fs.mkdtempSync(path.join(process.env.TEMP_ROOT_LEAK_PARENT, 'cache-'));
});
